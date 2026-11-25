import { partnerGuard, partnerJson } from "@/lib/partner/auth";
import { ENDPOINT_SCOPE } from "@/lib/partner/scopes";
import { parseCursor } from "@/lib/partner/params";
import { fetchProducts, pageResponse, shopifyErrorResponse } from "@/lib/partner/queries";

// GET /api/partner/products (D70): the Social Media Agent's catalogue, live from Shopify. Server to server, so no CORS.
// Dynamic because it reads req.headers and req.url; no `runtime` export under cacheComponents.

export async function GET(req: Request) {
  const store = await partnerGuard(req, ENDPOINT_SCOPE.products);
  if (store instanceof Response) return store;
  const cursor = parseCursor(new URL(req.url).searchParams);
  if (cursor !== null && typeof cursor === "object") return partnerJson({ error: cursor.error }, 400);
  try {
    const page = await fetchProducts(store, cursor);
    return pageResponse(page);
  } catch (e) {
    return shopifyErrorResponse(e);
  }
}
