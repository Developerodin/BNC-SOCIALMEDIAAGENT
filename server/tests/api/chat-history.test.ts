import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";
import type { HistoryMessage } from "@/lib/chat/turn";
import type { HistoryItem } from "@/lib/widget-contract";

// Task 22: the server's history item is the shape the widget's contract expects (compile-time check, run by tsc).
const _historyMatchesContract: HistoryItem[] = [] as HistoryMessage[];
void _historyMatchesContract;

// GET /api/chat/history (Task 20, UD13). C15 = (b): the saved card snapshot comes back as saved, with no live re-check,
// so nothing here calls OpenAI or Shopify.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/history/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
let inactiveShop: string;
const ORIGIN = "https://shop-a.example.com";

function get(shop: string, tok: string | null, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (tok) headers["x-conversation-token"] = tok;
  return route.GET(new Request(`http://localhost/api/chat/history?shop=${encodeURIComponent(shop)}`, { headers }));
}

/** A conversation for `storeId` with its token; the row is inserted through the admin connection. */
async function conversation(storeId: string) {
  const { conversationId, token: tok } = token.mintToken(storeId);
  await admin`insert into conversations (id, store_id, token_hash) values (${conversationId}, ${storeId}, ${token.tokenHash(tok)})`;
  return { id: conversationId, token: tok };
}

/** Inserts messages one second apart, oldest first. */
async function addMessages(
  storeId: string,
  conversationId: string,
  rows: { role: "user" | "assistant"; content: string; status?: string; cards?: unknown; rating?: number }[],
) {
  const base = Date.parse("2026-11-24T10:00:00Z");
  const ids: string[] = [];
  for (const [i, r] of rows.entries()) {
    const [row] = await admin`
      insert into messages (store_id, conversation_id, role, content, status, cards, rating, created_at)
      values (${storeId}, ${conversationId}, ${r.role}, ${r.content}, ${r.status ?? "ok"},
              ${r.cards === undefined ? null : admin.json(r.cards as never)}, ${r.rating ?? null}, ${new Date(base + i * 1000)})
      returning id`;
    ids.push(row.id);
  }
  return ids;
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  route = await import("@/app/api/chat/history/route");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const inactive = await newStore(admin, false);
  const shop = async (id: string, domains: string[]) => {
    const [s] = await admin`update stores set domains = ${domains} where id = ${id} returning shop_domain`;
    return s.shop_domain as string;
  };
  shopA = await shop(storeA, ["shop-a.example.com"]);
  await shop(storeB, ["shop-b.example.com"]);
  inactiveShop = await shop(inactive, ["shop-a.example.com"]);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

// --- shop and CORS ---

test("a malformed, unknown or inactive shop → 404", async () => {
  const c = await conversation(storeA);
  expect((await get("evil.com", c.token)).status).toBe(404);
  expect((await get("nope.myshopify.com", c.token)).status).toBe(404);
  expect((await get(inactiveShop, c.token)).status).toBe(404);
});

test("a disallowed Origin, or none, → 403 with no CORS headers", async () => {
  const c = await conversation(storeA);
  for (const origin of ["https://evil.com", "https://shop-b.example.com", "http://shop-a.example.com", null]) {
    const res = await get(shopA, c.token, origin);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
});

test("OPTIONS allows GET and the X-Conversation-Token header", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/chat/history", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  expect(res.headers.get("access-control-allow-headers")).toContain("X-Conversation-Token");
  expect(res.headers.get("vary")).toBe("Origin");
  const bad = await route.OPTIONS(new Request("http://localhost/api/chat/history", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  expect(bad.status).toBe(403);
});

// --- token ---

test("a missing, invalid or other-store token → 401 with CORS headers", async () => {
  const b = await conversation(storeB);
  const a = await conversation(storeA);
  const tampered = a.token.slice(0, -2) + (a.token.endsWith("AA") ? "BB" : "AA");
  for (const tok of [null, "garbage", tampered, b.token]) {
    const res = await get(shopA, tok);
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
});

test("a valid token whose conversation is gone → 404", async () => {
  const { token: tok } = token.mintToken(storeA); // signed for store A, but no row
  const res = await get(shopA, tok);
  expect(res.status).toBe(404);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
});

// --- history ---

test("a valid token returns that conversation's messages only, oldest first, uncached, with CORS headers", async () => {
  const mine = await conversation(storeA);
  const other = await conversation(storeA);
  const ids = await addMessages(storeA, mine.id, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", cards: [] },
    { role: "user", content: "boots?" },
    { role: "assistant", content: "these", status: "cut_off", cards: [] },
  ]);
  await addMessages(storeA, other.id, [{ role: "user", content: "someone else" }]);

  const res = await get(shopA, mine.token);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("vary")).toBe("Origin");
  const { messages } = await res.json();
  expect(messages).toEqual([
    { id: ids[0], role: "user", content: "hi", status: "ok", cards: [], rating: null },
    { id: ids[1], role: "assistant", content: "hello", status: "ok", cards: [], rating: null },
    { id: ids[2], role: "user", content: "boots?", status: "ok", cards: [], rating: null },
    { id: ids[3], role: "assistant", content: "these", status: "cut_off", cards: [], rating: null },
  ]);
});

test("a saved rating comes back with its message (UD14, C27)", async () => {
  const c = await conversation(storeA);
  const ids = await addMessages(storeA, c.id, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "liked", rating: 1 },
    { role: "user", content: "and?" },
    { role: "assistant", content: "disliked", rating: -1 },
  ]);
  const { messages } = await (await get(shopA, c.token)).json();
  expect(messages.map((m: { id: string; rating: number | null }) => [m.id, m.rating])).toEqual([
    [ids[0], null],
    [ids[1], 1],
    [ids[2], null],
    [ids[3], -1],
  ]);
});

test("a conversation with 30 messages returns the last 20, oldest first", async () => {
  const c = await conversation(storeA);
  await addMessages(
    storeA,
    c.id,
    Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: `m${i}` })),
  );
  const { messages } = await (await get(shopA, c.token)).json();
  expect(messages.map((m: { content: string }) => m.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 10}`));
});

test("masked text comes back masked", async () => {
  const c = await conversation(storeA);
  await addMessages(storeA, c.id, [{ role: "user", content: "mail me at [email]" }]);
  const { messages } = await (await get(shopA, c.token)).json();
  expect(messages[0].content).toBe("mail me at [email]");
});

test("cards come back exactly as saved (C15 b), with no live re-check", async () => {
  const c = await conversation(storeA);
  const cards = [
    {
      id: "gid://shopify/Product/1",
      title: "Tee 1",
      imageUrl: null,
      url: "https://shop-a.example.com/products/h1",
      currency: "EUR",
      available: true,
      action: "add",
      stock: { kind: "count", n: 2 },
      price: "10.00",
      compareAtPrice: "12.00",
      variants: [{ id: "11", title: "S", options: [], available: true, stock: { kind: "count", n: 2 }, price: "10.00", compareAtPrice: "12.00" }],
      moreVariants: false,
    },
    {
      id: "gid://shopify/Product/2",
      title: "Tee 2",
      imageUrl: "https://cdn.example.com/2.jpg",
      url: "https://shop-a.example.com/products/h2",
      currency: null,
      available: null,
      action: "none",
      stock: null,
      price: null,
      compareAtPrice: null,
      variants: [],
      moreVariants: false,
    },
  ];
  await addMessages(storeA, c.id, [
    { role: "user", content: "tees" },
    { role: "assistant", content: "two tees", cards },
  ]);
  const { messages } = await (await get(shopA, c.token)).json();
  expect(messages[1].cards).toEqual(cards);
});

test("assistant items carry the adds made from their cards (oldest first); other items have no cartAdds", async () => {
  await admin`insert into products (store_id, shopify_id, handle, title, status, published, content, content_hash, shopify_updated_at)
              values (${storeA}, 'gid://shopify/Product/71', 'a', 'Wax <b>One</b>', 'ACTIVE', true, 'c', 'h', now()),
                     (${storeA}, 'gid://shopify/Product/72', 'b', 'Wax Two', 'ACTIVE', true, 'c', 'h', now())`;
  const c = await conversation(storeA);
  const [, answer] = await addMessages(storeA, c.id, [
    { role: "user", content: "wax" },
    { role: "assistant", content: "two waxes" },
    { role: "assistant", content: "nothing added" },
  ]);
  const add = (product: string, at: string) =>
    admin`insert into cart_events (store_id, conversation_id, message_id, product_id, variant_id, quantity, event_id, created_at)
          values (${storeA}, ${c.id}, ${answer}, ${product}, '1', 1, gen_random_uuid(), ${at}::timestamptz)`;
  await add("gid://shopify/Product/72", "2026-11-24T11:00:02Z");
  await add("gid://shopify/Product/71", "2026-11-24T11:00:01Z");
  const { messages } = await (await get(shopA, c.token)).json();
  expect(messages[0]).not.toHaveProperty("cartAdds");
  expect(messages[1].cartAdds).toEqual([{ title: "Wax <b>One</b>" }, { title: "Wax Two" }]);
  expect(messages[2]).not.toHaveProperty("cartAdds");
});
