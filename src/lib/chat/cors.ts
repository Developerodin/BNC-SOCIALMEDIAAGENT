import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";

// CORS for the storefront chat (Review Focus 3). An Origin is allowed only when it is exactly
// https://<host> for a host in the store's domains (stores.domains, lowercased by refreshShopInfo).
// No Origin, or any other Origin, is refused before any OpenAI or Shopify call.

const SHOP = /^[a-z0-9-]+\.myshopify\.com$/;

function hostOf(origin: string | null): string | null {
  if (!origin) return null;
  const o = origin.toLowerCase();
  return o.startsWith("https://") ? o.slice("https://".length) : null;
}

/** The CORS headers for an allowed Origin, or null when the request must get a 403. */
export function corsFor(req: Request, store: { domains: string[] }): Record<string, string> | null {
  const origin = req.headers.get("origin");
  const host = hostOf(origin);
  if (!host || !store.domains.includes(host)) return null;
  return { "Access-Control-Allow-Origin": origin!, Vary: "Origin" };
}

/**
 * Steps 1 and 2 of every storefront chat route (Task 19): validate `shop` and load the active store (else 404), then
 * check the Origin against its domains (else 403). Returns the error Response, or the store and its CORS headers.
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
    })
    .from(stores)
    .where(eq(stores.shopDomain, shop));
  if (!store?.active) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const cors = corsFor(req, store);
  if (!cors) return new Response(null, { status: 403 });
  return { store, cors };
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
  const rows = await db.execute(sql`select 1 from stores where active and ${host} = any(domains) limit 1`);
  if (rows.length === 0) return new Response(null, { status: 403 });
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
