import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { newStore } from "../helpers/seed";

// POST /api/chat/cart-event (Task 27, UD11, §7.6): an Add to cart from a chat card. eventId makes a retried log idempotent.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/cart-event/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
const ORIGIN = "https://shop-a.example.com";

function post(shop: string, tok: string | null, body: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (tok) headers["x-conversation-token"] = tok;
  return route.POST(
    new Request(`http://localhost/api/chat/cart-event?shop=${encodeURIComponent(shop)}`, {
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

async function message(storeId: string, conversationId: string, role: "user" | "assistant" = "assistant") {
  const [row] = await admin`
    insert into messages (store_id, conversation_id, role, content) values (${storeId}, ${conversationId}, ${role}, 'hi') returning id`;
  return row.id as string;
}

const event = (o: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  productId: "gid://shopify/Product/123",
  variantId: "456",
  quantity: 1,
  ...o,
});

async function rows(eventId: string) {
  return admin`select store_id, conversation_id, message_id, product_id, variant_id, quantity from cart_events where event_id = ${eventId}`;
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  route = await import("@/app/api/chat/cart-event/route");
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
  await shop(storeB, ["shop-b.example.com"]);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("logs the event with its message: 204, CORS, no-store", async () => {
  const c = await conversation(storeA);
  const m = await message(storeA, c.id);
  const e = event({ messageId: m, quantity: 3 });
  const res = await post(shopA, c.token, e);
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("vary")).toBe("Origin");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect([...(await rows(e.eventId))]).toEqual([
    { store_id: storeA, conversation_id: c.id, message_id: m, product_id: e.productId, variant_id: "456", quantity: 3 },
  ]);
});

test("the same eventId twice → one row, both 204", async () => {
  const c = await conversation(storeA);
  const e = event();
  expect((await post(shopA, c.token, e)).status).toBe(204);
  expect((await post(shopA, c.token, { ...e, quantity: 5 })).status).toBe(204);
  const r = await rows(e.eventId);
  expect(r.length).toBe(1);
  expect(r[0].quantity).toBe(1);
});

test("no messageId, or null → stored as null", async () => {
  const c = await conversation(storeA);
  const e1 = event();
  const e2 = event({ messageId: null });
  expect((await post(shopA, c.token, e1)).status).toBe(204);
  expect((await post(shopA, c.token, e2)).status).toBe(204);
  expect((await rows(e1.eventId))[0].message_id).toBeNull();
  expect((await rows(e2.eventId))[0].message_id).toBeNull();
});

test("Review Focus 4: a messageId of another conversation or another store is stored as null", async () => {
  const a = await conversation(storeA);
  const other = await conversation(storeA);
  const b = await conversation(storeB);
  const mOther = await message(storeA, other.id);
  const mB = await message(storeB, b.id);
  for (const messageId of [mOther, mB]) {
    const e = event({ messageId });
    expect((await post(shopA, a.token, e)).status).toBe(204);
    const [r] = await rows(e.eventId);
    expect(r.message_id).toBeNull();
    expect(r.conversation_id).toBe(a.id);
    expect(r.store_id).toBe(storeA);
  }
});

test("Review Focus 4: a store-B token on store A's shop → 401, nothing logged", async () => {
  const b = await conversation(storeB);
  const e = event();
  expect((await post(shopA, b.token, e)).status).toBe(401);
  expect((await rows(e.eventId)).length).toBe(0);
});

test("a deleted conversation → 404, not 500", async () => {
  const c = await conversation(storeA);
  await admin`delete from conversations where id = ${c.id}`;
  const e = event();
  expect((await post(shopA, c.token, e)).status).toBe(404);
  expect((await rows(e.eventId)).length).toBe(0);
});

test("a missing or invalid token → 401; a bad Origin → 403; a bad shop → 404", async () => {
  const c = await conversation(storeA);
  expect((await post(shopA, null, event())).status).toBe(401);
  expect((await post(shopA, "garbage", event())).status).toBe(401);
  const res = await post(shopA, c.token, event(), "https://evil.com");
  expect(res.status).toBe(403);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect((await post(shopA, c.token, event(), null)).status).toBe(403);
  expect((await post("evil.com", c.token, event())).status).toBe(404);
});

test("invalid fields → 400, nothing logged", async () => {
  const c = await conversation(storeA);
  const bad: Record<string, unknown>[] = [
    { variantId: "gid://shopify/ProductVariant/456" },
    { variantId: "abc" },
    { variantId: "" },
    { variantId: 456 },
    { variantId: "1".repeat(21) },
    { productId: "123" },
    { productId: "gid://shopify/ProductVariant/123" },
    { productId: "gid://shopify/Product/abc" },
    { quantity: 0 },
    { quantity: 100 },
    { quantity: 1.5 },
    { quantity: "1" },
    { eventId: "nope" },
    { eventId: undefined },
    { messageId: "nope" },
    { messageId: 5 },
  ];
  for (const o of bad) {
    const e = event(o);
    const res = await post(shopA, c.token, e);
    expect(res.status, JSON.stringify(o)).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    if (!("eventId" in o)) expect((await rows(e.eventId as string)).length).toBe(0);
  }
  for (const body of ["not json", "[]", "null"]) expect((await post(shopA, c.token, body)).status).toBe(400);
});

test("quantity 99 is allowed", async () => {
  const c = await conversation(storeA);
  expect((await post(shopA, c.token, event({ quantity: 99 }))).status).toBe(204);
});

test("a body over 2 kB → 413", async () => {
  const c = await conversation(storeA);
  const e = event({ pad: "x".repeat(3000) });
  expect((await post(shopA, c.token, e)).status).toBe(413);
  expect((await rows(e.eventId)).length).toBe(0);
});

test("OPTIONS allows POST, Content-Type and X-Conversation-Token", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/chat/cart-event", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, X-Conversation-Token");
  expect(res.headers.get("vary")).toBe("Origin");
  const bad = await route.OPTIONS(new Request("http://localhost/api/chat/cart-event", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  expect(bad.status).toBe(403);
});
