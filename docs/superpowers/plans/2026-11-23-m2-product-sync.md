# M2: Product Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a copy of every store's catalog in Postgres. A bulk sync runs on install, on a schedule, and on Resync, and product webhooks keep it current in between. Home shows the sync status.

**Architecture:**
- A full sync is two pg-boss jobs:
  - `store-sync` starts a Shopify bulk operation,
  - `sync-poll` checks on it until it finishes, then streams the JSONL into `products` and removes products that are no longer in the catalog.
- Product webhooks go through a 60 s debounced `product-sync` job per product, which re-reads that one product through GraphQL.
- M3 embeds `products.content` and re-embeds only rows whose `content_hash` changed.

**Tech Stack:** what M1 uses (Next.js 16.4.6, Drizzle, pg-boss 12, `@shopify/shopify-api` 15.1.2 on API `2026-10`, Vitest).

**Spec:** `product.md` §7.3, §7.12 (Home), §7.13, §8 (D23, D24, D25, D47, D65). This plan extends `docs/superpowers/plans/2026-11-23-phase1-build-plan.md`, whose Global Constraints still apply, and continues its task numbers (M1 = Tasks 1–5).

## Plan choices (not in the spec; approved by the user on 2026-11-23 as D67)

- **C1 Store every product, not only indexed ones.** `products` keeps `status` and `published` (as in §7.13), and M3 embeds only `status = 'ACTIVE' and published`. This means a product job never has to decide whether to delete a row.
- **C2 Save the stable text on the row** (`products.content`). M3 then embeds without calling Shopify again. §7.13 has no column for it.
- **C3 "Metafield specs" means** product metafields of these types: `single_line_text_field`, `multi_line_text_field`, `number_integer`, `number_decimal`, `boolean`, `dimension`, `weight`, `volume`, `list.single_line_text_field`. Namespaces starting with `app--` are skipped, and each value is cut to 500 characters. Up to 50 metafields per product.
- **C4 Home progress** shows "Syncing your catalog… N items read", where N is the bulk operation's `objectCount` (products plus metafields). Shopify does not give a total, so there is no percentage.
- **C5 A sync starts after every token exchange.** That covers install and reinstall, and the rare case of a re-exchange after the refresh token expires.
- **C6 `shop/update` updates `stores.name` only.** `domains[]` waits for the milestone that uses it (M4/M5 CORS).

## Global Constraints (M2 additions)

- Webhook topics in `shopify.app.toml` after M2: `app/uninstalled`, `products/create`, `products/update`, `products/delete`, `shop/update`, `bulk_operations/finish`, plus the three compliance topics (§7.3).
- Price and stock are never stored or hashed (D25).
- At most one bulk sync per store at a time. `store-sync` and `sync-poll` queues use policy `stately` with `singletonKey: storeId` (§7.3).
- Product webhook jobs are debounced per product for 60 s (D24).
- Resync frequency is `stores.settings.resyncFrequency`: `'daily' | 'weekly' | 'off'`, default `'daily'` (D47). There's no UI for it until M7.
- Every new store-owned table gets ENABLE + FORCE RLS and the `store_isolation` policy. The RLS coverage test from Task 2 enforces this.
- Every new queue gets `retryLimit: 5, retryBackoff: true`, like `shop-redact`.

## Review Focus

1. **A product webhook job runs during a bulk sync,** and the bulk import later writes older data for that product. The newer row must survive: the upsert is ignored when the incoming `shopifyUpdatedAt` is older than the stored one (§8). Test in Task 6.
2. **A store with zero products:** a completed bulk operation has `url = null`. The sync must finish as `idle` with 0 products, not crash. Test in Task 7.
3. **A product that was deleted or unpublished while a webhook was missed** is removed by the next full sync. A product written by a webhook job **during** the sync is kept. Test in Task 7.
4. **`bulk_operations/finish` never arrives:** polling alone completes the sync. Test in Task 7.
5. **The store uninstalls while a sync or product job is queued:** the job ends quietly without calling Shopify, and doesn't burn retries. Tests in Tasks 7 and 8.
6. **Resync clicked twice, or Resync and the hourly scan overlap:** only one `store-sync` job is queued for the store. Test in Task 9.

---

### Task 6: Products table and product content

**Files:**
- Modify: `src/db/schema.ts` (add `products`, add sync columns to `stores`)
- Create: `drizzle/0002_*.sql` (generated) and `drizzle/0003_products_rls.sql` (hand-written, in the style of `0001_rls.sql`)
- Create: `src/lib/products.ts`
- Test: `tests/products.test.ts`

**Interfaces:**
- Consumes: `forStore`, `Conn` and `db` from `src/db/client.ts`
- Produces:
  - `products` table: `storeId uuid fk → stores ON DELETE CASCADE`, `shopifyId text` (the product GID), `handle`, `title`, `url text null` (`onlineStoreUrl`), `imageUrl text null`, `status text`, `published bool`, `content text`, `contentHash text`, `shopifyUpdatedAt timestamptz`, `syncedAt timestamptz default now()`. Primary key `(storeId, shopifyId)`.
  - New `stores` columns: `syncStatus text not null default 'idle'` (`'idle' | 'running' | 'failed'`), `lastSyncAt timestamptz null`, `bulkOperationId text null`, `syncStartedAt timestamptz null`, `syncObjectCount integer not null default 0`.
  - `type ShopifyProduct = { id: string; handle: string; title: string; description: string; productType: string; vendor: string; tags: string[]; options: { name: string; values: string[] }[]; status: string; onlineStoreUrl: string | null; imageUrl: string | null; updatedAt: string; metafields: { namespace: string; key: string; type: string; value: string }[] }`
  - `PRODUCT_FIELDS: string`, the GraphQL selection for one product, without metafields (Task 7 and Task 8 both use it). The image comes from `featuredMedia { preview { image { url } } }`. **Check the field names against the 2026-10 Admin API** with the shopify-ai-toolkit docs before writing it.
  - `buildContent(p: ShopifyProduct): string` is deterministic. It contains title, description, type, vendor, tags (sorted), options, and the metafields allowed by C3 (sorted by `namespace.key`).
  - `upsertProducts(storeId: string, ps: ShopifyProduct[], conn?: Conn): Promise<void>` runs in `forStore`. It inserts `ON CONFLICT (store_id, shopify_id) DO UPDATE … WHERE excluded.shopify_updated_at >= products.shopify_updated_at`, sets `synced_at = now()`, and sets `content_hash` to sha256 hex of `buildContent`.
  - `deleteProduct(storeId: string, shopifyId: string): Promise<void>`
  - `sweepProducts(storeId: string, before: Date): Promise<number>` deletes rows with `synced_at < before` and returns the count.

- [ ] **Step 1:** Write `tests/products.test.ts`:
  - `buildContent` returns the same string when tags and metafields arrive in a different order,
  - `buildContent` leaves out a `json` metafield, an `app--x` namespace, and anything about price,
  - a metafield value longer than 500 characters is cut to 500,
  - `upsertProducts` then reading through `forStore` returns one row with `published = (onlineStoreUrl != null)` and a 64-character `content_hash`,
  - upserting the same product again with an **older** `updatedAt` and a new title keeps the old title (Review Focus 1),
  - upserting with a newer `updatedAt` changes the title and the hash,
  - `sweepProducts(storeId, t)` deletes only rows synced before `t` and doesn't touch another store's rows.
- [ ] **Step 2:** Run `npx vitest run tests/products.test.ts`. Expected: FAIL (the module doesn't exist).
- [ ] **Step 3:** Implement the schema, run `npx drizzle-kit generate`, add the RLS migration for `products`, and write `src/lib/products.ts`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS, including the RLS coverage test in `tests/db/tenant-isolation.test.ts`.
- [ ] **Step 5:** Commit with the message "Add products table and stable product content for embedding".

### Task 7: Bulk sync with polling

**Files:**
- Create: `src/lib/shopify/admin.ts`, `src/lib/sync.ts`
- Modify:
  - `src/lib/shopify/session.ts`: `ensureShopName` uses `adminGraphql`, and the `TODO(M2)` becomes `enqueueSync(storeId)` **after** the lock transaction commits,
  - `src/lib/jobs.ts`: create and work the queues `store-sync` and `sync-poll`,
  - `src/lib/shopify/webhooks.ts`: add the `BULK_OPERATIONS_FINISH` handler,
  - `shopify.app.toml`: subscribe `bulk_operations/finish`
- Test: `tests/sync.test.ts`, and one case added to `tests/shopify/webhooks.test.ts`

**Interfaces:**
- Consumes: `getAccessToken`, `shopify`, `enqueue`, `boss`, and everything Task 6 produces
- Produces:
  - `adminGraphql<T>(storeId: string, shop: string, query: string, variables?: Record<string, unknown>): Promise<T>`. It builds the offline `Session` the way `ensureShopName` does now, and returns `data`. This is the only place that builds a Shopify GraphQL client.
  - `enqueueSync(storeId: string): Promise<void>` sends `store-sync` with `{ storeId }` and `singletonKey: storeId`.
  - `startSync({ storeId }): Promise<void>` (the `store-sync` handler):
    - returns at once if the store is inactive (Review Focus 5) or `syncStatus = 'running'`,
    - runs `bulkOperationRunQuery` over `products { edges { node { ${PRODUCT_FIELDS} metafields(first: 50) { edges { node { namespace key type value } } } } } }` and throws on `userErrors` so pg-boss retries,
    - saves `bulkOperationId`, `syncStatus = 'running'`, `syncStartedAt = now()` and `syncObjectCount = 0`,
    - enqueues `sync-poll` with `{ storeId }`, `singletonKey: storeId`, `startAfter: 15`.
  - `pollSync({ storeId }): Promise<void>` (the `sync-poll` handler). It returns if the store has no `bulkOperationId`. Otherwise it reads `node(id: $id) { ... on BulkOperation { status objectCount url errorCode } }` and then:
    - `CREATED` or `RUNNING`: saves `syncObjectCount` and enqueues itself again with `startAfter: 15`,
    - `COMPLETED`: streams `url` (when not null) through `importJsonl`, calls `sweepProducts(storeId, syncStartedAt)`, then sets `syncStatus = 'idle'`, `lastSyncAt = now()` and `bulkOperationId = null`,
    - anything else: `syncStatus = 'failed'`, `bulkOperationId = null`, and logs `errorCode`.

    It is safe to run twice on the same finished operation, because the upserts and the sweep are idempotent.
  - `importJsonl(storeId: string, lines: AsyncIterable<string>): Promise<number>`. A line without `__parentId` starts a new product. A line with `__parentId` is a metafield of the current product. It upserts in batches of 250 and returns the product count.

    `// ponytail:` relies on Shopify writing a product's child lines right after it. **Confirm this in the bulk-operations docs.** If the docs don't promise it, collect children in a map keyed by `__parentId` instead, and comment the memory ceiling.
  - Webhook `BULK_OPERATIONS_FINISH`: finds the store by domain and enqueues `sync-poll` for it without a delay. With `stately`, an already-queued poll absorbs it, which is fine.

- [ ] **Step 1:** Write `tests/sync.test.ts`. Mock `adminGraphql` with `vi.mock("@/lib/shopify/admin")`, and mock `fetch` for the JSONL. Cases:
  - `importJsonl` with one product line followed by two metafield lines stores one product whose `content` includes both metafields,
  - `pollSync` on `COMPLETED` with `url: null` leaves the store `idle`, sets `lastSyncAt`, and sweeps an old product (Review Focus 2),
  - `pollSync` on `COMPLETED` deletes a product synced before `syncStartedAt` that is missing from the JSONL, and keeps a product upserted after `syncStartedAt` that is also missing (Review Focus 3),
  - `pollSync` on `RUNNING` saves `syncObjectCount = 42` and leaves exactly one queued `sync-poll` job (check `pgboss.job`),
  - `pollSync` on `FAILED` sets `syncStatus = 'failed'`,
  - two `pollSync` calls on `COMPLETED` give the same row count (idempotent), with no webhook involved (Review Focus 4),
  - `startSync` for an inactive store doesn't call `adminGraphql`,
  - `startSync` throws when `bulkOperationRunQuery` returns `userErrors`,
  - in `webhooks.test.ts`: a signed `bulk_operations/finish` for a known store gives 200 and queues `sync-poll`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. **Check `bulkOperationRunQuery`, the `BulkOperation` status values, and the JSONL format against the 2026-10 Admin API docs first.** Stream the download with `Readable.fromWeb(res.body)` and `readline`, never with `res.text()`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Sync the catalog with bulk operations, polling for completion".

### Task 8: Product webhooks and debounced product jobs

**Files:**
- Modify: `src/lib/shopify/webhooks.ts`, `src/lib/jobs.ts`, `src/lib/sync.ts`, `shopify.app.toml`
- Test: `tests/shopify/webhooks.test.ts`, `tests/sync.test.ts`

**Interfaces:**
- Consumes: `adminGraphql`, `PRODUCT_FIELDS`, `upsertProducts`, `deleteProduct`, `boss`
- Produces:
  - The handler type gets a third parameter: `(shopDomain: string, tx: Conn, payload: any) => Promise<void>`. `handleWebhook` passes `JSON.parse(rawBody)`. Existing handlers ignore it.
  - `PRODUCTS_CREATE`, `PRODUCTS_UPDATE` and `PRODUCTS_DELETE` find the active store by domain and call `enqueueProductSync(storeId, gid)`. The gid is `payload.admin_graphql_api_id`, or `gid://shopify/Product/${payload.id}` for delete payloads, which carry only `id`.
  - `SHOP_UPDATE` sets `stores.name = payload.name` (C6).
  - `enqueueProductSync(storeId: string, productId: string): Promise<void>` calls `boss.sendDebounced('product-sync', { storeId, productId }, null, 60, `${storeId}:${productId}`)` after `init()`. It lives in `jobs.ts` next to `enqueue`.
  - `syncProduct({ storeId, productId }): Promise<void>` (the `product-sync` handler) returns if the store is inactive. Otherwise it reads `product(id:)` with `PRODUCT_FIELDS` and `metafields(first: 50)`. If the result is null it calls `deleteProduct`; otherwise it calls `upsertProducts` with one product.
  - toml subscriptions: `products/create`, `products/update`, `products/delete`, `shop/update`.

- [ ] **Step 1:** Write the tests:
  - two signed `products/update` webhooks for the same product, with different webhook ids, give 200 each and leave **one** `product-sync` job in `pgboss.job`,
  - `products/delete` for a product we never stored gives 200,
  - `syncProduct` when GraphQL returns `product: null` deletes the row,
  - `syncProduct` for an inactive store doesn't call `adminGraphql` (Review Focus 5),
  - `shop/update` with `{ name: "New name" }` updates `stores.name`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. **Confirm `sendDebounced` semantics in `node_modules/pg-boss`** (v12.39): one job per key per window, the latest data kept.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Keep products current from webhooks, debounced per product".

### Task 9: Scheduled re-check, Resync, and sync status on Home

**Files:**
- Create: `src/app/api/app/sync/route.ts`
- Modify: `src/lib/sync.ts`, `src/lib/jobs.ts`, `src/app/(embedded)/app/page.tsx`
- Test: `tests/sync.test.ts`, `tests/api/sync-route.test.ts`

**Interfaces:**
- Consumes: `authenticateEmbedded`, `enqueueSync`, `forStore`
- Produces:
  - `isResyncDue(frequency: 'daily' | 'weekly' | 'off' | undefined, lastSyncAt: Date | null, now: Date): boolean`. `undefined` counts as `'daily'`. Daily is due after 24 h and weekly after 7 days. `off` is never due. A null `lastSyncAt` is due unless `off`.
  - `resyncScan(): Promise<void>` (the `resync-scan` handler) selects active stores with `syncStatus <> 'running'` and calls `enqueueSync` for each one that `isResyncDue`. `startWorkers` registers it with `boss.schedule('resync-scan', '0 * * * *')`.

    `// ponytail:` one query over all stores each hour. Page it once the store count reaches the thousands.
  - `GET /api/app/sync` returns `{ status, lastSyncAt, itemsRead, productCount }`, where `productCount` counts `published` `ACTIVE` products through `forStore`. `POST /api/app/sync` calls `enqueueSync` and returns 202. `storeId` comes only from `authenticateEmbedded`.
  - Home (`page.tsx`) keeps "Connected to {name}" and adds a status line:
    - running: "Syncing your catalog… {itemsRead} items read" (C4),
    - idle: "{productCount} products synced · last synced {date}",
    - failed: "The last sync failed."

    It also adds an `<s-button>` labelled "Resync" that POSTs and is disabled while running. While the status is running, the page polls `GET` every 5 s.

- [ ] **Step 1:** Write the tests:
  - `isResyncDue` table: daily at 23 h → false, daily at 25 h → true, weekly at 6 days → false, weekly at 8 days → true, off → false, `undefined` with null `lastSyncAt` → true,
  - `resyncScan` queues `store-sync` for an overdue store, and not for a store with `resyncFrequency: 'off'`, an inactive store, or a running one,
  - `POST /api/app/sync` with no bearer gives 401,
  - with `authenticateEmbedded` mocked, two `POST`s give 202 each and leave **one** queued `store-sync` job for the store (Review Focus 6),
  - `GET` returns `productCount` counting only `ACTIVE` and published products.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS. `npx next build` succeeds with the `SHOPIFY_*` env set (D66).
- [ ] **Step 5:** Commit with the message "Schedule catalog re-checks and show sync status with Resync on Home".

**M2 exit check** (with `shopify app dev`, after the M1 exit check):
- `npx vitest run` passes everything.
- Installing on the dev store shows "Syncing your catalog…" and then "{n} products synced", where n matches the store's active, published products.
- Editing a product title in the admin changes the `products` row within about 90 s.
- Deleting a product removes its row.
- Resync runs a new bulk operation and ends `idle`.
