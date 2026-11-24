import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { partnerGrants, partnerTokens, stores } from "@/db/schema";
import { forTokenHash } from "./db";
import { rateLimit } from "./rate-limit";
import type { PartnerScope } from "./scopes";
import { ACCESS_PREFIX, REFRESH_PREFIX, sha256Hex, tokenKindOf } from "./secrets";

// D70 / D73: a portal reads one store's data through these routes. The store comes only from the per-store token
// (plan Task P7), or, until the portal switches (C31, removed by P11), from PARTNER_STORE_DOMAIN with the shared
// PARTNER_API_SECRET. Never from the request's query, headers, host or body.

export type PartnerStore = { storeId: string; shop: string };

/** Every partner response: never cached, never CORS (server to server). */
export function partnerJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

const bearerOf = (req: Request): string | null => /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

const invalidToken = () =>
  partnerJson({ error: "invalid_token" }, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });

const rateLimited = (wait: number) => partnerJson({ error: "rate_limited" }, 429, { "Retry-After": String(wait) });

/**
 * Runs the checks every partner route shares and returns the store to read, or the Response to send.
 * A Bearer value that looks like a token (`ack_` or `ackr_`) takes the token path; anything else the legacy path.
 */
export async function partnerGuard(req: Request, scope: PartnerScope): Promise<PartnerStore | Response> {
  const bearer = bearerOf(req);
  if (bearer !== null && (bearer.startsWith(ACCESS_PREFIX) || bearer.startsWith(REFRESH_PREFIX))) {
    return tokenGuard(bearer, scope);
  }
  return legacyGuard(bearer);
}

/**
 * Token path, in order: format is an access token (else 401, no DB) → the row by sha256 (forTokenHash) is an access
 * token, not expired, its grant not revoked and its store active (each else 401 invalid_token) → the grant's scopes
 * hold `scope` (403) → this token's rate limit (429) → `last_used_at` touched at most once an hour.
 * The refusals are one indistinguishable 401 so a caller learns nothing beyond "reconnect".
 */
async function tokenGuard(bearer: string, scope: PartnerScope): Promise<PartnerStore | Response> {
  if (tokenKindOf(bearer) !== "access") return invalidToken();

  const result = await forTokenHash(sha256Hex(bearer), async (tx, token): Promise<PartnerStore | Response> => {
    if (token.kind !== "access") return invalidToken();
    if (token.expiresAt !== null && token.expiresAt.getTime() <= Date.now()) return invalidToken();

    const [grant] = await tx
      .select({ scopes: partnerGrants.scopes, shop: stores.shopDomain, active: stores.active })
      .from(partnerGrants)
      .innerJoin(stores, eq(stores.id, partnerGrants.storeId))
      .where(and(eq(partnerGrants.id, token.grantId), isNull(partnerGrants.revokedAt)));
    if (!grant?.active) return invalidToken();

    if (!grant.scopes.includes(scope)) return partnerJson({ error: "insufficient_scope", scope }, 403);

    const wait = rateLimit(token.id);
    if (wait > 0) return rateLimited(wait);

    // At most one write an hour per token; the WHERE makes concurrent calls write once between them.
    await tx
      .update(partnerTokens)
      .set({ lastUsedAt: dsql`now()` })
      .where(
        and(
          eq(partnerTokens.id, token.id),
          or(isNull(partnerTokens.lastUsedAt), lt(partnerTokens.lastUsedAt, dsql`now() - interval '1 hour'`)),
        ),
      );
    return { storeId: token.storeId, shop: grant.shop };
  });
  return result ?? invalidToken();
}

/** Constant-time check of the Bearer value. Hashing first gives equal-length buffers whatever is sent. */
function secretMatches(bearer: string | null, secret: string): boolean {
  if (bearer === null) return false;
  return timingSafeEqual(sha256(bearer), sha256(secret));
}

/**
 * Legacy path (C31, removed by P11), today's responses unchanged: store configured and secret right (else 401),
 * rate limit (429), store installed (503). An unset PARTNER_STORE_DOMAIN turns the path off; it used to be 404,
 * and is 401 now that the routes exist for token holders (plan (h)).
 * ponytail: wrong secrets are not rate limited; the secret must be long and random (32+ bytes), so guessing is hopeless.
 */
async function legacyGuard(bearer: string | null): Promise<PartnerStore | Response> {
  const shop = process.env.PARTNER_STORE_DOMAIN?.trim().toLowerCase();
  const secret = process.env.PARTNER_API_SECRET;
  if (!shop || !secret || !secretMatches(bearer, secret)) return partnerJson({ error: "unauthorized" }, 401);

  const wait = rateLimit(sha256(secret).toString("hex"));
  if (wait > 0) return rateLimited(wait);

  const [store] = await db.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!store?.active) return partnerJson({ error: "store_not_connected" }, 503, { "Retry-After": "3600" });
  return { storeId: store.id, shop };
}
