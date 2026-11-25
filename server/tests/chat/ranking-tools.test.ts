import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import type { LiveProduct } from "@/lib/shopify/live-products";
import { newStore } from "../helpers/seed";

// D95: trending_products, top_rated_products and featured_collection (src/lib/chat/ranking-tools.ts, admin-tools.ts).

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));
vi.mock("@/lib/search-provider", () => ({ searchProducts: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let tools: typeof import("@/lib/chat/tools");
let client: typeof import("@/db/client");
let sales: typeof import("@/lib/sales");
let products: typeof import("@/lib/products");
let gql: ReturnType<typeof vi.fn>;
let storeId: string;

const gid = (n: number) => `gid://shopify/Product/${n}`;
const live = (n: number) =>
  ({
    id: gid(n),
    title: `Chair ${n}`,
    available: true,
    action: "add",
    hasOnlyDefaultVariant: true,
    options: [],
    variants: [{ id: String(n), title: "Default", options: [], available: true, stock: { kind: "in_stock" }, price: "10.00", compareAtPrice: null }],
    moreVariants: false,
  }) as unknown as LiveProduct;

type Ctx = import("@/lib/chat/tools").ToolContext;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  store: { id: storeId, shopDomain: "x.myshopify.com", settings: {} },
  live: { ok: true, products: new Map() },
  allowed: new Map(),
  threshold: 5,
  includeGiftCards: false,
  signal: new AbortController().signal,
  // A product that is not published is dropped by the live check: here, number 99.
  check: vi.fn(async (ids: string[]) => ({ ok: true as const, products: new Map(ids.filter((id) => id !== gid(99)).map((id) => [id, live(Number(id.split("/").pop()))])) })),
  ...over,
});
const run = (name: string, args: object, c: Ctx) => tools.runTool(name, JSON.stringify(args), c);
const inner = (out: string) => out.slice("<store_data>\n".length, -"\n</store_data>".length);

async function addProduct(n: number, meta: { namespace: string; key: string; type: string; value: string }[] = [], o: { status?: string } = {}) {
  await products.upsertProducts(storeId, [
    products.toShopifyProduct(
      { id: gid(n), handle: `h${n}`, title: `Chair ${n}`, description: "d", productType: "Chair", vendor: "v", tags: [], options: [], status: o.status ?? "ACTIVE", onlineStoreUrl: `https://s.example/products/h${n}`, publishedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", isGiftCard: false },
      meta,
    ),
  ]);
}
const rated = (rating: string, count: string) => [
  { namespace: "reviews", key: "rating", type: "rating", value: JSON.stringify({ scale_min: "1.0", scale_max: "5.0", value: rating }) },
  { namespace: "reviews", key: "rating_count", type: "number_integer", value: count },
];
const ids = (text: string) => [...text.matchAll(/^#\d+ (Chair \d+)/gm)].map((m) => m[1]);

beforeAll(async () => {
  tools = await import("@/lib/chat/tools");
  client = await import("@/db/client");
  sales = await import("@/lib/sales");
  products = await import("@/lib/products");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
afterAll(async () => {
  await (await import("@/lib/jobs")).boss.stop();
  await admin.end();
  await client.sql.end();
});
beforeEach(async () => {
  storeId = await newStore(admin);
  gql.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("the three tools are offered with the Admin tools only, and an MCP turn refuses them", async () => {
  const names = ["trending_products", "top_rated_products", "featured_collection"];
  expect(tools.toolDefs().map((d) => d.name)).not.toEqual(expect.arrayContaining(names));
  expect(tools.toolDefs({ admin: true }).map((d) => d.name)).toEqual(expect.arrayContaining(names));
  for (const n of names) expect(await run(n, { kind: "sale" }, ctx({ catalog: {} as never }))).toMatch(/Unknown tool/);
});

// --- trending_products ---

test("trending_products says so when no snapshot exists yet, and when the store sold nothing", async () => {
  expect(inner(await run("trending_products", {}, ctx()))).toMatch(/No sales ranking is available/);
  await sales.saveSales(storeId, new Map(), new Date());
  expect(inner(await run("trending_products", {}, ctx()))).toMatch(/no sales in the last 30 days/);
});

test("trending_products lists the best sellers by units, numbered and live-checked, without sales numbers", async () => {
  await sales.saveSales(
    storeId,
    new Map([
      [gid(1), { units: 3, orders: 3 }],
      [gid(2), { units: 40, orders: 10 }],
      [gid(99), { units: 100, orders: 50 }], // sold a lot but no longer published: dropped by the live check
      [gid(3), { units: 40, orders: 20 }], // same units as 2, more orders: ahead of it
    ]),
    new Date(),
  );
  const c = ctx();
  const out = inner(await run("trending_products", {}, c));
  expect(ids(out)).toEqual(["Chair 3", "Chair 2", "Chair 1"]);
  expect(out).not.toMatch(/\b40\b|\b100\b|units/);
  expect(c.allowed.get("1")).toBe(gid(3)); // [[product:1]] cards work
  expect(out).toContain("LIVE:");
});

test("trending_products reads only its own store's snapshot", async () => {
  const other = await newStore(admin);
  await sales.saveSales(other, new Map([[gid(7), { units: 9, orders: 1 }]]), new Date());
  await sales.saveSales(storeId, new Map([[gid(1), { units: 1, orders: 1 }]]), new Date());
  expect(ids(inner(await run("trending_products", {}, ctx())))).toEqual(["Chair 1"]);
});

test("trending_products with every best seller dropped says none can be shown", async () => {
  await sales.saveSales(storeId, new Map([[gid(99), { units: 5, orders: 1 }]]), new Date());
  expect(inner(await run("trending_products", {}, ctx()))).toMatch(/None of these products can be shown/);
});

// --- top_rated_products ---

test("the rating is normalized and stored at sync time, and cleared when the product loses it", async () => {
  await addProduct(1, rated("4.5", "12"));
  expect((await admin`select rating, rating_count from products where store_id = ${storeId}`)[0]).toEqual({ rating: 4.5, rating_count: 12 });
  await addProduct(1, []);
  expect((await admin`select rating, rating_count from products where store_id = ${storeId}`)[0]).toEqual({ rating: null, rating_count: null });
});

test("top_rated_products says so when the store has no rating data", async () => {
  await addProduct(1);
  expect(inner(await run("top_rated_products", {}, ctx()))).toMatch(/No product in this store has review ratings/);
});

test("top_rated_products with too few reviews says there is no ranking yet", async () => {
  await addProduct(1, rated("5.0", "2"));
  expect(inner(await run("top_rated_products", {}, ctx()))).toMatch(/at least 3 reviews yet/);
});

test("top_rated_products sorts by rating then review count, needs 3 reviews, and skips unpublished and inactive products", async () => {
  await addProduct(1, rated("4.5", "10"));
  await addProduct(2, rated("4.9", "3"));
  await addProduct(3, rated("4.9", "20"));
  await addProduct(4, rated("5.0", "2")); // too few reviews
  await addProduct(5, rated("5.0", "30"), { status: "ARCHIVED" });
  await addProduct(99, rated("5.0", "30")); // dropped by the live check
  const c = ctx();
  const out = inner(await run("top_rated_products", {}, c));
  expect(ids(out)).toEqual(["Chair 3", "Chair 2", "Chair 1"]);
  expect(out).toContain("RATING: 4.9/5 from 20 reviews");
  expect(out).toContain("RATING: 4.5/5 from 10 reviews");
  expect(c.allowed.size).toBe(3);
});

test("top_rated_products reads only its own store's products", async () => {
  const mine = storeId;
  storeId = await newStore(admin);
  await addProduct(1, rated("5.0", "50"));
  storeId = mine;
  await addProduct(2, rated("4.0", "5"));
  expect(ids(inner(await run("top_rated_products", {}, ctx())))).toEqual(["Chair 2"]);
});

// --- featured_collection ---

const collections = (...titles: string[]) => ({
  productsCount: { count: 5, precision: "EXACT" },
  collections: { pageInfo: { hasNextPage: false }, nodes: titles.map((t, i) => ({ id: `gid://shopify/Collection/${i}`, title: t, handle: t.toLowerCase().replace(/\W+/g, "-"), productsCount: { count: 3 } })) },
  products: { nodes: [] },
});
const collectionProducts = (...n: number[]) => ({ collection: { products: { nodes: n.map((x) => ({ id: gid(x), status: "ACTIVE" })) } } });

test("featured_collection lists the first products of the store's best-sellers collection, numbered", async () => {
  gql.mockResolvedValueOnce(collections("Canapés", "Meilleures ventes")).mockResolvedValueOnce(collectionProducts(4, 5));
  const c = ctx();
  const out = inner(await run("featured_collection", { kind: "best_sellers" }, c));
  expect(out).toContain('Collection "Meilleures ventes"');
  expect(ids(out)).toEqual(["Chair 4", "Chair 5"]);
  expect(gql.mock.calls[1][3]).toMatchObject({ id: "gid://shopify/Collection/1" });
  expect(c.allowed.size).toBe(2);
  expect(out).not.toMatch(/Do not state any discount/); // that note is for sale only
});

test("featured_collection for sale finds Soldes and adds no discount claims", async () => {
  gql.mockResolvedValueOnce(collections("Fauteuils", "Soldes")).mockResolvedValueOnce(collectionProducts(6));
  const out = inner(await run("featured_collection", { kind: "sale" }, ctx()));
  expect(out).toContain('Collection "Soldes"');
  expect(out).toMatch(/Do not state any discount, percentage/);
  expect(out).not.toMatch(/%|off\b|remise|réduction/i);
});

test("featured_collection with no matching collection says so for both kinds, and rejects another kind", async () => {
  gql.mockResolvedValue(collections("Canapés", "Fauteuils"));
  expect(inner(await run("featured_collection", { kind: "best_sellers" }, ctx()))).toMatch(/no best-sellers collection/);
  expect(inner(await run("featured_collection", { kind: "sale" }, ctx()))).toMatch(/no sale or offers collection[\s\S]*Do not say any product is on sale/);
  expect(inner(await run("featured_collection", { kind: "new" }, ctx()))).toMatch(/Invalid arguments/);
});

test("featured_collection failing on Shopify gives the short unavailable result, never a throw", async () => {
  gql.mockRejectedValue(new Error("boom"));
  expect(inner(await run("featured_collection", { kind: "sale" }, ctx()))).toMatch(/temporarily unavailable/);
});
