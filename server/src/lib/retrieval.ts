import { and, asc, cosineDistance, eq, notInArray, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { chunks, products } from "@/db/schema";
import { deadline } from "@/lib/chat/openai";
import { embed } from "@/lib/embeddings";
import { productGid } from "@/lib/ids";

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
const EMBED_TIMEOUT_MS = 3000;

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
  opts: { productId?: string; includeGiftCards?: boolean; minScore?: number; signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  // The embeddings client has no retries and an SDK default timeout of 10 minutes, so a hung call would hold the turn;
  // 3s, or the caller's abort. A failure or timeout throws, like any other embed error, and the caller handles it.
  const d = deadline(EMBED_TIMEOUT_MS, opts.signal);
  const {
    vectors: [q],
  } = await embed([query], { signal: d.signal }).finally(d.clear);
  const productId = productGid(opts.productId);

  // The distance is selected once and both queries order by its alias. Drizzle binds the vector again for every use, so
  // a score in the select list plus the distance in ORDER BY sent the 512 floats twice and Postgres computed every chunk's
  // distance twice. Measured at 20k chunks: 39 ms -> 29 ms in Postgres, and 78 ms -> 30 ms wall on local Docker, where the
  // second ~6 KB parameter alone cost ~45 ms per query in TCP stalls. Ordering by the bare distance, not by a score,
  // keeps an HNSW index usable later.
  const cols = {
    chunkId: chunks.id,
    source: sql<"product">`${chunks.source}`,
    productId: sql<string>`${chunks.productId}`,
    content: chunks.content,
    distance: sql<number>`${cosineDistance(chunks.embedding, q)}`.as("distance"),
  };
  const toHit = ({ distance, ...h }: Omit<SearchHit, "score"> & { distance: number }): SearchHit => ({ ...h, score: 1 - distance });
  return forStore(storeId, async (tx) => {
    // D42: filter on store_id as well as RLS.
    // ponytail: exact scan (no vector index). Measured with 512-dim halfvecs in shared buffers: about 30 ms in Postgres
    // for a 20k-chunk store, linear in its chunk count. When one store is most of the table the plan is a seq scan of
    // every store's chunks, so the total table size counts too. Upgrade path past ~50k chunks per store: an HNSW index
    // with hnsw.iterative_scan = relaxed_order so the store filter still returns k rows (§7.5, C9); check the recall of
    // small stores, whose rows are a sliver of one shared index.
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
      .orderBy((f) => asc(f.distance))
      .limit(k * OVERFETCH)
      .then((rows) => rows.map(toHit));
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
      .orderBy((f) => asc(f.distance))
      .limit(2)
      .then((rows) => rows.map(toHit));
    return [...hits, ...extra];
  });
}
