import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

// Runs as the non-superuser `app_user` so RLS applies. Never point this at the admin URL.
export const sql = postgres(process.env.DATABASE_URL!, {
  max: Number(process.env.DB_POOL_MAX) || 10,
});
export const db = drizzle(sql, { schema });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool, or an open transaction to run inside (nested calls become savepoints). */
export type Conn = typeof db | Tx;

/** Runs fn in a transaction with app.store_id set (transaction-local, so it never leaks on the pool). */
export function forStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>, conn: Conn = db): Promise<T> {
  return conn.transaction(async (tx) => {
    await tx.execute(dsql`select set_config('app.store_id', ${storeId}, true)`);
    return fn(tx);
  });
}
