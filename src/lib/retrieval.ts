import { and, asc, cosineDistance, eq, notInArray, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { chunks } from "@/db/schema";
import { embed } from "@/lib/embeddings";

export type SearchHit = { chunkId: string; source: "product"; productId: string; content: string; score: number };

/**
 * The only retrieval entry point (§7.5): the k chunks of this store nearest to the query, score = 1 - cosine distance.
 * With opts.productId (a GID or a numeric id), up to 2 of that product's nearest chunks not already among the hits
 * are appended after the top k, so a product page always has its own product in context.
 * The query must already be masked (D41); this sends it to OpenAI as is.
 */
export async function search(
  storeId: string,
  query: string,
  k = 8,
  opts: { productId?: string } = {},
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
    const hits = await tx.select(cols).from(chunks).where(eq(chunks.storeId, storeId)).orderBy(asc(distance)).limit(k);
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
