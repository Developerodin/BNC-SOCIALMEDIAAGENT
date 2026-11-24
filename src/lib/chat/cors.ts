import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { MOBILE_KEY_HEADER } from "@/lib/chat/mobile-key";
import { rateLimit } from "@/lib/partner/rate-limit";
import { safeEqualHex, sha256Hex } from "@/lib/partner/secrets";
import { embedDomains } from "@/lib/embed-domains";
import { appOrigin } from "@/lib/widget-config";

// CORS for the storefront chat (Review Focus 3). An Origin is allowed only when it is exactly
// https://<host> for a host in the store's domains (stores.domains, lowercased by refreshShopInfo).
// No Origin, or any other Origin, is refused before any OpenAI or Shopify call. The one addition: our own https origin
// (the hosted chat page, /chat/<shop>, which the embed shows in an iframe) is allowed for a store whose merchant has
// allowed at least one embedding site (settings.embedDomains); embedding is off until then.

const SHOP = /^[a-z0-9-]+\.myshopify\.com$/;

function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  const o = origin.toLowerCase();
  return o.startsWith("https://") ? o.slice("https://".length) : null;
}

/** The CORS headers for an allowed Origin, or null when the request must get a 403. */
export function corsFor(req: Request, store: { domains: string[]; settings?: unknown }): Record<string, string> | null {
  const origin = req.headers.get("origin");
  const own = embedDomains(store.settings).length > 0 ? appOrigin() : null;
  if (own) {
    if (origin?.toLowerCase() === own) return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    // A same-origin GET carries no Origin header. Sec-Fetch-Site is set by the browser and page scripts can't forge it;
    // a non-browser client could, but it can equally send any Origin, so this opens nothing new.
    if (!origin && req.headers.get("sec-fetch-site") === "same-origin" && req.headers.has("sec-fetch-mode")) return {};
  }
  const host = hostOf(origin);
  if (!host || !store.domains.includes(host)) return null;
  return { "Access-Control-Allow-Origin": origin!, Vary: "Origin" };
}

/** Mobile app key path: requests per minute from one client IP, and for the whole store across all its app users. */
export const MOBILE_IP_LIMIT = 30;
export const MOBILE_STORE_LIMIT = 600;

/**
 * The caller's IP for the per-IP limit: the first X-Forwarded-For hop. `// ponytail:` only as trustworthy as the proxy
 * in front of us, which must overwrite the header (Vercel, Fly and most load balancers do); behind one that appends,
 * a client can rotate fake IPs and only the per-store limit holds. All callers without the header share one bucket.
 */
function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/**
 * The store's mobile app (docs/mobile-api.md): no Origin, and the store's key in X-AskCart-App-Key. A wrong, revoked
 * or missing key is a 403 like a wrong Origin; over a limit is a 429 with Retry-After. No CORS headers: a browser
 * always sends an Origin, so it can never take this path.
 */
function appKeyCheck(req: Request, key: string, store: { id: string; mobileKeyHash: string | null }): Response | null {
  if (!store.mobileKeyHash || !safeEqualHex(sha256Hex(key), store.mobileKeyHash)) return new Response(null, { status: 403 });
  // ponytail: in-memory counters (see rate-limit.ts), so N instances allow N × the limits; move with the M10 deployment.
  const wait =
    rateLimit(`mobile:ip:${store.id}:${clientIp(req)}`, Date.now(), MOBILE_IP_LIMIT) ||
    rateLimit(`mobile:store:${store.id}`, Date.now(), MOBILE_STORE_LIMIT);
  return wait ? Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } }) : null;
}

/**
 * Steps 1 and 2 of every storefront chat route (Task 19): validate `shop` and load the active store (else 404), then
 * check the Origin against its domains (else 403). A request with no Origin may instead carry the store's mobile app
 * key (appKeyCheck). Returns the error Response, or the store and its CORS headers (none for the app).
 */
export async function storeFor(req: Request, shop: unknown) {
  if (typeof shop !== "string" || !SHOP.test(shop)) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const [store] = await db
    .select({
      id: stores.id,
      shopDomain: stores.shopDomain,
      active: stores.active,
      domains: stores.domains,
      name: stores.name,
      primaryLocale: stores.primaryLocale,
      currencyCode: stores.currencyCode,
      settings: stores.settings,
      mobileKeyHash: stores.mobileKeyHash,
    })
    .from(stores)
    .where(eq(stores.shopDomain, shop));
  if (!store?.active) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const { mobileKeyHash, ...rest } = store; // the hash stays here, out of the routes and their logs
  const appKey = req.headers.get(MOBILE_KEY_HEADER);
  if (!req.headers.get("origin") && appKey) {
    const refused = appKeyCheck(req, appKey, { id: store.id, mobileKeyHash });
    return refused ?? { store: rest, cors: {} as Record<string, string> };
  }
  const cors = corsFor(req, store);
  if (!cors) return new Response(null, { status: 403 });
  return { store: rest, cors };
}

/**
 * The preflight carries no body, so the shop isn't known yet: the Origin is allowed when any active store lists its host.
 * The route then checks it against the named store. `// ponytail:` a scan over stores.domains per preflight; add a GIN index
 * on domains if the store count makes it slow. `allow` defaults to the POST /api/chat preflight.
 */
export async function preflight(
  req: Request,
  allow: { methods: string; headers: string } = { methods: "POST, OPTIONS", headers: "Content-Type" },
): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = hostOf(origin);
  if (!host) return new Response(null, { status: 403 });
  // Our hosted chat page needs no store lookup here: the route checks the shop.
  if (origin!.toLowerCase() !== appOrigin()) {
    const rows = await db.execute(sql`select 1 from stores where active and ${host} = any(domains) limit 1`);
    if (rows.length === 0) return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Methods": allow.methods,
      "Access-Control-Allow-Headers": allow.headers,
      Vary: "Origin",
    },
  });
}
