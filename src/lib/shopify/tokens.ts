import { eq } from "drizzle-orm";
import { type Conn, db, forStore } from "@/db/client";
import { stores, storeTokens } from "@/db/schema";
import { CURRENT_KEY_ID, decrypt, encrypt } from "@/lib/crypto";
import { shopify } from "./api";

export type TokenSet = {
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
};
export type RefreshFn = (p: { shop: string; refreshToken: string }) => Promise<TokenSet>;

const REFRESH_WINDOW_MS = 5 * 60_000;

/** stores.sync_error for a store whose access and refresh tokens have both expired. Opening the app clears it (session.ts). */
export const RECONNECT_NEEDED = "Reconnect needed: open the app in Shopify admin";

/** Only a new token exchange, run when the merchant opens the app, can give this store a token again. */
export class ReconnectNeededError extends Error {
  constructor(storeId: string) {
    super(`Refresh token missing or expired for store ${storeId}; token exchange required`);
  }
}

const defaultRefresh: RefreshFn = async (p) => {
  const { session } = await shopify.auth.refreshToken(p);
  return {
    accessToken: session.accessToken!,
    accessExpiresAt: session.expires ?? null,
    refreshToken: session.refreshToken ?? null,
    refreshExpiresAt: session.refreshTokenExpires ?? null,
  };
};

function row(storeId: string, t: TokenSet) {
  return {
    storeId,
    accessTokenEnc: encrypt(t.accessToken, storeId),
    accessExpiresAt: t.accessExpiresAt,
    refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, storeId) : null,
    refreshExpiresAt: t.refreshExpiresAt,
    keyId: CURRENT_KEY_ID,
  };
}

export function saveTokens(storeId: string, t: TokenSet, conn: Conn = db): Promise<void> {
  return forStore(storeId, async (tx) => {
    const r = row(storeId, t);
    await tx.insert(storeTokens).values(r).onConflictDoUpdate({ target: storeTokens.storeId, set: r });
  }, conn);
}

/**
 * Returns a valid access token, refreshing (once, under a row lock) when <5 min of validity remains.
 * When the refresh token has expired too, marks the store RECONNECT_NEEDED (so Shopify jobs skip it) and throws ReconnectNeededError.
 */
export async function getAccessToken(storeId: string, refresh: RefreshFn = defaultRefresh): Promise<string> {
  try {
    return await readOrRefresh(storeId, refresh);
  } catch (e) {
    // Marked outside the token transaction, which the throw rolls back.
    if (e instanceof ReconnectNeededError) await db.update(stores).set({ syncError: RECONNECT_NEEDED }).where(eq(stores.id, storeId));
    throw e;
  }
}

function readOrRefresh(storeId: string, refresh: RefreshFn): Promise<string> {
  return forStore(storeId, async (tx) => {
    // ponytail: the row lock is held across the refresh HTTP call; fine while refreshes are rare and fast.
    const [t] = await tx.select().from(storeTokens).where(eq(storeTokens.storeId, storeId)).for("update");
    if (!t) throw new Error(`No tokens stored for store ${storeId}`);
    const fresh = !t.accessExpiresAt || t.accessExpiresAt.getTime() - Date.now() > REFRESH_WINDOW_MS;
    if (fresh) return decrypt(t.accessTokenEnc, storeId);

    if (!t.refreshTokenEnc || !t.refreshExpiresAt || t.refreshExpiresAt.getTime() <= Date.now()) {
      throw new ReconnectNeededError(storeId);
    }
    const [s] = await tx.select({ shopDomain: stores.shopDomain }).from(stores).where(eq(stores.id, storeId));
    const next = await refresh({ shop: s.shopDomain, refreshToken: decrypt(t.refreshTokenEnc, storeId) });
    await tx.update(storeTokens).set(row(storeId, next)).where(eq(storeTokens.storeId, storeId));
    return next.accessToken;
  });
}
