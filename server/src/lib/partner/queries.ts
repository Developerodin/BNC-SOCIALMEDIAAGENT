import { GraphqlQueryError } from "@shopify/shopify-api";
import { adminGraphql } from "@/lib/shopify/admin";
import { isThrottled } from "@/lib/shopify/live-products";
import { throttleWaitMs } from "@/lib/shopify/throttle";
import { withTimeout } from "@/lib/chat/openai";
import { ReconnectNeededError } from "@/lib/shopify/tokens";
import { partnerJson, type PartnerStore } from "./auth";
import type { OrdersFilter } from "./params";

// D70 partner reads. Everything is read live from Shopify per request and nothing is stored (D73). Only the fields the
// Social Media Agent asked for: no customer, email, phone or address ever enters a query, so none can leak. Line items
// carry product facts only (title, sku, quantity, ids, prices).

/** Items per response (the consumer's contract). Smaller than a plain list because orders carry line items and products carry collections. */
export const ORDERS_PAGE_ITEMS = 25;
export const PRODUCTS_PAGE_ITEMS = 50;
// Shopify refuses a single query whose requested cost is over 1000 points (connection = 2 + first × node cost, each
// object 1, a money bag 2). So a response is several smaller Shopify pages that never exceed the response size (the last
// call asks for only what is still missing). Requested costs are estimates, not measured against a live store:
// a line item = 1 + three money bags 6 + product 1 + variant 1 = 9; an order = 56 base + lineItems(first: 10) 2 + 10 × 9
//   = 148, so 5 per call ≈ 740. An order with more than 10 line items gets follow-up calls of up to 40 (2 + 40 × 9 = 362);
// a product = 57 base + collections(first: 25) 27 = 84, so 5 per call ≈ 420; variant follow-ups ask for 250 (≈ 252).
// ponytail: up to 5 (orders) / 10 (products) sequential Shopify calls per response, plus follow-ups per order or
// product. If that is too slow, move backfills to a bulk operation.
export const MAX_LINE_ITEMS = 100;
const ORDERS_PER_CALL = 5;
const LINE_ITEMS_PER_CALL = 10;
const LINE_ITEMS_FOLLOW_UP = 40; // per follow-up call: keeps one call's requested cost (362) well under the 1000 limit
const LINE_ITEM_COST = 9;
const ORDER_COST = 56 + 2 + LINE_ITEMS_PER_CALL * LINE_ITEM_COST;
const SHIPPING_LINES = 5; // ponytail: an order with more than 5 shipping lines loses the rest; none exist in practice.
const PRODUCTS_PER_CALL = 5;
const PRODUCT_COST = 57 + 27;
const COLLECTIONS = 25; // ponytail: a product in more than 25 collections loses the rest.
const VARIANTS_PER_CALL = 50;
const MORE_VARIANTS_PER_CALL = 250;
const MORE_VARIANTS_COST = 2 + MORE_VARIANTS_PER_CALL;
// The partner path shares the store's Admin cost bucket with the storefront chat (its live check asks for ~1250) and the
// product sync, and is the lowest priority: before every Shopify call it needs `requested cost + RESERVE` points
// available (throttle.ts's estimate from the last response seen), else it stops and returns what it has with rateLimited.
// ponytail: a standard bucket holds 1000, so the estimate (which is not capped at the bucket size) can over-wait by up to
// a few tens of seconds after a big call; the Retry-After says how long. Tune RESERVE down if that is too slow.
export const RESERVE = 1000;
const CALL_MS = 10_000; // one Shopify call; a longer one is cut off (the call itself finishes in the background)
const SIXTY_DAYS_MS = 60 * 86_400_000;
// A backfill counts as reaching past the window only when createdFrom is more than 61 days back: createdFrom is a date in
// the shop's time zone (up to UTC±14h) read here as UTC midnight, so "60 days ago" must not be refused.
// ponytail: a createdFrom 60–61 days back can lose up to a day of its oldest orders silently. Upgrade path: compare
// against the shop's ianaTimezone.
const BACKFILL_MARGIN_MS = 61 * 86_400_000;

export type Money = { amount: string; currencyCode: string };
/** `waitMs` is internal (how long until the Shopify bucket has room again); pageResponse turns it into Retry-After and drops it. */
export type Page<T> = { items: T[]; nextCursor: string | null; complete: boolean; rateLimited?: boolean; waitMs?: number };

type Bag = { shopMoney: Money } | null;
const money = (b: Bag): Money | null => (b ? { amount: b.shopMoney.amount, currencyCode: b.shopMoney.currencyCode } : null);
const MONEY = "shopMoney { amount currencyCode }";
type TaxLine = { title: string; rate: number | null; priceSet: Bag };
const taxLine = (t: TaxLine) => ({ title: t.title, rate: t.rate, priceSet: money(t.priceSet) });
const TAX_LINE = `title rate priceSet { ${MONEY} }`;
const LINE_ITEM = `id title variantTitle sku quantity currentQuantity product { id } variant { id }
  originalUnitPriceSet { ${MONEY} } discountedTotalSet { ${MONEY} } discountedUnitPriceAfterAllDiscountsSet { ${MONEY} }`;

/** A call that was not made or not finished in time: the bucket is low (`waitMs`), Shopify throttled it, or it timed out. */
class Stopped extends Error {
  constructor(readonly waitMs: number, readonly timeout: boolean, readonly original?: unknown) {
    super(timeout ? "partner call timed out" : "partner call held back by the Shopify cost bucket");
  }
}

/** One Admin call for the partner path: checks the shared bucket first, then runs with a timeout. Throws Stopped or the call's own error. */
async function call<T>(s: PartnerStore, requestedCost: number, query: string, variables: Record<string, unknown>): Promise<T> {
  const floor = requestedCost + RESERVE;
  const wait = throttleWaitMs(s.storeId, floor);
  if (wait > 0) throw new Stopped(wait, false);
  try {
    return await withTimeout(adminGraphql<T>(s.storeId, s.shop, query, variables), CALL_MS);
  } catch (e) {
    if (isThrottled(e)) throw new Stopped(throttleWaitMs(s.storeId, floor), false, e); // adminGraphql has recorded the empty bucket
    if (e instanceof Error && e.name === "TimeoutError") throw new Stopped(0, true, e);
    throw e;
  }
}

/** Retry-After seconds for a wait: at least 2. */
export const retryAfterSeconds = (waitMs = 0) => Math.max(2, Math.ceil(waitMs / 1000));

/** The response for a list page; a rateLimited page carries Retry-After derived from how long the bucket needs. */
export function pageResponse<P extends Page<unknown>>(page: P): Response {
  const { waitMs, ...body } = page;
  return partnerJson(body, 200, page.rateLimited ? { "Retry-After": String(retryAfterSeconds(waitMs)) } : {});
}

type Batch<T> = {
  items: T[];
  hasNextPage: boolean;
  /** The cursor after the last COMPLETE item (the page's end cursor when all are complete; the `after` it started from when none are). */
  endCursor: string | null;
  stop?: Stopped;
};

/**
 * Reads Shopify pages from `cursor` until pageItems items or the end, each call asking for no more than is still missing.
 * `complete` is true only when the walk reached the end. A throttle, a held-back call (shared bucket low) or, once items
 * exist, a timeout returns the COMPLETE items so far with `rateLimited` and the cursor after the last of them, so the
 * consumer resumes without losing or repeating anything and every attempt advances. A timeout with nothing read is thrown
 * (502), as any other failure.
 */
async function walk<T>(
  pageItems: number,
  perCall: number,
  cursor: string | null,
  fetchPage: (after: string | null, first: number, have: number) => Promise<Batch<T>>,
): Promise<Page<T>> {
  const items: T[] = [];
  let after = cursor;
  const stopped = (at: string | null, e: Stopped): Page<T> => ({ items, nextCursor: at, complete: false, rateLimited: true, waitMs: e.waitMs });
  while (items.length < pageItems) {
    let b: Batch<T>;
    try {
      b = await fetchPage(after, Math.min(perCall, pageItems - items.length), items.length);
    } catch (e) {
      if (!(e instanceof Stopped)) throw e;
      if (e.timeout && items.length === 0) throw e.original;
      return stopped(after, e);
    }
    items.push(...b.items);
    if (b.stop) return stopped(b.endCursor, b.stop);
    if (!b.hasNextPage || !b.endCursor) return { items, nextCursor: null, complete: true };
    after = b.endCursor;
  }
  return { items, nextCursor: after, complete: false };
}

// ---------- orders ----------

const ORDERS_QUERY = `query PartnerOrders($first: Int!, $after: String, $query: String!, $sortKey: OrderSortKeys!) {
  currentAppInstallation { accessScopes { handle } }
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node {
      id name processedAt createdAt cancelledAt test updatedAt taxesIncluded sourceName
      displayFulfillmentStatus displayFinancialStatus discountCodes
      currentSubtotalPriceSet { ${MONEY} }
      currentTotalDiscountsSet { ${MONEY} }
      currentShippingPriceSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      currentTaxLines { ${TAX_LINE} }
      shippingLines(first: ${SHIPPING_LINES}) {
        nodes { title originalPriceSet { ${MONEY} } discountedPriceSet { ${MONEY} } taxLines { ${TAX_LINE} } }
      }
      lineItems(first: ${LINE_ITEMS_PER_CALL}) { pageInfo { hasNextPage endCursor } nodes { ${LINE_ITEM} } }
    } }
  }
}`;
const MORE_LINE_ITEMS_QUERY = `query PartnerLineItems($id: ID!, $first: Int!, $after: String) {
  order(id: $id) { lineItems(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${LINE_ITEM} } } }
}`;

type LineItemNode = {
  id: string; title: string; variantTitle: string | null; sku: string | null; quantity: number; currentQuantity: number;
  product: { id: string } | null; variant: { id: string } | null; originalUnitPriceSet: Bag; discountedTotalSet: Bag;
  discountedUnitPriceAfterAllDiscountsSet: Bag;
};
type LineItems = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: LineItemNode[] };
type OrderNode = {
  displayFulfillmentStatus: string; displayFinancialStatus: string | null; discountCodes: string[]; lineItems: LineItems;
  id: string; name: string; processedAt: string; createdAt: string; cancelledAt: string | null; test: boolean;
  updatedAt: string; taxesIncluded: boolean; sourceName: string | null;
  currentSubtotalPriceSet: Bag; currentTotalDiscountsSet: Bag; currentShippingPriceSet: Bag; currentTotalPriceSet: Bag;
  totalRefundedSet: Bag; currentTaxLines: TaxLine[];
  shippingLines: { nodes: { title: string; originalPriceSet: Bag; discountedPriceSet: Bag; taxLines: TaxLine[] }[] };
};
type OrdersData = {
  currentAppInstallation: { accessScopes: { handle: string }[] };
  orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { cursor: string; node: OrderNode }[] };
};

type Lines = { nodes: LineItemNode[]; truncated: boolean; stop?: Stopped };

/**
 * The first MAX_LINE_ITEMS line items: the rest beyond the first call come from follow-up calls of up to
 * LINE_ITEMS_FOLLOW_UP. `truncated` when more exist or a follow-up was stopped (`stop` says why; `nodes` are those read so far).
 */
async function allLineItems(s: PartnerStore, o: OrderNode): Promise<Lines> {
  const nodes = [...o.lineItems.nodes];
  let info = o.lineItems.pageInfo;
  while (info.hasNextPage && info.endCursor && nodes.length < MAX_LINE_ITEMS) {
    const first = Math.min(MAX_LINE_ITEMS - nodes.length, LINE_ITEMS_FOLLOW_UP);
    let d;
    try {
      d = await call<{ order: { lineItems: LineItems } | null }>(s, 2 + first * LINE_ITEM_COST, MORE_LINE_ITEMS_QUERY, {
        id: o.id,
        first,
        after: info.endCursor,
      });
    } catch (e) {
      if (e instanceof Stopped) return { nodes, truncated: true, stop: e };
      throw e;
    }
    if (!d.order) break; // deleted mid-read
    nodes.push(...d.order.lineItems.nodes);
    info = d.order.lineItems.pageInfo;
  }
  return { nodes, truncated: info.hasNextPage };
}

/** Built from explicit fields, so a field added to the query never reaches the consumer by accident. */
function mapOrder(o: OrderNode, lines: Lines) {
  return {
    id: o.id,
    name: o.name,
    processedAt: o.processedAt,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    test: o.test,
    updatedAt: o.updatedAt,
    taxesIncluded: o.taxesIncluded,
    sourceName: o.sourceName,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    displayFinancialStatus: o.displayFinancialStatus,
    discountCodes: o.discountCodes,
    currentSubtotalPriceSet: money(o.currentSubtotalPriceSet),
    currentTotalDiscountsSet: money(o.currentTotalDiscountsSet),
    currentShippingPriceSet: money(o.currentShippingPriceSet),
    currentTotalPriceSet: money(o.currentTotalPriceSet),
    totalRefundedSet: money(o.totalRefundedSet),
    currentTaxLines: o.currentTaxLines.map(taxLine),
    shippingLines: o.shippingLines.nodes.map((s) => ({
      title: s.title,
      originalPriceSet: money(s.originalPriceSet),
      discountedPriceSet: money(s.discountedPriceSet),
      taxLines: s.taxLines.map(taxLine),
    })),
    lineItems: lines.nodes.map((l) => ({
      id: l.id,
      // A line without a product is a custom line typed by the merchant (manual/draft order) or a deleted product: its text is hidden.
      title: l.product ? l.title : null,
      variantTitle: l.product ? l.variantTitle : null,
      sku: l.sku,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
      productId: l.product?.id ?? null,
      variantId: l.variant?.id ?? null,
      originalUnitPriceSet: money(l.originalUnitPriceSet),
      discountedTotalSet: money(l.discountedTotalSet),
      discountedUnitPriceAfterAllDiscountsSet: money(l.discountedUnitPriceAfterAllDiscountsSet),
    })),
    lineItemsTruncated: lines.truncated,
  };
}
export type PartnerOrder = ReturnType<typeof mapOrder>;

/** Without read_all_orders, Shopify silently returns only orders created in the last 60 days (no error). */
export class AllOrdersPendingError extends Error {
  constructor(readonly visibleSince: string) {
    super("read_all_orders not granted");
  }
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Orders in one of two modes. Incremental: updated_at ≥ updatedSince, oldest update first. Backfill: created on
 * createdFrom..createdTo inclusive (Shopify reads the dates in the shop's time zone; `< next day` keeps createdTo whole).
 * Shopify's silent 60-day window is detected from the granted scopes (asked in the same query): a backfill reaching past
 * it throws AllOrdersPendingError (→ 403); an incremental read gets a `warning`, since orders created before the window
 * are left out even when updated recently.
 */
export async function fetchOrders(
  s: PartnerStore,
  filter: OrdersFilter,
  cursor: string | null,
  now = Date.now(),
): Promise<Page<PartnerOrder> & { warning?: { code: "read_all_orders_pending"; visibleSince: string } }> {
  const visibleSince = new Date(now - SIXTY_DAYS_MS).toISOString();
  const [query, sortKey] =
    filter.mode === "incremental"
      ? [`updated_at:>='${filter.updatedSince}'`, "UPDATED_AT"]
      : [`created_at:>='${filter.createdFrom}' created_at:<'${nextDay(filter.createdTo)}'`, "CREATED_AT"];
  const reachesPastWindow = filter.mode === "backfill" && Date.parse(`${filter.createdFrom}T00:00:00Z`) < now - BACKFILL_MARGIN_MS;
  let allOrders: boolean | undefined;

  const page = await walk(ORDERS_PAGE_ITEMS, ORDERS_PER_CALL, cursor, async (after, first, have) => {
    const d = await call<OrdersData>(s, first * ORDER_COST, ORDERS_QUERY, { first, after, query, sortKey });
    allOrders = d.currentAppInstallation.accessScopes.some((x) => x.handle === "read_all_orders");
    if (reachesPastWindow && !allOrders) throw new AllOrdersPendingError(visibleSince);
    const items: PartnerOrder[] = [];
    let last = after;
    let forced: Stopped | undefined;
    for (const { cursor: c, node } of d.orders.edges) {
      const lines = await allLineItems(s, node);
      // Complete orders are never dropped. If not even one order of this response is complete, this one is returned with
      // its line items cut (lineItemsTruncated) and the walk goes on, so every attempt moves forward instead of repeating.
      if (lines.stop && have + items.length > 0) return { items, hasNextPage: true, endCursor: last, stop: lines.stop };
      forced ??= lines.stop;
      items.push(mapOrder(node, lines));
      last = c;
    }
    return { items, ...d.orders.pageInfo, stop: d.orders.pageInfo.hasNextPage ? forced : undefined }; // at the end of the list the cut flag is the signal
  });
  if (filter.mode === "incremental" && allOrders === false) {
    return { ...page, warning: { code: "read_all_orders_pending", visibleSince } };
  }
  return page;
}

// ---------- products ----------

const VARIANT = "id sku title price compareAtPrice inventoryQuantity availableForSale";
const PRODUCTS_QUERY = `query PartnerProducts($first: Int!, $after: String) {
  shop { currencyCode }
  products(first: $first, after: $after, query: "status:active", sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node {
      id title handle onlineStoreUrl productType description status vendor tags
      collections(first: ${COLLECTIONS}) { nodes { id title handle } }
      featuredMedia { preview { image { url } } }
      variants(first: ${VARIANTS_PER_CALL}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT} } }
    } }
  }
}`;
const MORE_VARIANTS_QUERY = `query PartnerVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: ${MORE_VARIANTS_PER_CALL}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT} } } }
}`;

type VariantNode = {
  id: string; sku: string | null; title: string; price: string; compareAtPrice: string | null;
  inventoryQuantity: number | null; availableForSale: boolean;
};
type Variants = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VariantNode[] };
type ProductNode = {
  id: string; title: string; handle: string; onlineStoreUrl: string | null; productType: string; description: string;
  vendor: string; tags: string[]; collections: { nodes: { id: string; title: string; handle: string }[] };
  status: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null; variants: Variants;
};

type Variation = { nodes: VariantNode[]; truncated: boolean; stop?: Stopped };

/** Every variant of the product: the rest beyond the first VARIANTS_PER_CALL come from follow-up calls. `truncated` only when a follow-up was stopped (`stop` says why). */
async function allVariants(s: PartnerStore, p: ProductNode): Promise<Variation> {
  const out = [...p.variants.nodes];
  let info = p.variants.pageInfo;
  while (info.hasNextPage && info.endCursor) {
    let d;
    try {
      d = await call<{ product: { variants: Variants } | null }>(s, MORE_VARIANTS_COST, MORE_VARIANTS_QUERY, { id: p.id, after: info.endCursor });
    } catch (e) {
      if (e instanceof Stopped) return { nodes: out, truncated: true, stop: e };
      throw e;
    }
    if (!d.product) break; // deleted mid-read
    out.push(...d.product.variants.nodes);
    info = d.product.variants.pageInfo;
  }
  return { nodes: out, truncated: false };
}

function mapProduct(p: ProductNode, v: Variation, currencyCode: string) {
  const m = (amount: string | null) => (amount === null ? null : { amount, currencyCode });
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    onlineStoreUrl: p.onlineStoreUrl,
    productType: p.productType,
    description: p.description,
    status: p.status,
    vendor: p.vendor,
    tags: p.tags,
    collections: p.collections.nodes.map((c) => ({ id: c.id, title: c.title, handle: c.handle })),
    featuredImageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    variantsTruncated: v.truncated,
    variants: v.nodes.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price: m(v.price)!,
      compareAtPrice: m(v.compareAtPrice),
      inventoryQuantity: v.inventoryQuantity,
      availableForSale: v.availableForSale,
    })),
  };
}
export type PartnerProduct = ReturnType<typeof mapProduct>;

/**
 * ACTIVE products, live from the Admin API so price and stock are current (our synced table has neither stock nor every
 * field, so reading it would still need a live call per page). A product is returned with all its variants unless a
 * follow-up was stopped: complete products are kept and the cursor moves past them; if not even one product is complete the
 * first is returned with `variantsTruncated: true`, so every attempt advances.
 */
export function fetchProducts(s: PartnerStore, cursor: string | null): Promise<Page<PartnerProduct>> {
  return walk(PRODUCTS_PAGE_ITEMS, PRODUCTS_PER_CALL, cursor, async (after, first, have) => {
    const d = await call<{
      shop: { currencyCode: string };
      products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { cursor: string; node: ProductNode }[] };
    }>(s, first * PRODUCT_COST, PRODUCTS_QUERY, { first, after });
    const items: PartnerProduct[] = [];
    let last = after;
    let forced: Stopped | undefined;
    for (const { cursor: c, node } of d.products.edges) {
      const v = await allVariants(s, node);
      if (v.stop && have + items.length > 0) return { items, hasNextPage: true, endCursor: last, stop: v.stop };
      forced ??= v.stop;
      items.push(mapProduct(node, v, d.shop.currencyCode));
      last = c;
    }
    return { items, ...d.products.pageInfo, stop: d.products.pageInfo.hasNextPage ? forced : undefined };
  });
}

// ---------- shop ----------

export async function fetchShop(s: PartnerStore): Promise<{ name: string; currencyCode: string }> {
  const d = await withTimeout(adminGraphql<{ shop: { name: string; currencyCode: string } }>(s.storeId, s.shop, "{ shop { name currencyCode } }"), CALL_MS);
  return { name: d.shop.name, currencyCode: d.shop.currencyCode };
}

// ---------- errors ----------

function graphqlCodes(e: unknown): string[] {
  if (!(e instanceof GraphqlQueryError)) return [];
  const errs = e.body?.errors?.graphQLErrors ?? e.body?.errors;
  return Array.isArray(errs) ? errs.map((x) => x?.extensions?.code).filter(Boolean) : [];
}

/** Maps a failed Shopify read to the response. Logs the message only: the token is in a header, never in an error. */
export function shopifyErrorResponse(e: unknown): Response {
  if (e instanceof AllOrdersPendingError) {
    return partnerJson({ error: "read_all_orders_pending", visibleSince: e.visibleSince }, 403);
  }
  if (e instanceof ReconnectNeededError) return partnerJson({ error: "store_reconnect_needed" }, 503, { "Retry-After": "3600" });
  if (isThrottled(e)) return partnerJson({ error: "shopify_throttled" }, 503, { "Retry-After": "2" });
  if (graphqlCodes(e).includes("ACCESS_DENIED")) return partnerJson({ error: "access_denied" }, 403);
  console.error("partner: Shopify read failed:", e instanceof Error ? e.message : String(e));
  return partnerJson({ error: "upstream_error" }, 502);
}
