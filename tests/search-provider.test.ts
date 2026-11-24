import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SearchHit } from "@/lib/retrieval";

// Offline: both providers are mocked; this tests only the switch.
const search = vi.fn();
vi.mock("@/lib/retrieval", () => ({ search: (...a: unknown[]) => search(...a) }));
const mcpSearch = vi.fn();
vi.mock("@/lib/shopify/catalog-mcp", () => ({ mcpSearch: (...a: unknown[]) => mcpSearch(...a) }));

import { searchProducts, searchProvider } from "@/lib/search-provider";

const gid = (id: string) => `gid://shopify/Product/${id}`;
const hit = (id: string, chunk = `c${id}`): SearchHit => ({ chunkId: chunk, source: "product", productId: gid(id), content: `about ${id}`, score: 0.5 });
const store = (settings: unknown) => ({ id: "store-1", shopDomain: "shop.myshopify.com", settings });

beforeEach(() => {
  search.mockReset();
  mcpSearch.mockReset();
  search.mockResolvedValue([hit("1")]);
  mcpSearch.mockResolvedValue([hit("2", `mcp:${gid("2")}`)]);
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("searchProvider: ours, mcp, hybrid; anything else (missing, invalid, wrong type, null settings) is ours", () => {
  expect(searchProvider({ searchProvider: "mcp" })).toBe("mcp");
  expect(searchProvider({ searchProvider: "hybrid" })).toBe("hybrid");
  expect(searchProvider({ searchProvider: "ours" })).toBe("ours");
  for (const s of [{}, { searchProvider: "MCP" }, { searchProvider: "shopify" }, { searchProvider: 1 }, null, undefined]) {
    expect(searchProvider(s)).toBe("ours");
  }
});

test("default (no setting) uses our search with the same arguments as before, and never MCP", async () => {
  const hits = await searchProducts(store({}), "boots", 8, { productId: gid("9"), includeGiftCards: true, signal: new AbortController().signal });
  expect(hits).toEqual([hit("1")]);
  expect(search).toHaveBeenCalledWith("store-1", "boots", 8, { productId: gid("9"), includeGiftCards: true });
  expect(mcpSearch).not.toHaveBeenCalled();
});

test("an invalid setting uses ours", async () => {
  await searchProducts(store({ searchProvider: "bing" }), "boots", 8);
  expect(search).toHaveBeenCalledTimes(1);
  expect(mcpSearch).not.toHaveBeenCalled();
});

test("mcp uses MCP with the shop domain, k, gift-card flag and signal, and doesn't call our search without a product page", async () => {
  const signal = new AbortController().signal;
  const hits = await searchProducts(store({ searchProvider: "mcp" }), "boots", 8, { includeGiftCards: false, signal });
  expect(hits).toEqual([hit("2", `mcp:${gid("2")}`)]);
  expect(mcpSearch).toHaveBeenCalledWith("shop.myshopify.com", "boots", 8, { storeId: "store-1", includeGiftCards: false, signal });
  expect(search).not.toHaveBeenCalled();
});

test("mcp on a product page adds the current product's chunks from our search (k = 0), unless MCP already returned it", async () => {
  search.mockResolvedValue([hit("9", "c9a"), hit("9", "c9b")]);
  const hits = await searchProducts(store({ searchProvider: "mcp" }), "boots", 8, { productId: gid("9") });
  expect(search).toHaveBeenCalledWith("store-1", "boots", 0, { productId: gid("9"), includeGiftCards: undefined });
  expect(hits.map((h) => h.chunkId)).toEqual([`mcp:${gid("2")}`, "c9a", "c9b"]);

  mcpSearch.mockResolvedValue([hit("9", `mcp:${gid("9")}`)]);
  const again = await searchProducts(store({ searchProvider: "mcp" }), "boots", 8, { productId: gid("9") });
  expect(again.map((h) => h.chunkId)).toEqual([`mcp:${gid("9")}`]);
});

test("hybrid uses ours when it finds something, and does not call MCP", async () => {
  const hits = await searchProducts(store({ searchProvider: "hybrid" }), "boots", 8);
  expect(hits).toEqual([hit("1")]);
  expect(mcpSearch).not.toHaveBeenCalled();
});

test("hybrid falls back to MCP only when ours is empty", async () => {
  search.mockResolvedValue([]);
  const hits = await searchProducts(store({ searchProvider: "hybrid" }), "boots", 8);
  expect(hits).toEqual([hit("2", `mcp:${gid("2")}`)]);
  expect(mcpSearch).toHaveBeenCalledTimes(1);
});

test("hybrid on a product page: ours with only the current product's chunks counts as empty; MCP's hits go first, the page's chunks are kept", async () => {
  search.mockResolvedValue([hit("9", "c9a")]);
  const hits = await searchProducts(store({ searchProvider: "hybrid" }), "boots", 8, { productId: "9" });
  expect(search).toHaveBeenCalledWith("store-1", "boots", 8, { productId: "9", includeGiftCards: undefined });
  expect(hits.map((h) => h.chunkId)).toEqual([`mcp:${gid("2")}`, "c9a"]);

  search.mockResolvedValue([hit("1"), hit("9", "c9a")]);
  mcpSearch.mockClear();
  await searchProducts(store({ searchProvider: "hybrid" }), "boots", 8, { productId: "9" });
  expect(mcpSearch).not.toHaveBeenCalled();
});

test("mcp or hybrid without UCP_AGENT_PROFILE_URL falls back to ours with a log line", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "");
  for (const p of ["mcp", "hybrid"]) {
    search.mockClear();
    expect(await searchProducts(store({ searchProvider: p }), "boots", 8)).toEqual([hit("1")]);
    expect(search).toHaveBeenCalledWith("store-1", "boots", 8, { productId: undefined, includeGiftCards: undefined });
    expect(console.warn).toHaveBeenCalledWith("search provider falls back to ours", {
      storeId: "store-1",
      provider: p,
      reason: "UCP_AGENT_PROFILE_URL is not set",
    });
  }
  expect(mcpSearch).not.toHaveBeenCalled();
});
