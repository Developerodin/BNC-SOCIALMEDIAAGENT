# M3: Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each store's synced products into embedded chunks, and give the chat (M4) one function, `search(storeId, query, k)`, that returns the most relevant chunks from that store only.

**Architecture:**
- An `embed-products` pg-boss job per store compares each indexable product's `content_hash` with the hash its chunks were built from.
- When the hashes differ, it re-chunks and re-embeds that product, then swaps the product's chunks in one transaction, so the old chunks keep serving until the new ones are ready.
- Products that are no longer indexable lose their chunks.
- `search` embeds the query and runs an exact cosine search on `halfvec(512)` inside `forStore`.

**Tech Stack:** what M2 uses, plus the `openai` npm package (`text-embedding-3-small`) and pgvector (already in the `pgvector/pgvector:pg17` image).

**Spec:** `product.md` §7.5, §7.13 (`Chunk`), §8, and D26, D33, D25. This plan continues `docs/superpowers/plans/2026-11-23-m2-product-sync.md` (Tasks 6–9). Both earlier plans' Global Constraints still apply.

## Plan choices to confirm (not in the spec)

- **C7 Products are chunked like PDFs:** about 800 tokens per chunk with overlap, counted as about 4 characters per token. That gives windows of 3,200 characters, a 400-character overlap, and cuts on whitespace. Most products fit in one chunk. Every chunk after the first starts with `Title: <title>` so it still says which product it is.
- **C8 Only `ACTIVE` and published products get chunks** (from C1). Archiving, drafting or unpublishing a product removes its chunks at the next embed run.
- **C9 HNSW waits.** Phase 1 uses exact search only. Above 20k chunks per store, §7.5 calls for HNSW plus iterative scan. A `ponytail:` comment marks where it goes, because no beta store is expected to be that big.
- **C10 Spend tracking for embeddings waits for M10**, when the daily spend cap (D40) is built. `embed()` returns the token usage, so M10 only has to record it.

## Global Constraints (M3 additions)

- Embeddings use `text-embedding-3-small` with `dimensions: 512`, stored as `halfvec(512)` (D26, D33). The model name and size are constants in one file, so the D33 move to 1536 changes one place plus the column.
- `search` defaults to `k = 8` (D33).
- `search` is the **only** retrieval entry point, and it lives in `src/lib/retrieval.ts` (§7.5).
- On a product page, that product's chunks are always included (§7.5).
- Price and stock are never embedded (D25).
- If an embedding call fails, pg-boss retries with backoff and the old chunks stay in place (§8).
- `chunks` is store-owned: ENABLE + FORCE RLS with the `store_isolation` policy, `ON DELETE CASCADE` from `stores`, and from `products`.
- `OPENAI_API_KEY` comes from env and goes in `.env.example`. Nothing calls OpenAI in the default test run.

## Review Focus

1. **Store B's chunks must never appear in store A's search**, even when B's product is a closer match. Test in Task 12.
2. **A product that gets archived or unpublished** must disappear from search after the next embed run. Test in Task 11.
3. **An embedding call that fails halfway through a store** leaves every product's old chunks searchable, and the retry finishes the job. Test in Task 11.
4. **A re-sync where nothing changed** makes no OpenAI calls. Test in Task 11.
5. **An empty or whitespace query, or a store with no chunks,** returns `[]`, and an empty query makes no OpenAI call. Test in Task 12.
6. **A `productId` that the store doesn't have**, or that has no chunks, still returns the normal top-k without error. Test in Task 12.

## 4-lens review fixes (2026-11-23). These override the task text below where they differ.

1. **Commit progress per batch.** `embedStore` handles about 100 products per batch: `chunkText`, then `embed`, then that batch's own top-level `forStore` swap. A retry skips the batches already done, because their hashes match. The job's `signal` is passed to OpenAI and checked between batches.
2. **No OpenAI call inside a DB transaction.** Selecting the stale products is one `forStore`, embedding runs outside any transaction, and each swap is its own `forStore`.
3. **The OpenAI client is created lazily inside `embed()`.** `EMBEDDING_MODEL`, `EMBEDDING_DIMS` and `CHUNKER_VERSION` live in `src/lib/embedding-config.ts`, which imports nothing, and `schema.ts` uses `EMBEDDING_DIMS`. `enqueueEmbed` lives in `jobs.ts`, so `sync.ts` never imports the SDK.
4. **The chunker hard-cuts at 3,200 characters when a window has no whitespace** (CJK, long URLs). Test: 8,000 characters with no spaces.
5. **`embed` batches by an estimated token budget**: at most 100 inputs and about 200k estimated tokens per request, counting CJK characters as 1 token each. A 400 error for one product's input logs that product and skips it, and the rest continue.
6. **The swap inserts only for products that still exist.** It locks the product rows (`FOR UPDATE`) and skips missing ones. Test: delete the product between `embed` and the swap.
7. **`chunks` gets `ordinal int` with `UNIQUE (store_id, product_id, ordinal)`**, so two overlapping runs can't duplicate chunks.
8. **`resyncScan` also calls `enqueueEmbed` for every active store every hour.** When nothing has changed this costs no OpenAI calls. It recovers lost or exhausted runs and stores synced before M3.
9. **`opts.productId` is a GID.** `search` turns a numeric id into `gid://shopify/Product/<n>`, with a test. At most the 2 nearest included chunks are added, with their real `score`.
10. **`sourceHash = sha256(EMBEDDING_MODEL | EMBEDDING_DIMS | CHUNKER_VERSION | contentHash)`**, so changing the model or the chunker re-embeds. The D33 comment notes that the 1536 migration must `DELETE FROM chunks`.
11. **`search` also filters on `eq(chunks.storeId, storeId)`**, as well as relying on RLS (D42).
12. **`search`'s docstring says the query must already be masked (D41).** M4 masks before calling it.
13. **The live test counts only if the output shows "1 passed".** `vitest.config.ts` passes `OPENAI_API_KEY` from `loadEnv`.
14. **`CHECK (source <> 'product' OR product_id IS NOT NULL)`** is added in 0005.
15. **`embedStore` returns and logs `tokens`** for M10 (C10).

---

### Task 10: Chunks table, chunker, and embedding client

**Files:**
- Modify: `src/db/schema.ts` (add `chunks`), `.env.example` (`OPENAI_API_KEY=`), `package.json` (`npm i openai`)
- Create: `drizzle/0004_*.sql` (generated; prepend `CREATE EXTENSION IF NOT EXISTS vector;` if drizzle doesn't), `drizzle/0005_chunks_rls.sql` (hand-written, in the style of `0003_products_rls.sql`)
- Create: `src/lib/chunking.ts`, `src/lib/embeddings.ts`
- Test: `tests/chunking.test.ts`, `tests/embeddings.test.ts`

**Interfaces:**
- Produces:
  - **`chunks` table:**
    - `id uuid pk default random`, `storeId uuid not null fk → stores ON DELETE CASCADE`
    - `source text not null` (`'product'` for now; M6 and M7 add `'doc'` and `'faq'`, with their own id columns then)
    - `productId text null`, a composite fk `(storeId, productId) → products(storeId, shopifyId) ON DELETE CASCADE`
    - `content text not null`
    - `sourceHash text not null` (the product's `contentHash` when it was embedded)
    - `embedding halfvec(512) not null`
    - `createdAt`
    - index on `(storeId, productId)`
  - `EMBEDDING_MODEL = "text-embedding-3-small"` and `EMBEDDING_DIMS = 512`, exported from `src/lib/embeddings.ts`.
  - `chunkText(title: string, content: string): string[]` implements C7 and returns at least one chunk for non-empty content.
  - `embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>`:
    - batches of 100 inputs per `openai.embeddings.create({ model, input, dimensions })` call,
    - vectors in input order,
    - `tokens` summed from `usage.total_tokens`,
    - `[]` in gives no call.
  - Use the SDK's default retries off (`maxRetries: 0`), so pg-boss owns retrying.

- [ ] **Step 1:** Write the tests:
  - `chunkText` on 500 characters gives 1 chunk equal to the content,
  - `chunkText` on 8,000 characters gives chunks of ≤ 3,200 characters each, where consecutive chunks share about 400 characters, and every chunk after the first starts with `Title: `,
  - no chunk cuts a word in half (each boundary falls on whitespace),
  - with `vi.mock("openai")`, `embed` of 250 texts makes 3 calls of 100, 100 and 50, passes `dimensions: 512` and the model constant, returns 250 vectors in order, and sums `tokens`,
  - `embed([])` makes no call,
  - the RLS coverage test in `tests/db/tenant-isolation.test.ts` passes with `chunks` added.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Use drizzle's `halfvec` from `drizzle-orm/pg-core`, and check that `drizzle-kit generate` emits `halfvec(512)`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add chunks table with halfvec embeddings, a chunker and the embedding client".

### Task 11: The embed job

**Files:**
- Create: `src/lib/indexing.ts`
- Modify: `src/lib/jobs.ts` (the `embed-products` queue and worker), `src/lib/sync.ts` (enqueue after a completed full sync and after `syncProduct`)
- Test: `tests/indexing.test.ts`

**Interfaces:**
- Consumes: `chunkText`, `embed`, `chunks`, `products`, `forStore`, and `enqueue`. The queue setup follows the M2 pattern in `jobs.ts`, with `createQueue` then `updateQueue` and the same retry options as `store-sync`.
- Produces:
  - `enqueueEmbed(storeId: string): Promise<void>` sends `embed-products` with `{ storeId }` and `singletonKey: storeId`, on a queue with policy `stately`. A burst of webhooks collapses into at most one queued run plus one active run per store.
  - `embedStore({ storeId }): Promise<{ embedded: number; removed: number }>`, the `embed-products` handler. It returns early for an inactive store. Otherwise, inside `forStore`:
    1. **Removes** chunks whose product is no longer `status = 'ACTIVE' and published` (C8). Deleted products are already gone through the cascade.
    2. **Finds** indexable products with no chunks, or with chunks whose `sourceHash <> products.content_hash`.
    3. For those products: `chunkText`, then one `embed` call over all their chunks (it batches internally). Only after `embed` succeeds, one transaction per batch of products deletes each product's old chunks and inserts the new ones (Review Focus 3).

    `// ponytail:` all changed products of a store are embedded in one job run. Page them (for example 500 products per run, then re-enqueue) if a first sync of a large catalog makes the job outlive `expireInSeconds`.
  - `pollSync` calls `enqueueEmbed(storeId)` after it marks the store `idle`. `syncProduct` calls it after its upsert or delete.

- [ ] **Step 1:** Write `tests/indexing.test.ts`, mocking `embed` with a deterministic fake that returns a 512-length vector derived from the text. Cases:
  - after `upsertProducts` of 2 active, published products, `embedStore` gives 2 products with chunks, and each chunk's `source_hash` equals its product's `content_hash`,
  - running `embedStore` again with nothing changed makes **0** `embed` calls (Review Focus 4),
  - changing one product's description and re-running re-embeds only that product,
  - upserting a product with `status: 'ARCHIVED'`, or with `onlineStoreUrl: null`, and re-running removes its chunks (Review Focus 2),
  - `deleteProduct` removes its chunks through the cascade,
  - with `embed` rejecting, `embedStore` throws and the product's previous chunks are still there and unchanged (Review Focus 3),
  - `embedStore` for an inactive store makes no `embed` call,
  - `syncProduct` (with `adminGraphql` mocked as in `tests/sync.test.ts`) leaves exactly one queued `embed-products` job for the store.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Embed changed products per store and drop chunks of products no longer for sale".

### Task 12: `search()`

**Files:**
- Create: `src/lib/retrieval.ts`
- Test: `tests/retrieval.test.ts`, `tests/live/retrieval.live.test.ts`

**Interfaces:**
- Consumes: `embed`, `chunks`, `forStore`
- Produces:
  - `type SearchHit = { chunkId: string; source: "product"; productId: string; content: string; score: number }`, where `score = 1 - cosine distance`.
  - `search(storeId: string, query: string, k = 8, opts?: { productId?: string }): Promise<SearchHit[]>`:
    - a trimmed empty query returns `[]` without calling `embed`,
    - it embeds the query, then inside `forStore` orders by `embedding <=> $q` and takes `k`, using drizzle's `cosineDistance` (check it works with `halfvec`),
    - with `opts.productId`, that product's chunks are added if they aren't already among the hits, after the top-k (so up to `k` plus that product's chunks),
    - `// ponytail:` exact scan, fine below 20k chunks per store. Above that, HNSW with `hnsw.iterative_scan = relaxed_order` (§7.5, C9).
  - The live test runs only when `OPENAI_API_KEY` is set (`test.skipIf`), so the default run never calls OpenAI.

- [ ] **Step 1:** Write `tests/retrieval.test.ts` with the same deterministic fake `embed` as Task 11, built so that texts sharing words get closer vectors. Cases:
  - stores A and B each have a "waterproof hiking boots" product. Searching A for "hiking boots" returns only A's chunks (Review Focus 1),
  - with three products in A, the best-matching product ranks first, `score` values are descending, and `k = 2` returns 2 hits,
  - `search(A, "   ")` returns `[]`, and `embed` is not called. A store with no chunks returns `[]` (Review Focus 5),
  - `opts.productId` of a low-ranked product includes its chunks. A `productId` the store doesn't have returns the normal top-k (Review Focus 6).

  Write `tests/live/retrieval.live.test.ts`: it seeds 3 products ("Waterproof hiking boots", "Cotton summer dress", "Stainless steel water bottle"), runs `embedStore` with the real `embed`, and checks that "shoes for rainy mountain trails" ranks the boots first.
- [ ] **Step 2:** Run `npx vitest run tests/retrieval.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS, with the live test skipped. If `OPENAI_API_KEY` is available, run `npx vitest run tests/live` once and record the result. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add store-scoped vector search over product chunks".

**M3 exit check:**
- `npx vitest run` passes everything.
- With `OPENAI_API_KEY` set, the live test passes.
- On the dev store after an M2 sync, `select count(*) from chunks` matches roughly one chunk per active, published product.
