import { and, eq } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { productSales, stores } from "@/db/schema";
import { enqueue } from "@/lib/jobs";
import { adminGraphql } from "@/lib/shopify/admin";
import { isThrottled } from "@/lib/shopify/live-products";
import { throttleWaitMs } from "@/lib/shopify/throttle";
import { ReconnectNeededError } from "@/lib/shopify/tokens";

// D95: trending products from real sales. A daily job per installed store reads the orders of the last 30 days and keeps,
// per product, only the net units sold and the number of orders that held it (product_sales, replaced as a whole each run).
// The query asks for no customer, address, price or order name; order ids stay in memory (needed only to page the line items
// of a big order) and are never written. Cancelled and test orders are skipped.

export const WINDOW_DAYS = 30;
const KEEP_PRODUCTS = 200; // the chat shows a handful; a store with more sold products keeps its best sellers
const ORDERS_PER_CALL = 20;
const LINES_PER_CALL = 10; // an order with more lines gets follow-up calls
const LINES_FOLLOW_UP = 40;
const MAX_LINES = 100; // lines read per order; an order with more loses the rest (a purchase that large is not a trend)
// Requested cost (Shopify charges the requested cost up front, and refunds the part the response did not use):
// an order = 1 + lineItems 2 + 10 lines × (node 1 + product 1) = 23, so a call of 20 = 2 + 460 = 462; a follow-up of 40 lines = 2 + 80 = 82.
const CALL_COST = 2 + ORDERS_PER_CALL * (3 + LINES_PER_CALL * 2);
const FOLLOW_UP_COST = 2 + LINES_FOLLOW_UP * 2;
// The chat's live check, the product sync and the partner API share the store's Admin bucket: every call first needs its
// cost plus this reserve available (throttle.ts's estimate), like the partner path.
const RESERVE = 1000;
const BUDGET_MS = 10 * 60_000; // the job's whole time; past it the run throws and pg-boss retries it
const MAX_THROTTLED_RETRIES = 3;

const LINES = `lineItems(first: $lines) { pageInfo { hasNextPage endCursor } nodes { currentQuantity product { id } } }`;
const ORDERS_QUERY = `query SalesOrders($first: Int!, $after: String, $query: String!, $lines: Int!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id cancelledAt test ${LINES} }
  }
}`;
const MORE_LINES_QUERY = `query SalesLines($id: ID!, $first: Int!, $after: String) {
  order(id: $id) { lineItems(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { currentQuantity product { id } } } }
}`;

type Line = { currentQuantity: number; product: { id: string } | null };
type Lines = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Line[] };
type OrderNode = { id: string; cancelledAt: string | null; test: boolean; lineItems: Lines };
export type Sold = Map<string, { units: number; orders: number }>;

/** Adds one order to the totals: skipped when cancelled or a test; per product the net quantity, and one order each. */
export function addOrder(sold: Sold, o: { cancelledAt: string | null; test: boolean }, lines: Line[]): void {
  if (o.cancelledAt || o.test) return;
  const inOrder = new Map<string, number>();
  for (const l of lines) {
    if (!l.product || !(l.currentQuantity > 0)) continue; // a removed or fully refunded line, or a custom line with no product
    inOrder.set(l.product.id, (inOrder.get(l.product.id) ?? 0) + l.currentQuantity);
  }
  for (const [id, q] of inOrder) {
    const t = sold.get(id) ?? { units: 0, orders: 0 };
    t.units += q;
    t.orders += 1;
    sold.set(id, t);
  }
}

/** Waits until the bucket holds `cost + RESERVE` points, or throws when that would pass the deadline. */
async function gate(storeId: string, cost: number, deadline: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (;;) {
    const wait = throttleWaitMs(storeId, cost + RESERVE);
    if (wait <= 0) return;
    if (Date.now() + wait > deadline) throw new Error("Shopify cost bucket stayed low; sales snapshot will retry");
    await sleep(wait);
  }
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The orders of the last WINDOW_DAYS days, summed per product. Throws on an API error or when the budget runs out (nothing is kept then). */
export async function readSales(storeId: string, shop: string, now = new Date(), sleep = pause): Promise<Sold> {
  const deadline = Date.now() + BUDGET_MS;
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const query = `created_at:>='${since}'`;
  const sold: Sold = new Map();

  const call = async <T>(cost: number, q: string, variables: Record<string, unknown>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      await gate(storeId, cost, deadline, sleep);
      try {
        return await adminGraphql<T>(storeId, shop, q, variables);
      } catch (e) {
        if (!isThrottled(e) || attempt >= MAX_THROTTLED_RETRIES) throw e; // adminGraphql recorded the empty bucket: gate waits for it
      }
    }
  };

  let after: string | null = null;
  for (;;) {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: OrderNode[] } } = await call(CALL_COST, ORDERS_QUERY, { first: ORDERS_PER_CALL, after, query, lines: LINES_PER_CALL });
    for (const o of d.orders.nodes) {
      const lines = [...o.lineItems.nodes];
      let info = o.lineItems.pageInfo;
      // Only an order that counts needs its remaining lines.
      while (!o.cancelledAt && !o.test && info.hasNextPage && info.endCursor && lines.length < MAX_LINES) {
        const more: { order: { lineItems: Lines } | null } = await call(FOLLOW_UP_COST, MORE_LINES_QUERY, { id: o.id, first: Math.min(LINES_FOLLOW_UP, MAX_LINES - lines.length), after: info.endCursor });
        if (!more.order) break;
        lines.push(...more.order.lineItems.nodes);
        info = more.order.lineItems.pageInfo;
      }
      addOrder(sold, o, lines);
    }
    if (!d.orders.pageInfo.hasNextPage || !d.orders.pageInfo.endCursor) return sold;
    after = d.orders.pageInfo.endCursor;
  }
}

/** Replaces the store's product_sales with this run's totals (its top KEEP_PRODUCTS by units) and stamps the run. One transaction: readers see the old or the new snapshot. */
export async function saveSales(storeId: string, sold: Sold, periodEnd: Date): Promise<number> {
  const rows = [...sold]
    .sort((a, b) => b[1].units - a[1].units || b[1].orders - a[1].orders)
    .slice(0, KEEP_PRODUCTS)
    .map(([productId, t]) => ({ storeId, productId, units: t.units, orderCount: t.orders, periodEnd }));
  await forStore(storeId, async (tx) => {
    await tx.delete(productSales).where(eq(productSales.storeId, storeId));
    if (rows.length) await tx.insert(productSales).values(rows);
    await tx.update(stores).set({ salesSnapshotAt: periodEnd }).where(eq(stores.id, storeId));
  });
  return rows.length;
}

/** The `sales-snapshot` handler. A store that is gone, inactive, MCP-only or needs a reconnect is skipped. */
export async function snapshotSales({ storeId }: { storeId: string }): Promise<{ products: number } | null> {
  const [s] = await db.select({ shop: stores.shopDomain, active: stores.active, mode: stores.mode }).from(stores).where(eq(stores.id, storeId));
  if (!s?.active || s.mode !== "app") return null;
  const now = new Date();
  try {
    return { products: await saveSales(storeId, await readSales(storeId, s.shop, now), now) };
  } catch (e) {
    if (e instanceof ReconnectNeededError) return null;
    // The app may not hold read_orders (the merchant has not approved it): permanent, so no retry; the chat then says there is no sales data.
    if (e instanceof Error && /access denied|not approved|scope/i.test(e.message)) {
      console.error("sales snapshot refused by Shopify", { storeId, error: e.message });
      return null;
    }
    throw e;
  }
}

/** The daily `sales-scan` handler: one `sales-snapshot` job per installed store, spread over the next hour so stores don't all start at once. */
export async function salesScan(spreadSeconds = 3600): Promise<number> {
  const rows = await db.select({ id: stores.id }).from(stores).where(and(eq(stores.active, true), eq(stores.mode, "app")));
  for (const r of rows) await enqueue("sales-snapshot", { storeId: r.id }, { singletonKey: r.id, startAfter: Math.floor(Math.random() * spreadSeconds) });
  return rows.length;
}

