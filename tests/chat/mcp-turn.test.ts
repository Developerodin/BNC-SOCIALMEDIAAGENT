import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { fakeStream } from "../helpers/fake-openai";
import { newStore } from "../helpers/seed";
import { money, pgid, ucpProduct, ucpReply, ucpVariant } from "../helpers/ucp";

// A chat turn for an mcp-mode store: OpenAI, rewrite, our search and our live check are mocked (the last two must NOT be
// called); fetch stands in for Shopify's UCP endpoint with schema-derived payloads (re-record in Phase 0).
const create = vi.fn();
vi.mock("openai", () => ({ default: vi.fn(function () { return { responses: { create } }; }) }));
const search = vi.fn();
vi.mock("@/lib/retrieval", () => ({ search: (...a: unknown[]) => search(...a) }));
const rewriteQuery = vi.fn();
vi.mock("@/lib/chat/rewrite", () => ({ rewriteQuery: (...a: unknown[]) => rewriteQuery(...a) }));
const liveCheck = vi.fn();
vi.mock("@/lib/shopify/live-products", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify/live-products")>()), liveCheck: (...a: unknown[]) => liveCheck(...a) }));
const fetchMock = vi.fn();

let admin: ReturnType<typeof postgres>;
let turn: typeof import("@/lib/chat/turn");
let limits: typeof import("@/lib/chat/limits");
let guard: typeof import("@/lib/shopify/ucp-guard");
let client: typeof import("@/db/client");

async function loadStore(id: string) {
  const [s] = await admin`select id, shop_domain, name, primary_locale, currency_code, settings, mode from stores where id = ${id}`;
  return { id: s.id, shopDomain: s.shop_domain, name: s.name, primaryLocale: s.primary_locale, currencyCode: s.currency_code, settings: s.settings, mode: s.mode };
}
async function mcpStore() {
  const id = await newStore(admin);
  await admin`update stores set mode = 'mcp', name = 'Pilot', currency_code = 'EUR', primary_locale = 'en' where id = ${id}`;
  return id;
}

async function run(storeId: string, message = "tees") {
  const st = await loadStore(storeId);
  const opened = await turn.openTurn(st, { message, pageUrl: null });
  if (!opened.ok || opened.replay) throw new Error("openTurn failed");
  const events: { event: string; data: Record<string, unknown> }[] = [];
  await turn.runTurn({
    store: st,
    conversationId: opened.conversationId,
    token: opened.token,
    history: opened.history,
    message: opened.message,
    country: "DE",
    signal: new AbortController().signal,
    send: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
  });
  return { events, conversationId: opened.conversationId };
}

/** search_catalog and lookup_catalog replies by tool name. */
function shopify(onSearch: () => Response) {
  fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
    const p = JSON.parse(init.body).params;
    if (p.name === "search_catalog") return onSearch();
    return ucpReply();
  });
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  turn = await import("@/lib/chat/turn");
  limits = await import("@/lib/chat/limits");
  guard = await import("@/lib/shopify/ucp-guard");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  create.mockReset();
  search.mockReset();
  liveCheck.mockReset();
  fetchMock.mockReset();
  guard.resetUcpGuard();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  rewriteQuery.mockReset();
  rewriteQuery.mockImplementation(async (o: { message: string }) => ({ query: o.message, includeGiftCards: false, budget: null, sort: null, tokens: { input: 1, output: 1 } }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

test("an mcp turn takes products from the UCP payload: no embedding search, no Admin live check, cards carry Shopify's prices", async () => {
  const id = await mcpStore();
  shopify(() => ucpReply(ucpProduct(7, { title: "Linen Tee", variants: [ucpVariant(71, { price: money(1999, "EUR") })] })));
  create.mockImplementationOnce(fakeStream([`Try the Linen Tee [[product:1]]`]));
  const r = await run(id);
  expect(search).not.toHaveBeenCalled();
  expect(liveCheck).not.toHaveBeenCalled();
  const card = r.events.find((e) => e.event === "product")!.data;
  expect(card).toMatchObject({ id: pgid(7), title: "Linen Tee", currency: "EUR", price: "19.99", action: "add" });
  expect((card.variants as { id: string }[])[0].id).toBe("71");
  expect(JSON.stringify(create.mock.calls[0][0].input)).toContain("Linen Tee");
  expect(r.events.at(-1)?.event).toBe("done");
});

test("every catalog call of the turn carries the store currency and the shopper's country", async () => {
  const id = await mcpStore();
  shopify(() => ucpReply(ucpProduct(7)));
  create.mockImplementationOnce(fakeStream(["ok"]));
  await run(id);
  const contexts = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).params.arguments.catalog.context);
  expect(contexts.length).toBeGreaterThan(0);
  for (const c of contexts) expect(c).toEqual({ currency: "EUR", address_country: "DE" });
});

test("degraded: when Shopify answers nothing the prompt says the catalog is unavailable, never 'no matching products'", async () => {
  const id = await mcpStore();
  fetchMock.mockRejectedValue(new Error("down"));
  create.mockImplementationOnce(fakeStream(["Sorry, try again"]));
  const r = await run(id);
  const prompt = JSON.stringify(create.mock.calls[0][0].input);
  expect(prompt).toContain("temporarily unavailable");
  expect(r.events.at(-1)?.event).toBe("done");
  expect(r.events.some((e) => e.event === "product")).toBe(false);
});

test("a store with no currency still gets live cards for mcp (the gate is for installed stores only), and no fallback cards", async () => {
  const id = await mcpStore();
  await admin`update stores set currency_code = null where id = ${id}`;
  shopify(() => ucpReply(ucpProduct(7)));
  create.mockImplementationOnce(fakeStream([`ok [[product:1]]`]));
  const r = await run(id);
  expect(r.events.find((e) => e.event === "product")!.data).toMatchObject({ price: "25.00", action: "add" });
});

test("daily cap: over MCP_DAILY_MESSAGES shopper messages today ends the turn with a friendly error, no OpenAI and no Shopify call", async () => {
  const id = await mcpStore();
  const [c] = await admin`insert into conversations (id, store_id, token_hash) values (gen_random_uuid(), ${id}, gen_random_uuid()::text) returning id`;
  const n = limits.MCP_DAILY_MESSAGES;
  await admin`insert into messages (store_id, conversation_id, role, content) select ${id}, ${c.id}, 'user', 'm' from generate_series(1, ${n})`;
  const r = await run(id); // this message is the (n+1)th
  expect(r.events.map((e) => e.event)).toEqual(["error"]);
  expect(String(r.events[0].data.message)).toMatch(/daily limit/);
  expect(create).not.toHaveBeenCalled();
  expect(rewriteQuery).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  // released: the next openTurn on that conversation is not a 409
  const [row] = await admin`select busy_until from conversations where id = ${r.conversationId}`;
  expect(row.busy_until).toBeNull();
});

test("daily cap: exactly at the cap still answers; yesterday's messages don't count; other stores are separate", async () => {
  const id = await mcpStore();
  const other = await mcpStore();
  const [c] = await admin`insert into conversations (id, store_id, token_hash) values (gen_random_uuid(), ${id}, gen_random_uuid()::text) returning id`;
  const [o] = await admin`insert into conversations (id, store_id, token_hash) values (gen_random_uuid(), ${other}, gen_random_uuid()::text) returning id`;
  const n = limits.MCP_DAILY_MESSAGES;
  await admin`insert into messages (store_id, conversation_id, role, content, created_at)
              select ${id}, ${c.id}, 'user', 'old', now() - interval '2 days' from generate_series(1, 500)`;
  await admin`insert into messages (store_id, conversation_id, role, content) select ${other}, ${o.id}, 'user', 'm' from generate_series(1, ${n + 50})`;
  await admin`insert into messages (store_id, conversation_id, role, content) select ${id}, ${c.id}, 'user', 'm' from generate_series(1, ${n - 1})`;
  shopify(() => ucpReply(ucpProduct(7)));
  create.mockImplementationOnce(fakeStream(["fine"]));
  const r = await run(id); // the nth today
  expect(r.events.at(-1)?.event).toBe("done");
});

test("the cap applies to mcp stores only: an installed store over the same count is answered as before", async () => {
  const id = await newStore(admin);
  await admin`update stores set currency_code = 'EUR' where id = ${id}`;
  const [c] = await admin`insert into conversations (id, store_id, token_hash) values (gen_random_uuid(), ${id}, gen_random_uuid()::text) returning id`;
  await admin`insert into messages (store_id, conversation_id, role, content) select ${id}, ${c.id}, 'user', 'm' from generate_series(1, ${limits.MCP_DAILY_MESSAGES + 20})`;
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue({ ok: true, products: new Map() });
  create.mockImplementationOnce(fakeStream(["hello"]));
  const r = await run(id);
  expect(r.events.at(-1)?.event).toBe("done");
  expect(search).toHaveBeenCalled(); // our own search, as before
  expect(fetchMock).not.toHaveBeenCalled(); // no UCP call for an installed store
});

test("the lock covers the real timeouts: rewrite 8 s + catalog budget + 60 s answer fit in it", async () => {
  const id = await mcpStore();
  const st = await loadStore(id);
  await turn.openTurn(st, { message: "hi", pageUrl: null });
  const [r] = await admin`select extract(epoch from busy_until - now()) as s from conversations where store_id = ${id}`;
  expect(Number(r.s)).toBeGreaterThan(8 + guard.MCP_BUDGET_MS / 1000 + 60);
  expect(Number(r.s)).toBeLessThanOrEqual(90);
});
