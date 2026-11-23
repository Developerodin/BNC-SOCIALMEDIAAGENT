import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let sync: typeof import("@/lib/sync");
let products: typeof import("@/lib/products");
let jobs: typeof import("@/lib/jobs");
let client: typeof import("@/db/client");
let schema: typeof import("@/db/schema");
let gql: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  sync = await import("@/lib/sync");
  products = await import("@/lib/products");
  jobs = await import("@/lib/jobs");
  client = await import("@/db/client");
  schema = await import("@/db/schema");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

beforeEach(() => {
  vi.restoreAllMocks();
  gql.mockReset();
});

afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

async function newStore(opts: { active?: boolean; bulkOperationId?: string | null; syncStartedAt?: Date } = {}) {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`
    insert into stores (account_id, shop_domain, active, bulk_operation_id, sync_status, sync_started_at)
    values (${acc.id}, ${`s-${randomUUID()}.myshopify.com`}, ${opts.active ?? true}, ${opts.bulkOperationId ?? null},
            ${opts.bulkOperationId ? "running" : "idle"}, ${opts.syncStartedAt ?? null})
    returning id`;
  return s.id as string;
}

const node = (id: string, title = "Tee") => ({
  id: `gid://shopify/Product/${id}`,
  handle: `h${id}`,
  title,
  description: "D",
  productType: "Shirt",
  vendor: "Acme",
  tags: [],
  options: [],
  status: "ACTIVE",
  onlineStoreUrl: null,
  updatedAt: "2026-01-02T00:00:00Z",
  featuredMedia: null,
});
const meta = (parent: string, key: string, value: string) => ({
  namespace: "custom",
  key,
  type: "single_line_text_field",
  value,
  __parentId: `gid://shopify/Product/${parent}`,
});
const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function* lines(...rows: object[]) {
  for (const r of rows) yield JSON.stringify(r);
}

const rows = (storeId: string) => client.forStore(storeId, (tx) => tx.select().from(schema.products));
const store = async (id: string) => (await admin`select * from stores where id = ${id}`)[0];
const completed = (url: string | null) => ({ node: { status: "COMPLETED", objectCount: "3", url, errorCode: null } });

test("importJsonl stores a product with the metafields that follow it", async () => {
  const storeId = await newStore();
  const n = await sync.importJsonl(storeId, lines(node("1"), meta("1", "fabric", "cotton"), meta("1", "care", "wash cold")));
  expect(n).toBe(1);
  const [r] = await rows(storeId);
  expect(r.content).toContain("custom.fabric: cotton");
  expect(r.content).toContain("custom.care: wash cold");
});

test("pollSync on COMPLETED with no url leaves the store idle and sweeps old products", async () => {
  const storeId = await newStore({ bulkOperationId: "gid://shopify/BulkOperation/1" });
  await products.upsertProducts(storeId, [products.toShopifyProduct(node("1"), [])]);
  await new Promise((r) => setTimeout(r, 20));
  await admin`update stores set sync_started_at = now() where id = ${storeId}`;
  gql.mockResolvedValueOnce(completed(null));

  await sync.pollSync({ storeId });

  const s = await store(storeId);
  expect(s.sync_status).toBe("idle");
  expect(s.last_sync_at).not.toBeNull();
  expect(s.bulk_operation_id).toBeNull();
  expect(await rows(storeId)).toHaveLength(0);
});

test("pollSync on COMPLETED deletes products missing from the file synced before the start, and keeps later ones", async () => {
  const storeId = await newStore({ bulkOperationId: "gid://shopify/BulkOperation/2" });
  await products.upsertProducts(storeId, [products.toShopifyProduct(node("old"), [])]);
  await new Promise((r) => setTimeout(r, 20));
  await admin`update stores set sync_started_at = now() where id = ${storeId}`;
  await new Promise((r) => setTimeout(r, 20));
  await products.upsertProducts(storeId, [products.toShopifyProduct(node("webhook"), [])]);
  gql.mockResolvedValueOnce(completed("https://bulk.example.com/file.jsonl"));
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(jsonl(node("1"), meta("1", "fabric", "cotton"))));

  await sync.pollSync({ storeId });

  const ids = (await rows(storeId)).map((r) => r.shopifyId).sort();
  expect(ids).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/webhook"]);
});

test("pollSync on RUNNING saves the object count and leaves one queued poll", async () => {
  const storeId = await newStore({ bulkOperationId: "gid://shopify/BulkOperation/3", syncStartedAt: new Date() });
  gql.mockResolvedValue({ node: { status: "RUNNING", objectCount: "42", url: null, errorCode: null } });

  await sync.pollSync({ storeId });
  await sync.pollSync({ storeId });

  expect((await store(storeId)).sync_object_count).toBe(42);
  const queued = await admin`select id from pgboss.job where name = 'sync-poll' and singleton_key = ${storeId} and state = 'created'`;
  expect(queued).toHaveLength(1);
});

test("pollSync on FAILED marks the sync failed", async () => {
  const storeId = await newStore({ bulkOperationId: "gid://shopify/BulkOperation/4", syncStartedAt: new Date() });
  gql.mockResolvedValueOnce({ node: { status: "FAILED", objectCount: "0", url: null, errorCode: "INTERNAL_SERVER_ERROR" } });
  vi.spyOn(console, "error").mockImplementation(() => {});

  await sync.pollSync({ storeId });

  const s = await store(storeId);
  expect(s.sync_status).toBe("failed");
  expect(s.bulk_operation_id).toBeNull();
});

test("two pollSync runs on the same COMPLETED operation give the same rows", async () => {
  const storeId = await newStore({ bulkOperationId: "gid://shopify/BulkOperation/5", syncStartedAt: new Date() });
  const body = jsonl(node("1"), node("2"), meta("2", "fabric", "wool"));
  gql.mockResolvedValue(completed("https://bulk.example.com/file.jsonl"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));

  await sync.pollSync({ storeId });
  const first = (await rows(storeId)).map((r) => r.contentHash).sort();
  await admin`update stores set bulk_operation_id = 'gid://shopify/BulkOperation/5' where id = ${storeId}`;
  await sync.pollSync({ storeId });
  const second = (await rows(storeId)).map((r) => r.contentHash).sort();

  expect(first).toHaveLength(2);
  expect(second).toEqual(first);
});

test("startSync skips an inactive store", async () => {
  const storeId = await newStore({ active: false });
  await sync.startSync({ storeId });
  expect(gql).not.toHaveBeenCalled();
});

test("startSync throws on userErrors so the job is retried", async () => {
  const storeId = await newStore();
  gql.mockResolvedValueOnce({ bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ field: null, message: "already in progress" }] } });
  await expect(sync.startSync({ storeId })).rejects.toThrow(/already in progress/);
  expect((await store(storeId)).sync_status).toBe("idle");
});
