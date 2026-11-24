import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// POST /api/chat/feedback (Task 27, UD14, C27): thumbs on an answer, changeable and clearable. Review Focus 4: a token
// can only rate assistant messages of its own conversation in its own store.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/feedback/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
let shopB: string;
const ORIGIN = "https://shop-a.example.com";

function post(shop: string, tok: string | null, body: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (tok) headers["x-conversation-token"] = tok;
  return route.POST(
    new Request(`http://localhost/api/chat/feedback?shop=${encodeURIComponent(shop)}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function conversation(storeId: string) {
  const { conversationId, token: tok } = token.mintToken(storeId);
  await admin`insert into conversations (id, store_id, token_hash) values (${conversationId}, ${storeId}, ${token.tokenHash(tok)})`;
  return { id: conversationId, token: tok };
}

async function message(storeId: string, conversationId: string, role: "user" | "assistant" = "assistant", rating: number | null = null) {
  const [row] = await admin`
    insert into messages (store_id, conversation_id, role, content, rating)
    values (${storeId}, ${conversationId}, ${role}, 'hi', ${rating}) returning id`;
  return row.id as string;
}

async function ratingOf(id: string) {
  const [row] = await admin`select rating from messages where id = ${id}`;
  return row.rating as number | null;
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  route = await import("@/app/api/chat/feedback/route");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const shop = async (id: string, domains: string[]) => {
    const [s] = await admin`update stores set domains = ${domains} where id = ${id} returning shop_domain`;
    return s.shop_domain as string;
  };
  shopA = await shop(storeA, ["shop-a.example.com"]);
  shopB = await shop(storeB, ["shop-b.example.com"]);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("rating 1, then -1, then null: 204 each time and the row follows (C27)", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  for (const rating of [1, -1, null] as const) {
    const res = await post(shopA, c.token, { messageId: m, rating });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await ratingOf(m)).toBe(rating);
  }
});

test("Review Focus 4: conversation A's token can't rate conversation B's message → 404, row unchanged", async () => {
  const a = await conversation(storeA);
  const b = await conversation(storeA);
  const mb = await message(storeA, b.id, "assistant", -1);
  const res = await post(shopA, a.token, { messageId: mb, rating: 1 });
  expect(res.status).toBe(404);
  expect(await ratingOf(mb)).toBe(-1);
});

test("Review Focus 4: a store-A token can't rate a store-B message", async () => {
  const a = await conversation(storeA);
  const b = await conversation(storeB);
  const mb = await message(storeB, b.id, "assistant", -1);
  expect((await post(shopA, a.token, { messageId: mb, rating: 1 })).status).toBe(404);
  // Store B's token sent to store A's shop doesn't verify there.
  expect((await post(shopA, b.token, { messageId: mb, rating: 1 })).status).toBe(401);
  // Nor does store A's token on store B's shop (with B's Origin).
  expect((await post(shopB, a.token, { messageId: mb, rating: 1 }, "https://shop-b.example.com")).status).toBe(401);
  expect(await ratingOf(mb)).toBe(-1);
});

test("a user-role message → 404", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id, "user");
  expect((await post(shopA, c.token, { messageId: m, rating: 1 })).status).toBe(404);
  expect(await ratingOf(m)).toBeNull();
});

test("an unknown message id → 404", async () => {
  const c = await conversation(storeA);
  expect((await post(shopA, c.token, { messageId: "00000000-0000-4000-8000-000000000000", rating: 1 })).status).toBe(404);
});

test("a bad Origin, or none, → 403 with no CORS headers; a bad shop → 404", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  for (const origin of ["https://evil.com", "https://shop-b.example.com", null]) {
    const res = await post(shopA, c.token, { messageId: m, rating: 1 }, origin);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect((await post("evil.com", c.token, { messageId: m, rating: 1 })).status).toBe(404);
  expect(await ratingOf(m)).toBeNull();
});

test("a missing or invalid token → 401 with CORS headers", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  for (const tok of [null, "garbage"]) {
    const res = await post(shopA, tok, { messageId: m, rating: 1 });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
});

test("invalid bodies → 400", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  for (const body of [
    "not json",
    [],
    {},
    { messageId: m },
    { messageId: m, rating: 2 },
    { messageId: m, rating: 0 },
    { messageId: m, rating: "1" },
    { messageId: "nope", rating: 1 },
    { messageId: 5, rating: 1 },
  ]) {
    const res = await post(shopA, c.token, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
  expect(await ratingOf(m)).toBeNull();
});

test("a body over 2 kB → 413", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  const res = await post(shopA, c.token, { messageId: m, rating: 1, pad: "x".repeat(3000) });
  expect(res.status).toBe(413);
  expect(await ratingOf(m)).toBeNull();
});

test("OPTIONS allows POST, Content-Type and X-Conversation-Token", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/chat/feedback", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, X-Conversation-Token");
  expect(res.headers.get("vary")).toBe("Origin");
  const bad = await route.OPTIONS(new Request("http://localhost/api/chat/feedback", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  expect(bad.status).toBe(403);
});
