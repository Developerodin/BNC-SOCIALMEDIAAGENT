import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { GraphqlQueryError } from "@shopify/shopify-api";

// D70 orders and products: mapping (no PII), the two order modes, pagination, partial reads on throttle, read_all_orders.
const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));
// Records the time limit every partner Shopify call runs under.
const timeouts = vi.hoisted(() => [] as number[]);
vi.mock("@/lib/chat/openai", async (orig) => {
  const m = await orig<typeof import("@/lib/chat/openai")>();
  return { ...m, withTimeout: (p: Promise<unknown>, ms: number, sig?: AbortSignal) => (timeouts.push(ms), m.withTimeout(p, ms, sig)) };
});

const SHOP = "bc-partner.myshopify.com";
const SECRET = "s3cret-partner-value-long-enough";
let admin: ReturnType<typeof postgres>;
let orders: typeof import("@/app/api/partner/orders/route");
let products: typeof import("@/app/api/partner/products/route");
let shop: typeof import("@/app/api/partner/shop/route");
let rl: typeof import("@/lib/rate-limit");
let client: typeof import("@/db/client");
let tokens: typeof import("@/lib/shopify/tokens");
let throttle: typeof import("@/lib/shopify/throttle");
let queries: typeof import("@/lib/partner/queries");
let storeId: string;

beforeAll(async () => {
  orders = await import("@/app/api/partner/orders/route");
  products = await import("@/app/api/partner/products/route");
  shop = await import("@/app/api/partner/shop/route");
  rl = await import("@/lib/rate-limit");
  client = await import("@/db/client");
  tokens = await import("@/lib/shopify/tokens");
  throttle = await import("@/lib/shopify/throttle");
  queries = await import("@/lib/partner/queries");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const [acc] = await admin`insert into accounts default values returning id`;
  const [st] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${SHOP}) returning id`;
  storeId = st.id;
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
  throttle.resetThrottle();
  timeouts.length = 0;
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
  originalUnitPriceSet: bag("50.00"), discountedTotalSet: bag("90.00"), discountedUnitPriceAfterAllDiscountsSet: bag("45.00"),
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
// Shopify's last edge cursor is the page's endCursor; the others are per order.
const edgesOf = (nodes: { id: string }[], endCursor: string | null) =>
  nodes.map((node, i) => ({ cursor: i === nodes.length - 1 && endCursor ? endCursor : `e${node.id.split("/").pop()}`, node }));
const ordersData = (nodes: { id: string }[], hasNextPage: boolean, endCursor: string | null, scopes = ["read_orders", "read_all_orders"]) => ({
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
  orders: { pageInfo: { hasNextPage, endCursor }, edges: edgesOf(nodes, endCursor) },
});
// What adminGraphql does on a THROTTLED error: remembers the bucket as empty.
const throttledCall = async () => {
  throttle.recordThrottled(storeId);
  throw gqlError("THROTTLED");
};
const THROTTLE_STATUS = (currentlyAvailable: number) => ({ throttleStatus: { currentlyAvailable, restoreRate: 50 } });
const orderWithMoreLines = (n: number) => ({ ...orderNode(n), lineItems: lines(1, 10, true, "l10") });
const RESERVE = () => queries.RESERVE;

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
        discountedUnitPriceAfterAllDiscountsSet: { amount: "45.00", currencyCode: "INR" },
      }],
      lineItemsTruncated: false,
    }],
    nextCursor: null,
    complete: true,
  });
  expect(JSON.stringify(body)).not.toMatch(PII_KEY);
});

test("line items: a custom line (no product) hides its title and variant title; quantities and amounts stay", async () => {
  const o = { ...orderNode(1), lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [lineNode(1, { product: null, title: "Cash for Maria", variantTitle: "x" })] } };
  adminGraphql.mockResolvedValueOnce(ordersData([o], false, null));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items[0].lineItems[0]).toMatchObject({
    title: null, variantTitle: null, productId: null, quantity: 2, currentQuantity: 1, discountedTotalSet: { amount: "90.00", currencyCode: "INR" },
  });
  expect(JSON.stringify(body)).not.toContain("Maria");
});

test("line items: a deleted product or variant maps to null ids; no personal key survives even if Shopify sent one", async () => {
  const o = { ...orderNode(1), lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [lineNode(1, { product: null, variant: null, variantTitle: null, sku: null })] } };
  adminGraphql.mockResolvedValueOnce(ordersData([o], false, null));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items[0].lineItems[0]).toMatchObject({ productId: null, variantId: null, title: null, variantTitle: null, sku: null });
  expect(JSON.stringify(body)).not.toMatch(PII_KEY);
});

test("line items beyond the first call come from follow-ups of at most 40; more than 100 are cut with lineItemsTruncated", async () => {
  adminGraphql
    .mockResolvedValueOnce(ordersData([orderWithMoreLines(1)], false, null))
    .mockResolvedValueOnce({ order: { lineItems: lines(11, 40, true, "l50") } })
    .mockResolvedValueOnce({ order: { lineItems: lines(51, 40, true, "l90") } })
    .mockResolvedValueOnce({ order: { lineItems: lines(91, 10, true, "l100") } });
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(body.items[0].lineItems).toHaveLength(100);
  expect(body.items[0].lineItemsTruncated).toBe(true);
  expect(adminGraphql.mock.calls.slice(1).map((c) => c[3])).toEqual([
    { id: "gid://shopify/Order/1", first: 40, after: "l10" },
    { id: "gid://shopify/Order/1", first: 40, after: "l50" },
    { id: "gid://shopify/Order/1", first: 10, after: "l90" },
  ]);

  adminGraphql.mockReset();
  adminGraphql
    .mockResolvedValueOnce(ordersData([orderWithMoreLines(2)], false, null))
    .mockResolvedValueOnce({ order: { lineItems: lines(11, 5) } });
  const exact = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(exact.items[0].lineItems).toHaveLength(15);
  expect(exact.items[0].lineItemsTruncated).toBe(false);
  expect(adminGraphql.mock.calls[1][3].first).toBe(40);
});

test("a throttle on the first order's line-items follow-up returns that order with its lines cut and moves the cursor past it", async () => {
  adminGraphql
    .mockResolvedValueOnce(ordersData([orderWithMoreLines(1)], true, "c1"))
    .mockRejectedValueOnce(gqlError("THROTTLED"));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z&cursor=c0"))).json();
  expect(body).toMatchObject({ nextCursor: "c1", complete: false, rateLimited: true });
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ id: "gid://shopify/Order/1", lineItemsTruncated: true });
  expect(body.items[0].lineItems).toHaveLength(10);
  expect(body.waitMs).toBeUndefined();
});

test("a stopped follow-up keeps the complete orders before it and resumes after the last of them; no wait, no livelock over 3 attempts", async () => {
  const all = [orderNode(1), orderWithMoreLines(2), orderWithMoreLines(3)];
  adminGraphql.mockImplementation(async (_s: string, _d: string, q: string, v: { after: string | null }) => {
    if (q.includes("PartnerLineItems")) {
      throttle.recordThrottled(storeId); // what adminGraphql does on a THROTTLED error
      throw gqlError("THROTTLED");
    }
    const from = v.after === null ? 0 : all.findIndex((o) => `e${o.id.split("/").pop()}` === v.after) + 1;
    const rest = all.slice(from);
    return ordersData(rest, false, null);
  });
  const seen: string[] = [];
  let cursor: string | null = null;
  const attempts: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    throttle.resetThrottle(); // time passed
    const res: Response = await orders.GET(get(`orders?updatedSince=2026-11-01T00:00:00Z${cursor ? `&cursor=${cursor}` : ""}`));
    const body = await res.json();
    attempts.push({ ids: body.items.map((o: { id: string }) => o.id.split("/").pop()), next: body.nextCursor, rl: body.rateLimited ?? false });
    seen.push(...body.items.map((o: { id: string }) => o.id));
    cursor = body.nextCursor;
  }
  // attempt 1: order 1 whole, order 2 not started (it would be held back); 2: order 2 with its lines cut; 3: order 3, the end.
  expect(attempts).toEqual([
    { ids: ["1"], next: "e1", rl: true },
    { ids: ["2"], next: "e2", rl: true },
    { ids: ["3"], next: null, rl: false },
  ]);
  expect(seen).toEqual(all.map((o) => o.id));
});

test("a Shopify call is held back when the bucket cannot cover its cost plus the reserve: nothing is called, rateLimited, Retry-After from the wait", async () => {
  throttle.recordThrottle(storeId, { throttleStatus: { currentlyAvailable: 500, restoreRate: 50 } });
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z&cursor=c0"));
  expect(adminGraphql).not.toHaveBeenCalled();
  expect(res.status).toBe(200);
  // (5 orders × 148 + 1000 − 500) / 50 points a second = 24.8 s
  expect(res.headers.get("retry-after")).toBe("25");
  expect(await res.json()).toEqual({ items: [], nextCursor: "c0", complete: false, rateLimited: true });
  const p = await products.GET(get("products"));
  expect(p.headers.get("retry-after")).toBe("19"); // (5 × 84 + 1000 − 500) / 50 = 18.4 s
  expect(adminGraphql).not.toHaveBeenCalled();
  expect(RESERVE()).toBe(1000);
});

test("the reserve is also checked before each follow-up: orders already complete are returned, the follow-up is not called", async () => {
  adminGraphql.mockImplementationOnce(async () => {
    throttle.recordThrottle(storeId, THROTTLE_STATUS(100));
    return ordersData([orderNode(1), orderWithMoreLines(2)], true, "c2");
  });
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(adminGraphql).toHaveBeenCalledTimes(1);
  // follow-up: 2 + 40 × 9 = 362, + 1000 reserve − 100 available = 1262 / 50 = 25.24 s
  expect(res.headers.get("retry-after")).toBe("26");
  expect(await res.json()).toMatchObject({ items: [{ id: "gid://shopify/Order/1" }], nextCursor: "e1", complete: false, rateLimited: true });
});

test("a timed-out call after items were read is treated like a throttle: whole items so far, rateLimited, Retry-After 2", async () => {
  const timeout = Object.assign(new Error("Timed out"), { name: "TimeoutError" });
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1), orderNode(2)], true, "c2")).mockRejectedValueOnce(timeout);
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(res.status).toBe(200);
  expect(res.headers.get("retry-after")).toBe("2");
  expect(await res.json()).toMatchObject({ nextCursor: "c2", complete: false, rateLimited: true, items: [{ name: "#1001" }, { name: "#1002" }] });
  expect(timeouts.length).toBeGreaterThan(0);
  expect(timeouts.every((ms) => ms === 10_000)).toBe(true);

  adminGraphql.mockReset();
  adminGraphql.mockRejectedValueOnce(timeout); // nothing read yet: an error, as any other failure
  expect((await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).status).toBe(502);

  adminGraphql.mockReset();
  adminGraphql.mockResolvedValueOnce(ordersData([orderWithMoreLines(1)], true, "c1")).mockRejectedValueOnce(timeout);
  const first = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(first).toMatchObject({ nextCursor: "c1", rateLimited: true, items: [{ lineItemsTruncated: true }] }); // the first order still moves on
});

test("the orders query asks for no personal field; the first values sent keep each call's requested cost under Shopify's 1000-point limit (estimate)", async () => {
  adminGraphql
    .mockResolvedValueOnce(ordersData([orderWithMoreLines(1)], false, null))
    .mockResolvedValueOnce({ order: { lineItems: lines(11, 40, true, "l50") } })
    .mockResolvedValueOnce({ order: { lineItems: lines(51, 40, false, null) } });
  await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  const [, , query, vars] = adminGraphql.mock.calls[0];
  expect(query).not.toMatch(PII);
  expect(query).toContain("lineItems(first: 10)");
  expect(query).toContain("discountedUnitPriceAfterAllDiscountsSet");
  expect(vars.first).toBe(5);
  // Same estimate as the comment in queries.ts: a line item 9, an order 56 + 2 + 10 × 9.
  expect(vars.first * (56 + 2 + 10 * 9)).toBeLessThanOrEqual(1000);
  const followUps = adminGraphql.mock.calls.slice(1).map((c) => c[3].first);
  expect(followUps).toEqual([40, 40]);
  for (const f of followUps) expect(2 + f * 9).toBeLessThanOrEqual(1000);
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
  expect(adminGraphql.mock.calls.map((c) => c[3].first)).toEqual([5, 5, 5, 5, 5]);

  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(200)], false, "c10"));
  const last = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z&cursor=c4"))).json();
  expect(last).toMatchObject({ nextCursor: null, complete: true });
  expect(adminGraphql.mock.lastCall![3].after).toBe("c4");
});

test("a response never exceeds 25 orders: the last call asks only for what is missing", async () => {
  const sizes = [3, 5, 5, 5, 5, 2];
  let n = 0;
  sizes.forEach((size, i) => adminGraphql.mockResolvedValueOnce(ordersData(Array.from({ length: size }, () => orderNode(n++)), true, `c${i}`)));
  const body = await (await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).json();
  expect(adminGraphql.mock.calls.map((c) => c[3].first)).toEqual([5, 5, 5, 5, 5, 2]);
  expect(body.items).toHaveLength(25);
  expect(body.nextCursor).toBe("c5");
});

test("Shopify throttling mid-read returns the items so far with rateLimited and the cursor to resume from (200)", async () => {
  adminGraphql.mockResolvedValueOnce(ordersData([orderNode(1), orderNode(2)], true, "c1")).mockRejectedValueOnce(gqlError("THROTTLED"));
  const res = await orders.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"));
  expect(res.status).toBe(200);
  expect(res.headers.get("retry-after")).toBe("2"); // nothing recorded about the bucket: the minimum
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
const productsData = (nodes: { id: string }[], hasNextPage: boolean, endCursor: string | null) => ({
  shop: { currencyCode: "INR" },
  products: { pageInfo: { hasNextPage, endCursor }, edges: edgesOf(nodes, endCursor) },
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
      variantsTruncated: false,
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
  expect(adminGraphql.mock.calls.map((c) => c[3].first)).toEqual(Array(10).fill(5));
  const query = adminGraphql.mock.calls[0][2];
  expect(query).toContain("collections(first: 25)");
  expect(query).not.toMatch(PII);
  expect(adminGraphql.mock.calls[0][3].first * (57 + 2 + 25)).toBeLessThanOrEqual(1000); // estimate, as in queries.ts
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

test("a response never exceeds 50 products: the last call asks only for what is missing", async () => {
  const sizes = [4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1];
  let n = 0;
  sizes.forEach((size, i) => adminGraphql.mockResolvedValueOnce(productsData(Array.from({ length: size }, () => productNode(n++)), true, `p${i}`)));
  const body = await (await products.GET(get("products"))).json();
  expect(adminGraphql.mock.calls.map((c) => c[3].first)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1]);
  expect(body.items).toHaveLength(50);
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

test("products: a stopped variants follow-up on the first product returns it with variantsTruncated and moves the cursor past it", async () => {
  const more = { pageInfo: { hasNextPage: true, endCursor: "v1" }, nodes: [variant(1)] };
  adminGraphql.mockResolvedValueOnce(productsData([productNode(1, more), productNode(2, more)], true, "p2")).mockImplementation(throttledCall);
  const body = await (await products.GET(get("products"))).json();
  expect(body).toMatchObject({ nextCursor: "e1", rateLimited: true, complete: false });
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ id: "gid://shopify/Product/1", variantsTruncated: true });

  // and after a complete product, the next one's stopped follow-up keeps the complete one
  adminGraphql.mockReset();
  throttle.resetThrottle();
  adminGraphql.mockResolvedValueOnce(productsData([productNode(1), productNode(2, more)], true, "p2")).mockImplementation(throttledCall);
  const kept = await (await products.GET(get("products"))).json();
  expect(kept).toMatchObject({ nextCursor: "e1", rateLimited: true });
  expect(kept.items.map((p: { id: string }) => p.id)).toEqual(["gid://shopify/Product/1"]);
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
