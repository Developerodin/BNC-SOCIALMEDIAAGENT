import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// POST /api/chat/feedback with a reason: only with rating -1, from a fixed list, cleared when the rating changes or clears.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/feedback/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let events: typeof import("@/lib/chat/events");
let shop: string;
let storeId: string;
const ORIGIN = "https://shop-a.example.com";

function post(tok: string, body: unknown) {
  return route.POST(
    new Request(`http://localhost/api/chat/feedback?shop=${encodeURIComponent(shop)}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-conversation-token": tok },
      body: JSON.stringify(body),
    }),
  );
}

async function setup() {
  const { conversationId, token: tok } = token.mintToken(storeId);
  await admin`insert into conversations (id, store_id, token_hash) values (${conversationId}, ${storeId}, ${token.tokenHash(tok)})`;
  const [m] = await admin`insert into messages (store_id, conversation_id, role, content) values (${storeId}, ${conversationId}, 'assistant', 'hi') returning id`;
  return { token: tok, id: m.id as string };
}
const row = async (id: string) => (await admin`select rating, feedback_reason as reason from messages where id = ${id}`)[0];

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  route = await import("@/app/api/chat/feedback/route");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  events = await import("@/lib/chat/events");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  const [s] = await admin`update stores set domains = ${["shop-a.example.com"]} where id = ${storeId} returning shop_domain`;
  shop = s.shop_domain;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const M = "11111111-1111-4111-8111-111111111111";

test("parseFeedback accepts each reason with -1 and defaults the reason to null", () => {
  for (const reason of ["wrong_products", "wrong_price_stock", "misunderstood", "unclear", "other"]) {
    expect(events.parseFeedback({ messageId: M, rating: -1, reason })).toEqual({ messageId: M, rating: -1, reason });
  }
  expect(events.parseFeedback({ messageId: M, rating: -1 })?.reason).toBeNull();
  expect(events.parseFeedback({ messageId: M, rating: -1, reason: null })?.reason).toBeNull();
  expect(events.parseFeedback({ messageId: M, rating: 1 })?.reason).toBeNull();
  expect(events.parseFeedback({ messageId: M, rating: null, reason: null })?.reason).toBeNull();
});

test("parseFeedback rejects a reason with rating 1 or null, an unknown value, or a non-string", () => {
  for (const body of [
    { messageId: M, rating: 1, reason: "other" },
    { messageId: M, rating: null, reason: "other" },
    { messageId: M, rating: -1, reason: "rude" },
    { messageId: M, rating: -1, reason: "" },
    { messageId: M, rating: -1, reason: 3 },
    { messageId: M, rating: -1, reason: ["other"] },
    { messageId: M, rating: -1, reason: "OTHER" },
  ]) {
    expect(events.parseFeedback(body), JSON.stringify(body)).toBeNull();
  }
});

test("a reason is stored with -1, and thumbs-up, clearing or a plain -1 removes it", async () => {
  const c = await setup();
  expect((await post(c.token, { messageId: c.id, rating: -1 })).status).toBe(204);
  expect(await row(c.id)).toMatchObject({ rating: -1, reason: null });
  expect((await post(c.token, { messageId: c.id, rating: -1, reason: "wrong_products" })).status).toBe(204);
  expect(await row(c.id)).toMatchObject({ rating: -1, reason: "wrong_products" });
  expect((await post(c.token, { messageId: c.id, rating: -1, reason: "unclear" })).status).toBe(204);
  expect((await row(c.id)).reason).toBe("unclear");
  expect((await post(c.token, { messageId: c.id, rating: 1 })).status).toBe(204);
  expect(await row(c.id)).toMatchObject({ rating: 1, reason: null });
  await post(c.token, { messageId: c.id, rating: -1, reason: "other" });
  expect((await post(c.token, { messageId: c.id, rating: null })).status).toBe(204);
  expect(await row(c.id)).toMatchObject({ rating: null, reason: null });
  await post(c.token, { messageId: c.id, rating: -1, reason: "other" });
  await post(c.token, { messageId: c.id, rating: -1 });
  expect((await row(c.id)).reason).toBeNull();
});

test("a reason with rating 1, null or an unknown value is a 400 and changes nothing", async () => {
  const c = await setup();
  await post(c.token, { messageId: c.id, rating: -1, reason: "other" });
  for (const body of [
    { messageId: c.id, rating: 1, reason: "other" },
    { messageId: c.id, rating: null, reason: "other" },
    { messageId: c.id, rating: -1, reason: "rude" },
  ]) {
    expect((await post(c.token, body)).status).toBe(400);
  }
  expect(await row(c.id)).toMatchObject({ rating: -1, reason: "other" });
});

test("the database refuses a reason on a row that isn't thumbs-down", async () => {
  const c = await setup();
  await expect(admin`update messages set rating = 1, feedback_reason = 'other' where id = ${c.id}`).rejects.toThrow();
  await expect(admin`update messages set rating = -1, feedback_reason = 'rude' where id = ${c.id}`).rejects.toThrow();
});

test("the 2 kB body limit still applies", async () => {
  const c = await setup();
  expect((await post(c.token, { messageId: c.id, rating: -1, reason: "other", pad: "x".repeat(3000) })).status).toBe(413);
});

test("another conversation's message is still a 404 with a reason", async () => {
  const a = await setup();
  const b = await setup();
  expect((await post(a.token, { messageId: b.id, rating: -1, reason: "other" })).status).toBe(404);
  expect((await row(b.id)).reason).toBeNull();
});
