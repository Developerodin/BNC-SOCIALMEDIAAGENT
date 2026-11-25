import { eq, sql as dsql } from "drizzle-orm";
import { db, type Conn } from "@/db/client";
import { partnerTokens } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PartnerTokenRow = typeof partnerTokens.$inferSelect;

/**
 * Runs fn scoped to the store of the token whose sha256 hex is `tokenHash`, for callers that know only the token
 * (the bearer guard, DELETE /api/partner/token). Returns null, without calling fn, when no token has that hash.
 *
 * Three steps in one transaction, all settings transaction-local like forStore:
 * 1. app.partner_token_hash = hash, which makes exactly that token row readable (policy token_lookup, SELECT only),
 * 2. app.store_id = the row's store_id, and the hash setting is cleared,
 * 3. fn(tx, token) runs under plain store isolation, so it can join the grant and write that store's rows only.
 *
 * The row is returned whatever its kind, expiry or grant state: validity is the caller's check (DELETE accepts an
 * expired or refresh token). Like forStore, don't nest it inside another store's transaction: the settings last
 * until the outer transaction ends.
 */
export function forTokenHash<T>(
  tokenHash: string,
  fn: (tx: Tx, token: PartnerTokenRow) => Promise<T>,
  conn: Conn = db,
): Promise<T | null> {
  return conn.transaction(async (tx) => {
    await tx.execute(dsql`select set_config('app.partner_token_hash', ${tokenHash}, true)`);
    const [token] = await tx.select().from(partnerTokens).where(eq(partnerTokens.tokenHash, tokenHash)).limit(1);
    if (!token) return null;
    await tx.execute(
      dsql`select set_config('app.store_id', ${token.storeId}, true), set_config('app.partner_token_hash', '', true)`,
    );
    return fn(tx, token);
  });
}
