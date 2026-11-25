import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { GraphqlQueryError } from "@shopify/shopify-api";

// D70 orders and products: mapping (no PII), the two order modes, pagination, partial reads on throttle, read_all_orders.
const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));

const SHOP = "bc-partner.myshopify.com";
const SECRET = "s3cret-partner-value-long-enough";
let admin: ReturnType<typeof postgres>;
let orders: typeof import("@/app/api/partner/orders/route");
let products: typeof import("@/app/api/partner/products/route");
let shop: typeof import("@/app/api/partner/shop/route");
let rl: typeof import("@/lib/rate-limit");
let client: typeof import("@/db/client");
let tokens: typeof import("@/lib/shopify/tokens");

beforeAll(async () => {
  orders = await import("@/app/api/partner/orders/route");
  products = await import("@/app/api/partner/products/route");
  shop = await import("@/app/api/partner/shop/route");
  rl = await import("@/lib/rate-limit");
  client = await import("@/db/client");
  tokens = await import("@/lib/shopify/tokens");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const [acc] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${SHOP})`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  vi.stubEnv("PARTNER_STORE_DOMAIN", SHOP);
  vi.stubEnv("PARTNER_API_SECRET", SECRET);
  rl.resetRateLimit();
  adminGraphql.mockReset();
});

const get = (path: string) => new Request(`http://x/api/partner/${path}`, { headers: { authorization: `Bearer ${SECRET}` } });
const gqlError = (code: string) =>
  new GraphqlQueryError({ message: code, response: {} as never, body: { errors: { graphQLErrors: [{ extensions: { code } }] } } as never });
const bag = (amount: string) => ({ shopMoney: { amount, currencyCode: "INR" }, presentmentMoney: { amount: "9", currencyCode: "USD" } });
const PII = /customer|email|phone|address|firstName|lastName/i;
// No personal key anywhere in a response (values such as a product title are not keys).
const PII_KEY = /"[^"]*(customer|email|phone|address|firstName|lastName|note)[^"]*"\s*:/i;
const lineNode = (n: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/LineItem/${n}`, title: `Shirt ${n}`, variantTitle: "M", sku: `SKU-${n}`, quantity: 2, currentQuantity: 1,
  product: { id: `gid://shopify/Product/${n}` }, variant: { id: `gid://shopify/ProductVariant/${n}` },
  originalUnitPriceSet: bag("50.00"), discountedTotalSet: bag("90.00"),
  // never requested; the mapper must drop them anyway
  customAttributes: [{ key: "note", value: "x" }], taxLines: [], customer: { email: "a@b.c" },
  ...over,
});
const lines = (from: number, count: number, hasNextPage = false, endCursor: string | null = null) => ({
  pageInfo: { hasNextPage, endCursor }, nodes: Array.from({ length: count }, (_, i) => lineNode(from + i)),
});

function orderNode(n: number) {
  return {
    id: `gid://shopify/Order/${n}`, name: `#${1000 + n}`, processedAt: "2026-11-02T10:00:00Z", createdAt: "2026-11-02T10:00:00Z",
    cancelledAt: null, test: false, updatedAt: "2026-11-03T10:00:00Z", taxesIncluded: true, sourceName: "web",
    currentSubtotalPriceSet: bag("100.00"), currentTotalDiscountsSet: bag("10.00"), currentShippingPriceSet: bag("5.00"),
    currentTotalPriceSet: bag("95.00"), totalRefundedSet: bag("0.00"),
    currentTaxLines: [{ title: "GST", rate: 0.18, priceSet: bag("14.49"), channelLiable: false }],
    shippingLines: { nodes: [{ title: "Standard", originalPriceSet: bag("5.00"), discountedPriceSet: bag("5.00"), taxLines: [] }] },
    displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PAID", discountCodes: ["SAVE10"],
    lineItems: lines(1, 1),
    // Fields Shopify would never send for our query; the mapper must drop them anyway.
    customer: { email: "a@b.c", phone: "+1", firstName: "A" }, email: "a@b.c", shippingAddress: { address1: "x" },
    billingAddress: { address1: "y" }, note: "leave at door", phone: "+1",
  };
}
const ordersData = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null, scopes = ["read_orders", "read_all_orders"]) => ({
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
  orders: { pageInfo: { hasNextPage, endCursor }, nodes },
});

// ---------- orders ----------

test("incremental mode: updated_at filter, UPDATED_AT sort, exact field mapping with money in shop currency and no PII", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1)], false, "c1"));
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T05:30:00%2B05:30"));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  const vars = adminGraphql.mock.calls[0][3];
  expect(vars).toMatchObject({ query: "updated_at:>='2026-11-01T00:00:00.000Z'", sortKey: "UPDATED_AT", after: null });
  expect(adminGraphql.mock.calls[0][2]).not.toMatch(PII);
  expect(body).toEqual({
    items: [{
      id: "gid://shopify/Order/1", name: "#1001", processedAt: "2026-11-02T10:00:00Z", createdAt: "2026-11-02T10:00:00Z",
      cancelledAt: null, test: false, updatedAt: "2026-11-03T10:00:00Z", taxesIncluded: true, sourceName: "web",
      currentSubtotalPriceSet: { amount: "100.00", currencyCode: "INR" },
      currentTotalDiscountsSet: { amount: "10.00", currencyCode: "INR" },
      currentShippingPriceSet: { amount: "5.00", currencyCode: "INR" },
      currentTotalPriceSet: { amount: "95.00", currencyCode: "INR" },
      totalRefundedSet: { amount: "0.00", currencyCode: "INR" },
      currentTaxLines: [{ title: "GST", rate: 0.18, priceSet: { amount: "14.49", currencyCode: "INR" } }],
      shippingLines: [{
        title: "Standard", originalPriceSet: { amount: "5.00", currencyCode: "INR" },
        discountedPriceSet: { amount: "5.00", currencyCode: "INR" }, taxLines: [],
      }],
      displayFulfillmentStatus: "UNFULFILLED", displayFinancialStatus: "PAID", discountCodes: ["SAVE10"],
      lineItems: [{
        id: "gid://shopify/LineItem/1", title: "Shirt 1", variantTitle: "M", sku: "SKU-1", quantity: 2, currentQuantity: 1,
        productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1",
        originalUnitPriceSet: { amount: "50.00", currencyCode: "INR" }, discountedTotalSet: { amount: "90.00", currencyCode: "INR" },
      }],
      lineItemsTruncated: false,
    }],
    nextCursor: null,
    complete: true,
  });
  expect(JSON.stringify(body)).not.toMatch(PII_KEY);
});

test("line items: a deleted product or variant maps to null ids; no personal key survives even if Shopify sent one", async () => {
  const o = { ...orderNode(1), lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [lineNode(1, { product: null, variant: null, variantTitle: null, sku: null })] } };
  adminGraphql.mockResolvedValueOnce(ordersData([o], false, null));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items[0].lineItems[0]).toMatchObject({ productId: null, variantId: null, variantTitle: null, sku: null });
  expect(JSON.stringify(body)).not.toMatch(PII_KEY);
});

test("line items beyond the first call are fetched by follow-up calls; more than 100 are cut with lineItemsTruncated", async () => {
  const o = { ...orderNode(1), lineItems: lines(1, 10, true, "l10") };
  adminGraphql
    .mockResolvedValueOnce(ordersData([o], false, null))
    .mockResolvedValueOnce({ order: { lineItems: lines(11, 90, true, "l100") } });
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items[0].lineItems).toHaveLength(100);
  expect(body.items[0].lineItemsTruncated).toBe(true);
  expect(adminGraphql.mock.calls[1][3]).toEqual({ id: "gid://shopify/Order/1", first: 90, after: "l10" });

  adminGraphql.mockReset();
  adminGraphql
    .mockResolvedValueOnce(ordersData([{ ...orderNode(2), lineItems: lines(1, 10, true, "l10") }], false, null))
    .mockResolvedValueOnce({ order: { lineItems: lines(11, 5) } });
  const exact = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(exact.items[0].lineItems).toHaveLength(15);
  expect(exact.items[0].lineItemsTruncated).toBe(false);
});

test("a throttle on the line-items follow-up drops that Shopify page and resumes from its start", async () => {
  adminGraphql
    .mockResolvedValueOnce(ordersData([{ ...orderNode(1), lineItems: lines(1, 10, true, "l10") }], true, "c1"))
    .mockRejectedValueOnce(gqlError("THROTTLED"));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z&cursor=c0"))).json();
  expect(body).toMatchObject({ items: [], nextCursor: "c0", complete: false, rateLimited: true });
});

test("the orders query asks for no personal field and stays under Shopify's 1000-point limit (estimate)", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([], false, null));
  await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  const [, , query, vars] = adminGraphql.mock.calls[0];
  expect(query).not.toMatch(PII);
  expect(query).toContain("lineItems(first: 10)");
  // Same estimate as the comment in queries.ts: base 56 + (2 + 10 * 7) per order.
  expect(vars.first * (56 + 2 + 10 * 7)).toBeLessThanOrEqual(1000);
  expect(2 + 90 * 7).toBeLessThanOrEqual(1000); // the line-items follow-up
});

test("backfill mode: inclusive created_at range, CREATED_AT sort, cursor passed through", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([], false, null));
  const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const res = await orders.GET(get(`orders?createdFrom=${from}&createdTo=2099-12-31&cursor=abc%3D%3D`));
  expect(res.status).toBe(200);
  expect(adminGraphql.mock.calls[0][3]).toMatchObject({
    query: `created_at:>='${from}' created_at:<'2100-01-01'`, sortKey: "CREATED_AT", after: "abc==",
  });
});

test("a page is 25 orders gathered from several Shopify calls; nextCursor resumes, complete only at the end", async () => {
  for (let p = 0; p < 5; p++) adminGraphql.mockResolvedValueOnce(ordersData(Array.from({ length: 5 }, (_, i) => orderNode(p * 5 + i)), true, `c${p}`));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items).toHaveLength(25);
  expect(body).toMatchObject({ nextCursor: "c4", complete: false });
  expect(body.rateLimited).toBeUndefined();
  expect(adminGraphql.mock.calls.map((c) => c[3].after)).toEqual([null, "c0", "c1", "c2", "c3"]);
  expect(adminGraphql.mock.calls[0][3].first).toBe(5);

  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(200)], false, "c10"));
  const last = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z&cursor=c4"))).json();
  expect(last).toMatchObject({ nextCursor: null, complete: true });
  expect(adminGraphql.mock.lastCall![3].after).toBe("c4");
});

test("Shopify throttling mid-read returns the items so far with rateLimited and the cursor to resume from (200)", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1), orderNode(2)], true, "c1")).mockRejectedValueOnce(gqlError("THROTTLED"));
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(res.status).toBe(200);
  expect(res.headers.get("retry-after")).toBe("2");
  expect(await res.json()).toMatchObject({ nextCursor: "c1", complete: false, rateLimited: true, items: [{ name: "#1001" }, { name: "#1002" }] });
});

test("a backfill reaching past 60 days without read_all_orders is 403 with a reason, not a silently short list", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1)], false, null, ["read_orders"]));
  const res = await orders.GET(get("orders?createdFrom=2020-01-01&createdTo=2026-11-01"));
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe("read_all_orders_pending");
  expect(Date.parse(body.visibleSince)).toBeGreaterThan(Date.now() - 61 * 86_400_000);

  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1)], false, null));
  expect((await orders.GET(get("orders?createdFrom=2020-01-01&createdTo=2026-11-01"))).status).toBe(200);
});

test("the 60-day boundary has a day's margin for the shop's time zone: 60 days back is read, 62 days back is 403", async () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const today = daysAgo(0);
  adminGraphql.mockResolvedValue(ordersData([orderNode(1)], false, null, ["read_orders"]));
  expect((await orders.GET(get(`orders?createdFrom=${daysAgo(60)}&createdTo=${today}`))).status).toBe(200);
  expect((await orders.GET(get(`orders?createdFrom=${daysAgo(62)}&createdTo=${today}`))).status).toBe(403);
});

test("an incremental read without read_all_orders carries a warning, since older orders are left out", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1)], false, null, ["read_orders"]));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.warning).toMatchObject({ code: "read_all_orders_pending" });
  expect(body.items).toHaveLength(1);
});

test("Shopify ACCESS_DENIED is 403; a reconnect-needed store is 503 with Retry-After", async () => {
  adminGraphql.mockRejectedValueOnce(gqlError("ACCESS_DENIED"));
  const denied = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "access_denied" });

  adminGraphql.mockRejectedValueOnce(new tokens.ReconnectNeededError("x"));
  const re = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(re.status).toBe(503);
  expect(re.headers.get("retry-after")).toBeTruthy();
});

test.each([
  ["orders", "mode_required"],
  ["orders?updatedSince=2026-11-01T00:00:00Z&createdFrom=2026-11-01&createdTo=2026-11-02", "one_mode_only"],
  ["orders?updatedSince=2026-11-01", "invalid_updatedSince"],
  ["orders?updatedSince=2026-11-01T00:00:00", "invalid_updatedSince"],
  ["orders?updatedSince=yesterday", "invalid_updatedSince"],
  ["orders?createdFrom=2026-11-01", "invalid_createdTo"],
  ["orders?createdTo=2026-11-01", "invalid_createdFrom"],
  ["orders?createdFrom=2026-02-30&createdTo=2026-03-01", "invalid_createdFrom"],
  ["orders?createdFrom=2026/11/01&createdTo=2026-11-02", "invalid_createdFrom"],
  ["orders?createdFrom=2026-11-05&createdTo=2026-11-01", "createdFrom_after_createdTo"],
  ["orders?createdFrom=2026-11-01&createdTo=2026-11-02&cursor=a'b", "invalid_cursor"],
  [`orders?updatedSince=2026-11-01T00:00:00Z&cursor=${"a".repeat(1025)}`, "invalid_cursor"],
  ["products?cursor=", "invalid_cursor"],
  ["products?cursor=x%20y", "invalid_cursor"],
])("GET %s is 400 %s, without calling Shopify", async (path, error) => {
  const route = path.startsWith("orders") ? orders : products;
  const res = await route.GET(get(path));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error });
  expect(adminGraphql).not.toHaveBeenCalled();
});

// ---------- products ----------

const variant = (n: number) => ({
  id: `gid://shopify/ProductVariant/${n}`, sku: `SKU-${n}`, title: `V${n}`, price: "499.00", compareAtPrice: n === 1 ? "599.00" : null,
  inventoryQuantity: 7, availableForSale: true,
});
const productNode = (n: number, variants = { pageInfo: { hasNextPage: false, endCursor: null as string | null }, nodes: [variant(1)] }) => ({
  id: `gid://shopify/Product/${n}`, title: `P${n}`, handle: `p-${n}`, onlineStoreUrl: `https://bc.example/products/p-${n}`,
  productType: "Shirt", description: "Plain text.", status: "ACTIVE", vendor: "Bois", tags: ["linen", "summer"],
  collections: { nodes: [{ id: "gid://shopify/Collection/5", title: "Shirts", handle: "shirts", description: "x" }] },
  featuredMedia: { preview: { image: { url: `https://cdn.example/${n}.jpg` } } }, variants,
});
const productsData = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  shop: { currencyCode: "INR" },
  products: { pageInfo: { hasNextPage, endCursor }, nodes },
});

test("products: ACTIVE only, exact mapping with money in shop currency, complete on the last page", async () => {
  adminGraphql.mockResolvedValueOnce(productsData([productNode(1)], false, "p1"));
  const res = await products.GET(get("products"));
  expect(res.status).toBe(200);
  expect(adminGraphql.mock.calls[0][2]).toContain('query: "status:active"');
  expect(await res.json()).toEqual({
    items: [{
      id: "gid://shopify/Product/1", title: "P1", handle: "p-1", onlineStoreUrl: "https://bc.example/products/p-1",
      productType: "Shirt", description: "Plain text.", status: "ACTIVE", featuredImageUrl: "https://cdn.example/1.jpg",
      vendor: "Bois", tags: ["linen", "summer"], collections: [{ id: "gid://shopify/Collection/5", title: "Shirts", handle: "shirts" }],
      variants: [{
        id: "gid://shopify/ProductVariant/1", sku: "SKU-1", title: "V1", price: { amount: "499.00", currencyCode: "INR" },
        compareAtPrice: { amount: "599.00", currencyCode: "INR" }, inventoryQuantity: 7, availableForSale: true,
      }],
    }],
    nextCursor: null,
    complete: true,
  });
});

test("products: a page is 50 products from calls of 5; the query asks for the first 25 collections and nothing personal", async () => {
  for (let p = 0; p < 10; p++) adminGraphql.mockResolvedValueOnce(productsData(Array.from({ length: 5 }, (_, i) => productNode(p * 5 + i)), true, `p${p}`));
  const body = await (await products.GET(get("products"))).json();
  expect(body.items).toHaveLength(50);
  expect(body).toMatchObject({ nextCursor: "p9", complete: false });
  const query = adminGraphql.mock.calls[0][2];
  expect(query).toContain("collections(first: 25)");
  expect(query).not.toMatch(PII);
  expect(5 * (57 + 2 + 25)).toBeLessThanOrEqual(1000); // estimate, as in queries.ts
  expect(JSON.stringify(body)).not.toMatch(PII_KEY);
});

test("products: variants beyond the first call are fetched, so every product is whole", async () => {
  const first = { pageInfo: { hasNextPage: true, endCursor: "v1" }, nodes: [variant(1)] };
  adminGraphql
    .mockResolvedValueOnce(productsData([productNode(1, first)], false, null))
    .mockResolvedValueOnce({ product: { variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [variant(2), variant(3)] } } });
  const body = await (await products.GET(get("products"))).json();
  expect(body.items[0].variants.map((v: { sku: string }) => v.sku)).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
  expect(adminGraphql.mock.calls[1][3]).toEqual({ id: "gid://shopify/Product/1", after: "v1" });
});

test("products: a throttle mid-walk keeps only whole pages, complete false, and resumes from the failed page", async () => {
  const more = { pageInfo: { hasNextPage: true, endCursor: "v1" }, nodes: [variant(1)] };
  adminGraphql
    .mockResolvedValueOnce(productsData([productNode(1)], true, "p1"))
    .mockResolvedValueOnce(productsData([productNode(2, more)], true, "p2"))
    .mockRejectedValueOnce(gqlError("THROTTLED")); // the extra-variants call for product 2
  const res = await products.GET(get("products?cursor=p0"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ complete: false, rateLimited: true, nextCursor: "p1" });
  expect(body.items.map((p: { id: string }) => p.id)).toEqual(["gid://shopify/Product/1"]);
  expect(adminGraphql.mock.calls[0][3]).toEqual({ first: 5, after: "p0" });
});

// ---------- shop ----------

test("shop: name and currency; a throttle here (nothing partial to return) is 503 with Retry-After", async () => {
  adminGraphql.mockResolvedValueOnce({ shop: { name: "B&C", currencyCode: "INR", email: "owner@x" } });
  expect(await (await shop.GET(get("shop"))).json()).toEqual({ name: "B&C", currencyCode: "INR" });
  adminGraphql.mockRejectedValueOnce(gqlError("THROTTLED"));
  const res = await shop.GET(get("shop"));
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("2");
});
