import { GraphqlQueryError } from "@shopify/shopify-api";
import { adminGraphql } from "@/lib/shopify/admin";
import { isThrottled } from "@/lib/shopify/live-products";
import { ReconnectNeededError } from "@/lib/shopify/tokens";
import { partnerJson, type PartnerStore } from "./auth";
import type { OrdersFilter } from "./params";

// D70 partner reads. Everything is read live from Shopify per request and nothing is stored (D73). Only the fields the
// Social Media Agent asked for: no customer, email, phone, address or line item ever enters a query, so none can leak.

/** Items per response (the consumer's contract). */
export const PAGE_ITEMS = 100;
// Shopify refuses a single query whose requested cost is over 1000 points (connection = 2 + first × node cost, each
// object 1). So a response is several smaller Shopify pages, each a multiple of PAGE_ITEMS so a response never splits one:
// orders ≈ 1 + 10 money objects + tax lines + shippingLines(5) ≈ 56 each → 10 per call (~560);
// products ≈ 1 + featuredMedia 3 + variants(50) ≈ 57 each → 10 per call (~570).
// ponytail: up to 10 sequential Shopify calls per response (~2–4 s). If that is too slow, raise the sub-page size by
// trimming fields, or move backfills to a bulk operation.
const ORDERS_PER_CALL = 10;
const SHIPPING_LINES = 5; // ponytail: an order with more than 5 shipping lines loses the rest; none exist in practice.
const PRODUCTS_PER_CALL = 10;
const VARIANTS_PER_CALL = 50;
const MORE_VARIANTS_PER_CALL = 250;
const SIXTY_DAYS_MS = 60 * 86_400_000;

export type Money = { amount: string; currencyCode: string };
export type Page<T> = { items: T[]; nextCursor: string | null; complete: boolean; rateLimited?: boolean };

type Bag = { shopMoney: Money } | null;
const money = (b: Bag): Money | null => (b ? { amount: b.shopMoney.amount, currencyCode: b.shopMoney.currencyCode } : null);
const MONEY = "shopMoney { amount currencyCode }";
type TaxLine = { title: string; rate: number | null; priceSet: Bag };
const taxLine = (t: TaxLine) => ({ title: t.title, rate: t.rate, priceSet: money(t.priceSet) });
const TAX_LINE = `title rate priceSet { ${MONEY} }`;

/**
 * Reads Shopify pages from `cursor` until PAGE_ITEMS items or the end. `complete` is true only when the walk reached the
 * end. A throttle returns the items so far with `rateLimited` and the cursor to resume from (the start of the page that
 * failed; null when that was the first page), so the consumer can stop and resume later.
 */
async function walk<T>(
  cursor: string | null,
  fetchPage: (after: string | null) => Promise<{ items: T[]; hasNextPage: boolean; endCursor: string | null }>,
): Promise<Page<T>> {
  const items: T[] = [];
  let after = cursor;
  while (items.length < PAGE_ITEMS) {
    let page;
    try {
      page = await fetchPage(after);
    } catch (e) {
      if (isThrottled(e)) return { items, nextCursor: after, complete: false, rateLimited: true };
      throw e;
    }
    items.push(...page.items);
    if (!page.hasNextPage || !page.endCursor) return { items, nextCursor: null, complete: true };
    after = page.endCursor;
  }
  return { items, nextCursor: after, complete: false };
}

// ---------- orders ----------

const ORDERS_QUERY = `query PartnerOrders($first: Int!, $after: String, $query: String!, $sortKey: OrderSortKeys!) {
  currentAppInstallation { accessScopes { handle } }
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt createdAt cancelledAt test updatedAt taxesIncluded sourceName
      currentSubtotalPriceSet { ${MONEY} }
      currentTotalDiscountsSet { ${MONEY} }
      currentShippingPriceSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalRefundedSet { ${MONEY} }
      currentTaxLines { ${TAX_LINE} }
      shippingLines(first: ${SHIPPING_LINES}) {
        nodes { title originalPriceSet { ${MONEY} } discountedPriceSet { ${MONEY} } taxLines { ${TAX_LINE} } }
      }
    }
  }
}`;

type OrderNode = {
  id: string; name: string; processedAt: string; createdAt: string; cancelledAt: string | null; test: boolean;
  updatedAt: string; taxesIncluded: boolean; sourceName: string | null;
  currentSubtotalPriceSet: Bag; currentTotalDiscountsSet: Bag; currentShippingPriceSet: Bag; currentTotalPriceSet: Bag;
  totalRefundedSet: Bag; currentTaxLines: TaxLine[];
  shippingLines: { nodes: { title: string; originalPriceSet: Bag; discountedPriceSet: Bag; taxLines: TaxLine[] }[] };
};
type OrdersData = {
  currentAppInstallation: { accessScopes: { handle: string }[] };
  orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: OrderNode[] };
};

/** Built from explicit fields, so a field added to the query never reaches the consumer by accident. */
function mapOrder(o: OrderNode) {
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
  const reachesPastWindow = filter.mode === "backfill" && Date.parse(`${filter.createdFrom}T00:00:00Z`) < now - SIXTY_DAYS_MS;
  let allOrders: boolean | undefined;

  const page = await walk(cursor, async (after) => {
    const d = await adminGraphql<OrdersData>(s.storeId, s.shop, ORDERS_QUERY, { first: ORDERS_PER_CALL, after, query, sortKey });
    allOrders = d.currentAppInstallation.accessScopes.some((x) => x.handle === "read_all_orders");
    if (reachesPastWindow && !allOrders) throw new AllOrdersPendingError(visibleSince);
    return { items: d.orders.nodes.map(mapOrder), ...d.orders.pageInfo };
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
    nodes {
      id title handle onlineStoreUrl productType description status
      featuredMedia { preview { image { url } } }
      variants(first: ${VARIANTS_PER_CALL}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT} } }
    }
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
  status: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null; variants: Variants;
};

/** Every variant of the product: the rest beyond the first VARIANTS_PER_CALL come from follow-up calls. */
async function allVariants(s: PartnerStore, p: ProductNode): Promise<VariantNode[]> {
  const out = [...p.variants.nodes];
  let info = p.variants.pageInfo;
  while (info.hasNextPage && info.endCursor) {
    const d = await adminGraphql<{ product: { variants: Variants } | null }>(s.storeId, s.shop, MORE_VARIANTS_QUERY, {
      id: p.id,
      after: info.endCursor,
    });
    if (!d.product) break; // deleted mid-read
    out.push(...d.product.variants.nodes);
    info = d.product.variants.pageInfo;
  }
  return out;
}

function mapProduct(p: ProductNode, variants: VariantNode[], currencyCode: string) {
  const m = (amount: string | null) => (amount === null ? null : { amount, currencyCode });
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    onlineStoreUrl: p.onlineStoreUrl,
    productType: p.productType,
    description: p.description,
    status: p.status,
    featuredImageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    variants: variants.map((v) => ({
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
 * field, so reading it would still need a live call per page). A product is only returned with all its variants: a
 * throttle while fetching extra variants drops that whole Shopify page and resumes from its start.
 */
export function fetchProducts(s: PartnerStore, cursor: string | null): Promise<Page<PartnerProduct>> {
  return walk(cursor, async (after) => {
    const d = await adminGraphql<{
      shop: { currencyCode: string };
      products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProductNode[] };
    }>(s.storeId, s.shop, PRODUCTS_QUERY, { first: PRODUCTS_PER_CALL, after });
    const items: PartnerProduct[] = [];
    for (const p of d.products.nodes) items.push(mapProduct(p, await allVariants(s, p), d.shop.currencyCode));
    return { items, ...d.products.pageInfo };
  });
}

// ---------- shop ----------

export async function fetchShop(s: PartnerStore): Promise<{ name: string; currencyCode: string }> {
  const d = await adminGraphql<{ shop: { name: string; currencyCode: string } }>(s.storeId, s.shop, "{ shop { name currencyCode } }");
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
