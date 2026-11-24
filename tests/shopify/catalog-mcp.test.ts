import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { gid, newStore, node, upsert } from "../helpers/seed";

// Offline: fetch is stubbed; the DB is the test database.
let admin: ReturnType<typeof postgres>;
let mcp: typeof import("@/lib/shopify/catalog-mcp");
let client: typeof import("@/db/client");
let storeId: string;
const fetchMock = vi.fn();
const PROFILE = "https://example.com/profile.json";

/** A search_catalog JSON-RPC reply listing these product GIDs, in order. */
const reply = (...ids: string[]) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: false, structuredContent: { products: ids.map((id) => ({ id, title: `t ${id}`, variants: [] })) } },
    }),
    { status: 200 },
  );

beforeAll(async () => {
  mcp = await import("@/lib/shopify/catalog-mcp");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  await upsert(
    storeId,
    node("1", { title: "Board one", description: "First board" }),
    node("2", { title: "Draft board", status: "DRAFT" }),
    node("3", { title: "Hidden board", publishedAt: null, onlineStoreUrl: null }),
    node("4", { title: "Gift card", isGiftCard: true }),
    node("5", { title: "Board five", description: "Fifth board" }),
  );
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Answers the available: true call with `ready` and the available: false call with `soldOut`. */
const byAvailability = (ready: string[], soldOut: string[] = []) =>
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
    JSON.parse(String(init.body)).params.arguments.catalog.filters.available ? reply(...ready) : reply(...soldOut),
  );

test("calls search_catalog on the shop twice in parallel, available: true and available: false (false returns only sold-out), with the profile and k", async () => {
  fetchMock.mockImplementation(async () => reply());
  await mcp.mcpSearch("shop.myshopify.com", "snowboard", 8, { storeId });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const bodies = fetchMock.mock.calls.map(([url, init]) => {
    expect(url).toBe("https://shop.myshopify.com/api/ucp/mcp");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return JSON.parse(init.body);
  });
  expect(bodies.map((b) => b.params.arguments.catalog.filters.available).sort()).toEqual([false, true]);
  expect(bodies[0]).toEqual({
    jsonrpc: "2.0",
    method: "tools/call",
    id: 1,
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile: PROFILE } },
        catalog: { query: "snowboard", filters: { available: bodies[0].params.arguments.catalog.filters.available }, pagination: { limit: 8 } },
      },
    },
  });
});

test("keeps only our ACTIVE, published products, sale-ready first then sold-out, with our content and a rank score; drops unknown, draft, unpublished and gift cards", async () => {
  byAvailability([gid("5"), gid("999"), gid("2"), gid("3"), gid("4")], [gid("1"), gid("5")]);
  const hits = await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId });
  expect(hits.map((h) => h.productId)).toEqual([gid("5"), gid("1")]);
  expect(hits[0]).toEqual({ chunkId: `mcp:${gid("5")}`, source: "product", productId: gid("5"), content: expect.stringContaining("Fifth board"), score: 1 });
  expect(hits[1].score).toBeCloseTo(1 - 1 / 8);
  const [row] = await admin`select content from products where store_id = ${storeId} and shopify_id = ${gid("1")}`;
  expect(hits[1].content).toBe(row.content);
});

test("at most k hits: sold-out products fill only what sale-ready ones leave", async () => {
  byAvailability([gid("5")], [gid("1")]);
  expect((await mcp.mcpSearch("shop.myshopify.com", "board", 1, { storeId })).map((h) => h.productId)).toEqual([gid("5")]);
});

test("includeGiftCards keeps gift cards", async () => {
  byAvailability([gid("1")], [gid("4")]);
  const hits = await mcp.mcpSearch("shop.myshopify.com", "gift", 8, { storeId, includeGiftCards: true });
  expect(hits.map((h) => h.productId)).toEqual([gid("1"), gid("4")]);
});

test("another store's products are never returned", async () => {
  const other = await newStore(admin);
  byAvailability([gid("1"), gid("5")]);
  expect(await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId: other })).toEqual([]);
});

const failures: [() => Promise<Response> | Response, string][] = [
  [() => new Response("nope", { status: 500 }), "HTTP 500: nope"],
  [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad args" } })), "bad args"],
  [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } })), "tool error"],
  [() => Promise.reject(new TypeError("fetch failed")), "TypeError: fetch failed"],
];

test("an HTTP error, a JSON-RPC error, a tool error or a network error on one call keeps the other call's results and logs the exact error", async () => {
  for (const [res, msg] of failures) {
    for (const readyFails of [false, true]) {
      fetchMock.mockReset();
      // The available: true call is made first.
      if (readyFails) fetchMock.mockImplementationOnce(res).mockImplementationOnce(async () => reply(gid("1")));
      else fetchMock.mockImplementationOnce(async () => reply(gid("5"))).mockImplementationOnce(res);
      const warn = vi.mocked(console.warn);
      warn.mockClear();
      const hits = await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId });
      expect(hits.map((h) => h.productId)).toEqual([readyFails ? gid("1") : gid("5")]);
      expect(warn).toHaveBeenCalledWith("catalog mcp search partly failed", { storeId, available: readyFails, error: expect.stringContaining(msg) });
    }
  }
});

test("both calls failing gives [] and logs the exact errors", async () => {
  for (const [res, msg] of failures) {
    fetchMock.mockReset();
    fetchMock.mockImplementation(res);
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    expect(await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId })).toEqual([]);
    expect(warn).toHaveBeenCalledWith("catalog mcp search failed", { storeId, error: expect.stringContaining(msg) });
  }
});

test("a reply slower than ~3 s times out: [] and a log line", async () => {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
  );
  const t0 = Date.now();
  expect(await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId })).toEqual([]);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
  expect(console.warn).toHaveBeenCalledWith("catalog mcp search failed", { storeId, error: expect.stringContaining("TimeoutError") });
}, 10_000);

test("an aborted caller signal aborts the request", async () => {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
  );
  const ac = new AbortController();
  const p = mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId, signal: ac.signal });
  ac.abort();
  expect(await p).toEqual([]);
  expect(console.warn).toHaveBeenCalledWith("catalog mcp search failed", { storeId, error: expect.stringContaining("AbortError") });
});

test("without UCP_AGENT_PROFILE_URL, or with an empty query, nothing is fetched", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "");
  expect(await mcp.mcpSearch("shop.myshopify.com", "board", 8, { storeId })).toEqual([]);
  expect(console.warn).toHaveBeenCalledWith("catalog mcp unavailable", { storeId, error: "UCP_AGENT_PROFILE_URL is not set" });
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  expect(await mcp.mcpSearch("shop.myshopify.com", "  ", 8, { storeId })).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});
