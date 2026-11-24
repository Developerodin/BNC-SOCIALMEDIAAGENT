import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import { db } from "@/db/client";
import { partnerClients, partnerConnectRequests, stores } from "@/db/schema";
import { parseScopeParam } from "./scopes";
import { REQUEST_TTL_MS, isValidChallenge, isValidState, redirectUriMatches } from "./secrets";

// Task P4: GET /partner/connect, the portal's entry point (plan "Full HTTP contract").
// Order matters for "no open redirect": nothing redirects until the client is known and redirect_uri is an exact
// allow-list match. Before that, every failure is the same static AskCart page.

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The myshopify subdomain, which is the store handle in admin.shopify.com URLs. */
const storeHandle = (shop: string) => shop.slice(0, -".myshopify.com".length);

/** P0-verified (Step 1): the admin URL takes the app's client_id, not a made-up handle. */
export function consentUrl(shop: string, requestId: string): string {
  const u = new URL(
    `https://admin.shopify.com/store/${storeHandle(shop)}/apps/${process.env.SHOPIFY_API_KEY}/app/partner-consent`,
  );
  u.searchParams.set("request", requestId);
  return u.href;
}

/**
 * The managed-install link for a store without AskCart. NOT yet verified on a dev store (P0 Step 2 runs in P10).
 * C34 (a): the request doesn't survive the install; the merchant clicks Connect in the portal again.
 */
export function installUrl(shop: string): string {
  const u = new URL(`https://admin.shopify.com/store/${storeHandle(shop)}/oauth/install`);
  u.searchParams.set("client_id", process.env.SHOPIFY_API_KEY!);
  return u.href;
}

const REDIRECT_HEADERS = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

// D49: draft wording until the user approves it. Static: no request input is ever reflected.
const ERROR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AskCart</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">This connect link is not valid</h1>
<p>AskCart couldn't recognise the app that sent you here. Go back to that app and start connecting again.</p>
</body></html>`;

/** The 400 page for a bad client or redirect_uri. The same page for both, so it reveals nothing about which failed. */
export function errorPage(): Response {
  return new Response(ERROR_HTML, {
    status: 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...REDIRECT_HEADERS } });
}

/** A param present exactly once; null when missing or repeated (RFC 6749 3.1: no parameter more than once). */
function one(q: URLSearchParams, name: string): string | null {
  const all = q.getAll(name);
  return all.length === 1 ? all[0] : null;
}

type ErrorDescription =
  | "invalid_shop"
  | "invalid_state"
  | "invalid_code_challenge"
  | "unsupported_code_challenge_method"
  | "invalid_scope";

function errorRedirect(redirectUri: string, description: ErrorDescription, state: string | null): Response {
  const u = new URL(redirectUri); // registered by the script as an absolute https URL
  u.searchParams.set("error", description === "invalid_scope" ? "invalid_scope" : "invalid_request");
  u.searchParams.set("error_description", description);
  if (state !== null) u.searchParams.set("state", state); // encoded once; the portal decodes it back unchanged
  return redirect(u.href);
}

export async function startConnect(url: URL): Promise<Response> {
  const q = url.searchParams;

  // 1. Client and exact redirect_uri, or the static page. Never redirect before this passes.
  const clientId = one(q, "client_id");
  const redirectUri = one(q, "redirect_uri");
  if (!clientId || redirectUri === null) return errorPage();
  const [client] = await db
    .select({ redirectUris: partnerClients.redirectUris, allowedScopes: partnerClients.allowedScopes })
    .from(partnerClients)
    .where(and(eq(partnerClients.clientId, clientId), isNull(partnerClients.disabledAt)))
    .limit(1);
  if (!client) return errorPage();
  if (!redirectUriMatches(redirectUri, client.redirectUris)) return errorPage();

  // 2. Everything else goes back to the portal as an OAuth error, with state only when it is itself valid.
  const rawState = one(q, "state");
  const state = rawState !== null && isValidState(rawState) ? rawState : null;
  if (state === null) return errorRedirect(redirectUri, "invalid_state", null);
  const shop = one(q, "shop")?.toLowerCase() ?? "";
  if (!SHOP_RE.test(shop)) return errorRedirect(redirectUri, "invalid_shop", state);
  const challenge = one(q, "code_challenge");
  if (challenge === null || !isValidChallenge(challenge)) return errorRedirect(redirectUri, "invalid_code_challenge", state);
  if (one(q, "code_challenge_method") !== "S256")
    return errorRedirect(redirectUri, "unsupported_code_challenge_method", state);
  const scopeParam = q.getAll("scope");
  if (scopeParam.length > 1) return errorRedirect(redirectUri, "invalid_scope", state);
  const scopes = parseScopeParam(scopeParam[0] ?? null, client.allowedScopes);
  if ("error" in scopes) return errorRedirect(redirectUri, "invalid_scope", state);

  // 3. Save the request (DB clock for expiry), clearing rows expired over a day ago, then pick the destination.
  const requestId = await db.transaction(async (tx) => {
    await tx
      .delete(partnerConnectRequests)
      .where(dsql`${partnerConnectRequests.expiresAt} < now() - interval '1 day'`);
    const [row] = await tx
      .insert(partnerConnectRequests)
      .values({
        clientId,
        shopDomain: shop,
        redirectUri,
        state,
        codeChallenge: challenge,
        scopes,
        status: "pending",
        expiresAt: dsql`now() + ${REQUEST_TTL_MS} * interval '1 millisecond'`,
      })
      .returning({ id: partnerConnectRequests.id });
    return row.id;
  });

  const [store] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.shopDomain, shop), eq(stores.active, true)))
    .limit(1);
  return redirect(store ? consentUrl(shop, requestId) : installUrl(shop));
}
