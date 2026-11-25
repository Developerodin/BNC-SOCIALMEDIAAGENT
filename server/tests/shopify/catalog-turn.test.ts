import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { catalogLive, catalogProduct, catalogSearch, newTurnCatalog } from "@/lib/shopify/catalog-turn";
import { breakerOpen, MCP_BUDGET_MS, recordUcp, resetUcpGuard, ucpGuardSize } from "@/lib/shopify/ucp-guard";
import { money, pgid, ucpProduct, ucpReply, ucpVariant } from "../helpers/ucp";

// Offline: fetch is stubbed. Payloads are schema-derived (tests/helpers/ucp.ts); re-record in Phase 0.
const fetchMock = vi.fn();
const store = (shop = "a.myshopify.com", currencyCode: string | null = "USD") => ({ id: `id-${shop}`, shopDomain: shop, currencyCode });
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).params as { name: string; arguments: { catalog: Record<string, unknown> } });
const info = vi.spyOn(console, "info");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  info.mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetUcpGuard();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  info.mockReset();
});

/** search_catalog: available=true gets `ready`, available=false gets `soldOut`. */
function searchReplies(ready: unknown[], soldOut: unknown[] = []) {
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
    const a = JSON.parse(init.body).params.arguments.catalog;
    return ucpReply(...(a.filters.available ? ready : soldOut));
  });
}

test("search sends both availability calls with the store currency and country, and keeps the payload in the turn's map", async () => {
  searchReplies([ucpProduct(1)], [ucpProduct(2, { variants: [ucpVariant(21, { available: false })] })]);
  const cat = newTurnCatalog(store(), "DE");
  const r = await catalogSearch(cat, "tee", 8, {});
  expect(r.status).toBe("ok");
  expect(r.hits.map((h) => h.productId)).toEqual([pgid(1), pgid(2)]);
  expect(r.hits[0]).toMatchObject({ chunkId: `mcp:${pgid(1)}`, source: "product", content: "Soft cotton tee 1" });
  expect([...cat.products.keys()]).toEqual([pgid(1), pgid(2)]);
  const calls = sent();
  expect(calls.map((c) => c.arguments.catalog.filters)).toEqual([{ available: true }, { available: false }]);
  for (const c of calls) expect(c.arguments.catalog.context).toEqual({ currency: "USD", address_country: "DE" });
});

test("no known currency or country: context is empty rather than invented", async () => {
  searchReplies([ucpProduct(1)]);
  await catalogSearch(newTurnCatalog(store("a.myshopify.com", null)), "tee", 8, {});
  expect(sent()[0].arguments.catalog.context).toEqual({});
});

test("the payload map is per turn: a second turn's catalog starts empty and never sees the first's products", async () => {
  searchReplies([ucpProduct(1)]);
  const a = newTurnCatalog(store());
  await catalogSearch(a, "tee", 8, {});
  const b = newTurnCatalog(store());
  expect(b.products.size).toBe(0);
  expect(a.products.size).toBe(1);
  fetchMock.mockReset();
  searchReplies([]);
  const live = await catalogLive(b, [pgid(1)], { includeGiftCards: false });
  expect(live.size).toBe(0); // b had to ask Shopify; it did not borrow a's copy
});

test("sold-out variants from the second call are merged into the same product", async () => {
  searchReplies(
    [ucpProduct(1, { variants: [ucpVariant(11, { available: true })] })],
    [ucpProduct(1, { variants: [ucpVariant(12, { available: false })] })],
  );
  const cat = newTurnCatalog(store());
  const r = await catalogSearch(cat, "tee", 8, {});
  expect(r.hits).toHaveLength(1);
  const live = await catalogLive(cat, [pgid(1)], { includeGiftCards: false });
  expect(live.get(pgid(1))!.variants.map((v) => [v.id, v.available])).toEqual([["11", true], ["12", false]]);
});

test("hits are cut to k, ranked by position, and drop gift cards unless asked", async () => {
  searchReplies([ucpProduct(1), ucpProduct(2, { gift: true }), ucpProduct(3)]);
  const cat = newTurnCatalog(store());
  const r = await catalogSearch(cat, "tee", 2, {});
  expect(r.hits.map((h) => [h.productId, h.score])).toEqual([[pgid(1), 1], [pgid(3), 0.5]]);
  const withGifts = await catalogSearch(newTurnCatalog(store()), "tee", 3, { includeGiftCards: true });
  expect(withGifts.hits).toHaveLength(3);
});

test("lookup: ids already in the turn's map cost no call; the rest go in batches of at most 10, sale-ready and sold-out", async () => {
  searchReplies([ucpProduct(1)]);
  const cat = newTurnCatalog(store());
  await catalogSearch(cat, "tee", 8, {});
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
    const a = JSON.parse(init.body).params.arguments.catalog;
    return ucpReply(...(a.filters.available ? (a.ids as string[]).map((id) => ucpProduct(id.split("/").pop()!)) : []));
  });
  const ids = [pgid(1), ...Array.from({ length: 23 }, (_, i) => pgid(100 + i))];
  const live = await catalogLive(cat, ids, { includeGiftCards: false });
  const calls = sent();
  expect(calls.every((c) => c.name === "lookup_catalog")).toBe(true);
  expect(calls).toHaveLength(6); // 23 missing ids = 3 batches x 2 availability calls
  expect(Math.max(...calls.map((c) => (c.arguments.catalog.ids as string[]).length))).toBe(10);
  expect(calls.flatMap((c) => c.arguments.catalog.ids as string[]).includes(pgid(1))).toBe(false);
  expect(live.size).toBe(24);
});

test("degraded: both calls failing gives status degraded with no hits and sets the flag; one failing still answers", async () => {
  fetchMock.mockRejectedValue(new Error("network"));
  const cat = newTurnCatalog(store());
  expect(await catalogSearch(cat, "tee", 8, {})).toEqual({ hits: [], status: "degraded" });
  expect(cat.degraded).toBe(true);

  resetUcpGuard();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
    if (!JSON.parse(init.body).params.arguments.catalog.filters.available) throw new Error("boom");
    return ucpReply(ucpProduct(1));
  });
  const cat2 = newTurnCatalog(store());
  const r = await catalogSearch(cat2, "tee", 8, {});
  expect(r.status).toBe("ok");
  expect(r.hits).toHaveLength(1);
  expect(cat2.degraded).toBe(false);
});

test("a reply with no products array is a failure, not 'nothing matches'", async () => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: {} } }), { status: 200 }));
  expect((await catalogSearch(newTurnCatalog(store()), "tee", 8, {})).status).toBe("degraded");
});

test("a real empty result is ok with no hits (the store really has nothing)", async () => {
  searchReplies([], []);
  expect(await catalogSearch(newTurnCatalog(store()), "tee", 8, {})).toEqual({ hits: [], status: "ok" });
});

test("a 429 opens that store's breaker: the next call is not made, and the other store is unaffected", async () => {
  fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "30" } }));
  const r = await catalogSearch(newTurnCatalog(store("a.myshopify.com")), "tee", 8, {});
  expect(r.status).toBe("degraded");
  expect(breakerOpen("a.myshopify.com")).toBe(true);
  expect(breakerOpen("b.myshopify.com")).toBe(false);
  fetchMock.mockClear();
  expect((await catalogSearch(newTurnCatalog(store("a.myshopify.com")), "tee", 8, {})).status).toBe("degraded");
  expect(fetchMock).not.toHaveBeenCalled();
  searchReplies([ucpProduct(1)]);
  expect((await catalogSearch(newTurnCatalog(store("b.myshopify.com")), "tee", 8, {})).status).toBe("ok");
});

test("the breaker honours Retry-After by time, never by sleeping: closed again once it has passed", () => {
  recordUcp("a.myshopify.com", { kind: "rate_limited", retryAfter: 20 }, 1000);
  expect(breakerOpen("a.myshopify.com", 1000 + 19_000)).toBe(true);
  expect(breakerOpen("a.myshopify.com", 1000 + 20_001)).toBe(false);
});

test("a huge Retry-After is capped at a minute, a missing one defaults to 10 s", () => {
  recordUcp("a.myshopify.com", { kind: "rate_limited", retryAfter: 86_400 }, 0);
  expect(breakerOpen("a.myshopify.com", 59_000)).toBe(true);
  expect(breakerOpen("a.myshopify.com", 61_000)).toBe(false);
  recordUcp("b.myshopify.com", { kind: "rate_limited" }, 0);
  expect(breakerOpen("b.myshopify.com", 9_000)).toBe(true);
  expect(breakerOpen("b.myshopify.com", 11_000)).toBe(false);
});

test("the global breaker opens only when 3 distinct stores fail within the window; one broken store never trips it", () => {
  for (let i = 0; i < 20; i++) recordUcp("broken.myshopify.com", { kind: "failure" }, i);
  expect(breakerOpen("other.myshopify.com", 100)).toBe(false);
  recordUcp("b.myshopify.com", { kind: "failure" }, 200);
  expect(breakerOpen("other.myshopify.com", 300)).toBe(false);
  recordUcp("c.myshopify.com", { kind: "failure" }, 400);
  expect(breakerOpen("other.myshopify.com", 500)).toBe(true);
  expect(breakerOpen("other.myshopify.com", 31_000)).toBe(false);
});

test("failures from different stores outside the window don't add up; a success clears that store's failure", () => {
  recordUcp("a.myshopify.com", { kind: "failure" }, 0);
  recordUcp("b.myshopify.com", { kind: "failure" }, 1000);
  recordUcp("c.myshopify.com", { kind: "failure" }, 40_000); // a and b are older than the window
  expect(breakerOpen("x.myshopify.com", 40_001)).toBe(false);
  recordUcp("d.myshopify.com", { kind: "failure" }, 41_000);
  recordUcp("c.myshopify.com", { kind: "ok" }, 41_500);
  recordUcp("e.myshopify.com", { kind: "failure" }, 42_000); // c cleared, so d and e only
  expect(breakerOpen("x.myshopify.com", 42_001)).toBe(false);
});

test("429s never count toward the global breaker, however many stores send them", () => {
  for (let i = 0; i < 10; i++) recordUcp(`s${i}.myshopify.com`, { kind: "rate_limited", retryAfter: 5 }, 0);
  expect(breakerOpen("fresh.myshopify.com", 1)).toBe(false);
  expect(breakerOpen("s1.myshopify.com", 1)).toBe(true); // each keeps its own cooldown
});

test("the per-store breaker map is bounded", () => {
  for (let i = 0; i < 600; i++) {
    recordUcp(`s${i}.myshopify.com`, { kind: "rate_limited", retryAfter: 60 }, 0);
    recordUcp("ok.myshopify.com", { kind: "ok" }, 0); // keep the global failure count from tripping
  }
  expect(ucpGuardSize()).toBeLessThanOrEqual(500);
});

test("the time budget: once a turn has spent it, no more catalog calls are made and the answer is degraded", async () => {
  searchReplies([ucpProduct(1)]);
  const cat = newTurnCatalog(store());
  cat.spentMs = MCP_BUDGET_MS - 100; // under the minimum useful call time
  expect((await catalogSearch(cat, "tee", 8, {})).status).toBe("degraded");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a call's timeout is capped by what is left of the budget", async () => {
  const spy = vi.spyOn(AbortSignal, "timeout");
  searchReplies([ucpProduct(1)]);
  const cat = newTurnCatalog(store());
  cat.spentMs = MCP_BUDGET_MS - 1000;
  await catalogSearch(cat, "tee", 8, {});
  expect(spy).toHaveBeenCalledWith(1000);
  spy.mockRestore();
});

test("elapsed time is charged to the budget once for a parallel pair", async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return ucpReply(ucpProduct(1));
    });
    const cat = newTurnCatalog(store());
    const p = catalogSearch(cat, "tee", 8, {});
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(cat.spentMs).toBeGreaterThanOrEqual(400);
    expect(cat.spentMs).toBeLessThan(800);
  } finally {
    vi.useRealTimers();
  }
});

test("a call is logged with tool, status, ms and retryAfter, never the query, the ids or an IP", async () => {
  fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "7" } }));
  await catalogSearch(newTurnCatalog(store()), "secret query 10.0.0.1", 8, {});
  const logged = info.mock.calls.filter(([m]) => m === "ucp call").map(([, f]) => f);
  expect(logged.length).toBeGreaterThan(0);
  expect(logged[0]).toMatchObject({ tool: "search_catalog", status: "rate_limited", retryAfter: 7 });
  expect(typeof logged[0].ms).toBe("number");
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret|10\.0\.0\.1/);
});

test("without UCP_AGENT_PROFILE_URL the store is degraded and nothing is called", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "");
  expect((await catalogSearch(newTurnCatalog(store()), "tee", 8, {})).status).toBe("degraded");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a shopper who left (aborted signal) is not counted against Shopify's health", async () => {
  const ac = new AbortController();
  ac.abort();
  fetchMock.mockImplementation(async (_u: string, init: { signal: AbortSignal }) => {
    if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
    return ucpReply();
  });
  for (let i = 0; i < 6; i++) await catalogSearch(newTurnCatalog(store()), "tee", 8, { signal: ac.signal });
  expect(breakerOpen("a.myshopify.com")).toBe(false);
});

test("a call cut short by the turn's budget that then times out is not a breaker failure; a full-length timeout is", async () => {
  fetchMock.mockImplementation(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  for (let i = 0; i < 4; i++) {
    const cat = newTurnCatalog(store(`t${i}.myshopify.com`));
    cat.spentMs = MCP_BUDGET_MS - 1000; // 1 s left: the call's timeout is shortened
    expect((await catalogSearch(cat, "tee", 8, {})).status).toBe("degraded");
  }
  expect(breakerOpen("anything.myshopify.com")).toBe(false); // four budget timeouts on four stores: nothing recorded
  for (let i = 0; i < 3; i++) await catalogSearch(newTurnCatalog(store(`full${i}.myshopify.com`)), "tee", 8, {});
  expect(breakerOpen("anything.myshopify.com")).toBe(true); // three stores, real 3 s timeouts
});

test("budget: a product priced in another currency than the store's is dropped, so a budget never compares GBP with USD", async () => {
  searchReplies([
    ucpProduct(1, { variants: [ucpVariant(11, { price: money(4000, "USD") })] }),
    ucpProduct(2, { variants: [ucpVariant(21, { price: money(3000, "GBP") })] }),
  ]);
  const cat = newTurnCatalog(store("a.myshopify.com", "USD"));
  const r = await catalogSearch(cat, "tee", 8, {});
  expect(r.hits.map((h) => h.productId)).toEqual([pgid(1)]);
  const live = await catalogLive(cat, [pgid(1), pgid(2)], { includeGiftCards: false });
  expect([...live.keys()]).toEqual([pgid(1)]);
  // no known store currency: nothing to compare with, nothing dropped
  searchReplies([ucpProduct(2, { variants: [ucpVariant(21, { price: money(3000, "GBP") })] })]);
  expect((await catalogSearch(newTurnCatalog(store("a.myshopify.com", null)), "tee", 8, {})).hits).toHaveLength(1);
});

test("card links: the store's own hosts and *.myshopify.com pass; any other host is rebuilt from the handle on the store's domain", async () => {
  searchReplies([
    ucpProduct(1, { url: "https://www.brand.com/products/h1" }),
    ucpProduct(2, { url: "https://a.myshopify.com/products/h2" }),
    ucpProduct(3, { url: "https://evil.example.net/products/h3" }),
    ucpProduct(4, { url: "http://www.brand.com/products/h4" }),
  ]);
  const cat = newTurnCatalog({ ...store(), domains: ["a.myshopify.com", "www.brand.com"] });
  await catalogSearch(cat, "tee", 8, {});
  const live = await catalogLive(cat, [pgid(1), pgid(2), pgid(3), pgid(4)], { includeGiftCards: false });
  expect([...live.values()].map((p) => p.url)).toEqual([
    "https://www.brand.com/products/h1",
    "https://a.myshopify.com/products/h2",
    "https://a.myshopify.com/products/h3",
    "https://a.myshopify.com/products/h4",
  ]);
});

test("product_details in an mcp store goes through the breaker, the budget, the currency context and the log", async () => {
  const detail = (available: boolean) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { product: ucpProduct(1, { variants: [ucpVariant(available ? 11 : 12, { available })] }) } } }), { status: 200 });
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => detail(JSON.parse(init.body).params.arguments.catalog.filters.available));
  const cat = newTurnCatalog(store());
  const p = await catalogProduct(cat, pgid(1));
  expect((p!.variants as unknown[]).length).toBe(2); // sale-ready and sold-out merged
  expect(sent().map((c) => [c.name, c.arguments.catalog.context])).toEqual([["get_product", { currency: "USD" }], ["get_product", { currency: "USD" }]]);
  expect(info.mock.calls.filter(([m]) => m === "ucp call")).toHaveLength(2);

  fetchMock.mockClear();
  recordUcp("a.myshopify.com", { kind: "rate_limited", retryAfter: 30 });
  expect(await catalogProduct(newTurnCatalog(store()), pgid(1))).toBeNull(); // breaker open: no call
  expect(fetchMock).not.toHaveBeenCalled();
  resetUcpGuard();
  const spent = newTurnCatalog(store());
  spent.spentMs = MCP_BUDGET_MS;
  expect(await catalogProduct(spent, pgid(1))).toBeNull(); // budget spent: no call
  expect(fetchMock).not.toHaveBeenCalled();
});
