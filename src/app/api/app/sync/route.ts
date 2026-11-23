import { and, count, eq } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { products, stores } from "@/db/schema";
import { authenticateEmbedded } from "@/lib/shopify/session";
import { enqueueSync } from "@/lib/sync";

export async function GET(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    const [s] = await db
      .select({ status: stores.syncStatus, lastSyncAt: stores.lastSyncAt, itemsRead: stores.syncObjectCount })
      .from(stores)
      .where(eq(stores.id, storeId));
    const [{ n }] = await forStore(storeId, (tx) =>
      tx.select({ n: count() }).from(products).where(and(eq(products.status, "ACTIVE"), eq(products.published, true))),
    );
    return Response.json({ ...s, productCount: n });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    await enqueueSync(storeId);
    return new Response(null, { status: 202 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
