import { authenticateEmbedded, ensureShopName } from "@/lib/shopify/session";
import { syncWidgetConfig } from "@/lib/widget-config";

export async function GET(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    const name = await ensureShopName(storeId, shop);
    // After the name is known (the default header title). Never throws; an unchanged config costs one select.
    await syncWidgetConfig(storeId, shop);
    return Response.json({ shop, name });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
