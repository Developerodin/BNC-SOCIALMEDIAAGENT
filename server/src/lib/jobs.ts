import { PgBoss, type Job, type JobResult, type SendOptions } from "pg-boss";
import { and, eq, notExists } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, partnerConnectRequests, stores } from "@/db/schema";

// Admin URL: pg-boss creates and migrates its own `pgboss` schema, which app_user cannot do.
export const boss = new PgBoss(process.env.DATABASE_ADMIN_URL!);
boss.on("error", (e) => console.error("pg-boss", e));

let ready: Promise<void> | undefined;
/** Starts boss and creates the queues once per process; send/work fail on a queue that does not exist. */
function init(): Promise<void> {
  return (ready ??= (async () => {
    await boss.start();
    await boss.createQueue("shop-redact", { retryLimit: 5, retryBackoff: true });
    // stately + singletonKey storeId: at most one queued and one active job per store.
    // Default policy for product-sync: sendDebounced dedupes with singleton_on slots, which stately's singletonKey rules would fight.
    // createQueue is a no-op for an existing queue, so updateQueue applies the retry options to databases created earlier.
    // Backoff from 30s, capped at 15 min: 5 retries span roughly 15-30 min, enough to ride out throttling or a Shopify 5xx.
    const retry = { retryLimit: 5, retryBackoff: true, retryDelay: 30, retryDelayMax: 900 };
    for (const [name, policy] of [["store-sync", "stately"], ["sync-poll", "stately"], ["product-sync", "standard"], ["embed-products", "stately"]] as const) {
      await boss.createQueue(name, { policy, ...retry });
      await boss.updateQueue(name, retry);
    }
    await boss.createQueue("resync-scan", { retryLimit: 5, retryBackoff: true });
    await boss.createQueue("retention-scan", { retryLimit: 3, retryBackoff: true });
    await boss.createQueue("sales-scan", { retryLimit: 3, retryBackoff: true });
    // stately + singletonKey storeId, like store-sync: a repeated scan or a retry can not stack two runs for one store.
    await boss.createQueue("sales-snapshot", { policy: "stately", ...retry });
    await boss.updateQueue("sales-snapshot", retry);
  })());
}

/** Deletes the store (store_tokens, partner_grants and partner_tokens go with it via ON DELETE CASCADE) and its partner connect requests, then its account if no other store uses it. Idempotent. */
export async function shopRedact({ shopDomain }: { shopDomain: string }): Promise<void> {
  await db.transaction(async (tx) => {
    // D65: a store that reinstalled before the job ran is active again, so it is kept.
    const [s] = await tx
      .delete(stores)
      .where(and(eq(stores.shopDomain, shopDomain), eq(stores.active, false)))
      .returning({ accountId: stores.accountId });
    if (!s) return;
    // Keyed by shop domain with no FK to stores, so the cascade doesn't reach them.
    await tx.delete(partnerConnectRequests).where(eq(partnerConnectRequests.shopDomain, shopDomain));
    await tx
      .delete(accounts)
      .where(and(eq(accounts.id, s.accountId), notExists(tx.select().from(stores).where(eq(stores.accountId, s.accountId)))));
    // S3 cleanup is added in M6.
  });
}

/**
 * product-sync worker options. A bulk edit fires one products/update webhook per product, and with pg-boss's defaults
 * (one job per fetch, a fetch every 2 s) the queue drained at 0.5 jobs/s: 5,000 edited products took about 3 hours.
 * Batches of 10, fetched back to back while they come back full, drain at the speed of the Admin reads (~3/s measured
 * with a fake 300 ms read). perJobResults settles each job on its own (settleEach), so one failing product doesn't fail
 * or retry the other nine.
 * ponytail: reads stay one at a time, but during a backlog they now run ~6x as often, so they drain the store's Admin
 * cost bucket (points restored per second, shared with the chat's live check) faster; not yet measured against a real
 * store. syncProduct (sync.ts) waits while the store's last throttleStatus says the bucket is nearly empty (throttle.ts)
 * and gives each read 15 s; a throttled read still fails only its job, which pg-boss retries with backoff. Check: read
 * extensions.cost from one real product read and compare ~3 x actual cost per second with the store's restore rate.
 * Still serial per process, so 20k edits take about 2 hours; localConcurrency is the upgrade path, sized the same way.
 */
export const PRODUCT_SYNC_WORK = { batchSize: 10, burstWhenBatchFull: true, perJobResults: true } as const;

/** Runs each job of a perJobResults batch in turn; a job that throws is logged and failed alone, so pg-boss retries just it. */
export async function settleEach<T>(jobs: Job<T>[], run: (data: T) => Promise<unknown>): Promise<JobResult[]> {
  const out: JobResult[] = [];
  for (const job of jobs) {
    try {
      await run(job.data);
      out.push({ id: job.id, status: "completed" });
    } catch (e) {
      // The message and code only: a Shopify GraphqlQueryError carries the whole response body, and a throttled bulk edit logs one per attempt.
      console.error("job failed", { queue: job.name, id: job.id, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string } | null)?.code });
      out.push({ id: job.id, status: "failed", output: { message: e instanceof Error ? e.message : String(e) } });
    }
  }
  return out;
}

export async function startWorkers(): Promise<void> {
  await init();
  await boss.work<{ shopDomain: string }>("shop-redact", async (jobs) => {
    for (const job of jobs) await shopRedact(job.data);
  });
  // Dynamic import: sync.ts imports enqueue from this module.
  const { startSync, pollSync, syncProduct, resyncScan, runSyncJob } = await import("@/lib/sync");
  // ponytail: pg-boss defaults, so each queue runs one job at a time in this process, across all stores; one slow
  // catalog download delays every other store's poll. Upgrade path: `localConcurrency` on these work() calls, or
  // `groupConcurrency` with a per-store group once several workers run.
  await boss.work<{ storeId: string }, void, { includeMetadata: true }>("store-sync", { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runSyncJob(job, startSync);
  });
  await boss.work<{ storeId: string }, void, { includeMetadata: true }>("sync-poll", { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runSyncJob(job, pollSync);
  });
  await boss.work<{ storeId: string; productId: string }, void, typeof PRODUCT_SYNC_WORK>("product-sync", PRODUCT_SYNC_WORK, (jobs) =>
    settleEach(jobs, syncProduct),
  );
  const { embedStore } = await import("@/lib/indexing");
  await boss.work<{ storeId: string }>("embed-products", async (jobs) => {
    for (const job of jobs) {
      const r = await embedStore(job.data, job.signal);
      // C10: tokens are logged for M10's usage accounting.
      console.info("embed-products done", { storeId: job.data.storeId, ...r });
    }
  });
  await boss.work("resync-scan", async () => {
    await resyncScan();
  });
  await boss.schedule("resync-scan", "0 * * * *");
  const { retentionScan } = await import("@/lib/retention");
  await boss.work("retention-scan", async () => {
    await retentionScan();
  });
  await boss.schedule("retention-scan", "30 3 * * *"); // daily, 03:30 UTC
  const { salesScan, snapshotSales } = await import("@/lib/sales");
  await boss.work("sales-scan", async () => {
    await salesScan();
  });
  await boss.work<{ storeId: string }>("sales-snapshot", async (jobs) => {
    for (const job of jobs) console.info("sales-snapshot done", { storeId: job.data.storeId, ...(await snapshotSales(job.data)) });
  });
  await boss.schedule("sales-scan", "0 3 * * *"); // daily, 03:00 UTC; each store starts at a random moment in the next hour
}

export async function enqueue(name: string, data: object, opts?: SendOptions): Promise<string | null> {
  await init();
  return boss.send(name, data, opts);
}

/**
 * Debounced per product: the first webhook in a 60s window runs at once, one more is queued for the next window
 * (so the final state is always re-read), and any further ones in that window are dropped. The job carries only ids; it re-reads the product.
 */
export async function enqueueProductSync(storeId: string, productId: string): Promise<void> {
  await init();
  await boss.sendDebounced("product-sync", { storeId, productId }, null, 60, `${storeId}:${productId}`);
}

/** `stately` + singletonKey: a burst of webhooks collapses into at most one queued and one active run per store. */
export async function enqueueEmbed(storeId: string): Promise<void> {
  await enqueue("embed-products", { storeId }, { singletonKey: storeId });
}
