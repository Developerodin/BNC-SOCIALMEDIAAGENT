import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { eq, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { enqueue, enqueueEmbed } from "@/lib/jobs";
import { deleteProduct, PRODUCT_FIELDS, type ShopifyProduct, sweepProducts, toShopifyProduct, upsertProducts } from "@/lib/products";
import { adminGraphql } from "@/lib/shopify/admin";
import { RECONNECT_NEEDED, ReconnectNeededError } from "@/lib/shopify/tokens";

const BATCH = 250;
const POLL_DELAY_S = 15;

// One selection for the bulk and the single-product query, so both paths build the same content.
// ponytail: bulk queries ignore `first` and return every metafield and collection, so a product with more than 50
// metafields or 20 collections can still differ between the two paths (one extra re-embed when it flips). Upgrade path:
// first: 250 here, at a higher query cost per product-sync.
const NESTED = `metafields(first: 50) { edges { node { namespace key type value } } } collections(first: 20) { edges { node { title } } }`;
const BULK_QUERY = `{ products { edges { node { ${PRODUCT_FIELDS} ${NESTED} } } } }`;
const RUN = `mutation($query: String!) {
  bulkOperationRunQuery(query: $query) { bulkOperation { id } userErrors { field message } }
}`;
const POLL = `query($id: ID!) { node(id: $id) { ... on BulkOperation { status objectCount url errorCode } } }`;

/** False when nothing was queued: the queue is `stately`, so a send is dropped while this store already has a queued store-sync. */
export async function enqueueSync(storeId: string): Promise<boolean> {
  return (await enqueue("store-sync", { storeId }, { singletonKey: storeId })) !== null;
}

/** stores.sync_error when Shopify refuses bulkOperationRunQuery to this app. Retrying can't fix it; the developer must. */
export const BULK_ACCESS_DENIED =
  "Bulk operations are not enabled for this app. Enable them in the Dev Dashboard → Settings → Access requests.";

const HOUR_MS = 3600_000;
export type ResyncFrequency = "daily" | "weekly" | "off";

/** D47/D66: daily (default), weekly or off. A store never synced is due unless off (R6 safety net for a failed first enqueue). */
export function isResyncDue(frequency: ResyncFrequency | undefined, lastSyncAt: Date | null, now: Date): boolean {
  const f = frequency ?? "daily";
  if (f === "off") return false;
  if (!lastSyncAt) return true;
  return now.getTime() - lastSyncAt.getTime() >= (f === "weekly" ? 168 : 24) * HOUR_MS;
}

/**
 * The hourly `resync-scan` handler. enqueueSync and enqueuePoll are singleton per store, so overlapping scans are harmless.
 * A running store gets a poll instead: a healthy one already has a queued poll that absorbs it, and a stuck one is driven
 * to completion or failure.
 * ponytail: one query over all stores each hour. Page it once the store count reaches the thousands.
 */
export async function resyncScan(): Promise<void> {
  const rows = await db
    .select({ id: stores.id, settings: stores.settings, lastSyncAt: stores.lastSyncAt, syncStatus: stores.syncStatus })
    .from(stores)
    .where(eq(stores.active, true));
  const now = new Date();
  for (const r of rows) {
    // Costs no OpenAI call when nothing changed; recovers lost or exhausted embed runs and stores synced before M3.
    await enqueueEmbed(r.id);
    if (r.syncStatus === "running") {
      await enqueuePoll(r.id);
      continue;
    }
    const f = (r.settings as { resyncFrequency?: ResyncFrequency }).resyncFrequency;
    if (isResyncDue(f, r.lastSyncAt, now)) await enqueueSync(r.id);
  }
}

/** `stately` keeps one queued poll per store, so extra sends (webhook + timer) are absorbed. */
export async function enqueuePoll(storeId: string, startAfter = 0): Promise<void> {
  await enqueue("sync-poll", { storeId }, { singletonKey: storeId, startAfter });
}

/** Marks the sync failed. `reason` is shown to the merchant; without one, any earlier reason is cleared. */
export async function failSync(storeId: string, detail: object, reason: string | null = null): Promise<void> {
  console.error("bulk sync failed", { storeId, reason, ...detail });
  await db.update(stores).set({ syncStatus: "failed", bulkOperationId: null, syncError: reason }).where(eq(stores.id, storeId));
}

/**
 * Runs a `store-sync` or `sync-poll` job. On the final attempt (pg-boss fails a job once retryCount reaches retryLimit),
 * an error marks the store's sync failed instead of being rethrown, so the store can't stay `running` with no job left.
 * A store that needs reconnecting is already marked (getAccessToken), and retrying can't help, so that error ends the job.
 */
export async function runSyncJob(job: JobWithMetadata<{ storeId: string }>, run: (d: { storeId: string }) => Promise<void>): Promise<void> {
  try {
    await run(job.data);
  } catch (e) {
    if (e instanceof ReconnectNeededError) return;
    if (job.retryCount < job.retryLimit) throw e;
    await failSync(job.data.storeId, { queue: job.name, attempts: job.retryCount + 1, error: e });
  }
}

/** The `store-sync` handler: starts a bulk query over the catalog and schedules the first poll. */
export async function startSync({ storeId }: { storeId: string }): Promise<void> {
  const [s] = await db
    .select({ shop: stores.shopDomain, active: stores.active, syncStatus: stores.syncStatus, syncError: stores.syncError })
    .from(stores)
    .where(eq(stores.id, storeId));
  if (!s?.active || s.syncError === RECONNECT_NEEDED) return;
  // A sync already running (or left running by a poll that ran out of retries): poll it to completion or failure instead.
  if (s.syncStatus === "running") return enqueuePoll(storeId);

  let r: { bulkOperation: { id: string } | null; userErrors: { field: string[] | null; message: string }[] };
  try {
    ({ bulkOperationRunQuery: r } = await adminGraphql<{ bulkOperationRunQuery: typeof r }>(storeId, s.shop, RUN, { query: BULK_QUERY }));
  } catch (e) {
    // A GraphQL error, not a userError: the app lacks bulk access. Permanent, so fail now instead of retrying.
    if (e instanceof Error && e.message.includes("Access denied for bulkOperationRunQuery")) {
      return failSync(storeId, { queue: "store-sync", error: e.message }, BULK_ACCESS_DENIED);
    }
    throw e;
  }
  // Thrown so pg-boss retries. ponytail: if we crash between Shopify accepting the operation and the update below,
  // retries get "already in progress" userErrors until that operation ends; the store then needs a fresh enqueueSync.
  if (r.userErrors.length || !r.bulkOperation) throw new Error(`bulkOperationRunQuery failed: ${r.userErrors.map((e) => e.message).join("; ")}`);

  // DB now(), the same clock products.synced_at uses, so the sweep cut-off can't skew.
  await db
    .update(stores)
    .set({ bulkOperationId: r.bulkOperation.id, syncStatus: "running", syncStartedAt: sql`now()`, syncObjectCount: 0 })
    .where(eq(stores.id, storeId));
  await enqueuePoll(storeId, POLL_DELAY_S);
}

/**
 * The `sync-poll` handler. Safe to run twice on the same finished operation: the upserts and the sweep are idempotent.
 * Errors are retried with backoff (jobs.ts). The final failed attempt marks the sync failed (runSyncJob); a store still
 * `running` is re-polled by startSync and by the hourly resyncScan.
 */
export async function pollSync({ storeId }: { storeId: string }): Promise<void> {
  const [s] = await db
    .select({ shop: stores.shopDomain, opId: stores.bulkOperationId, startedAt: stores.syncStartedAt, syncError: stores.syncError })
    .from(stores)
    .where(eq(stores.id, storeId));
  // A store needing a reconnect stays `running`; the first poll after the merchant reopens the app carries on.
  if (!s?.opId || s.syncError === RECONNECT_NEEDED) return;

  const { node: op } = await adminGraphql<{
    node: { status: string; objectCount: string; url: string | null; errorCode: string | null } | null;
  }>(storeId, s.shop, POLL, { id: s.opId });

  if (op?.status === "CREATED" || op?.status === "RUNNING") {
    await db.update(stores).set({ syncObjectCount: Number(op.objectCount) }).where(eq(stores.id, storeId));
    await enqueuePoll(storeId, POLL_DELAY_S);
    return;
  }
  if (op?.status === "COMPLETED") {
    // Docs: "If the query produced no results, then the url field will return null."
    if (op.url) {
      const res = await fetch(op.url);
      // Final, not retried: the same URL won't start working (an expired one gives 403), and throwing would leave the store running.
      // A thrown fetch (network error) still throws, so pg-boss retries it.
      if (!res.ok || !res.body) return failSync(storeId, { status: op.status, downloadStatus: res.status });
      const input = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      await importJsonl(storeId, createInterface({ input, crlfDelay: Infinity }));
    }
    await sweepProducts(storeId, s.startedAt!);
    await db
      .update(stores)
      .set({ syncStatus: "idle", lastSyncAt: sql`now()`, bulkOperationId: null, syncError: null })
      .where(eq(stores.id, storeId));
    await enqueueEmbed(storeId);
    return;
  }
  // FAILED, CANCELED, CANCELING, EXPIRED, or an operation Shopify no longer knows.
  await failSync(storeId, { status: op?.status ?? null, errorCode: op?.errorCode ?? null });
}

const PRODUCT = `query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} ${NESTED} } }`;

/** The `product-sync` handler: re-reads one product and upserts it, or deletes it when Shopify no longer has it. */
export async function syncProduct({ storeId, productId }: { storeId: string; productId: string }): Promise<void> {
  const [s] = await db
    .select({ shop: stores.shopDomain, active: stores.active, syncError: stores.syncError })
    .from(stores)
    .where(eq(stores.id, storeId));
  if (!s?.active || s.syncError === RECONNECT_NEEDED) return;
  const { product } = await adminGraphql<{
    product:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | (Record<string, any> & {
          metafields: { edges: { node: ShopifyProduct["metafields"][number] }[] };
          collections?: { edges: { node: { title: string } }[] };
        })
      | null;
  }>(storeId, s.shop, PRODUCT, { id: productId });
  if (!product) await deleteProduct(storeId, productId);
  else {
    const collections = product.collections?.edges.map((e) => e.node.title) ?? [];
    await upsertProducts(storeId, [toShopifyProduct(product, product.metafields.edges.map((e) => e.node), collections)]);
  }
  await enqueueEmbed(storeId);
}

/**
 * Imports bulk-query JSONL: a line without `__parentId` is a product; a line with one is a metafield (has `namespace`)
 * or a collection (has `title`) of that product.
 * Returns the product count.
 *
 * The docs promise only that "nested connections appear after their parents in the file", not right after
 * (https://shopify.dev/docs/api/usage/bulk-operations/queries), so products are held in a map until the file ends.
 * Keying by id also means a batch can't contain one product twice (which ON CONFLICT DO UPDATE rejects).
 * ponytail: memory ceiling is the whole catalog in memory, roughly a few KB per product (up to 50 metafields of
 * 500+ chars each), so ~100k products is hundreds of MB. Upgrade path: run the query with `groupObjects: true`
 * and flush each product when the next parent line starts.
 */
export async function importJsonl(storeId: string, lines: AsyncIterable<string>): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, { node: any; metafields: ShopifyProduct["metafields"]; collections: string[] }>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.__parentId) {
      const parent = byId.get(row.__parentId);
      if (row.namespace !== undefined) parent?.metafields.push({ namespace: row.namespace, key: row.key, type: row.type, value: row.value });
      else if (row.title !== undefined) parent?.collections.push(row.title);
    } else {
      // A repeated product line keeps the latest node and the children collected so far.
      const prev = byId.get(row.id);
      byId.set(row.id, { node: row, metafields: prev?.metafields ?? [], collections: prev?.collections ?? [] });
    }
  }
  const all = [...byId.values()].map((p) => toShopifyProduct(p.node, p.metafields, p.collections));
  for (let i = 0; i < all.length; i += BATCH) await upsertProducts(storeId, all.slice(i, i + BATCH));
  return all.length;
}
