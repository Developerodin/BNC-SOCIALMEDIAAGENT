import { and, eq } from "drizzle-orm";
import { type Conn, db, forStore } from "@/db/client";
import { stores, storeTokens, webhookEvents } from "@/db/schema";
import { enqueue, enqueueProductSync } from "@/lib/jobs";
import { enqueuePoll } from "@/lib/sync";
import { shopify } from "./api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (shopDomain: string, tx: Conn, payload: any) => Promise<void>;

/** Keyed by the topic as `shopify.webhooks.validate` returns it (app/uninstalled -> APP_UNINSTALLED). */
export const handlers: Record<string, Handler> = {
  async APP_UNINSTALLED(shopDomain, tx) {
    // Reset the sync too: polls fail without tokens, and a reinstall must start a fresh sync instead of polling a dead one.
    const [s] = await tx
      .update(stores)
      .set({ active: false, syncStatus: "idle", bulkOperationId: null })
      .where(eq(stores.shopDomain, shopDomain))
      .returning({ id: stores.id });
    if (!s) return;
    // Inside forStore: RLS hides store_tokens otherwise and the delete would silently affect 0 rows.
    await forStore(s.id, (t) => t.delete(storeTokens).where(eq(storeTokens.storeId, s.id)), tx);
  },
  async CUSTOMERS_DATA_REQUEST(shopDomain) {
    console.info("webhook customers/data_request received", { shopDomain });
  },
  async CUSTOMERS_REDACT(shopDomain) {
    console.info("webhook customers/redact received", { shopDomain });
  },
  async SHOP_REDACT(shopDomain, tx) {
    const [s] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.shopDomain, shopDomain));
    if (!s) return;
    // ponytail: enqueued on pg-boss's own connection, so it is not rolled back with tx; the job is idempotent, so a duplicate is harmless.
    await enqueue("shop-redact", { shopDomain });
  },
  async BULK_OPERATIONS_FINISH(shopDomain, tx) {
    const [s] = await tx.select({ id: stores.id }).from(stores).where(eq(stores.shopDomain, shopDomain));
    if (!s) return;
    // Poll now instead of waiting for the timer; pollSync reads the store's own operation, so the payload isn't needed.
    await enqueuePoll(s.id);
  },
  PRODUCTS_CREATE: (shopDomain, tx, payload) => productChanged(shopDomain, tx, payload.admin_graphql_api_id),
  PRODUCTS_UPDATE: (shopDomain, tx, payload) => productChanged(shopDomain, tx, payload.admin_graphql_api_id),
  // Delete payloads carry only the numeric id.
  PRODUCTS_DELETE: (shopDomain, tx, payload) => productChanged(shopDomain, tx, `gid://shopify/Product/${payload.id}`),
  async SHOP_UPDATE(shopDomain, tx, payload) {
    // REST shop payload: `primary_locale` and `currency` (2026-10 sample). Absent fields keep the stored value.
    await tx
      .update(stores)
      .set({
        name: payload.name,
        ...(payload.primary_locale ? { primaryLocale: payload.primary_locale } : {}),
        ...(payload.currency ? { currencyCode: payload.currency } : {}),
      })
      .where(eq(stores.shopDomain, shopDomain));
  },
};

async function productChanged(shopDomain: string, tx: Conn, productId: string): Promise<void> {
  const [s] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.shopDomain, shopDomain), eq(stores.active, true)));
  if (s) await enqueueProductSync(s.id, productId);
}

export async function handleWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const v = await shopify.webhooks.validate({ rawBody, rawRequest: req });
  if (!v.valid) return new Response(null, { status: 401 });

  try {
    // Dedupe and handler share one transaction: a failed handler rolls back the dedupe row, so Shopify's retry is processed.
    await db.transaction(async (tx) => {
      const [fresh] = await tx
        .insert(webhookEvents)
        .values({ id: v.webhookId, topic: v.topic, shopDomain: v.domain })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (!fresh) return;
      await handlers[v.topic]?.(v.domain, tx, JSON.parse(rawBody));
    });
  } catch (e) {
    console.error("webhook handler failed", { topic: v.topic, shopDomain: v.domain, webhookId: v.webhookId }, e);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
