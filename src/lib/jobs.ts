import { PgBoss, type SendOptions } from "pg-boss";
import { and, eq, notExists } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, stores } from "@/db/schema";

// Admin URL: pg-boss creates and migrates its own `pgboss` schema, which app_user cannot do.
export const boss = new PgBoss(process.env.DATABASE_ADMIN_URL!);
boss.on("error", (e) => console.error("pg-boss", e));

let ready: Promise<void> | undefined;
/** Starts boss and creates the queues once per process; send/work fail on a queue that does not exist. */
function init(): Promise<void> {
  return (ready ??= (async () => {
    await boss.start();
    await boss.createQueue("shop-redact", { retryLimit: 5, retryBackoff: true });
  })());
}

/** Deletes the store (store_tokens go with it via ON DELETE CASCADE), then its account if no other store uses it. Idempotent. */
export async function shopRedact({ shopDomain }: { shopDomain: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [s] = await tx.delete(stores).where(eq(stores.shopDomain, shopDomain)).returning({ accountId: stores.accountId });
    if (!s) return;
    await tx
      .delete(accounts)
      .where(and(eq(accounts.id, s.accountId), notExists(tx.select().from(stores).where(eq(stores.accountId, s.accountId)))));
    // S3 cleanup is added in M6.
  });
}

export async function startWorkers(): Promise<void> {
  await init();
  await boss.work<{ shopDomain: string }>("shop-redact", async (jobs) => {
    for (const job of jobs) await shopRedact(job.data);
  });
}

export async function enqueue(name: string, data: object, opts?: SendOptions): Promise<string | null> {
  await init();
  return boss.send(name, data, opts);
}
