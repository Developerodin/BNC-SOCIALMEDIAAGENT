import { and, count, countDistinct, eq } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { chunks, products, stores } from "@/db/schema";
import { authenticateEmbedded } from "@/lib/shopify/session";
import { enqueueSync } from "@/lib/sync";

export async function GET(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    const [s] = await db
      .select({ status: stores.syncStatus, lastSyncAt: stores.lastSyncAt, itemsRead: stores.syncObjectCount, syncError: stores.syncError })
      .from(stores)
      .where(eq(stores.id, storeId));
    // productCount: searchable (ACTIVE and published); totalCount: every synced product; embeddedCount: products with chunks.
    const counts = await forStore(storeId, async (tx) => {
      const [{ productCount }] = await tx
        .select({ productCount: count() })
        .from(products)
        .where(and(eq(products.status, "ACTIVE"), eq(products.published, true)));
      const [{ totalCount }] = await tx.select({ totalCount: count() }).from(products);
      const [{ embeddedCount }] = await tx
        .select({ embeddedCount: countDistinct(chunks.productId) })
        .from(chunks)
        .where(eq(chunks.source, "product"));
      return { productCount, totalCount, embeddedCount };
    });
    return Response.json({ ...s, ...counts });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    // Refused only while a store-sync is already queued for this store (an active one doesn't block a queued one).
    if (!(await enqueueSync(storeId))) return Response.json({ reason: "already_queued" }, { status: 409 });
    return new Response(null, { status: 202 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
