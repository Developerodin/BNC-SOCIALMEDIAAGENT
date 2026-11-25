import { partnerGuard, partnerJson } from "@/lib/partner/auth";
import { ENDPOINT_SCOPE } from "@/lib/partner/scopes";
import { parseCursor, parseOrdersFilter } from "@/lib/partner/params";
import { fetchOrders, shopifyErrorResponse } from "@/lib/partner/queries";

// GET /api/partner/orders (D70): the Social Media Agent's Sales tab. Server to server, so no CORS. Dynamic because it reads
// req.headers and req.url (route-handlers.md, "With Cache Components"); no `runtime` export under cacheComponents.

export async function GET(req: Request) {
  const store = await partnerGuard(req, ENDPOINT_SCOPE.orders);
  if (store instanceof Response) return store;
  const q = new URL(req.url).searchParams;
  const filter = parseOrdersFilter(q);
  if ("error" in filter) return partnerJson({ error: filter.error }, 400);
  const cursor = parseCursor(q);
  if (cursor !== null && typeof cursor === "object") return partnerJson({ error: cursor.error }, 400);
  try {
    const page = await fetchOrders(store, filter, cursor);
    return partnerJson(page, 200, page.rateLimited ? { "Retry-After": "2" } : {});
  } catch (e) {
    return shopifyErrorResponse(e);
  }
}
