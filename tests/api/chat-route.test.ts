import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { fakeStream } from "../helpers/fake-openai";
import { gid, newStore } from "../helpers/seed";
import type { LiveProduct } from "@/lib/shopify/live-products";

// Nothing here calls OpenAI or Shopify: the client, search, rewrite and liveCheck are all mocked.
const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));
const search = vi.fn();
vi.mock("@/lib/retrieval", () => ({ search: (...a: unknown[]) => search(...a) }));
const rewriteQuery = vi.fn();
vi.mock("@/lib/chat/rewrite", () => ({ rewriteQuery: (...a: unknown[]) => rewriteQuery(...a) }));
const liveCheck = vi.fn();
vi.mock("@/lib/shopify/live-products", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/live-products")>()),
  liveCheck: (...a: unknown[]) => liveCheck(...a),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
let shopB: string;
let inactiveShop: string;
const ORIGIN = "https://shop-a.example.com";

const live = (id: string): LiveProduct => ({
  id: gid(id),
  title: `Tee ${id}`,
  url: `https://shop.example.com/products/h${id}`,
  imageUrl: null,
  currency: "EUR",
  available: true,
  action: "add",
  hasOnlyDefaultVariant: true,
  options: [],
  variants: [{ id: `${id}1`, title: "Default Title", options: [], available: true, stock: { kind: "in_stock" }, price: "10.00", compareAtPrice: null }],
  moreVariants: false,
});

function post(body: unknown, origin: string | null = ORIGIN) {
  return route.POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

type Ev = { event: string; data: Record<string, unknown> };
/** Strict SSE parse: every block is "event: <name>\ndata: <JSON>" or a ":" comment, separated by a blank line. */
function parseSse(raw: string): Ev[] {
  expect(raw.endsWith("\n\n")).toBe(true);
  const out: Ev[] = [];
  for (const block of raw.slice(0, -2).split("\n\n")) {
    if (block.startsWith(":")) continue;
    const m = /^event: (\w+)\ndata: (.*)$/.exec(block);
    expect(m, `bad SSE block: ${block}`).not.toBeNull();
    out.push({ event: m![1], data: JSON.parse(m![2]) });
  }
  return out;
}
const readAll = async (res: Response) => parseSse(await res.text());
/** Task 22: the id of the conversation's latest assistant row, which `done` carries as messageId. */
async function lastAssistantId(conversationId: string | null) {
  const [row] = await admin`select id from messages where conversation_id = ${conversationId} and role = 'assistant' order by created_at desc limit 1`;
  return row.id as string;
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  route = await import("@/app/api/chat/route");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const inactive = await newStore(admin, false);
  const shop = async (id: string, domains: string[]) => {
    const [s] = await admin`update stores set currency_code = 'EUR', name = 'Shop', domains = ${domains} where id = ${id} returning shop_domain`;
    return s.shop_domain as string;
  };
  shopA = await shop(storeA, ["shop-a.example.com"]);
  shopB = await shop(storeB, ["shop-b.example.com"]);
  inactiveShop = await shop(inactive, ["shop-a.example.com"]);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  create.mockReset();
  search.mockReset();
  rewriteQuery.mockReset();
  liveCheck.mockReset();
  rewriteQuery.mockImplementation(async (o: { message: string }) => ({ query: o.message, includeGiftCards: false, tokens: { input: 1, output: 1 } }));
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue({ ok: true, products: new Map() });
  create.mockImplementation(fakeStream(["Hello ", "there"]));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const noCalls = () => {
  expect(create).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(rewriteQuery).not.toHaveBeenCalled();
  expect(liveCheck).not.toHaveBeenCalled();
};

// --- CORS (Review Focus 3) ---

test("no Origin → 403, and nothing is called", async () => {
  const res = await post({ shop: shopA, message: "hi" }, null);
  expect(res.status).toBe(403);
  noCalls();
});

test("Origin https://evil.com → 403, with no CORS headers, and none of the mocks are called", async () => {
  const res = await post({ shop: shopA, message: "hi" }, "https://evil.com");
  expect(res.status).toBe(403);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  noCalls();
});

test("an http:// Origin, or store B's domain for store A, → 403", async () => {
  expect((await post({ shop: shopA, message: "hi" }, "http://shop-a.example.com")).status).toBe(403);
  expect((await post({ shop: shopA, message: "hi" }, "https://shop-b.example.com")).status).toBe(403);
  noCalls();
});

test("OPTIONS from an allowed origin returns the allow headers", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/chat", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, X-AskCart-Customer");
  expect(res.headers.get("vary")).toBe("Origin");
});

test("OPTIONS from an unknown origin, or with none, → 403", async () => {
  const opt = (h: Record<string, string>) => route.OPTIONS(new Request("http://localhost/api/chat", { method: "OPTIONS", headers: h }));
  expect((await opt({ origin: "https://evil.com" })).status).toBe(403);
  expect((await opt({})).status).toBe(403);
});

// --- request checks ---

test("a 2,001-character message → 413 with CORS headers; 2,000 is accepted", async () => {
  const res = await post({ shop: shopA, message: "a".repeat(2001) });
  expect(res.status).toBe(413);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  noCalls();
  const ok = await post({ shop: shopA, message: "a".repeat(2000) });
  expect(ok.status).toBe(200);
  await ok.text();
});

test("an empty or missing message → 400", async () => {
  expect((await post({ shop: shopA, message: "   " })).status).toBe(400);
  expect((await post({ shop: shopA })).status).toBe(400);
  noCalls();
});

test("an inactive store, an unknown shop, a malformed shop or a non-JSON body → 404", async () => {
  expect((await post({ shop: inactiveShop, message: "hi" })).status).toBe(404);
  expect((await post({ shop: "nope.myshopify.com", message: "hi" })).status).toBe(404);
  expect((await post({ shop: "https://evil.com", message: "hi" })).status).toBe(404);
  expect((await post("not json")).status).toBe(404);
  noCalls();
});

test("a store-B token with store A's shop → 401, and nothing is saved or called (Review Focus 2)", async () => {
  const resB = await post({ shop: shopB, message: "secret B" }, "https://shop-b.example.com");
  const tokB = (await readAll(resB)).at(-1)!.data.conversationToken as string;
  create.mockClear();
  rewriteQuery.mockClear();
  search.mockClear();
  liveCheck.mockClear();
  const res = await post({ shop: shopA, message: "hi", conversationToken: tokB });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid_token" });
  noCalls();
  const rows = await admin`select count(*)::int as n from messages where store_id = ${storeA} and content = 'hi'`;
  expect(rows[0].n).toBe(0);
});

test("a tampered or non-string token → 401", async () => {
  const { token: t } = token.mintToken(storeA);
  expect((await post({ shop: shopA, message: "hi", conversationToken: t.slice(0, -1) + (t.endsWith("A") ? "B" : "A") })).status).toBe(401);
  expect((await post({ shop: shopA, message: "hi", conversationToken: 42 })).status).toBe(401);
});

// --- conversations ---

test("the first message creates one conversation; meta (first) and done carry a token verifyToken accepts; a second request continues it", async () => {
  const before = await admin`select count(*)::int as n from conversations where store_id = ${storeA}`;
  const res = await post({ shop: shopA, message: "first", pageUrl: "https://shop-a.example.com/products/x" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const events = await readAll(res);
  expect(events.map((e) => e.event)).toEqual(["meta", "text", "text", "done"]);
  const tok = events.at(-1)!.data.conversationToken as string;
  // MetaEvent: the token comes first, before any text.
  expect(events[0]).toEqual({ event: "meta", data: { conversationToken: tok } });
  const conversationId = token.verifyToken(storeA, tok);
  expect(conversationId).not.toBeNull();
  const after = await admin`select count(*)::int as n from conversations where store_id = ${storeA}`;
  expect(after[0].n).toBe(before[0].n + 1);
  const [conv] = await admin`select page_url from conversations where id = ${conversationId}`;
  expect(conv.page_url).toBe("https://shop-a.example.com/products/x");

  const res2 = await post({ shop: shopA, message: "second", conversationToken: tok });
  const events2 = await readAll(res2);
  expect(events2[0]).toEqual({ event: "meta", data: { conversationToken: tok } });
  expect(events2.at(-1)).toEqual({ event: "done", data: { conversationToken: tok, messageId: await lastAssistantId(conversationId) } });
  expect(events.at(-1)!.data.messageId).toEqual(expect.any(String));
  expect(events.at(-1)!.data.messageId).not.toBe(events2.at(-1)!.data.messageId);
  const msgs = await admin`select role, content from messages where conversation_id = ${conversationId} order by created_at`;
  expect(msgs).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello there" },
    { role: "user", content: "second" },
    { role: "assistant", content: "Hello there" },
  ]);
  const final = await admin`select count(*)::int as n from conversations where store_id = ${storeA}`;
  expect(final[0].n).toBe(after[0].n);
  // The second turn's rewrite saw the first turn as history.
  expect(rewriteQuery.mock.calls.at(-1)![0].history).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello there" },
  ]);
});

// --- masking (Review Focus 4) ---

test('"mail me at a@b.com" is masked in the stored row, the rewrite input, the search query and the answer input', async () => {
  const bodies: unknown[] = [];
  create.mockImplementation(fakeStream(["ok"], { bodies }));
  const events = await readAll(await post({ shop: shopA, message: "mail me at a@b.com" }));
  const conversationId = token.verifyToken(storeA, events.at(-1)!.data.conversationToken as string);
  const [row] = await admin`select content from messages where conversation_id = ${conversationId} and role = 'user'`;
  expect(row.content).toBe("mail me at [email]");
  expect(rewriteQuery.mock.calls[0][0].message).toBe("mail me at [email]");
  expect(search.mock.calls[0][1]).toBe("mail me at [email]");
  const sent = JSON.stringify(bodies);
  expect(sent).toContain("[email]");
  const everything = JSON.stringify([rewriteQuery.mock.calls, search.mock.calls, bodies, row]);
  expect(everything).not.toContain("a@b.com");
});

// --- country (D77, C16 a) ---

test("a valid country is passed to liveCheck; a malformed or missing one is treated as missing", async () => {
  for (const [country, expected] of [
    ["FR", "FR"],
    ["fr", undefined],
    ["FRA", undefined],
    [undefined, undefined],
  ] as const) {
    liveCheck.mockClear();
    search.mockResolvedValueOnce([{ chunkId: "c", source: "product", productId: gid("1"), content: "x", score: 1 }]);
    liveCheck.mockResolvedValueOnce({ ok: true, products: new Map([[gid("1"), live("1")]]) });
    await readAll(await post({ shop: shopA, message: "hi", country }));
    expect(liveCheck.mock.calls[0][3].country).toBe(expected);
  }
});

// --- failures ---

test("cancelling the response body mid-stream aborts the OpenAI request, saves the cut-off answer and logs no unhandled rejection (Review Focus 7)", async () => {
  const signals: AbortSignal[] = [];
  create.mockImplementation(fakeStream(["Partial ", { hang: true }], { signals }));
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const res = await post({ shop: shopA, message: "cancel me" });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = "";
    while (!got.includes("event: text")) got += dec.decode((await reader.read()).value);
    await reader.cancel();
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await vi.waitFor(async () => {
      const rows = await admin`select m.content, m.status from messages m
        join messages u on u.conversation_id = m.conversation_id and u.role = 'user' and u.content = 'cancel me'
        where m.role = 'assistant'`;
      expect(rows).toEqual([{ content: "Partial ", status: "cut_off" }]);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    // D81: the shopper leaving frees the conversation for the next message.
    await vi.waitFor(async () => {
      const [conv] = await admin`select c.busy_until from conversations c
        join messages u on u.conversation_id = c.id and u.role = 'user' and u.content = 'cancel me'`;
      expect(conv.busy_until).toBeNull();
    });
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

// --- D81: one turn at a time, and retries not answered twice ---

/** Holds the next turn in its rewrite step until open() is called. */
function gateNextTurn() {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  rewriteQuery.mockImplementationOnce(async (o: { message: string }) => {
    await gate;
    return { query: o.message, includeGiftCards: false, tokens: { input: 1, output: 1 } };
  });
  return open;
}
const clearMocks = () => [create, search, rewriteQuery, liveCheck].forEach((m) => m.mockClear());
async function newConversation() {
  const events = await readAll(await post({ shop: shopA, message: "start" }));
  return events.at(-1)!.data.conversationToken as string;
}

test("meta reaches the client while the turn is still running, before any text, so an aborted stream still has the token", async () => {
  const open = gateNextTurn();
  const res = await post({ shop: shopA, message: "new conversation" });
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const [first] = parseSse(new TextDecoder().decode(value));
  expect(first.event).toBe("meta");
  expect(token.verifyToken(storeA, first.data.conversationToken as string)).not.toBeNull();
  open();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  expect(parseSse(rest).at(-1)!.data.conversationToken).toBe(first.data.conversationToken);
});

test("a second POST while the conversation's turn runs → 409 turn_in_progress with CORS headers and no calls; the first finishes", async () => {
  const tok = await newConversation();
  const open = gateNextTurn();
  const first = await post({ shop: shopA, message: "slow one", conversationToken: tok });
  expect(first.status).toBe(200);
  await vi.waitFor(() => expect(rewriteQuery).toHaveBeenCalledTimes(2));
  clearMocks();

  const second = await post({ shop: shopA, message: "impatient", conversationToken: tok });
  expect(second.status).toBe(409);
  expect(second.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(await second.json()).toEqual({ error: "turn_in_progress" });
  noCalls();
  const saved = await admin`select count(*)::int as n from messages where content = 'impatient'`;
  expect(saved[0].n).toBe(0);

  open();
  expect((await readAll(first)).at(-1)).toEqual({
    event: "done",
    data: { conversationToken: tok, messageId: await lastAssistantId(token.verifyToken(storeA, tok)) },
  });
  // Released after done: the next message goes through.
  const third = await post({ shop: shopA, message: "next", conversationToken: tok });
  expect(third.status).toBe(200);
  expect((await readAll(third)).at(-1)!.event).toBe("done");
});

test("the lock is released after an error, so the shopper can send again", async () => {
  const tok = await newConversation();
  create.mockImplementationOnce(fakeStream([{ error: Object.assign(new Error("HTTP 400"), { status: 400 }) }]));
  expect((await readAll(await post({ shop: shopA, message: "fails", conversationToken: tok }))).map((e) => e.event)).toEqual(["meta", "error"]);
  const res = await post({ shop: shopA, message: "again", conversationToken: tok });
  expect(res.status).toBe(200);
  await res.text();
});

test("an invalid requestId → 400 invalid_request_id with CORS headers, and nothing is called", async () => {
  for (const requestId of ["not-a-uuid", 42, "", "123e4567-e89b-12d3-a456-42661417400"]) {
    const res = await post({ shop: shopA, message: "hi", requestId });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ error: "invalid_request_id" });
  }
  noCalls();
});

test("a repeated requestId after done replays the saved answer as SSE (meta, text, products, done) without calling OpenAI", async () => {
  const tok = await newConversation();
  const requestId = crypto.randomUUID();
  search.mockResolvedValueOnce([{ chunkId: "c", source: "product", productId: gid("1"), content: "x", score: 1 }]);
  liveCheck.mockResolvedValueOnce({ ok: true, products: new Map([[gid("1"), live("1")]]) });
  create.mockImplementation(fakeStream(["Here ", "you go: ", "[[product:1]]"]));
  const firstEvents = await readAll(await post({ shop: shopA, message: "tee?", conversationToken: tok, requestId }));
  expect(firstEvents.map((e) => e.event)).toEqual(["meta", "text", "text", "product", "done"]);
  clearMocks();

  const res = await post({ shop: shopA, message: "tee?", conversationToken: tok, requestId });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const events = await readAll(res);
  expect(events).toEqual([
    { event: "meta", data: { conversationToken: tok } },
    { event: "text", data: { delta: "Here you go: " } },
    { event: "product", data: firstEvents[3].data },
    { event: "done", data: { conversationToken: tok, messageId: firstEvents[4].data.messageId } },
  ]);
  // The replay names the original answer row, so thumbs given to the first stream apply to the replayed one too.
  expect(firstEvents[4].data.messageId).toBe(await lastAssistantId(token.verifyToken(storeA, tok)));
  noCalls();
  const rows = await admin`select role from messages where request_id = ${requestId} or (role = 'assistant' and content = 'Here you go: ')`;
  expect(rows.map((r) => r.role).sort()).toEqual(["assistant", "user"]);
});

test("a repeated requestId while its turn runs → 409 turn_in_progress", async () => {
  const tok = await newConversation();
  const requestId = crypto.randomUUID();
  const open = gateNextTurn();
  const first = await post({ shop: shopA, message: "slow", conversationToken: tok, requestId });
  await vi.waitFor(() => expect(rewriteQuery).toHaveBeenCalledTimes(2));
  const again = await post({ shop: shopA, message: "slow", conversationToken: tok, requestId });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "turn_in_progress" });
  open();
  expect((await readAll(first)).at(-1)!.event).toBe("done");
  const users = await admin`select count(*)::int as n from messages where request_id = ${requestId}`;
  expect(users[0].n).toBe(1);
});

test("a repeated requestId after an error is answered again, without a second user row", async () => {
  const tok = await newConversation();
  const requestId = crypto.randomUUID();
  create.mockImplementationOnce(fakeStream([{ error: Object.assign(new Error("HTTP 400"), { status: 400 }) }]));
  const failed = await readAll(await post({ shop: shopA, message: "retry me", conversationToken: tok, requestId }));
  expect(failed.map((e) => e.event)).toEqual(["meta", "error"]);

  const retried = await readAll(await post({ shop: shopA, message: "retry me", conversationToken: tok, requestId }));
  expect(retried.map((e) => e.event)).toEqual(["meta", "text", "text", "done"]);
  const conversationId = token.verifyToken(storeA, tok);
  const msgs = await admin`select role, content from messages where conversation_id = ${conversationId} order by created_at`;
  expect(msgs).toEqual([
    { role: "user", content: "start" },
    { role: "assistant", content: "Hello there" },
    { role: "user", content: "retry me" },
    { role: "assistant", content: "Hello there" },
  ]);
});

test("a product marker streams a product event between the text and done, as valid SSE", async () => {
  search.mockResolvedValueOnce([{ chunkId: "c", source: "product", productId: gid("1"), content: "x", score: 1 }]);
  liveCheck.mockResolvedValueOnce({ ok: true, products: new Map([[gid("1"), live("1")]]) });
  create.mockImplementation(fakeStream(["Here: ", "[[prod", "uct:1]]"]));
  const events = await readAll(await post({ shop: shopA, message: "tee?" }));
  expect(events.map((e) => e.event)).toEqual(["meta", "text", "product", "done"]);
  expect(events[2].data).toMatchObject({ id: gid("1"), price: "10.00", currency: "EUR", action: "add" });
});
