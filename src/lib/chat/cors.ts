import { sql } from "drizzle-orm";
import { db } from "@/db/client";

// CORS for the storefront chat (Review Focus 3). An Origin is allowed only when it is exactly
// https://<host> for a host in the store's domains (stores.domains, lowercased by refreshShopInfo).
// No Origin, or any other Origin, is refused before any OpenAI or Shopify call.

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
 * The preflight carries no body, so the shop isn't known yet: the Origin is allowed when any active store lists its host.
 * POST then checks it against the named store. `// ponytail:` a scan over stores.domains per preflight; add a GIN index
 * on domains if the store count makes it slow.
 */
export async function preflight(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = hostOf(origin);
  if (!host) return new Response(null, { status: 403 });
  const rows = await db.execute(sql`select 1 from stores where active and ${host} = any(domains) limit 1`);
  if (rows.length === 0) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin!,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    },
  });
}
