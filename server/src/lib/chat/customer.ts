import { createHmac, timingSafeEqual } from "node:crypto";

// Customer session: proves "this request comes from signed-in customer X of store S" to the chat routes. AskCart issues
// it only after Shopify has vouched for the customer (Storefront API check for the mobile app, App Proxy signature for the
// website), so a customer id is never taken from a request body or from the client's word.
//
// Format: "<expiresAtMs>.<numeric customer id>.<base64url HMAC-SHA256>". The MAC covers store id, expiry and customer, so a
// session never verifies under another store, and neither the expiry nor the id can be edited. The key is derived from
// CHAT_TOKEN_SECRET with its own domain prefix ("cs1|"), so a conversation token can never pass as a session or the reverse;
// rotating that secret signs every customer out too (clients just ask for a new session).
//
// Failure modes. Expired mid-turn: the session is checked when a turn opens, so a running stream finishes; the next call
// gets 401 invalid_session and the client re-issues. Revoked / customer deleted: a session can't be recalled inside its
// hour (stateless); the customer's own conversations just stay reachable by that customer until it lapses.

export const SESSION_TTL_MS = 3_600_000;
const CUSTOMER_HEADER = "x-askcart-customer";

const GID_PREFIX = "gid://shopify/Customer/";
const CUSTOMER_ID = /^\d{1,20}$/;

function secret(): Buffer {
  const k = Buffer.from(process.env.CHAT_TOKEN_SECRET ?? "", "base64");
  if (k.length !== 32) throw new Error("CHAT_TOKEN_SECRET must be 32 bytes, base64-encoded");
  return k;
}

function mac(storeId: string, exp: string, id: string): string {
  return createHmac("sha256", secret()).update(`cs1|${storeId}|${exp}|${id}`).digest("base64url");
}

/** True for a canonical customer GID (gid://shopify/Customer/<digits>). */
export function isCustomerGid(gid: unknown): gid is string {
  return typeof gid === "string" && gid.startsWith(GID_PREFIX) && CUSTOMER_ID.test(gid.slice(GID_PREFIX.length));
}

/** The canonical GID for a numeric customer id (what the App Proxy's logged_in_customer_id holds), or null. */
export function customerGid(numericId: string): string | null {
  return CUSTOMER_ID.test(numericId) ? GID_PREFIX + numericId : null;
}

export function mintSession(storeId: string, gid: string, now = Date.now()): { token: string; expiresAt: number } {
  if (!isCustomerGid(gid)) throw new Error("not a customer GID");
  const exp = String(now + SESSION_TTL_MS);
  const id = gid.slice(GID_PREFIX.length);
  return { token: `${exp}.${id}.${mac(storeId, exp, id)}`, expiresAt: now + SESSION_TTL_MS };
}

/** The customer GID, or null for a bad format, another store, a tampered MAC or an expired session. */
export function verifySession(storeId: string, token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [exp, id, given] = parts;
  if (!/^\d{1,16}$/.test(exp) || !CUSTOMER_ID.test(id)) return null;
  // Compare the base64url text, as token.ts does.
  const a = Buffer.from(given);
  const b = Buffer.from(mac(storeId, exp, id));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) <= now) return null;
  return GID_PREFIX + id;
}

/**
 * The customer of a request: `{ ok: true }` with no customer when the header is absent (a guest, exactly as before), the
 * GID when it holds a valid session, `{ ok: false }` when it holds a bad or expired one (the route answers 401 so the
 * client re-issues; silently treating it as a guest would hide the person's own chats).
 */
export function customerOf(req: Request, storeId: string): { ok: true; customer?: string } | { ok: false } {
  const token = req.headers.get(CUSTOMER_HEADER);
  if (token === null) return { ok: true };
  const customer = verifySession(storeId, token);
  return customer ? { ok: true, customer } : { ok: false };
}
