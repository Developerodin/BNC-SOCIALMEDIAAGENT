import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { rateLimit } from "./rate-limit";

// D70 / D73: the Social Media Agent reads one store's data through these routes. The store comes only from
// PARTNER_STORE_DOMAIN, never from the request, and the caller proves itself with PARTNER_API_SECRET.

export type PartnerStore = { storeId: string; shop: string };

/** Every partner response: never cached, never CORS (server to server). */
export function partnerJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of `Authorization: Bearer <secret>`. Hashing first gives equal-length buffers whatever is sent. */
function secretMatches(req: Request, secret: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), sha256(secret));
}

/**
 * Runs the checks every partner route shares, in order: store configured (else 404), secret (401), rate limit (429),
 * store installed (503). Returns the locked store, or the Response to send.
 * ponytail: wrong secrets are not rate limited; the secret must be long and random (32+ bytes), so guessing is hopeless.
 */
export async function partnerGuard(req: Request): Promise<PartnerStore | Response> {
  const shop = process.env.PARTNER_STORE_DOMAIN?.trim().toLowerCase();
  if (!shop) return partnerJson({ error: "not_found" }, 404);

  const secret = process.env.PARTNER_API_SECRET;
  if (!secret || !secretMatches(req, secret)) return partnerJson({ error: "unauthorized" }, 401);

  const wait = rateLimit(sha256(secret).toString("hex"));
  if (wait > 0) return partnerJson({ error: "rate_limited" }, 429, { "Retry-After": String(wait) });

  const [store] = await db.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!store?.active) return partnerJson({ error: "store_not_connected" }, 503, { "Retry-After": "3600" });
  return { storeId: store.id, shop };
}
