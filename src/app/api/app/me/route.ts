import { authenticateEmbedded, ensureShopName } from "@/lib/shopify/session";

export async function GET(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    return Response.json({ shop, name: await ensureShopName(storeId, shop) });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
