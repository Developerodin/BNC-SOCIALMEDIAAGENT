import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { customerGid, mintSession } from "@/lib/chat/customer";
import { verifyProxy } from "@/lib/shopify/app-proxy";

// GET /apps/askcart/session on the storefront → here (shopify.app.askcart.toml [app_proxy]). Shopify signs the request and
// adds logged_in_customer_id, so a valid signature is the proof of who the customer is; nothing from the shopper is trusted.
// Signed-out shoppers get 401 and keep chatting as guests. No CORS check: the browser calls the store's own domain.
// Not cached: it is customer-specific (and a GET that reads req.url isn't prerendered, as in api/chat/history).

const SHOP = /^[a-z0-9-]+\.myshopify\.com$/;

export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  const params = new URL(req.url).searchParams;
  const secret = process.env.SHOPIFY_API_SECRET;
  const shop = params.get("shop");
  if (!secret || !shop || !SHOP.test(shop) || !verifyProxy(params, secret)) return new Response(null, { status: 403, headers });

  const gid = customerGid(params.get("logged_in_customer_id") ?? "");
  if (!gid) return Response.json({ error: "not_logged_in" }, { status: 401, headers });

  const [store] = await db.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!store?.active) return Response.json({ error: "unknown_shop" }, { status: 404, headers });
  const { token, expiresAt } = mintSession(store.id, gid);
  return Response.json({ sessionToken: token, expiresAt }, { headers });
}
