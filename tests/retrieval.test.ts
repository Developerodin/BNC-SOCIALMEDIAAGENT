import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { fakeEmbed } from "./helpers/fake-embed";
import { gid, node, newStore, upsert } from "./helpers/seed";

vi.mock("@/lib/embeddings", () => ({ embed: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let retrieval: typeof import("@/lib/retrieval");
let indexing: typeof import("@/lib/indexing");
let client: typeof import("@/db/client");
let embed: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  retrieval = await import("@/lib/retrieval");
  indexing = await import("@/lib/indexing");
  client = await import("@/db/client");
  embed = (await import("@/lib/embeddings")).embed as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

beforeEach(() => {
  embed.mockReset();
  embed.mockImplementation(fakeEmbed);
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const boots = (id: string) => node(id, { title: "Waterproof hiking boots", description: "Leather hiking boots for wet trails" });
const dress = (id: string) => node(id, { title: "Cotton summer dress", description: "Light floral dress" });
const bottle = (id: string) => node(id, { title: "Stainless steel water bottle", description: "Keeps drinks cold" });

async function seeded(...nodes: ReturnType<typeof node>[]) {
  const storeId = await newStore(admin);
  await upsert(storeId, ...nodes);
  await indexing.embedStore({ storeId });
  embed.mockClear();
  return storeId;
}

test("a store never sees another store's chunks, even a closer match", async () => {
  const a = await seeded(boots("1"), dress("2"));
  const b = await seeded(node("9", { title: "hiking boots", description: "hiking boots hiking boots" }));

  const hits = await retrieval.search(a, "hiking boots", 10);

  const bIds = (await admin`select id from chunks where store_id = ${b}`).map((r) => r.id);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => !bIds.includes(h.chunkId))).toBe(true);
  expect(new Set(hits.map((h) => h.productId))).toEqual(new Set([gid("1"), gid("2")]));
});

test("the best match ranks first, scores descend, and k limits the hits", async () => {
  const a = await seeded(dress("1"), boots("2"), bottle("3"));

  const hits = await retrieval.search(a, "hiking boots", 2);

  expect(hits).toHaveLength(2);
  expect(hits[0]).toMatchObject({ source: "product", productId: gid("2") });
  expect(hits[0].content).toContain("hiking boots");
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
  expect(hits[0].score).toBeLessThanOrEqual(1);
  expect(embed).toHaveBeenCalledTimes(1);
});

test("an empty or whitespace query returns [] without embedding", async () => {
  const a = await seeded(boots("1"));

  expect(await retrieval.search(a, "")).toEqual([]);
  expect(await retrieval.search(a, "   ")).toEqual([]);
  expect(embed).not.toHaveBeenCalled();
});

test("a store with no chunks returns []", async () => {
  const a = await newStore(admin);
  expect(await retrieval.search(a, "hiking boots")).toEqual([]);
});

test("opts.productId appends that product's chunks with their real score, as a GID or a numeric id", async () => {
  const a = await seeded(boots("1"), dress("2"), bottle("3"));
  const all = await retrieval.search(a, "hiking boots", 10);
  const bottleScore = all.find((h) => h.productId === gid("3"))!.score;

  for (const productId of [gid("3"), "3"]) {
    const hits = await retrieval.search(a, "hiking boots", 1, { productId });
    expect(hits.map((h) => h.productId)).toEqual([gid("1"), gid("3")]);
    expect(hits[1].score).toBeCloseTo(bottleScore, 5);
  }
});

test("opts.productId adds at most 2 chunks and never duplicates a hit", async () => {
  const long = node("4", { title: "Wool scarf", description: "warm knitted wool ".repeat(700) });
  const a = await seeded(boots("1"), long);
  expect((await admin`select count(*)::int as n from chunks where store_id = ${a} and product_id = ${gid("4")}`)[0].n).toBeGreaterThan(2);

  const hits = await retrieval.search(a, "hiking boots", 1, { productId: gid("4") });
  expect(hits.map((h) => h.productId)).toEqual([gid("1"), gid("4"), gid("4")]);

  const same = await retrieval.search(a, "hiking boots", 1, { productId: gid("1") });
  expect(same.map((h) => h.productId)).toEqual([gid("1")]);
});

test("a productId the store doesn't have returns the normal top-k", async () => {
  const a = await seeded(boots("1"), dress("2"), bottle("3"));
  await seeded(node("5", { title: "Rain jacket" })); // another store's product

  const plain = await retrieval.search(a, "hiking boots", 2);
  expect(await retrieval.search(a, "hiking boots", 2, { productId: "999" })).toEqual(plain);
  expect(await retrieval.search(a, "hiking boots", 2, { productId: gid("5") })).toEqual(plain);
});

test("one long product fills at most 2 of the k slots; the rest go to other products", async () => {
  const long = node("4", { title: "Hiking boots guide", description: "hiking boots trail ".repeat(700) });
  const a = await seeded(boots("1"), dress("2"), bottle("3"), long);
  expect((await admin`select count(*)::int as n from chunks where store_id = ${a} and product_id = ${gid("4")}`)[0].n).toBeGreaterThan(3);

  const hits = await retrieval.search(a, "hiking boots trail", 4);
  expect(hits).toHaveLength(4);
  expect(hits.filter((h) => h.productId === gid("4"))).toHaveLength(2);
  expect(new Set(hits.map((h) => h.productId)).size).toBe(3);
  for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
});

test("D74: gift cards are left out of search unless includeGiftCards is set", async () => {
  const gift = node("7", { title: "Gift card for hiking boots", description: "hiking boots gift card", isGiftCard: true });
  const a = await seeded(boots("1"), gift);

  const normal = await retrieval.search(a, "hiking boots gift", 10);
  expect(normal.map((h) => h.productId)).not.toContain(gid("7"));
  expect(normal.map((h) => h.productId)).toContain(gid("1"));

  const asked = await retrieval.search(a, "hiking boots gift", 10, { includeGiftCards: true });
  expect(asked.map((h) => h.productId)).toContain(gid("7"));
});
