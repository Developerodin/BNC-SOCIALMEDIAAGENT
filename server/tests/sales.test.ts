import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "./helpers/seed";

// D95: the daily sales snapshot (src/lib/sales.ts). Admin GraphQL is mocked; the tables are the real test database.

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));
const enqueue = vi.fn();
vi.mock("@/lib/jobs", () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

let admin: ReturnType<typeof postgres>;
let sales: typeof import("@/lib/sales");
let client: typeof import("@/db/client");
let throttle: typeof import("@/lib/shopify/throttle");
let gql: ReturnType<typeof vi.fn>;

const P = (n: number) => `gid://shopify/Product/${n}`;
const line = (n: number | null, q: number) => ({ currentQuantity: q, product: n === null ? null : { id: P(n) } });
const order = (o: { id?: string; cancelledAt?: string | null; test?: boolean; lines: ReturnType<typeof line>[]; more?: string }) => ({
  id: o.id ?? "gid://shopify/Order/1",
  cancelledAt: o.cancelledAt ?? null,
  test: o.test ?? false,
  lineItems: { pageInfo: { hasNextPage: !!o.more, endCursor: o.more ?? null }, nodes: o.lines },
});
const page = (nodes: ReturnType<typeof order>[], next: string | null = null) => ({ orders: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } });
const noSleep = async () => {};

beforeAll(async () => {
  sales = await import("@/lib/sales");
  client = await import("@/db/client");
  throttle = await import("@/lib/shopify/throttle");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  gql.mockReset();
  enqueue.mockReset();
  throttle.resetThrottle();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("net quantities are summed per product across orders, and an order counts once per product", async () => {
  gql.mockResolvedValueOnce(
    page(
      [
        order({ lines: [line(1, 2), line(1, 1), line(2, 1)] }), // two lines of product 1 in one order: 3 units, 1 order
        order({ lines: [line(1, 4), line(3, 0)] }), // product 3 fully refunded: not counted
      ],
      "c1",
    ),
  ).mockResolvedValueOnce(page([order({ lines: [line(2, 5)] })]));
  const sold = await sales.readSales("s", "x.myshopify.com", new Date("2026-11-25T03:00:00Z"), noSleep);
  expect(Object.fromEntries(sold)).toEqual({ [P(1)]: { units: 7, orders: 2 }, [P(2)]: { units: 6, orders: 2 } });
  expect(gql.mock.calls[0][3].query).toBe("created_at:>='2026-10-26T03:00:00.000Z'"); // 30 days back
  expect(gql.mock.calls[1][3].after).toBe("c1");
});

test("cancelled and test orders, and lines with no product, are left out", async () => {
  gql.mockResolvedValueOnce(
    page([
      order({ cancelledAt: "2026-11-01T00:00:00Z", lines: [line(1, 9)] }),
      order({ test: true, lines: [line(1, 9)] }),
      order({ lines: [line(null, 3), line(2, 1)] }), // a custom line typed by the merchant
    ]),
  );
  const sold = await sales.readSales("s", "x.myshopify.com", new Date(), noSleep);
  expect(Object.fromEntries(sold)).toEqual({ [P(2)]: { units: 1, orders: 1 } });
});

test("an order with more lines than the first call gets follow-up calls, but a cancelled one does not", async () => {
  gql
    .mockResolvedValueOnce(page([order({ id: "gid://shopify/Order/7", lines: [line(1, 1)], more: "l1" }), order({ cancelledAt: "2026-11-01T00:00:00Z", lines: [line(5, 1)], more: "l9" })]))
    .mockResolvedValueOnce({ order: { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(2, 2)] } } });
  const sold = await sales.readSales("s", "x.myshopify.com", new Date(), noSleep);
  expect(Object.fromEntries(sold)).toEqual({ [P(1)]: { units: 1, orders: 1 }, [P(2)]: { units: 2, orders: 1 } });
  expect(gql).toHaveBeenCalledTimes(2);
  expect(gql.mock.calls[1][3]).toMatchObject({ id: "gid://shopify/Order/7", after: "l1" });
});

test("the query asks for no customer data, and the table has nowhere to keep any", async () => {
  gql.mockResolvedValueOnce(page([]));
  await sales.readSales("s", "x.myshopify.com", new Date(), noSleep);
  const q: string = gql.mock.calls[0][2];
  expect(q).not.toMatch(/customer|email|phone|address|name|note|billing|shipping|price|total/i);
  const cols = await admin`select column_name from information_schema.columns where table_name = 'product_sales' order by column_name`;
  expect(cols.map((c) => c.column_name)).toEqual(["order_count", "period_end", "product_id", "store_id", "units"]);
});

test("a call waits for the shared Shopify bucket to hold its cost plus the 1000-point reserve, and gives up past the time budget", async () => {
  gql.mockResolvedValue(page([]));
  throttle.recordThrottle("s", { throttleStatus: { currentlyAvailable: 600, restoreRate: 50 } });
  const sleeps: number[] = [];
  await sales.readSales("s", "x.myshopify.com", new Date(), async (ms) => {
    sleeps.push(ms);
    throttle.recordThrottle("s", { throttleStatus: { currentlyAvailable: 5000, restoreRate: 50 } }); // the bucket refilled
  });
  // needs 462 + 1000 = 1462; has 600 at 50/s: about 17 s
  expect(sleeps).toHaveLength(1);
  expect(sleeps[0]).toBeGreaterThan(16_000);
  expect(sleeps[0]).toBeLessThan(18_000);

  throttle.recordThrottle("s", { throttleStatus: { currentlyAvailable: 0, restoreRate: 1 } }); // 1,462 s to refill: past the 10-minute budget
  await expect(sales.readSales("s", "x.myshopify.com", new Date(), noSleep)).rejects.toThrow(/bucket stayed low/);
});

test("saveSales replaces the whole snapshot, keeps aggregates only, and stamps the store", async () => {
  const id = await newStore(admin);
  const end = new Date("2026-11-25T03:00:00Z");
  await sales.saveSales(id, new Map([[P(1), { units: 5, orders: 3 }], [P(2), { units: 9, orders: 1 }]]), end);
  expect(await admin`select product_id, units, order_count from product_sales where store_id = ${id} order by units desc`).toMatchObject([
    { product_id: P(2), units: 9, order_count: 1 },
    { product_id: P(1), units: 5, order_count: 3 },
  ]);
  const [s1] = await admin`select sales_snapshot_at from stores where id = ${id}`;
  expect(s1.sales_snapshot_at).toEqual(end);

  await sales.saveSales(id, new Map([[P(3), { units: 1, orders: 1 }]]), new Date("2026-11-26T03:00:00Z"));
  expect((await admin`select product_id from product_sales where store_id = ${id}`).map((r) => r.product_id)).toEqual([P(3)]); // latest snapshot only

  await sales.saveSales(id, new Map(), new Date("2026-11-27T03:00:00Z")); // a month with no sales empties it, but the run is recorded
  expect(await admin`select 1 from product_sales where store_id = ${id}`).toHaveLength(0);
  expect((await admin`select sales_snapshot_at from stores where id = ${id}`)[0].sales_snapshot_at).not.toBeNull();
});

test("only the top 200 products by units are kept", async () => {
  const id = await newStore(admin);
  const many = new Map(Array.from({ length: 250 }, (_, i) => [P(i), { units: i + 1, orders: 1 }] as const));
  expect(await sales.saveSales(id, many, new Date())).toBe(200);
  const [m] = await admin`select min(units)::int as min from product_sales where store_id = ${id}`;
  expect(m.min).toBe(51);
});

test("product_sales is isolated by store (RLS)", async () => {
  const a = await newStore(admin);
  const b = await newStore(admin);
  await sales.saveSales(a, new Map([[P(1), { units: 5, orders: 1 }]]), new Date());
  await sales.saveSales(b, new Map([[P(2), { units: 7, orders: 1 }]]), new Date());
  const { productSales } = await import("@/db/schema");
  const seenByA = await client.forStore(a, (tx) => tx.select().from(productSales));
  expect(seenByA.map((r) => r.productId)).toEqual([P(1)]);
  expect(await client.db.select().from(productSales)).toHaveLength(0); // no store set: no rows
  // A write for another store is refused.
  await expect(client.forStore(a, (tx) => tx.insert(productSales).values({ storeId: b, productId: P(9), units: 1, orderCount: 1, periodEnd: new Date() }))).rejects.toThrow();
});

test("snapshotSales runs the whole read-and-save for an installed store, and skips inactive, MCP and unknown stores", async () => {
  const id = await newStore(admin);
  gql.mockResolvedValueOnce(page([order({ lines: [line(1, 2)] })]));
  expect(await sales.snapshotSales({ storeId: id })).toEqual({ products: 1 });
  expect((await admin`select units from product_sales where store_id = ${id}`)[0].units).toBe(2);

  const off = await newStore(admin, false);
  const [mcp] = await admin`select id from stores where id = ${await newStore(admin)}`;
  await admin`update stores set mode = 'mcp' where id = ${mcp.id}`;
  gql.mockClear();
  expect(await sales.snapshotSales({ storeId: off })).toBeNull();
  expect(await sales.snapshotSales({ storeId: mcp.id })).toBeNull();
  expect(await sales.snapshotSales({ storeId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  expect(gql).not.toHaveBeenCalled();
});

test("a store whose app lacks the orders scope is skipped without a retry, and keeps no snapshot; other errors are retried", async () => {
  const id = await newStore(admin);
  gql.mockRejectedValueOnce(new Error("Access denied for orders field. Required access: read_orders access scope."));
  expect(await sales.snapshotSales({ storeId: id })).toBeNull();
  expect((await admin`select sales_snapshot_at from stores where id = ${id}`)[0].sales_snapshot_at).toBeNull();
  gql.mockRejectedValueOnce(new Error("503 Service Unavailable"));
  await expect(sales.snapshotSales({ storeId: id })).rejects.toThrow(/503/);
});

test("salesScan queues one snapshot per installed store, spread over the hour, one at a time per store", async () => {
  await admin`truncate accounts, stores cascade`;
  const a = await newStore(admin);
  await newStore(admin, false);
  const m = await newStore(admin);
  await admin`update stores set mode = 'mcp' where id = ${m}`;
  expect(await sales.salesScan(3600)).toBe(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
  const [name, data, opts] = enqueue.mock.calls[0]!;
  expect(name).toBe("sales-snapshot");
  expect(data).toEqual({ storeId: a });
  expect(opts.singletonKey).toBe(a);
  expect(opts.startAfter).toBeGreaterThanOrEqual(0);
  expect(opts.startAfter).toBeLessThan(3600);
});
