import { and, eq, sql as dsql } from "drizzle-orm";
import { RequestedTokenType } from "@shopify/shopify-api";
import { type Conn, db, forStore } from "@/db/client";
import { stores, storeTokens } from "@/db/schema";
import { upsertStore } from "@/lib/stores";
import { enqueueSync } from "@/lib/sync";
import { adminGraphql } from "./admin";
import { shopify } from "./api";
import { RECONNECT_NEEDED, saveTokens, tokensUsable } from "./tokens";

const unauthorized = () => new Response(null, { status: 401 });

/** The store id when getAccessToken can serve this store without a new token exchange, else null. */
async function hasValidTokens(shop: string, conn: Conn = db): Promise<string | null> {
  const [s] = await conn.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!s?.active) return null;
  const [t] = await forStore(s.id, (tx) => tx.select().from(storeTokens).where(eq(storeTokens.storeId, s.id)), conn);
  return t && tokensUsable(t) ? s.id : null;
}

/** Verifies the App Bridge id token; exchanges it for an expiring offline token when the store has none usable. Throws Response(401). */
export async function authenticateEmbedded(req: Request): Promise<{ storeId: string; shop: string }> {
  const sessionToken = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!sessionToken) throw unauthorized();
  let shop: string;
  try {
    shop = new URL((await shopify.session.decodeSessionToken(sessionToken)).dest).hostname;
  } catch {
    throw unauthorized();
  }

  const existing = await hasValidTokens(shop);
  if (existing) {
    // Backstop: a store flagged while its tokens are valid would be skipped by every job, and no exchange would run to
    // clear it. Clear it here and resume the sync it skipped. The conditional update lets one request win the enqueue.
    const cleared = await db
      .update(stores)
      .set({ syncError: null })
      .where(and(eq(stores.id, existing), eq(stores.syncError, RECONNECT_NEEDED)))
      .returning({ id: stores.id });
    if (cleared.length) await enqueueSync(existing);
    return { storeId: existing, shop };
  }

  // Serialise exchanges per shop so concurrent first loads can't store a superseded token.
  // All writes run on the lock's own connection, so waiters holding pool slots can't starve the holder.
  // ponytail: each waiter holds a pooled connection across the exchange HTTP call; fine while exchanges are rare.
  const { storeId, exchanged } = await db.transaction(async (lock) => {
    await lock.execute(dsql`select pg_advisory_xact_lock(hashtext(${shop}))`);
    const winner = await hasValidTokens(shop, lock);
    if (winner) return { storeId: winner, exchanged: false };

    const { session } = await shopify.auth.tokenExchange({
      shop,
      sessionToken,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
      expiring: true,
    });
    const { storeId } = await upsertStore(shop, lock);
    await saveTokens(storeId, {
      accessToken: session.accessToken!,
      accessExpiresAt: session.expires ?? null,
      refreshToken: session.refreshToken ?? null,
      refreshExpiresAt: session.refreshTokenExpires ?? null,
    }, lock);
    // Jobs can reach Shopify again. Any other sync_error is left for the next sync to clear.
    await lock
      .update(stores)
      .set({ syncError: null })
      .where(and(eq(stores.id, storeId), eq(stores.syncError, RECONNECT_NEEDED)));
    return { storeId, exchanged: true };
  });
  // After commit, so the job never sees an uncommitted store. Install and reinstall both sync the catalog.
  // ponytail: if this send fails the request errors, and the next load finds valid tokens and won't retry the sync.
  if (exchanged) await enqueueSync(storeId);
  return { storeId, shop };
}

/** Returns the stored shop name, fetching and saving it while it is still null. A failed fetch returns null and is retried next load. */
export async function ensureShopName(storeId: string, shop: string): Promise<string | null> {
  const [s] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId));
  if (s.name) return s.name;
  try {
    const data = await adminGraphql<{ shop: { name: string } }>(storeId, shop, "{ shop { name } }");
    await db.update(stores).set({ name: data.shop.name }).where(eq(stores.id, storeId));
    return data.shop.name;
  } catch (e) {
    console.error(`Shop name fetch failed for ${shop}`, e);
    return null;
  }
}
