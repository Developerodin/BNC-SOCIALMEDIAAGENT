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

  const hits = await retrieval.search(a, "hiking boots", 10, { minScore: 0 });

  const bIds = (await admin`select id from chunks where store_id = ${b}`).map((r) => r.id);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => !bIds.includes(h.chunkId))).toBe(true);
  expect(new Set(hits.map((h) => h.productId))).toEqual(new Set([gid("1"), gid("2")]));
});

test("the best match ranks first, scores descend, and k limits the hits", async () => {
  const a = await seeded(dress("1"), boots("2"), bottle("3"));

  const hits = await retrieval.search(a, "hiking boots", 2, { minScore: 0 });

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
  const all = await retrieval.search(a, "hiking boots", 10, { minScore: 0 });
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

  const hits = await retrieval.search(a, "hiking boots trail", 4, { minScore: 0 });
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

test("D86: a query unrelated to every product returns [], a close one still returns its match", async () => {
  const a = await seeded(boots("1"), dress("2"));

  expect(await retrieval.search(a, "qwzx blorft zzkv", 10)).toEqual([]);

  const close = await retrieval.search(a, "waterproof leather hiking boots", 10);
  expect(close.map((h) => h.productId)).toContain(gid("1"));
  expect(close.every((h) => h.score >= retrieval.MIN_SCORE)).toBe(true);
});

test("D86: the current product's chunks are kept even below the threshold", async () => {
  const a = await seeded(boots("1"), dress("2"));

  const hits = await retrieval.search(a, "qwzx blorft zzkv", 10, { productId: gid("2") });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.productId === gid("2") && h.score < retrieval.MIN_SCORE)).toBe(true);
});

test("D86: opts.minScore overrides the threshold", async () => {
  const a = await seeded(boots("1"), dress("2"));

  const loose = await retrieval.search(a, "qwzx blorft zzkv", 10, { minScore: 0 });
  expect(new Set(loose.map((h) => h.productId))).toEqual(new Set([gid("1"), gid("2")]));
  expect(await retrieval.search(a, "waterproof leather hiking boots", 10, { minScore: 0.999 })).toEqual([]);
});

test("k = 0 with opts.productId returns only that product's chunks (the MCP provider's current-product extras, D89)", async () => {
  const a = await seeded(dress("1"), boots("2"), bottle("3"));
  const hits = await retrieval.search(a, "hiking boots", 0, { productId: "3" });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.productId === gid("3"))).toBe(true);
});

test("the query embedding gets a signal and a hung call is cut at 3s", async () => {
  const storeId = await seeded(boots("1"));
  vi.useFakeTimers();
  try {
    embed.mockImplementation((_t: string[], o: { signal: AbortSignal }) => {
      expect(o.signal.aborted).toBe(false);
      return new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const p = retrieval.search(storeId, "boots", 4).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe("aborted");
  } finally {
    vi.useRealTimers();
  }
});

test("the caller's abort cancels the query embedding at once", async () => {
  const storeId = await seeded(boots("1"));
  const ac = new AbortController();
  embed.mockImplementation((_t: string[], o: { signal: AbortSignal }) => new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))));
  const p = retrieval.search(storeId, "boots", 4, { signal: ac.signal }).catch((e: Error) => e.message);
  ac.abort();
  expect(await p).toBe("aborted");
});

test("each query binds the query vector once, so Postgres computes every chunk's distance once", async () => {
  const a = await seeded(boots("1"), dress("2"));
  const sent: { text: string; params: unknown[] }[] = [];
  const opts = client.sql.options as { debug?: unknown };
  opts.debug = (_conn: number, text: string, params: unknown[]) => sent.push({ text, params });
  try {
    const hits = await retrieval.search(a, "hiking boots", 1, { productId: gid("2"), minScore: 0 });
    expect(hits.map((h) => h.productId)).toEqual([gid("1"), gid("2")]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  } finally {
    opts.debug = false;
  }
  const vector = sent.filter((q) => q.text.includes("<=>"));
  expect(vector).toHaveLength(2); // the top-k query and the current product's extra chunks
  for (const q of vector) {
    expect(q.text.match(/<=>/g)).toHaveLength(1);
    expect(q.params.filter((p) => typeof p === "string" && p.startsWith("["))).toHaveLength(1);
  }
});

// --- similarTo: a search seeded by a product's own embedding (the cards' "similar products" icon) ---

test("similarTo: seeded by the product's own embedding (no query embedded), never returns the product itself, nearest first", async () => {
  const a = await seeded(boots("1"), node("2", { title: "Leather hiking boots", description: "Leather boots for wet trails" }), dress("3"));

  const hits = await retrieval.search(a, "", 10, { similarTo: gid("1"), minScore: 0 });

  expect(embed).not.toHaveBeenCalled();
  const ids = hits.map((h) => h.productId);
  expect(ids).not.toContain(gid("1"));
  expect(ids[0]).toBe(gid("2"));
  expect(new Set(ids)).toEqual(new Set([gid("2"), gid("3")]));
});

test("similarTo: opts.exclude (the cart) is left out too", async () => {
  const a = await seeded(boots("1"), node("2", { title: "Leather hiking boots", description: "Leather boots for wet trails" }), dress("3"));

  const hits = await retrieval.search(a, "ignored", 10, { similarTo: gid("1"), exclude: [gid("2")], minScore: 0 });

  expect(hits.map((h) => h.productId)).toEqual([gid("3")]);
});

test("similarTo: products of the same Type come first even when another type is nearer", async () => {
  const a = await seeded(
    boots("1"),
    { ...node("2", { title: "Leather hiking boots", description: "Leather boots for wet trails" }), productType: "Pants" },
    dress("3"),
  );

  const hits = await retrieval.search(a, "", 10, { similarTo: gid("1"), minScore: 0 });

  // boots("1") and the dress are both "Shirt"; the nearer boots(2) is "Pants", so it comes after the dress.
  expect([...new Set(hits.map((h) => h.productId))]).toEqual([gid("3"), gid("2")]);
});

test("similarTo: another store's product, an unknown product or a malformed id returns []", async () => {
  const a = await seeded(boots("1"), dress("2"));
  const b = await seeded(node("9", { title: "hiking boots", description: "hiking boots" }));

  expect(await retrieval.search(a, "", 10, { similarTo: gid("9"), minScore: 0 })).toEqual([]);
  expect(await retrieval.search(b, "", 10, { similarTo: gid("1"), minScore: 0 })).toEqual([]);
  expect(await retrieval.search(a, "", 10, { similarTo: gid("404"), minScore: 0 })).toEqual([]);
  expect(await retrieval.search(a, "boots", 10, { similarTo: "not-a-product", minScore: 0 })).toEqual([]);
  expect(embed).not.toHaveBeenCalled();
});

test("similarTo: gift cards stay out", async () => {
  const a = await seeded(boots("1"), node("2", { title: "Hiking boots gift card", description: "hiking boots", isGiftCard: true }));

  expect(await retrieval.search(a, "", 10, { similarTo: gid("1"), minScore: 0 })).toEqual([]);
});
