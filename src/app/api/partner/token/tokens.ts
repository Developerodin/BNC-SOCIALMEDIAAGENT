import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { partnerClients, partnerConnectRequests, partnerGrants, partnerTokens, stores } from "@/db/schema";
import { partnerJson } from "@/lib/partner/auth";
import { forTokenHash } from "@/lib/partner/db";
import { fetchShop } from "@/lib/partner/queries";
import { rateLimit } from "@/lib/partner/rate-limit";
import { GRANTABLE } from "@/lib/partner/scopes";
import {
  ACCESS_TTL_MS,
  TOKEN_MODEL,
  type TokenModel,
  accessExpiresAt,
  newToken,
  safeEqualHex,
  sha256Hex,
  tokenKindOf,
  verifyPkceS256,
} from "@/lib/partner/secrets";

// Task P6: the partner token endpoint. Exchange (authorization_code), refresh (only under TOKEN_MODEL
// "access_refresh", C32) and revoke (DELETE: the whole grant). Errors follow RFC 6749 5.2. Logs carry ids and
// token prefixes only: never a token, code, verifier, client secret or state.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Client = typeof partnerClients.$inferSelect;
type StoreRow = typeof stores.$inferSelect;
type ShopOut = { domain: string; name: string; currencyCode: string };
type Issued = { access: string; refresh?: string; scopes: string[] };

const MAX_BODY = 4096;
const ACTIVE_GRANT_UQ = "partner_grants_active_store_client_uq";
const fail = (error: string, status = 400, headers: Record<string, string> = {}) => partnerJson({ error }, status, headers);
const invalidGrant = () => fail("invalid_grant");

class ShopInfoUnavailable extends Error {}

/**
 * The JSON object body, or null for the wrong content type, more than 4 kB, bad JSON or a non-object.
 * ponytail: a chunked body without Content-Length is read whole before the size check; fine behind the host's own
 * request size limit. Stream with a byte cap if this endpoint is ever exposed without one.
 */
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) return null;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (b: Record<string, unknown>, k: string): string | null => (typeof b[k] === "string" && b[k] !== "" ? (b[k] as string) : null);

/** The client, if it exists, isn't disabled and the secret's sha256 matches in constant time. */
async function authenticateClient(clientId: string, secret: string): Promise<Client | null> {
  const [c] = await db.select().from(partnerClients).where(eq(partnerClients.clientId, clientId)).limit(1);
  if (!c || c.disabledAt) return null;
  return safeEqualHex(sha256Hex(secret), c.secretHash) ? c : null;
}

/**
 * The response's shop. Name and currency come from `stores`; when either is missing they are fetched from Shopify.
 * Called outside any transaction, so a slow Shopify call never holds a row lock or a second pooled connection.
 */
async function shopFor(store: StoreRow): Promise<ShopOut> {
  if (store.name && store.currencyCode) return { domain: store.shopDomain, name: store.name, currencyCode: store.currencyCode };
  try {
    const s = await fetchShop({ storeId: store.id, shop: store.shopDomain });
    return { domain: store.shopDomain, ...s };
  } catch (e) {
    console.error(`partner token: shop info fetch failed for store ${store.id} (${e instanceof Error ? e.name : "error"})`);
    throw new ShopInfoUnavailable();
  }
}

/** Inserts the grant's access token, plus a refresh token under access_refresh. Returns the plain tokens once. */
async function issueTokens(tx: Tx, grantId: string, storeId: string, model: TokenModel): Promise<Omit<Issued, "scopes">> {
  const access = newToken("access");
  const rows: (typeof partnerTokens.$inferInsert)[] = [
    { grantId, storeId, kind: "access", tokenHash: access.hash, tokenPrefix: access.prefix, expiresAt: accessExpiresAt(model) },
  ];
  const refresh = model === "access_refresh" ? newToken("refresh") : null;
  if (refresh) rows.push({ grantId, storeId, kind: "refresh", tokenHash: refresh.hash, tokenPrefix: refresh.prefix });
  await tx.insert(partnerTokens).values(rows);
  return { access: access.token, refresh: refresh?.token };
}

const revoke = (tx: Tx, where: ReturnType<typeof and>, reason: "code_replay" | "refresh_replay" | "portal" | "reconnect") =>
  tx.update(partnerGrants).set({ revokedAt: dsql`now()`, revokedReason: reason }).where(and(where, isNull(partnerGrants.revokedAt)));

function isActiveGrantClash(e: unknown): boolean {
  for (let x: unknown = e; x && typeof x === "object"; x = (x as { cause?: unknown }).cause) {
    const pg = x as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === ACTIVE_GRANT_UQ) return true;
  }
  return false;
}

/**
 * Two different codes for the same store and client exchanged at once: each revokes the active grant it can see,
 * then both insert, and the later insert hits the partial unique index (23505). Its whole transaction rolled back,
 * so its code is still approved; retrying replays C33 against the winner's grant, and the latest exchange wins.
 */
async function retryOnGrantClash<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isActiveGrantClash(e)) throw e;
    }
  }
}

function respond(i: Issued, shop: ShopOut): Response {
  return partnerJson({
    access_token: i.access,
    token_type: "Bearer",
    ...(i.refresh ? { expires_in: ACCESS_TTL_MS / 1000, refresh_token: i.refresh } : {}),
    shop,
    scopes: GRANTABLE.filter((s) => i.scopes.includes(s)),
  });
}

/**
 * grant_type=authorization_code. One transaction: lock the request by code hash; a code already exchanged is a replay
 * (RFC 6749 4.1.2) and revokes the grant issued from it; otherwise check status, expiry, client, exact redirect_uri
 * and PKCE, mark it exchanged, and under the store's RLS revoke the active grant for this store and client (C33 (a),
 * 'reconnect') before inserting the new grant and its tokens.
 */
async function exchangeCode(
  client: Client,
  f: { code: string; redirectUri: string; verifier: string },
  model: TokenModel,
): Promise<Response> {
  const codeHash = sha256Hex(f.code);
  const R = partnerConnectRequests;
  const [peek] = await db.select({ shopDomain: R.shopDomain, status: R.status }).from(R).where(eq(R.codeHash, codeHash)).limit(1);
  if (!peek) return invalidGrant();
  const [store] = await db.select().from(stores).where(eq(stores.shopDomain, peek.shopDomain)).limit(1);
  // Only an approved code on a live store gets as far as Shopify; a replay goes straight to the transaction.
  const shop = peek.status === "approved" && store?.active ? await shopFor(store) : null;

  const out = await retryOnGrantClash(() =>
    db.transaction(async (tx): Promise<Issued | "replay" | null> => {
      const [r] = await tx
        .select({
          id: R.id, clientId: R.clientId, shopDomain: R.shopDomain, redirectUri: R.redirectUri, codeChallenge: R.codeChallenge,
          scopes: R.scopes, status: R.status, approvedBy: R.approvedByUserId, live: dsql<boolean>`${R.codeExpiresAt} > now()`,
        })
        .from(R)
        .where(eq(R.codeHash, codeHash))
        .for("update");
      if (!r) return null;
      if (r.status === "exchanged") {
        const [s] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.shopDomain, r.shopDomain));
        if (s) await forStore(s.id, (stx) => revoke(stx, eq(partnerGrants.connectRequestId, r.id), "code_replay"), tx);
        console.warn(`partner token: code replay for request ${r.id} (client ${client.clientId}); its grant is revoked`);
        return "replay";
      }
      if (r.status !== "approved" || !r.live || r.clientId !== client.clientId || r.redirectUri !== f.redirectUri) return null;
      if (!verifyPkceS256(f.verifier, r.codeChallenge)) return null;
      const [s] = await tx.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, r.shopDomain));
      if (!s?.active || !shop) return null;

      await tx.update(R).set({ status: "exchanged", exchangedAt: dsql`now()` }).where(eq(R.id, r.id));
      return forStore(
        s.id,
        async (stx) => {
          await revoke(stx, and(eq(partnerGrants.storeId, s.id), eq(partnerGrants.clientId, client.clientId)), "reconnect");
          const [g] = await stx
            .insert(partnerGrants)
            .values({
              storeId: s.id, shopDomain: r.shopDomain, clientId: client.clientId, scopes: r.scopes,
              connectRequestId: r.id, grantedByUserId: r.approvedBy,
            })
            .returning({ id: partnerGrants.id });
          return { ...(await issueTokens(stx, g.id, s.id, model)), scopes: r.scopes };
        },
        tx,
      );
    }),
  );
  return out && out !== "replay" && shop ? respond(out, shop) : invalidGrant();
}

/**
 * grant_type=refresh_token, only under access_refresh. Locks the grant, rotates the refresh token (`replaced_at`) and
 * issues a new access and refresh token on the same grant. A refresh token already replaced is a theft signal and
 * revokes the grant ('refresh_replay'). Two refreshes at once: the grant lock serialises them and the second loses.
 */
async function refreshGrant(client: Client, refreshToken: string, model: TokenModel): Promise<Response> {
  if (tokenKindOf(refreshToken) !== "refresh") return invalidGrant();
  const hash = sha256Hex(refreshToken);
  const store = await forTokenHash(hash, async (tx, t) => (await tx.select().from(stores).where(eq(stores.id, t.storeId)))[0] ?? null);
  if (!store?.active) return invalidGrant();
  const shop = await shopFor(store);

  const out = await forTokenHash(hash, async (tx, t): Promise<Issued | "replay" | null> => {
    if (t.kind !== "refresh") return null;
    const [g] = await tx.select().from(partnerGrants).where(eq(partnerGrants.id, t.grantId)).for("update");
    if (!g || g.clientId !== client.clientId || g.revokedAt) return null;
    const [rotated] = await tx
      .update(partnerTokens)
      .set({ replacedAt: dsql`now()` })
      .where(and(eq(partnerTokens.id, t.id), isNull(partnerTokens.replacedAt)))
      .returning({ id: partnerTokens.id });
    if (!rotated) {
      await revoke(tx, eq(partnerGrants.id, g.id), "refresh_replay");
      console.warn(`partner token: refresh replay on token ${t.tokenPrefix} (grant ${g.id}); the grant is revoked`);
      return "replay";
    }
    const [s] = await tx.select({ active: stores.active }).from(stores).where(eq(stores.id, g.storeId));
    if (!s?.active) return null;
    return { ...(await issueTokens(tx, g.id, g.storeId, model)), scopes: g.scopes };
  });
  return out && out !== "replay" ? respond(out, shop) : invalidGrant();
}

/** POST /api/partner/token. `model` is a parameter only so tests can exercise the access_refresh switch. */
export async function tokenPost(req: Request, model: TokenModel = TOKEN_MODEL): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail("invalid_request");
  const grantType = body.grant_type ?? "authorization_code";
  if (typeof grantType !== "string") return fail("invalid_request");
  const refresh = grantType === "refresh_token" && model === "access_refresh";
  if (grantType !== "authorization_code" && !refresh) return fail("unsupported_grant_type");

  const clientId = str(body, "client_id");
  const secret = str(body, "client_secret");
  const refreshToken = str(body, "refresh_token");
  const f = { code: str(body, "code"), redirectUri: str(body, "redirect_uri"), verifier: str(body, "code_verifier") };
  if (!clientId || !secret) return fail("invalid_request");
  if (refresh ? !refreshToken : !f.code || !f.redirectUri || !f.verifier) return fail("invalid_request");

  const client = await authenticateClient(clientId, secret);
  if (!client) return fail("invalid_client", 401, { "WWW-Authenticate": 'Basic realm="askcart-partner"' });
  // After authentication, so junk with a wrong secret can't spend a real client's budget.
  const wait = rateLimit("token:" + client.clientId);
  if (wait > 0) return fail("rate_limited", 429, { "Retry-After": String(wait) });

  try {
    return refresh
      ? await refreshGrant(client, refreshToken!, model)
      : await exchangeCode(client, { code: f.code!, redirectUri: f.redirectUri!, verifier: f.verifier! }, model);
  } catch (e) {
    if (e instanceof ShopInfoUnavailable) return fail("temporarily_unavailable", 503, { "Retry-After": "5" });
    throw e;
  }
}

/**
 * DELETE /api/partner/token: revokes the whole grant of the presented token ('portal'). The lookup is by hash only, so
 * an expired access token or a refresh token works. Always 204 (already revoked, unknown, or not our token format:
 * nothing to say, RFC 7009 style); 400 only when there is no Bearer value.
 */
export async function revokeByBearer(req: Request): Promise<Response> {
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return fail("invalid_request");
  if (tokenKindOf(m[1])) {
    await forTokenHash(sha256Hex(m[1]), (tx, t) => revoke(tx, eq(partnerGrants.id, t.grantId), "portal"));
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
