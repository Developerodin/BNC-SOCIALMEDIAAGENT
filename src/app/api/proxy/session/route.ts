import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { customerGid, mintSession } from "@/lib/chat/customer";
import { rateLimit } from "@/lib/partner/rate-limit";
import { verifyProxy } from "@/lib/shopify/app-proxy";

// GET /apps/askcart/session on the storefront → here (shopify.app.askcart.toml [app_proxy]). Shopify signs the request and
// adds logged_in_customer_id, so a valid signature is the proof of who the customer is; nothing from the shopper is trusted.
// Signed-out shoppers get 401 and keep chatting as guests. No CORS check: the browser calls the store's own domain.
// Not cached: it is customer-specific (and a GET that reads req.url isn't prerendered, as in api/chat/history).

const SHOP = /^[a-z0-9-]+\.myshopify\.com$/;
// Per minute. The per-customer cap (keyed on the signature-verified id) stops one reloading shopper from using up the store's
// allowance; the store cap is only a backstop. In-memory like cors.ts (N instances = N x).
const PROXY_CUSTOMER_LIMIT = 10;
const PROXY_STORE_LIMIT = 600;

export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  const params = new URL(req.url).searchParams;
  const shop = params.get("shop");
  if (!shop || !SHOP.test(shop) || !(await verifyProxy(params))) return new Response(null, { status: 403, headers });

  const gid = customerGid(params.get("logged_in_customer_id") ?? "");
  if (!gid) return Response.json({ error: "not_logged_in" }, { status: 401, headers });

  const wait =
    rateLimit(`proxy:${shop}:${gid}`, Date.now(), PROXY_CUSTOMER_LIMIT) || rateLimit(`proxy:${shop}`, Date.now(), PROXY_STORE_LIMIT);
  if (wait) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...headers, "Retry-After": String(wait) } });

  const [store] = await db.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!store?.active) return Response.json({ error: "unknown_shop" }, { status: 404, headers });
  const { token, expiresAt } = mintSession(store.id, gid);
  return Response.json({ sessionToken: token, expiresAt }, { headers });
}
