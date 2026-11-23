import { eq } from "drizzle-orm";
import { type Conn, db } from "@/db/client";
import { accounts, stores } from "@/db/schema";

/** Creates the store (with a new account) or reactivates an existing one, keeping its ids. */
export function upsertStore(
  shopDomain: string,
  conn: Conn = db,
): Promise<{ storeId: string; accountId: string; created: boolean }> {
  return conn.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({}).returning({ id: accounts.id });
    // A concurrent first load blocks here until the other commits, then gets nothing back.
    const [inserted] = await tx
      .insert(stores)
      .values({ accountId: account.id, shopDomain })
      .onConflictDoNothing({ target: stores.shopDomain })
      .returning({ id: stores.id, accountId: stores.accountId });
    if (inserted) return { storeId: inserted.id, accountId: inserted.accountId, created: true };

    await tx.delete(accounts).where(eq(accounts.id, account.id));
    const [existing] = await tx
      .update(stores)
      .set({ active: true })
      .where(eq(stores.shopDomain, shopDomain))
      .returning({ id: stores.id, accountId: stores.accountId });
    return { storeId: existing.id, accountId: existing.accountId, created: false };
  });
}
