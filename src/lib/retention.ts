import { eq, sql } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { stores } from "@/db/schema";
import { retentionDays } from "@/lib/widget-config";

// The widget tells shoppers "Chats are kept for N days" (settings.retentionDays: 30, 90 or 365, default 30). This is the
// daily job that makes it true: a conversation is deleted once it is older than that and has had no message since the
// cutoff (so a long-running signed-in chat keeps its recent history). messages and cart_events go with it (ON DELETE CASCADE).
const DAY_MS = 86_400_000;
const BATCH = 500;
// ponytail: at most this many batches per store per run, so one store with a huge backlog can't hold the worker; the rest
// goes on the next day's run. At 500 x 40 = 20,000 conversations a day per store the backlog would only grow past that.
const MAX_BATCHES = 40;

/** Deletes one store's expired conversations (batched) and returns how many. Idempotent: a rerun finds nothing new. */
export async function purgeStore(storeId: string, days: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const gone = await forStore(storeId, (tx) =>
      tx.execute(sql`
        delete from conversations where id in (
          select c.id from conversations c
          where c.store_id = ${storeId} and c.created_at < ${cutoff}::timestamptz
            -- Skip a conversation a shopper is resuming right now; it gets a new message and survives the next run.
            and (c.busy_until is null or c.busy_until < now())
            and not exists (select 1 from messages m where m.store_id = c.store_id and m.conversation_id = c.id and m.created_at >= ${cutoff}::timestamptz)
          limit ${BATCH})
        returning id`),
    );
    total += gone.length;
    if (gone.length < BATCH) break;
  }
  return total;
}

/** The daily `retention-scan` handler: every active store, by its own retentionDays. One store failing doesn't stop the others. */
export async function retentionScan(now = new Date()): Promise<void> {
  const rows = await db.select({ id: stores.id, settings: stores.settings }).from(stores).where(eq(stores.active, true));
  for (const r of rows) {
    try {
      const deleted = await purgeStore(r.id, retentionDays(r.settings), now);
      if (deleted) console.info("retention purge", { storeId: r.id, deleted });
    } catch (err) {
      console.error("retention purge failed", { storeId: r.id, error: err instanceof Error ? err.name : typeof err });
    }
  }
}
