import { eq } from "drizzle-orm";
import { RequestedTokenType } from "@shopify/shopify-api";
import { db, forStore } from "@/db/client";
import { stores, storeTokens } from "@/db/schema";
import { upsertStore } from "@/lib/stores";
import { shopify } from "./api";
import { saveTokens } from "./tokens";

const unauthorized = () => new Response(null, { status: 401 });

/** The store id when getAccessToken can serve this store without a new token exchange, else null. */
async function hasValidTokens(shop: string): Promise<string | null> {
  const [s] = await db.select({ id: stores.id, active: stores.active }).from(stores).where(eq(stores.shopDomain, shop));
  if (!s?.active) return null;
  const [t] = await forStore(s.id, (tx) => tx.select().from(storeTokens).where(eq(storeTokens.storeId, s.id)));
  if (!t) return null;
  const now = Date.now();
  const accessOk = !t.accessExpiresAt || t.accessExpiresAt.getTime() > now;
  const refreshOk = !!t.refreshTokenEnc && !!t.refreshExpiresAt && t.refreshExpiresAt.getTime() > now;
  return accessOk || refreshOk ? s.id : null;
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
  if (existing) return { storeId: existing, shop };

  // ponytail: two first loads at once may both exchange; the last saveTokens wins, which is fine.
  const { session } = await shopify.auth.tokenExchange({
    shop,
    sessionToken,
    requestedTokenType: RequestedTokenType.OfflineAccessToken,
    expiring: true,
  });
  const { storeId } = await upsertStore(shop);
  await saveTokens(storeId, {
    accessToken: session.accessToken!,
    accessExpiresAt: session.expires ?? null,
    refreshToken: session.refreshToken ?? null,
    refreshExpiresAt: session.refreshTokenExpires ?? null,
  });
  // TODO(M2): enqueue the initial catalog sync when upsertStore reports created.

  const { data } = await new shopify.clients.Graphql({ session }).request<{ shop: { name: string } }>("{ shop { name } }");
  await db.update(stores).set({ name: data!.shop.name }).where(eq(stores.id, storeId));
  return { storeId, shop };
}
