import { after } from "next/server";
import { authenticateEmbedded, ensureShopName } from "@/lib/shopify/session";
import { syncWidgetConfig } from "@/lib/widget-config";

export async function GET(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    const name = await ensureShopName(storeId, shop);
    // After the name is known (the default header title), and after the response: the metafield write must not hold up
    // the app load. syncWidgetConfig never throws and logs its own errors; an unchanged config costs one select.
    after(() => syncWidgetConfig(storeId, shop));
    return Response.json({ shop, name });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
