import { and, eq, gt, sql as dsql } from "drizzle-orm";
import { AuthScopes, HttpResponseError, RequestedTokenType } from "@shopify/shopify-api";
import { db } from "@/db/client";
import { partnerClients, partnerConnectRequests, stores } from "@/db/schema";
import { shopify } from "@/lib/shopify/api";
import { authenticateEmbedded } from "@/lib/shopify/session";
import { SHOPIFY_SCOPE_FOR, type PartnerScope } from "./scopes";
import { CODE_TTL_MS, newCode } from "./secrets";

// Task P5: the consent screen inside Shopify admin. The approver is proven to be staff of the request's shop by the
// session token (dest = shop) and, on Allow, by an online token exchange whose user scopes must cover what is shared.

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const notFound = () => json({ error: "not_found" }, 404);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StaffResult = { userId: string } | { error: "approver_not_allowed" | "staff_permission_missing" | "shopify_unavailable"; missing?: string[] };

/**
 * C30 (a): any staff member who can open AskCart (Shopify grants the online token) and whose own permissions cover
 * the Shopify scope behind every requested partner scope. Collaborators count as staff. The online session is used
 * only for these two fields and then dropped: never stored, never logged.
 */
export async function staffCheck(sessionToken: string, shop: string, scopes: readonly string[]): Promise<StaffResult> {
  let info;
  try {
    const { session } = await shopify.auth.tokenExchange({ shop, sessionToken, requestedTokenType: RequestedTokenType.OnlineAccessToken });
    info = session.onlineAccessInfo;
  } catch (e) {
    // A 4xx means Shopify refused this user an online token for the app (e.g. no access to AskCart). 5xx, 429 and
    // network errors are Shopify being unavailable; log only the status, never the error (it may echo the request).
    const code = e instanceof HttpResponseError ? e.response.code : null;
    if (code !== null && code >= 400 && code < 500 && code !== 429) return { error: "approver_not_allowed" };
    console.error(`Partner consent: online token exchange failed for ${shop} (status ${code ?? "network"})`);
    return { error: "shopify_unavailable" };
  }
  const userId = info?.associated_user?.id;
  if (!info || userId == null) return { error: "approver_not_allowed" };
  // AuthScopes expands implied scopes, so write_orders covers read_orders.
  const held = new AuthScopes(info.associated_user_scope ?? "");
  const missing = scopes
    .map((s) => SHOPIFY_SCOPE_FOR[s as PartnerScope])
    .filter((s): s is string => !!s && !held.has(s));
  if (missing.length) return { error: "staff_permission_missing", missing: [...new Set(missing)] };
  return { userId: String(userId) };
}

/** The request if it exists and belongs to `shop`, with whether it is still live by the DB clock. */
async function loadRequest(id: unknown, shop: string) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const [r] = await db
    .select({
      id: partnerConnectRequests.id,
      shopDomain: partnerConnectRequests.shopDomain,
      status: partnerConnectRequests.status,
      scopes: partnerConnectRequests.scopes,
      redirectUri: partnerConnectRequests.redirectUri,
      state: partnerConnectRequests.state,
      expiresAt: partnerConnectRequests.expiresAt,
      live: dsql<boolean>`${partnerConnectRequests.expiresAt} > now()`,
      clientName: partnerClients.name,
    })
    .from(partnerConnectRequests)
    .innerJoin(partnerClients, eq(partnerClients.clientId, partnerConnectRequests.clientId))
    .where(eq(partnerConnectRequests.id, id));
  // Another shop's request looks exactly like a missing one.
  return r && r.shopDomain === shop ? r : null;
}

/** The response for a request that is not (or no longer) pending and live: 410 expired, else 409 already decided. */
function notPending(r: { status: string; live: boolean }): Response {
  if (r.status === "expired" || (r.status === "pending" && !r.live)) return json({ error: "expired" }, 410);
  return json({ error: "already_decided" }, 409);
}

function redirectTo(uri: string, params: Record<string, string>): string {
  const url = new URL(uri); // an exact allow-listed URI, checked at /partner/connect
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

async function authed(req: Request) {
  try {
    return await authenticateEmbedded(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

/** GET /api/app/partner-consent?request=<id>: what the consent screen shows. */
export async function getConsent(req: Request): Promise<Response> {
  const auth = await authed(req);
  if (auth instanceof Response) return auth;
  const r = await loadRequest(new URL(req.url).searchParams.get("request"), auth.shop);
  if (!r) return notFound();
  if (r.status !== "pending" || !r.live) {
    const res = notPending(r);
    return res.status === 410 ? res : notFound(); // a decided request reads as missing
  }
  const [s] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, auth.storeId));
  return json({
    clientName: r.clientName,
    shop: { domain: auth.shop, name: s?.name ?? null },
    scopes: r.scopes,
    expiresAt: r.expiresAt.toISOString(),
  });
}

/** POST /api/app/partner-consent `{ requestId, decision }`: Allow mints a one-time code, Deny closes the request. */
export async function decideConsent(req: Request): Promise<Response> {
  const auth = await authed(req);
  if (auth instanceof Response) return auth;
  let body: { requestId?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const { requestId, decision } = body ?? {};
  if (typeof requestId !== "string" || (decision !== "allow" && decision !== "deny")) return json({ error: "invalid_request" }, 400);

  const r = await loadRequest(requestId, auth.shop);
  if (!r) return notFound();
  if (r.status !== "pending" || !r.live) return notPending(r);

  // Only a pending, unexpired request of this shop changes; a lost race re-reads it for the right error.
  const pendingAndLive = and(
    eq(partnerConnectRequests.id, r.id),
    eq(partnerConnectRequests.shopDomain, auth.shop),
    eq(partnerConnectRequests.status, "pending"),
    gt(partnerConnectRequests.expiresAt, dsql`now()`),
  );
  const lostRace = async () => {
    const again = await loadRequest(r.id, auth.shop);
    return again ? notPending(again) : notFound();
  };

  if (decision === "deny") {
    const done = await db
      .update(partnerConnectRequests)
      .set({ status: "denied", decidedAt: dsql`now()` })
      .where(pendingAndLive)
      .returning({ id: partnerConnectRequests.id });
    if (!done.length) return lostRace();
    return json({ redirectUrl: redirectTo(r.redirectUri, { error: "access_denied", state: r.state, shop: auth.shop }) });
  }

  // authenticateEmbedded already verified this header's token.
  const sessionToken = req.headers.get("authorization")!.slice("Bearer ".length);
  const staff = await staffCheck(sessionToken, auth.shop, r.scopes);
  if ("error" in staff) {
    if (staff.error === "shopify_unavailable") return json({ error: "shopify_unavailable" }, 502);
    return json(staff.missing ? { error: staff.error, missing: staff.missing } : { error: staff.error }, 403);
  }

  const { code, hash } = newCode();
  const done = await db
    .update(partnerConnectRequests)
    .set({
      status: "approved",
      codeHash: hash,
      decidedAt: dsql`now()`,
      codeExpiresAt: dsql`now() + make_interval(secs => ${CODE_TTL_MS / 1000})`,
      approvedByUserId: staff.userId,
    })
    .where(pendingAndLive)
    .returning({ id: partnerConnectRequests.id });
  if (!done.length) return lostRace();
  return json({ redirectUrl: redirectTo(r.redirectUri, { code, state: r.state, shop: auth.shop }) });
}
