import { and, asc, cosineDistance, eq, notInArray, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { chunks, products } from "@/db/schema";
import { embed } from "@/lib/embeddings";

export type SearchHit = { chunkId: string; source: "product"; productId: string; content: string; score: number };

const PER_PRODUCT = 2;
// How many nearest chunks are read, as a multiple of k, before the per-product cap is applied.
const OVERFETCH = 4;

/**
 * The only retrieval entry point (§7.5): the k chunks of this store nearest to the query, score = 1 - cosine distance,
 * with at most PER_PRODUCT chunks from any one product so one long product can't fill every slot.
 * With opts.productId (a GID or a numeric id), up to 2 of that product's nearest chunks not already among the hits
 * are appended after the top k, so a product page always has its own product in context.
 * Gift cards are left out unless opts.includeGiftCards is set (D74); in M4 the chat model sets it when the shopper asks for one.
 * The query must already be masked (D41); this sends it to OpenAI as is.
 */
export async function search(
  storeId: string,
  query: string,
  k = 8,
  opts: { productId?: string; includeGiftCards?: boolean } = {},
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const {
    vectors: [q],
  } = await embed([query]);
  const productId = opts.productId && /^\d+$/.test(opts.productId) ? `gid://shopify/Product/${opts.productId}` : opts.productId;

  const distance = cosineDistance(chunks.embedding, q);
  const cols = {
    chunkId: chunks.id,
    source: sql<"product">`${chunks.source}`,
    productId: sql<string>`${chunks.productId}`,
    content: chunks.content,
    score: sql<number>`1 - (${distance})`,
  };
  return forStore(storeId, async (tx) => {
    // D42: filter on store_id as well as RLS.
    // ponytail: exact scan, fine below 20k chunks per store. Above that, add an HNSW index and
    // set hnsw.iterative_scan = relaxed_order so the store filter still returns k rows (§7.5, C9).
    // ponytail: the cap filters the k*OVERFETCH nearest chunks, so when those come from fewer than k/PER_PRODUCT
    // products the result has fewer than k hits. Upgrade path: a row_number() over (partition by product_id) window,
    // at the cost of the exact scan (an HNSW index can't serve it).
    const giftCards = tx
      .select({ id: products.shopifyId })
      .from(products)
      .where(and(eq(products.storeId, storeId), eq(products.isGiftCard, true)));
    const near = await tx
      .select(cols)
      .from(chunks)
      .where(and(eq(chunks.storeId, storeId), opts.includeGiftCards ? undefined : notInArray(chunks.productId, giftCards)))
      .orderBy(asc(distance))
      .limit(k * OVERFETCH);
    const perProduct = new Map<string, number>();
    const hits = near
      .filter((h) => {
        const n = perProduct.get(h.productId) ?? 0;
        perProduct.set(h.productId, n + 1);
        return n < PER_PRODUCT;
      })
      .slice(0, k);
    if (!productId) return hits;
    const extra = await tx
      .select(cols)
      .from(chunks)
      .where(
        and(
          eq(chunks.storeId, storeId),
          eq(chunks.productId, productId),
          hits.length ? notInArray(chunks.id, hits.map((h) => h.chunkId)) : undefined,
        ),
      )
      .orderBy(asc(distance))
      .limit(2);
    return [...hits, ...extra];
  });
}
