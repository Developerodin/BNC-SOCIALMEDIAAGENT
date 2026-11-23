import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { fakeEmbed } from "./helpers/fake-embed";

vi.mock("@/lib/embeddings", () => ({ embed: vi.fn() }));
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let indexing: typeof import("@/lib/indexing");
let products: typeof import("@/lib/products");
let sync: typeof import("@/lib/sync");
let jobs: typeof import("@/lib/jobs");
let client: typeof import("@/db/client");
let embed: ReturnType<typeof vi.fn>;
let gql: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  indexing = await import("@/lib/indexing");
  products = await import("@/lib/products");
  sync = await import("@/lib/sync");
  jobs = await import("@/lib/jobs");
  client = await import("@/db/client");
  embed = (await import("@/lib/embeddings")).embed as unknown as ReturnType<typeof vi.fn>;
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

beforeEach(() => {
  vi.restoreAllMocks();
  embed.mockReset();
  embed.mockImplementation(fakeEmbed);
  gql.mockReset();
});

afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

async function newStore(active = true) {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`
    insert into stores (account_id, shop_domain, active) values (${acc.id}, ${`s-${randomUUID()}.myshopify.com`}, ${active}) returning id`;
  return s.id as string;
}

const gid = (id: string) => `gid://shopify/Product/${id}`;
const node = (id: string, o: { description?: string; status?: string; onlineStoreUrl?: string | null; updatedAt?: string } = {}) => ({
  id: gid(id),
  handle: `h${id}`,
  title: `Tee ${id}`,
  description: o.description ?? `Soft cotton tee ${id}`,
  productType: "Shirt",
  vendor: "Acme",
  tags: [],
  options: [],
  status: o.status ?? "ACTIVE",
  onlineStoreUrl: o.onlineStoreUrl === undefined ? `https://shop.example.com/products/h${id}` : o.onlineStoreUrl,
  updatedAt: o.updatedAt ?? "2026-01-02T00:00:00Z",
  featuredMedia: null,
});
const upsert = (storeId: string, ...nodes: ReturnType<typeof node>[]) =>
  products.upsertProducts(storeId, nodes.map((n) => products.toShopifyProduct(n, [])));

const chunkRows = (storeId: string) =>
  admin`select c.product_id, c.ordinal, c.content, c.source_hash, c.embedding::text as embedding, p.content_hash
        from chunks c join products p on p.store_id = c.store_id and p.shopify_id = c.product_id
        where c.store_id = ${storeId} order by c.product_id, c.ordinal`;
const embeddedIds = async (storeId: string) => [...new Set((await chunkRows(storeId)).map((r) => r.product_id))].sort();
const embeddedTexts = () => embed.mock.calls.flatMap((c) => c[0] as string[]);

test("embedStore chunks and embeds active, published products with source hashes tied to the content hash", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"));

  const res = await indexing.embedStore({ storeId });

  expect(res).toMatchObject({ embedded: 2, removed: 0 });
  expect(res.tokens).toBeGreaterThan(0);
  const rows = await chunkRows(storeId);
  expect([...new Set(rows.map((r) => r.product_id))].sort()).toEqual([gid("1"), gid("2")]);
  for (const r of rows) expect(r.source_hash).toBe(indexing.sourceHash(r.content_hash));
});

test("a second run with nothing changed makes no embed call", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"));
  await indexing.embedStore({ storeId });
  embed.mockClear();

  expect(await indexing.embedStore({ storeId })).toEqual({ embedded: 0, removed: 0, tokens: 0 });
  expect(embed).not.toHaveBeenCalled();
});

test("changing one product's description re-embeds only that product", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"));
  await indexing.embedStore({ storeId });
  embed.mockClear();

  await upsert(storeId, node("2", { description: "Heavy wool sweater", updatedAt: "2026-01-03T00:00:00Z" }));
  expect(await indexing.embedStore({ storeId })).toMatchObject({ embedded: 1 });

  expect(embeddedTexts()).toHaveLength(1);
  expect(embeddedTexts()[0]).toContain("Heavy wool sweater");
  const rows = await chunkRows(storeId);
  expect(rows.find((r) => r.product_id === gid("2"))!.content).toContain("Heavy wool sweater");
  for (const r of rows) expect(r.source_hash).toBe(indexing.sourceHash(r.content_hash));
});

test("archived or unpublished products lose their chunks on the next run", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"), node("3"));
  await indexing.embedStore({ storeId });

  const later = "2026-01-03T00:00:00Z";
  await upsert(storeId, node("1", { status: "ARCHIVED", updatedAt: later }), node("2", { onlineStoreUrl: null, updatedAt: later }));
  expect(await indexing.embedStore({ storeId })).toMatchObject({ embedded: 0, removed: 2 });

  expect(await embeddedIds(storeId)).toEqual([gid("3")]);
});

test("deleteProduct removes its chunks through the cascade", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"));
  await indexing.embedStore({ storeId });

  await products.deleteProduct(storeId, gid("1"));

  expect(await embeddedIds(storeId)).toEqual([gid("2")]);
});

test("a failing embed throws and leaves the previous chunks unchanged", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"));
  await indexing.embedStore({ storeId });
  const before = await chunkRows(storeId);

  await upsert(storeId, node("1", { description: "Changed", updatedAt: "2026-01-03T00:00:00Z" }));
  embed.mockRejectedValue(new Error("openai down"));
  await expect(indexing.embedStore({ storeId })).rejects.toThrow("openai down");

  const after = await chunkRows(storeId);
  const own = (rs: typeof before) => rs.map((r) => [r.product_id, r.ordinal, r.content, r.source_hash, r.embedding]);
  expect(own(after)).toEqual(own(before));
  expect(after[0].source_hash).not.toBe(indexing.sourceHash(after[0].content_hash));
});

test("a failure in a later batch keeps the earlier batches, and the retry embeds only the rest", async () => {
  const storeId = await newStore();
  await upsert(storeId, ...Array.from({ length: 101 }, (_, i) => node(String(i))));
  embed.mockImplementationOnce(fakeEmbed).mockRejectedValueOnce(new Error("openai down"));

  await expect(indexing.embedStore({ storeId })).rejects.toThrow("openai down");
  expect(await embeddedIds(storeId)).toHaveLength(100);

  embed.mockReset();
  embed.mockImplementation(fakeEmbed);
  expect(await indexing.embedStore({ storeId })).toMatchObject({ embedded: 1 });
  expect(embed).toHaveBeenCalledTimes(1);
  expect(await embeddedIds(storeId)).toHaveLength(101);
});

test("a 400 for one product skips that product and embeds the rest", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("bad", { description: "BAD input" }), node("3"));
  embed.mockImplementation(async (texts: string[]) => {
    if (texts.some((t) => t.includes("BAD input"))) throw new OpenAI.BadRequestError(400, {}, "bad input", new Headers());
    return fakeEmbed(texts);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  expect(await indexing.embedStore({ storeId })).toMatchObject({ embedded: 2 });

  expect(await embeddedIds(storeId)).toEqual([gid("1"), gid("3")]);
  expect(console.error).toHaveBeenCalledWith("embed skipped product", expect.objectContaining({ storeId, productId: gid("bad") }));
});

test("a product deleted between embed and the swap gets no chunks and does not fail the run", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"), node("2"));
  embed.mockImplementation(async (texts: string[]) => {
    await admin`delete from products where store_id = ${storeId} and shopify_id = ${gid("1")}`;
    return fakeEmbed(texts);
  });

  expect(await indexing.embedStore({ storeId })).toMatchObject({ embedded: 1 });

  expect(await embeddedIds(storeId)).toEqual([gid("2")]);
});

test("an aborted signal stops the run before embedding", async () => {
  const storeId = await newStore();
  await upsert(storeId, node("1"));
  const ac = new AbortController();
  ac.abort();

  await expect(indexing.embedStore({ storeId }, ac.signal)).rejects.toThrow();
  expect(embed).not.toHaveBeenCalled();
});

test("embedStore does nothing for an inactive store", async () => {
  const storeId = await newStore(false);
  await upsert(storeId, node("1"));

  expect(await indexing.embedStore({ storeId })).toEqual({ embedded: 0, removed: 0, tokens: 0 });
  expect(embed).not.toHaveBeenCalled();
});

const queuedEmbeds = async (storeId: string) =>
  (await admin`select id from pgboss.job where name = 'embed-products' and singleton_key = ${storeId} and state = 'created'`).length;

test("syncProduct leaves exactly one queued embed-products job for the store", async () => {
  const storeId = await newStore();
  gql.mockResolvedValue({ product: { ...node("1"), metafields: { edges: [] } } });

  await sync.syncProduct({ storeId, productId: gid("1") });
  await sync.syncProduct({ storeId, productId: gid("1") });
  gql.mockResolvedValue({ product: null });
  await sync.syncProduct({ storeId, productId: gid("1") });

  expect(await queuedEmbeds(storeId)).toBe(1);
});

test("pollSync queues an embed run after a completed sync", async () => {
  const storeId = await newStore();
  await admin`update stores set bulk_operation_id = 'gid://shopify/BulkOperation/1', sync_status = 'running', sync_started_at = now() where id = ${storeId}`;
  gql.mockResolvedValueOnce({ node: { status: "COMPLETED", objectCount: "0", url: null, errorCode: null } });

  await sync.pollSync({ storeId });

  expect(await queuedEmbeds(storeId)).toBe(1);
});

test("resyncScan queues an embed run for every active store", async () => {
  const active = await newStore();
  const inactive = await newStore(false);
  await admin`update stores set last_sync_at = now() where id in (${active}, ${inactive})`;

  await sync.resyncScan();

  expect(await queuedEmbeds(active)).toBe(1);
  expect(await queuedEmbeds(inactive)).toBe(0);
});
