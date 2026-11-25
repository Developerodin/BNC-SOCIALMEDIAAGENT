# AskCart catalogue scale report: 5,000 and 20,000 products

Branch `worktree-agent-a91f318b8368e5b3a`, commit `43fd76e` (on top of `e3e66d8`). The benchmarks ran on a scratch database, `shopassist_scale`, in the local Docker Postgres 17.12 + pgvector 0.8.7 (shared_buffers 128 MB). The database has since been dropped. No Shopify store was called: the Shopify download, the Admin reads and the live check were all faked.

**Verdict: 5,000 products work without issue, and so do 20,000.** I found two real problems and fixed both: search sent the query vector twice, and the product-update queue drained too slowly. Neither one stopped a sync or a chat. Each sync, search and chat step is well inside its time limit at 20k, and a re-sync that changes nothing costs no OpenAI calls.

## Setup

- **Synthetic catalogues.** The bulk JSONL is written in Shopify's format, and the generator is in the scratchpad (`bench/gen.mts`).
  - Store A has 5,000 products, store B 20,000 and store C 2,000. Store C is there to exercise the store filter.
  - The data covers 12 categories, with product lines of about 2 KB and 7 child lines each: metafields of several types, including app-private ones, and collections.
  - About 10% of the child lines appear later in the file than their parent. About 3% of products have long descriptions that split into several chunks, about 6% are drafts or archived, about 3% are unpublished, and a few are gift cards.
- **The repo's own sync path.** The download is streamed through `readline` into `importJsonl`, exactly as `pollSync` does, then `sweepProducts` and `embedStore` run. Only the Shopify poll and the download are replaced.
- **Embeddings.** Real OpenAI calls to `text-embedding-3-small`, 512 dimensions.
- **Search.** The real `search()`. Every query runs twice: once with the real embedding call, then with that embedding response replayed from a cache. The second run gives the time spent in Postgres and JavaScript only.
- **Chat turns.** Real `openTurn` + `runTurn` with real OpenAI calls (rewrite and answer). The Admin live check is answered by a local fake that waits 250 ms.

## Results

| | 5k (store A) | 20k (store B) |
|---|---|---|
| Chunks | 4,887 | 19,512 |
| **First full sync**: JSONL import (parse + upsert) | 1.5 s | 5.7 s |
| First full sync: embedding job | 40 s, 91 OpenAI calls | 163 s, 367 OpenAI calls |
| First full sync: embedding tokens and cost | 1.00M tokens, **$0.020** | 4.00M tokens, **$0.080** |
| Peak memory (RSS), import | 246 MB (129 MB before the import) | 324 MB (129 MB before) |
| Peak memory (RSS), import + embedding | 273 MB (heap 121 MB) | 356 MB (heap 196 MB) |
| **Full re-sync, nothing changed** | n/a | 6.0 s import, **0 re-embedded, 0 OpenAI calls**, $0. 1 product was swept; see the observation below. |
| Embedding job with nothing changed (the hourly scan runs this for every store) | 33 ms | 66 ms |
| **One product updated** (product-sync upsert + embedding job) | 5 ms + 518 ms, 1 product re-embedded, 1 call | 6 ms + 852 ms, 1 product re-embedded, 1 call |
| Search p50 / p95 / p99, total (OpenAI query embedding ~366 ms p50 included) | 384 / 413 / 476 ms | 396 / 425 / 435 ms |
| Search p50 / p95 / p99, Postgres + JS only, **before the fix** | 64 / 69 / 70 ms | 76 / 79 / 81 ms |
| Search p50 / p95 / p99, Postgres + JS only, **after the fix** | **20.5 / 22 / 25 ms** | **31 / 32.5 / 34 ms** |
| Wide price search (k=30), Postgres + JS, after the fix | 21 ms | 32 ms |
| Recall: known product in the top 8 (20 queries naming brand, line and product) | 20/20 | 20/20 |
| Vector index used | **No**: no vector index exists, so every search is an exact scan of the store's chunks | **No**: exact scan |
| Plan under RLS (`EXPLAIN ANALYZE`, the exact statement `search()` sends) | Seq scan of chunks (whole table), 17.5 ms | Seq scan of chunks (whole table), 28.9 ms |
| Chat turn, total (5 turns, after the fix) | 2.9–4.3 s | 2.8–3.4 s |
| Chat turn, first text | 2.7–3.6 s | 2.3–2.9 s |
| Chat turn, OpenAI time (rewrite + answer) | 2.6–4.0 s | 2.5–3.0 s |
| Chat turn, everything except OpenAI (includes the 250 ms fake Admin call) | 303–348 ms | 312–354 ms (360–394 ms before the fix) |

Store C (2k products, 1,948 chunks) after the fix: Postgres + JS search p50 5.8 ms. Its plan is a **bitmap index scan on `chunks_store_product_idx`** that takes 2.7 ms, so a small store does not pay for the big stores' rows. Recall was 20/20.

**Total OpenAI spend** was about $0.11 for embedding about 5.4M tokens across all three stores, plus a few cents for about 20 chat turns.

**OpenAI rate limit.** The key allows 5M tokens/min and 10k requests/min. A first sync ran at about 1.5M tokens/min, so there is about 3x headroom. The embedding queue runs one job at a time per process, so several stores syncing at once don't stack up.

## Problems found and fixed (commit 43fd76e)

### 1. Search sent the query vector twice

**What was wrong.** The `cosineDistance` expression was used twice in `retrieval.ts`: once for the score in the select list and once in ORDER BY. Drizzle binds a value again for every use, so each search sent about 6 KB of floats twice, and Postgres computed every chunk's distance twice.

**Effect at 20k chunks:**
- Time in Postgres went from 39 ms to 29 ms.
- Total time per statement on local Docker went from 78 ms to 30 ms.
- I isolated the cause: adding one unused 6 KB parameter to the fixed query brings it back to 74 ms. So most of the cost here was the larger message stalling on TCP, not the extra computation.
- At 2k chunks the same pattern costs 48 ms against 4 ms, so the overhead does not depend on catalogue size.
- How much of the stall shows up in production depends on the network path. The Postgres-side saving applies everywhere.

**Fix.**
- The query selects the distance once under an alias and orders by that alias. `score = 1 - distance` is now computed in JavaScript.
- Ordering by the bare distance, not by the score, keeps a future HNSW index usable.
- A new test in `tests/retrieval.test.ts` captures the statements the driver sends and checks that each one binds the vector once. The test fails on the old code.

**Observation on the re-sync row.** Before that re-sync, my one-product test had stamped one product with `updatedAt = now()`, which is newer than the bulk file's `updatedAt`.
- The upsert's last-write-wins guard (`excluded.shopify_updated_at >= stored`) skipped that row, so its `synced_at` was not bumped, and the sweep then deleted it. The run left 19,999 products and swept 1.
- In real use the bulk file is a fresh snapshot, so its `updatedAt` should be at least the stored one. A product edited while a bulk operation runs also gets `synced_at` from its webhook, after `sync_started_at`, so it survives the sweep.
- The case that does lose a product: a stored `updatedAt` newer than the snapshot's for a row whose `synced_at` is older than the sync start. The product then disappears until the next sync.
- I did not change anything. It may be worth a look, for example bumping `synced_at` in the conflict branch even when the guard skips the update.

### 2. The product-update queue drained at 0.5 jobs/s

**What was wrong.** A bulk edit, such as a CSV import, fires one products/update webhook per product. The product-sync worker used pg-boss defaults: one job per fetch and a fetch every 2 s.
- Measured: 100 queued jobs took 199 s, which is 0.5 jobs/s.
- At that rate **5,000 edited products take about 2.8 hours** and 20,000 take about 11 hours.
- Meanwhile the stored product content stays out of date. Price and stock are not affected, because those come from the live check.

**Fix: `PRODUCT_SYNC_WORK` in `jobs.ts`.**
- The worker now takes batches of 10 with `burstWhenBatchFull`, so it keeps fetching without waiting while there is a backlog. When idle it still polls every 2 s.
- With `perJobResults` and the new `settleEach`, each job settles on its own. One product that throws is failed and retried alone and doesn't fail its batch-mates.
- Measured: 300 jobs in 94.6 s, which is **3.2 jobs/s (6.3x faster)**. 5,000 edits now take about 26 minutes.

**Rate-limit caveat, and the batch setting is PENDING your OK.**
- Products are still read one at a time, but Shopify limits Admin GraphQL by cost points per second, not by concurrency. During a backlog the reads now come about 6x as often, so they spend the store's cost bucket faster.
- The chat live check spends from the same bucket.
- The fake Admin had no cost model, so the new rate has **not** been checked against a real bucket.
- On a throttle, `settleEach` fails only that job, and pg-boss retries it with backoff from 30 s. But the worker moves straight on to the next job, so a long throttle spends retries.
- Check before relying on it: read `extensions.cost` (actual cost and restore rate) from one real product read on the dev store, and compare about 3 × actual cost per second with the restore rate. If it is close, lower `batchSize` or add a pause on throttle.
- The code comment says the same.
- A new test in `tests/jobs.test.ts` runs the real pg-boss with these options. In a batch where one job throws, the other two complete and only the failing one goes to `retry`.

### 3. Comments documenting the limits

The comments in `sync.ts` (import memory), `indexing.ts` (how long the embedding job can run) and `retrieval.ts` (cost of the exact scan) now carry the measured figures and their upgrade paths.

The full test suite passed after these changes (89 files, 1,365 tests, live tests excluded), and `tsc --noEmit` is clean.

## Checked and fine (no change needed)

- **Bulk download.** It is streamed with `readline`; the file is never read whole. Memory is held by the map of all products, so it grows with the catalogue: about 10 KB of RSS per product, roughly 200 MB at 20k.
- **Content hash.** It works:
  - A full re-sync with nothing changed re-embedded 0 products.
  - A webhook update re-embedded only the changed product.
  - The hourly `embedStore` with nothing changed reads only ids and hashes: 66 ms at 20k.
- **Embedding batches.** At most 100 inputs per call. A first sync of 20k takes 163 s, against pg-boss's 15-minute job expiry.
- **Shopify query cost.**
  - A bulk operation is one query, whatever the catalogue size.
  - Polling is every 15 s.
  - The live check is one `nodes(ids:)` call per turn, capped at 30 ids.
  - `browse_collection` is capped at 5 pages × 8 products.
  - `store_overview` uses Shopify's counts.
  - Nothing in a chat turn scales with the catalogue except the exact vector scan.
- **Webhook handler.** It only queues a debounced job, so it is O(1).
- **RLS.** It applies on every query, as a one-time filter. The plans also filter on `store_id` explicitly.

## HNSW experiment (temporary index, now dropped; not committed)

I built `hnsw (embedding halfvec_cosine_ops)` over 26k chunks: 2.5 s, 28 MB. The planner does use it under RLS when the query orders by the distance alias, and Postgres + JS search time falls to about 13 ms at 20k. **But recall collapsed:**

| | Store B (20k) recall, top 8 | Store C (2k) recall, top 8 | Store C: generic queries returning fewer than 8 hits |
|---|---|---|---|
| Exact scan (current code) | 20/20 | 20/20 | 1 |
| HNSW, ef_search 40 | 0/20 | 3/20 | 27 of 28 |
| HNSW + `iterative_scan = relaxed_order` | 0/20 | 11/20 | 11 |
| HNSW + relaxed + ef_search 200 | 7/20 | 12/20 | 11 |

**Caveat: these recall figures come from synthetic data, and I did not isolate the cause.**
- 0/20 for a store that holds three quarters of the index is not typical HNSW behaviour.
- The generated catalogue has hundreds of near-identical, templated products, so a query that names one exact product hits a dense cluster of near-ties.
- Treat this as "HNSW needs a recall check on real data", not as proof that HNSW fails.

**Recommendation (pending your decision): keep the exact scan.** It rests on the timing alone: about 30 ms at 20k chunks. Revisit HNSW only past about 50k chunks per store, and then with a recall check on the real catalogue before switching.

## Remaining limits (documented in code comments)

| Area | Limit | Upgrade path |
|---|---|---|
| Search: exact scan | Linear in the store's chunks: about 30 ms at 20k, roughly 150 ms at 100k. When one store is most of the table, the plan is a seq scan of every store's chunks. | HNSW + iterative scan with a recall check, or partitioning `chunks` by store. |
| Search: gift-card subquery | A seq scan of `products` costs about 9 ms of the 29 ms at 20k. | **Pending:** a partial index on `products (store_id) where is_gift_card`. It needs a new migration, so I held it back to avoid a migration-number clash with other branches. |
| Bulk import memory | The whole catalogue is held in a map: about 200 MB at 20k, about 1 GB at 100k. | Run the bulk query with `groupObjects: true` and write each product as soon as its lines end. |
| First-sync embedding job: **hard limit** | The stale-content read in `embedStore` uses `inArray(ids)`, and drizzle binds one parameter per id. postgres.js refuses more than 65,534 parameters (`MAX_PARAMETERS_EXCEEDED`, `postgres/src/build.js`). So a run with about **65k or more changed products fails on every retry**, and that store never gets embeddings. This doesn't affect 5k or 20k. | Page the job, for example 500 products per run, then re-enqueue. **Pending:** a small fix that reads stale content in slices of ids. |
| First-sync embedding job: soft limit | One run embeds everything that changed: 163 s at 20k, so the 15-minute expiry is reached around 100k products. A retry skips batches already done, so it still finishes. A 429 from OpenAI fails the job the same way. | Same as above. |
| Product-update queue | Serial, about 3 jobs/s per process: 20k edits take about 2 hours. The Admin cost-bucket check is pending (see fix 2). | `localConcurrency`, sized against the store's Admin cost bucket. Each read requests an estimated ~75 points, and the live check spends from the same bucket. |
| Embedding job per webhook | Each run checks hashes over the whole catalogue: 66 ms at 20k. Overlapping runs for a store collapse into one (one queued and one active at most). | Not needed at this scale. |
| Daily re-sync | Every product row is rewritten each sync to bump `synced_at` for the sweep, which adds table churn for autovacuum. | Fine at 20k. Past that, update `synced_at` only, and leave unchanged rows' other columns alone. |

## Database clean-up

`shopassist_scale` was dropped at the end of the run. The command for future runs:

```
docker exec shopifyextension-db-1 psql -U shopassist -d postgres -c "drop database if exists shopassist_scale with (force)"
```

The benchmark scripts are in `C:\Users\INTEL\AppData\Local\Temp\claude\bcd86c518d54453b\b6351683-27cd-46d3-bb6b-2767af38fb26\scratchpad\bench\`, outside the repo:
- `gen.mts`, `migrate.mts` and `import.mts` (data and sync)
- `search.mts`, `probe.mts` and `probe2.mts` (search)
- `incr.mts` and `drain.mts` (incremental updates and the job queue)
- `turn.mts` (chat turns)
- `ratelimit.mts` (OpenAI limits)
