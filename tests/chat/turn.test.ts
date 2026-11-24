import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { fakeStream, apiError } from "../helpers/fake-openai";
import { gid, newStore } from "../helpers/seed";
import type { LiveProduct } from "@/lib/shopify/live-products";
import type { SearchHit } from "@/lib/retrieval";

// Nothing here calls OpenAI or Shopify: the client, search, rewrite and liveCheck are all mocked.
const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));
const search = vi.fn();
vi.mock("@/lib/retrieval", () => ({ search: (...a: unknown[]) => search(...a) }));
const mcpSearch = vi.fn();
vi.mock("@/lib/shopify/catalog-mcp", () => ({ mcpSearch: (...a: unknown[]) => mcpSearch(...a) }));
const rewriteQuery = vi.fn();
vi.mock("@/lib/chat/rewrite", () => ({ rewriteQuery: (...a: unknown[]) => rewriteQuery(...a) }));
const liveCheck = vi.fn();
vi.mock("@/lib/shopify/live-products", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/live-products")>()),
  liveCheck: (...a: unknown[]) => liveCheck(...a),
}));

let admin: ReturnType<typeof postgres>;
let turn: typeof import("@/lib/chat/turn");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeId: string;
let otherStoreId: string;

const variant = (id: string, o: Partial<LiveProduct["variants"][number]> = {}): LiveProduct["variants"][number] => ({
  id,
  title: "Default Title",
  options: [],
  available: true,
  stock: { kind: "in_stock" },
  price: "10.00",
  compareAtPrice: null,
  ...o,
});
const live = (id: string, o: Partial<LiveProduct> = {}): LiveProduct => ({
  id: gid(id),
  title: `Tee ${id}`,
  url: `https://shop.example.com/products/h${id}`,
  imageUrl: null,
  currency: "EUR",
  available: true,
  action: "add",
  hasOnlyDefaultVariant: true,
  options: [],
  variants: [variant(`${id}1`)],
  moreVariants: false,
  ...o,
});
const hit = (id: string, content = `About tee ${id}`): SearchHit => ({ chunkId: `c${id}`, source: "product", productId: gid(id), content, score: 0.9 });
const liveMap = (...ps: LiveProduct[]) => ({ ok: true as const, products: new Map(ps.map((p) => [p.id, p])) });

async function loadStore(id = storeId) {
  const [s] = await admin`select id, shop_domain, name, primary_locale, currency_code, settings from stores where id = ${id}`;
  return { id: s.id, shopDomain: s.shop_domain, name: s.name, primaryLocale: s.primary_locale, currencyCode: s.currency_code, settings: s.settings };
}

async function start(message = "hello", store?: Awaited<ReturnType<typeof loadStore>>) {
  const st = store ?? (await loadStore());
  const opened = await turn.openTurn(st, { message, pageUrl: null });
  if (!opened.ok || opened.replay) throw new Error("openTurn failed");
  return { st, ...opened };
}

async function run(extra: { productId?: string; country?: string; signal?: AbortSignal; message?: string } = {}) {
  const t = await start(extra.message);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  await turn.runTurn({
    store: t.st,
    conversationId: t.conversationId,
    token: t.token,
    history: t.history,
    message: t.message,
    productId: extra.productId,
    country: extra.country,
    signal: extra.signal ?? new AbortController().signal,
    send: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
  });
  return { ...t, events, products: events.filter((e) => e.event === "product").map((e) => e.data) };
}

const assistantRows = (conversationId: string) =>
  admin`select content, product_ids, cards, model, status, input_tokens, output_tokens from messages
        where conversation_id = ${conversationId} and role = 'assistant'`;

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  turn = await import("@/lib/chat/turn");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  otherStoreId = await newStore(admin);
  await admin`update stores set name = 'Acme', currency_code = 'EUR', primary_locale = 'en' where id = ${storeId}`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  create.mockReset();
  search.mockReset();
  mcpSearch.mockReset();
  rewriteQuery.mockReset();
  liveCheck.mockReset();
  rewriteQuery.mockImplementation(async (o: { message: string }) => ({
    query: o.message,
    includeGiftCards: false,
    budget: null,
    sort: null,
    tokens: { input: 7, output: 3 },
  }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- openTurn ---

test("openTurn without a token creates one conversation with the masked user message, and an empty history", async () => {
  const { conversationId, token: tok, history, message } = await start("mail me at a@b.com");
  expect(message).toBe("mail me at [email]");
  expect(history).toEqual([]);
  expect(token.verifyToken(storeId, tok)).toBe(conversationId);
  const conv = await admin`select token_hash from conversations where id = ${conversationId}`;
  expect(conv).toEqual([{ token_hash: token.tokenHash(tok) }]);
  const msgs = await admin`select role, content from messages where conversation_id = ${conversationId}`;
  expect(msgs).toEqual([{ role: "user", content: "mail me at [email]" }]);
});

test("openTurn with a valid token continues that conversation and returns the earlier messages as history", async () => {
  const st = await loadStore();
  const first = await start("first", st);
  await admin`update conversations set busy_until = null where id = ${first.conversationId}`; // the first turn ended (D81)
  const again = await turn.openTurn(st, { token: first.token, message: "second", pageUrl: null });
  expect(again).toMatchObject({ ok: true, conversationId: first.conversationId, token: first.token });
  if (!again.ok || again.replay) return;
  expect(again.history).toEqual([{ role: "user", content: "first" }]);
  const n = await admin`select count(*)::int as n from conversations where id = ${first.conversationId}`;
  expect(n[0].n).toBe(1);
});

test("openTurn refuses a tampered token, and a token of another store, with 401 and saves nothing", async () => {
  const st = await loadStore();
  const first = await start("first", st);
  const tampered = first.token.slice(0, -2) + (first.token.endsWith("AA") ? "BB" : "AA");
  expect(await turn.openTurn(st, { token: tampered, message: "x", pageUrl: null })).toEqual({ ok: false, status: 401 });
  const other = token.mintToken(otherStoreId).token;
  expect(await turn.openTurn(st, { token: other, message: "x", pageUrl: null })).toEqual({ ok: false, status: 401 });
  const msgs = await admin`select count(*)::int as n from messages where content = 'x'`;
  expect(msgs[0].n).toBe(0);
});

test("openTurn with a valid token whose conversation is gone answers 404", async () => {
  const st = await loadStore();
  const { token: tok } = token.mintToken(storeId);
  expect(await turn.openTurn(st, { token: tok, message: "x", pageUrl: null })).toEqual({ ok: false, status: 404 });
});

// --- runTurn ---

test("a turn streams text and cards, saves the assistant row with both calls' tokens, and ends with done", async () => {
  search.mockResolvedValue([hit("1")]);
  liveCheck.mockResolvedValue(liveMap(live("1")));
  create.mockImplementationOnce(fakeStream(["Try this ", "[[product:1]]"], { usage: { input_tokens: 100, output_tokens: 20 } }));
  const r = await run();
  expect(r.events.map((e) => e.event)).toEqual(["text", "product", "done"]);
  expect(r.events[0].data).toEqual({ delta: "Try this " });
  expect(r.products[0]).toEqual({
    id: gid("1"),
    title: "Tee 1",
    imageUrl: null,
    url: "https://shop.example.com/products/h1",
    currency: "EUR",
    available: true,
    action: "add",
    stock: { kind: "in_stock" },
    price: "10.00",
    compareAtPrice: null,
    variants: [{ id: "11", title: "Default Title", options: [], available: true, stock: { kind: "in_stock" }, price: "10.00", compareAtPrice: null }],
    moreVariants: false,
  });
  // Task 22: done carries the saved assistant row's id, so the widget can show thumbs under it.
  const [saved] = await admin`select id from messages where conversation_id = ${r.conversationId} and role = 'assistant'`;
  expect(r.events[2].data).toEqual({ conversationToken: r.token, messageId: saved.id });
  const [row] = await assistantRows(r.conversationId);
  expect(row).toEqual({
    content: "Try this ",
    product_ids: [gid("1")],
    cards: [r.products[0]],
    model: "small",
    status: "ok",
    input_tokens: 107,
    output_tokens: 23,
  });
});

test("search gets the rewritten query, 8 hits, the current product as a GID and the gift-card flag; liveCheck gets hits + current product", async () => {
  rewriteQuery.mockResolvedValueOnce({ query: "gift card", includeGiftCards: true, tokens: { input: 1, output: 1 } });
  search.mockResolvedValue([hit("1"), hit("1", "more"), hit("2")]);
  liveCheck.mockResolvedValue(liveMap(live("1"), live("2"), live("9")));
  create.mockImplementationOnce(fakeStream(["ok"]));
  await run({ productId: "9", country: "FR" });
  expect(search).toHaveBeenCalledWith(storeId, "gift card", 8, { productId: gid("9"), includeGiftCards: true, signal: expect.any(AbortSignal) });
  expect(liveCheck.mock.calls[0][0]).toBe(storeId);
  expect(liveCheck.mock.calls[0][2]).toEqual([gid("1"), gid("2"), gid("9")]);
  expect(liveCheck.mock.calls[0][3]).toMatchObject({ country: "FR", includeGiftCards: true, currency: "EUR" });
  expect(liveCheck).toHaveBeenCalledTimes(1);
});

test("D89: a store set to the MCP search provider gets its hits from mcpSearch, which reach the live check and the prompt", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  await admin`update stores set settings = ${admin.json({ searchProvider: "mcp" })} where id = ${storeId}`;
  try {
    mcpSearch.mockResolvedValue([hit("5", "From the catalog MCP")]);
    liveCheck.mockResolvedValue(liveMap(live("5")));
    create.mockImplementationOnce(fakeStream(["ok"]));
    const r = await run({ message: "boards" });
    const [shop] = await admin`select shop_domain from stores where id = ${storeId}`;
    expect(mcpSearch).toHaveBeenCalledWith(shop.shop_domain, "boards", 8, expect.objectContaining({ storeId, includeGiftCards: false }));
    expect(search).not.toHaveBeenCalled();
    expect(liveCheck.mock.calls[0][2]).toEqual([gid("5")]);
    expect(JSON.stringify(create.mock.calls[0][0].input)).toContain("From the catalog MCP");
    expect(r.events.at(-1)?.event).toBe("done");
  } finally {
    await admin`update stores set settings = '{}'::jsonb where id = ${storeId}`;
    vi.unstubAllEnvs();
  }
});

test("a marker for a product the live check dropped, or outside the hits, gives no product event (Review Focus 1)", async () => {
  // Hit 2 is dropped by the live check, so only Tee 1 is numbered (#1). #2 and #99 are not this turn's products.
  search.mockResolvedValue([hit("1"), hit("2")]);
  liveCheck.mockResolvedValue(liveMap(live("1")));
  create.mockImplementationOnce(fakeStream(["See [[product:2]] and [[product:99]] and [[product:1]]"]));
  const r = await run();
  expect(r.products.map((p) => p.id)).toEqual([gid("1")]);
  const [row] = await assistantRows(r.conversationId);
  expect(row.product_ids).toEqual([gid("1")]);
});

test("a sold-out product gives one product event with available: false and action none (D72)", async () => {
  search.mockResolvedValue([hit("1")]);
  liveCheck.mockResolvedValue(
    liveMap(live("1", { available: false, action: "none", variants: [variant("11", { available: false, stock: { kind: "sold_out" } })] })),
  );
  create.mockImplementationOnce(fakeStream(["Sold out: [[product:1]][[product:1]]"]));
  const r = await run();
  expect(r.products).toHaveLength(1);
  expect(r.products[0]).toMatchObject({ available: false, action: "none", stock: { kind: "sold_out" } });
});

test("a selling-plan product gives action view_options (D75)", async () => {
  search.mockResolvedValue([hit("1")]);
  liveCheck.mockResolvedValue(liveMap(live("1", { action: "view_options" })));
  create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
  const r = await run();
  expect(r.products[0]).toMatchObject({ action: "view_options" });
});

test("card stock follows the merchant's threshold (UD10, C14): a count only below it", async () => {
  await admin`update stores set settings = ${admin.json({ stockThreshold: 3 })} where id = ${storeId}`;
  try {
    search.mockResolvedValue([hit("1")]);
    liveCheck.mockResolvedValue(
      liveMap(
        live("1", {
          hasOnlyDefaultVariant: false,
          variants: [variant("11", { title: "S", stock: { kind: "count", n: 2 } }), variant("12", { title: "M", stock: { kind: "count", n: 4 } })],
        }),
      ),
    );
    create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
    const r = await run();
    const p = r.products[0] as { stock: unknown; variants: { stock: unknown }[] };
    expect(p.variants.map((v) => v.stock)).toEqual([{ kind: "count", n: 2 }, { kind: "in_stock" }]);
    expect(p.stock).toEqual({ kind: "count", n: 2 }); // the first available variant leads the card
    const input = JSON.stringify(create.mock.calls[0][0].input);
    expect(input).toContain("S: only 2 left; M: in stock");
  } finally {
    await admin`update stores set settings = '{}' where id = ${storeId}`;
  }
});

test("liveCheck ok: false gives C11 (b) cards from our table with no price, stock or action, and the prompt says live data is unavailable", async () => {
  await admin`insert into products (store_id, shopify_id, handle, title, url, image_url, status, published, content, content_hash, shopify_updated_at)
              values (${storeId}, ${gid("5")}, 'h5', 'Boot 5', 'https://shop.example.com/products/h5', 'https://cdn.shopify.com/b5.jpg',
                      'ACTIVE', true, 'c', 'h', now())`;
  search.mockResolvedValue([hit("5")]);
  liveCheck.mockResolvedValue({ ok: false, reason: "throttled" });
  create.mockImplementationOnce(fakeStream(["Look: [[product:1]]"]));
  const r = await run();
  expect(r.products).toEqual([
    {
      id: gid("5"),
      title: "Boot 5",
      imageUrl: "https://cdn.shopify.com/b5.jpg",
      url: "https://shop.example.com/products/h5",
      currency: null,
      available: null,
      action: "none",
      stock: null,
      price: null,
      compareAtPrice: null,
      variants: [],
      moreVariants: false,
    },
  ]);
  expect(JSON.stringify(create.mock.calls[0][0].input)).toContain("live data unavailable");
  expect(r.events.at(-1)!.event).toBe("done");
});

test("a store with no currency code gets C11 (b) cards and never a price", async () => {
  await admin`update stores set currency_code = null where id = ${storeId}`;
  try {
    await admin`insert into products (store_id, shopify_id, handle, title, url, status, published, content, content_hash, shopify_updated_at)
                values (${storeId}, ${gid("6")}, 'h6', 'Hat 6', 'https://shop.example.com/products/h6', 'ACTIVE', true, 'c', 'h', now())`;
    search.mockResolvedValue([hit("6")]);
    create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
    const r = await run();
    expect(liveCheck).not.toHaveBeenCalled();
    expect(r.products).toMatchObject([{ id: gid("6"), price: null, action: "none" }]);
  } finally {
    await admin`update stores set currency_code = 'EUR' where id = ${storeId}`;
  }
});

// --- D87: budget and price order, by the live price ---

const priced = (id: string, price: string) => live(id, { variants: [variant(`${id}1`, { price })] });
const rewritten = (o: { budget?: { min?: number; max?: number } | null; sort?: "cheapest" | "priciest" | null }) =>
  rewriteQuery.mockResolvedValueOnce({ query: "tee", includeGiftCards: false, budget: o.budget ?? null, sort: o.sort ?? null, tokens: { input: 1, output: 1 } });
const promptOf = () => (create.mock.calls[0][0].input as { content: string }[])[0].content;

test("the rewrite gets the store currency; products over the budget are dropped and the rest keep their numbers in hit order", async () => {
  rewritten({ budget: { max: 40 } });
  search.mockResolvedValue([hit("1"), hit("2"), hit("3")]);
  liveCheck.mockResolvedValue(liveMap(priced("1", "10.00"), priced("2", "50.00"), priced("3", "40.00")));
  create.mockImplementationOnce(fakeStream(["[[product:2]]"]));
  const r = await run();
  expect(rewriteQuery.mock.calls[0][0]).toMatchObject({ storeLocale: "en", storeCurrency: "EUR" });
  const prompt = promptOf();
  expect(prompt).toContain("#1 Tee 1");
  expect(prompt).toContain("#2 Tee 3"); // 40.00 is inside "at most 40"
  expect(prompt).not.toContain("Tee 2");
  expect(r.products.map((p) => p.id)).toEqual([gid("3")]);
});

test("a cheapest question numbers the products by live price, cheapest first", async () => {
  rewritten({ sort: "cheapest" });
  search.mockResolvedValue([hit("1"), hit("2"), hit("3")]);
  liveCheck.mockResolvedValue(liveMap(priced("1", "50.00"), priced("2", "10.00"), priced("3", "30.00")));
  create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
  const r = await run();
  const prompt = promptOf();
  expect(prompt.indexOf("#1 Tee 2")).toBeGreaterThan(-1);
  expect(prompt.indexOf("#2 Tee 3")).toBeGreaterThan(prompt.indexOf("#1 Tee 2"));
  expect(prompt.indexOf("#3 Tee 1")).toBeGreaterThan(prompt.indexOf("#2 Tee 3"));
  expect(prompt).toMatch(/cheapest to the most expensive/);
  expect(r.products.map((p) => p.id)).toEqual([gid("2")]);
});

test("a cheapest question searches 30 hits, checks them in one call, and only the 8 cheapest reach the prompt", async () => {
  rewritten({ sort: "cheapest" });
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
  search.mockResolvedValue(ids.map((id) => hit(id)));
  // Product n costs 100 - n: the cheapest is the last hit, far outside the normal 8.
  liveCheck.mockResolvedValue(liveMap(...ids.map((id) => priced(id, `${100 - Number(id)}.00`))));
  create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
  const r = await run();
  expect(search).toHaveBeenCalledWith(storeId, "tee", 30, { includeGiftCards: false, signal: expect.any(AbortSignal) });
  expect(liveCheck).toHaveBeenCalledTimes(1);
  expect(liveCheck.mock.calls[0][2]).toHaveLength(30);
  const prompt = promptOf();
  expect(prompt).toMatch(/^#1 Tee 30$/m);
  expect(prompt).toMatch(/^#8 Tee 23$/m);
  expect(prompt).not.toContain("#9 ");
  expect(prompt).not.toMatch(/^#\d+ Tee 22$/m);
  expect(r.products.map((p) => p.id)).toEqual([gid("30")]);
});

test("a budget or sort turn offers product_details (when the UCP profile is set) but not search_products", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  try {
    for (const turn of [{ budget: { max: 50 } }, { sort: "cheapest" as const }, {}]) {
      create.mockClear();
      rewritten(turn);
      search.mockResolvedValue([hit("1")]);
      liveCheck.mockResolvedValue(liveMap(priced("1", "10.00")));
      create.mockImplementationOnce(fakeStream(["ok"]));
      await run();
      const names = (create.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("product_details");
      expect(names.includes("search_products")).toBe(!("budget" in turn || "sort" in turn));
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a budget question also searches 30 hits and keeps the first 8 in-budget products in hit order", async () => {
  rewritten({ budget: { max: 50 } });
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
  search.mockResolvedValue(ids.map((id) => hit(id)));
  // Odd products cost 90, even ones 20: the in-budget ones are 2, 4, …, 30.
  liveCheck.mockResolvedValue(liveMap(...ids.map((id) => priced(id, Number(id) % 2 ? "90.00" : "20.00"))));
  create.mockImplementationOnce(fakeStream(["ok"]));
  await run();
  expect(search).toHaveBeenCalledWith(storeId, "tee", 30, { includeGiftCards: false, signal: expect.any(AbortSignal) });
  expect(liveCheck).toHaveBeenCalledTimes(1);
  const prompt = promptOf();
  expect(prompt).toMatch(/^#1 Tee 2$/m);
  expect(prompt).toMatch(/^#8 Tee 16$/m);
  expect(prompt).not.toContain("#9 ");
  expect(prompt).not.toMatch(/^#\d+ Tee (1|3|18)$/m);
});

test("a budget that leaves no product tells the model so, and no card can be shown", async () => {
  rewritten({ budget: { min: 1, max: 5 } });
  search.mockResolvedValue([hit("1"), hit("2")]);
  liveCheck.mockResolvedValue(liveMap(priced("1", "10.00"), priced("2", "20.00")));
  create.mockImplementationOnce(fakeStream(["Nothing in that range. [[product:1]]"]));
  const r = await run();
  expect(promptOf()).toContain("No products are within the shopper's budget of €1–€5.");
  expect(r.products).toEqual([]);
  expect(r.events.at(-1)!.event).toBe("done");
});

test("when the live check fails (C11), the budget is not applied and the model is told prices couldn't be checked", async () => {
  await admin`insert into products (store_id, shopify_id, handle, title, url, status, published, content, content_hash, shopify_updated_at)
              values (${storeId}, ${gid("7")}, 'h7', 'Scarf 7', 'https://shop.example.com/products/h7', 'ACTIVE', true, 'c', 'h', now())`;
  rewritten({ budget: { max: 1 }, sort: "cheapest" });
  search.mockResolvedValue([hit("7")]);
  liveCheck.mockResolvedValue({ ok: false, reason: "throttled" });
  create.mockImplementationOnce(fakeStream(["[[product:1]]"]));
  const r = await run();
  expect(promptOf()).toContain("#1 Scarf 7");
  expect(promptOf()).toMatch(/Prices could not be checked/);
  expect(r.products).toMatchObject([{ id: gid("7"), price: null }]);
});

test("answer throwing ChatUnavailable gives an error event with the token; the user message stays and no assistant row is saved", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementation(fakeStream([{ error: apiError(400) }]));
  const r = await run();
  expect(r.events).toEqual([{ event: "error", data: { message: "Assistant unavailable right now", conversationToken: r.token } }]);
  expect(await assistantRows(r.conversationId)).toEqual([]);
  const users = await admin`select count(*)::int as n from messages where conversation_id = ${r.conversationId} and role = 'user'`;
  expect(users[0].n).toBe(1);
});

test("a failing search (embedding call) gives an error event and keeps the user message", async () => {
  search.mockRejectedValue(new Error("embed failed"));
  const r = await run();
  expect(r.events.map((e) => e.event)).toEqual(["error"]);
  expect(create).not.toHaveBeenCalled();
  expect(await assistantRows(r.conversationId)).toEqual([]);
});

test("an answer that hits the output limit is saved as cut_off (C19)", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementationOnce(fakeStream(["Long answer"], { incomplete: true }));
  const r = await run();
  expect(r.events.at(-1)!.event).toBe("done");
  const [row] = await assistantRows(r.conversationId);
  expect(row).toMatchObject({ content: "Long answer", status: "cut_off" });
});

test("aborting mid-answer aborts the OpenAI request and saves what was shown as cut_off, with no done event (C19)", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  const signals: AbortSignal[] = [];
  const ac = new AbortController();
  create.mockImplementationOnce(fakeStream(["Partial ", { hang: true }], { signals }));
  const t = await start();
  const events: string[] = [];
  await turn.runTurn({
    store: t.st,
    conversationId: t.conversationId,
    token: t.token,
    history: t.history,
    message: t.message,
    signal: ac.signal,
    send: (event) => {
      events.push(event);
      if (event === "text") ac.abort();
    },
  });
  expect(signals[0].aborted).toBe(true);
  expect(events).toEqual(["text"]);
  const [row] = await assistantRows(t.conversationId);
  expect(row).toMatchObject({ content: "Partial ", status: "cut_off" });
});

test("aborting before anything was shown saves no assistant row", async () => {
  const ac = new AbortController();
  ac.abort();
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementation(fakeStream(["never"]));
  const r = await run({ signal: ac.signal });
  expect(r.events).toEqual([]);
  expect(await assistantRows(r.conversationId)).toEqual([]);
});

// --- D81: one turn at a time per conversation, and retries not answered twice ---

const busy = async (conversationId: string) =>
  (await admin`select coalesce(busy_until > now(), false) as b from conversations where id = ${conversationId}`)[0].b as boolean;
const userRows = (conversationId: string) =>
  admin`select content, request_id from messages where conversation_id = ${conversationId} and role = 'user' order by created_at`;

type Opened = Extract<Awaited<ReturnType<typeof turn.openTurn>>, { ok: true }>;
const opened = (r: Awaited<ReturnType<typeof turn.openTurn>>): Opened => {
  if (!r.ok) throw new Error(`openTurn ${r.status}`);
  return r;
};
/** Runs runTurn for an opened (non-replay) turn; records the events and whether the conversation was still busy when done/error was sent. */
async function runOpened(st: Awaited<ReturnType<typeof loadStore>>, o: Opened, signal = new AbortController().signal) {
  if (o.replay) throw new Error("replay");
  const events: string[] = [];
  const busyAtEnd: Promise<boolean>[] = [];
  await turn.runTurn({
    store: st,
    conversationId: o.conversationId,
    token: o.token,
    history: o.history,
    message: o.message,
    signal,
    send: (event) => {
      events.push(event);
      if (event === "done" || event === "error") busyAtEnd.push(busy(o.conversationId));
    },
  });
  return { events, busyAtEnd: await Promise.all(busyAtEnd) };
}

test("openTurn claims a new conversation; a second openTurn while its turn runs gets 409 and saves nothing", async () => {
  const st = await loadStore();
  const first = await start("one", st);
  expect(await busy(first.conversationId)).toBe(true);
  expect(await turn.openTurn(st, { token: first.token, message: "two", pageUrl: null })).toEqual({ ok: false, status: 409 });
  expect((await userRows(first.conversationId)).map((r) => r.content)).toEqual(["one"]);
});

test("an expired lock (a crashed turn) can be claimed again", async () => {
  const st = await loadStore();
  const first = await start("one", st);
  await admin`update conversations set busy_until = now() - interval '1 second' where id = ${first.conversationId}`;
  const again = opened(await turn.openTurn(st, { token: first.token, message: "two", pageUrl: null }));
  expect(again.conversationId).toBe(first.conversationId);
  expect(await busy(first.conversationId)).toBe(true);
});

test("the lock is held for about 90 seconds", async () => {
  const first = await start("one");
  const [r] = await admin`select extract(epoch from busy_until - now())::int as s from conversations where id = ${first.conversationId}`;
  expect(r.s).toBeGreaterThanOrEqual(85);
  expect(r.s).toBeLessThanOrEqual(90);
});

test("runTurn releases the lock before sending done, so the next message is accepted", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementation(fakeStream(["Hi"]));
  const st = await loadStore();
  const first = opened(await turn.openTurn(st, { message: "one", pageUrl: null }));
  const r = await runOpened(st, first);
  expect(r.events.at(-1)).toBe("done");
  expect(r.busyAtEnd).toEqual([false]);
  expect((await turn.openTurn(st, { token: first.token, message: "two", pageUrl: null })).ok).toBe(true);
});

test("runTurn releases the lock before sending an error", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementation(fakeStream([{ error: apiError(400) }]));
  const st = await loadStore();
  const r = await runOpened(st, opened(await turn.openTurn(st, { message: "one", pageUrl: null })));
  expect(r.events).toEqual(["error"]);
  expect(r.busyAtEnd).toEqual([false]);
});

test("runTurn releases the lock when the shopper leaves, mid-answer (cut_off) or before anything was shown", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  const st = await loadStore();

  const ac = new AbortController();
  create.mockImplementationOnce(fakeStream(["Partial ", { hang: true }]));
  const mid = opened(await turn.openTurn(st, { message: "one", pageUrl: null }));
  if (mid.replay) throw new Error("replay");
  await turn.runTurn({
    store: st,
    conversationId: mid.conversationId,
    token: mid.token,
    history: mid.history,
    message: mid.message,
    signal: ac.signal,
    send: (event) => {
      if (event === "text") ac.abort();
    },
  });
  expect(await assistantRows(mid.conversationId)).toMatchObject([{ status: "cut_off" }]);
  expect(await busy(mid.conversationId)).toBe(false);

  const gone = new AbortController();
  gone.abort();
  const early = opened(await turn.openTurn(st, { message: "one", pageUrl: null }));
  const r = await runOpened(st, early, gone.signal);
  expect(r.events).toEqual([]);
  expect(await busy(early.conversationId)).toBe(false);
});

test("a repeated requestId after the answer was saved is replayed: same text and cards, no new rows, nothing called", async () => {
  search.mockResolvedValue([hit("1")]);
  liveCheck.mockResolvedValue(liveMap(live("1")));
  create.mockImplementationOnce(fakeStream(["Try ", "[[product:1]]"]));
  const st = await loadStore();
  const rid = crypto.randomUUID();
  const first = opened(await turn.openTurn(st, { message: "tee?", pageUrl: null, requestId: rid }));
  await runOpened(st, first);
  const [saved] = await assistantRows(first.conversationId);
  expect(saved.cards).toHaveLength(1);
  const [savedId] = await admin`select id from messages where conversation_id = ${first.conversationId} and role = 'assistant'`;
  create.mockClear();
  rewriteQuery.mockClear();

  const again = await turn.openTurn(st, { token: first.token, message: "tee?", pageUrl: null, requestId: rid });
  expect(again).toEqual({
    ok: true,
    replay: { id: savedId.id, content: "Try ", cards: saved.cards },
    conversationId: first.conversationId,
    token: first.token,
  });
  expect(await userRows(first.conversationId)).toEqual([{ content: "tee?", request_id: rid }]);
  expect(await assistantRows(first.conversationId)).toHaveLength(1);
  expect(await busy(first.conversationId)).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(rewriteQuery).not.toHaveBeenCalled();
});

test("a repeated requestId while its turn still runs gets 409", async () => {
  const st = await loadStore();
  const rid = crypto.randomUUID();
  const first = opened(await turn.openTurn(st, { message: "one", pageUrl: null, requestId: rid }));
  expect(await turn.openTurn(st, { token: first.token, message: "one", pageUrl: null, requestId: rid })).toEqual({ ok: false, status: 409 });
  expect(await userRows(first.conversationId)).toHaveLength(1);
});

test("a repeated requestId after an error is a new attempt that reuses the same user row", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  const st = await loadStore();
  const base = opened(await turn.openTurn(st, { message: "earlier", pageUrl: null }));
  create.mockImplementationOnce(fakeStream(["Earlier answer"]));
  await runOpened(st, base);

  const rid = crypto.randomUUID();
  create.mockImplementationOnce(fakeStream([{ error: apiError(400) }]));
  const failed = opened(await turn.openTurn(st, { token: base.token, message: "mail a@b.com", pageUrl: null, requestId: rid }));
  expect((await runOpened(st, failed)).events).toEqual(["error"]);

  create.mockImplementationOnce(fakeStream(["Now it works"]));
  const retry = opened(await turn.openTurn(st, { token: base.token, message: "mail a@b.com", pageUrl: null, requestId: rid }));
  if (retry.replay) throw new Error("replayed");
  expect(retry.message).toBe("mail [email]");
  // The history is what came before the reused row, not the row itself.
  expect(retry.history).toEqual([
    { role: "user", content: "earlier" },
    { role: "assistant", content: "Earlier answer" },
  ]);
  expect((await runOpened(st, retry)).events.at(-1)).toBe("done");
  expect(await userRows(base.conversationId)).toEqual([
    { content: "earlier", request_id: null },
    { content: "mail [email]", request_id: rid },
  ]);
  expect((await assistantRows(base.conversationId)).map((r) => r.content).sort()).toEqual(["Earlier answer", "Now it works"]);
});

test("the same requestId in another conversation is a separate message", async () => {
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue(liveMap());
  create.mockImplementation(fakeStream(["Hi"]));
  const st = await loadStore();
  const rid = crypto.randomUUID();
  const a = opened(await turn.openTurn(st, { message: "one", pageUrl: null, requestId: rid }));
  await runOpened(st, a);
  const b = opened(await turn.openTurn(st, { message: "one", pageUrl: null, requestId: rid }));
  expect(b.replay).toBeUndefined();
  expect(b.conversationId).not.toBe(a.conversationId);
});
