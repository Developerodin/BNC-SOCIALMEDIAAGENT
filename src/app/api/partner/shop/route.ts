import { partnerGuard, partnerJson } from "@/lib/partner/auth";
import { ENDPOINT_SCOPE } from "@/lib/partner/scopes";
import { fetchShop, shopifyErrorResponse } from "@/lib/partner/queries";

// GET /api/partner/shop (D70): the store's name and currency. Server to server, so no CORS.
// Dynamic because it reads req.headers; no `runtime` export under cacheComponents.

export async function GET(req: Request) {
  const store = await partnerGuard(req, ENDPOINT_SCOPE.shop);
  if (store instanceof Response) return store;
  try {
    return partnerJson(await fetchShop(store));
  } catch (e) {
    return shopifyErrorResponse(e);
  }
}
