import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { newStore } from "./helpers/seed";

// mcp-mode stores (no install, no Admin token) must be skipped by every job that would call Shopify's Admin API or embed.
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));
vi.mock("@/lib/embeddings", () => ({ embed: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let sync: typeof import("@/lib/sync");
let indexing: typeof import("@/lib/indexing");
let shopInfo: typeof import("@/lib/shop-info");
let wc: typeof import("@/lib/widget-config");
let faq: typeof import("@/app/api/faq/route");
let jobs: typeof import("@/lib/jobs");
let client: typeof import("@/db/client");
let gql: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  sync = await import("@/lib/sync");
  indexing = await import("@/lib/indexing");
  shopInfo = await import("@/lib/shop-info");
  wc = await import("@/lib/widget-config");
  faq = await import("@/app/api/faq/route");
  jobs = await import("@/lib/jobs");
  client = await import("@/db/client");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
beforeEach(() => {
  gql.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

async function mcpStore() {
  const id = await newStore(admin);
  await admin`update stores set mode = 'mcp', currency_code = 'EUR', name = 'Pilot', domains = ${["pilot.example.com"]} where id = ${id}`;
  return id;
}
const jobCount = async (storeId: string) =>
  (await admin`select id from pgboss.job where singleton_key = ${storeId} and state = 'created'`).length;

test("stores.mode defaults to 'app' and the check constraint refuses anything else", async () => {
  const id = await newStore(admin);
  expect((await admin`select mode from stores where id = ${id}`)[0].mode).toBe("app");
  await expect(admin`update stores set mode = 'other' where id = ${id}`).rejects.toThrow(/stores_mode_chk/);
});

test("resyncScan queues no sync, poll or embed job for an mcp store, and still does for an installed one", async () => {
  const mcp = await mcpStore();
  const app = await newStore(admin);
  await sync.resyncScan();
  expect(await jobCount(mcp)).toBe(0);
  expect(await jobCount(app)).toBeGreaterThan(0);
});

test("startSync, embedStore and the widget metafield sync do nothing for an mcp store: no Admin call, no embedding", async () => {
  const id = await mcpStore();
  await sync.startSync({ storeId: id });
  expect(await indexing.embedStore({ storeId: id })).toEqual({ embedded: 0, removed: 0, tokens: 0 });
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${id}`;
  await wc.syncWidgetConfig(id, shop_domain);
  expect(gql).not.toHaveBeenCalled();
  const [s] = await admin`select sync_status, widget_config_hash from stores where id = ${id}`;
  expect(s).toEqual({ sync_status: "idle", widget_config_hash: null });
});

test("refreshShopInfo for an mcp store returns the stored values and makes no Admin call", async () => {
  const id = await mcpStore();
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${id}`;
  const info = await shopInfo.refreshShopInfo(id, shop_domain);
  expect(gql).not.toHaveBeenCalled();
  expect(info).toMatchObject({ name: "Pilot", currencyCode: "EUR", domains: ["pilot.example.com"] });
});

test("/api/faq answers an empty list for an mcp store, even when a row exists for the product", async () => {
  const id = await mcpStore();
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${id}`;
  const product = "gid://shopify/Product/42";
  await admin`insert into faqs (store_id, product_id, question, answer, position) values (${id}, ${product}, 'q', 'a', 1)`;
  const res = await faq.GET(
    new Request(`http://localhost/api/faq?shop=${shop_domain}&product=${encodeURIComponent(product)}`, { headers: { origin: "https://pilot.example.com" } }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [] });
});

test("an installed store's faq route still returns its rows (unchanged)", async () => {
  const id = await newStore(admin);
  await admin`update stores set domains = ${["app.example.com"]} where id = ${id}`;
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${id}`;
  const product = `gid://shopify/Product/${randomUUID().replace(/\D/g, "").slice(0, 6) || 1}`;
  await admin`insert into faqs (store_id, product_id, question, answer, position) values (${id}, ${product}, 'q', 'a', 1)`;
  const res = await faq.GET(
    new Request(`http://localhost/api/faq?shop=${shop_domain}&product=${encodeURIComponent(product)}`, { headers: { origin: "https://app.example.com" } }),
  );
  expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
});
