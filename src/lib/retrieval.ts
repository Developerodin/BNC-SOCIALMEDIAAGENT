import { and, asc, cosineDistance, eq, notInArray, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { chunks, products } from "@/db/schema";
import { embed } from "@/lib/embeddings";

export type SearchHit = { chunkId: string; source: "product"; productId: string; content: string; score: number };

const PER_PRODUCT = 2;
// How many nearest chunks are read, as a multiple of k, before the per-product cap is applied.
const OVERFETCH = 4;
// D86: hits scoring below this are dropped, so a query the store has nothing for can return [].
// ponytail: tuned by hand on the 21 dev-store queries in scripts/mcp-compare (scores.mts prints the raw scores), for
// OpenAI text-embedding-3-small and our chunk format only; another embedding model or chunk layout needs a re-tune.
// One value for every store and language, and it only just separates: the lowest real match is the Hindi
// "I want a snowboard" at 0.192 (non-English queries score low against an English catalogue), the blender is 0.173.
// Off-topic queries that land higher still get hits: nonsense 0.274, "running shoes" 0.256, "car insurance" 0.219.
// So this drops the clearly unrelated, not everything unrelated; the chat prompt must still judge relevance.
// Upgrade path: a reranker or an LLM relevance check on the top hits, or per-language thresholds.
export const MIN_SCORE = 0.18;

/**
 * The only retrieval entry point (§7.5): the k chunks of this store nearest to the query, score = 1 - cosine distance,
 * with at most PER_PRODUCT chunks from any one product so one long product can't fill every slot.
 * With opts.productId (a GID or a numeric id), up to 2 of that product's nearest chunks not already among the hits
 * are appended after the top k, so a product page always has its own product in context.
 * Hits scoring below MIN_SCORE (or opts.minScore) are dropped (D86), so the result can be []; the current product's
 * chunks are kept whatever their score, because the shopper is looking at it.
 * Gift cards are left out unless opts.includeGiftCards is set (D74); in M4 the chat model sets it when the shopper asks for one.
 * The query must already be masked (D41); this sends it to OpenAI as is.
 */
export async function search(
  storeId: string,
  query: string,
  k = 8,
  opts: { productId?: string; includeGiftCards?: boolean; minScore?: number } = {},
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
    const minScore = opts.minScore ?? MIN_SCORE;
    const perProduct = new Map<string, number>();
    const hits = near
      .filter((h) => h.score >= minScore)
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
