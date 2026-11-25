import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// DELETE /api/chat/conversation (D84, "Clear chat"). Nothing here calls OpenAI or Shopify: POST /api/chat is only used
// with a deleted conversation's token, which openTurn refuses before the turn starts. OpenAI is mocked to be sure.
const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/conversation/route");
let history: typeof import("@/app/api/chat/history/route");
let chat: typeof import("@/app/api/chat/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
const ORIGIN = "https://shop-a.example.com";

function headersFor(tok: string | null, origin: string | null) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (tok) headers["x-conversation-token"] = tok;
  return headers;
}

function del(shop: string, tok: string | null, origin: string | null = ORIGIN) {
  const url = `http://localhost/api/chat/conversation?shop=${encodeURIComponent(shop)}`;
  return route.DELETE(new Request(url, { method: "DELETE", headers: headersFor(tok, origin) }));
}

/** A conversation for `storeId` with its token and two messages; rows are inserted through the admin connection. */
async function conversation(storeId: string, busy = false) {
  const { conversationId, token: tok } = token.mintToken(storeId);
  await admin`
    insert into conversations (id, store_id, token_hash, busy_until)
    values (${conversationId}, ${storeId}, ${token.tokenHash(tok)}, ${busy ? admin`now() + interval '90 seconds'` : null})`;
  await admin`
    insert into messages (store_id, conversation_id, role, content)
    values (${storeId}, ${conversationId}, 'user', 'hi'), (${storeId}, ${conversationId}, 'assistant', 'hello')`;
  return { id: conversationId, token: tok };
}

async function counts(id: string) {
  const [c] = await admin`select count(*)::int as n from conversations where id = ${id}`;
  const [m] = await admin`select count(*)::int as n from messages where conversation_id = ${id}`;
  return { conversations: c.n as number, messages: m.n as number };
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  process.env.OPENAI_API_KEY = "test";
  route = await import("@/app/api/chat/conversation/route");
  history = await import("@/app/api/chat/history/route");
  chat = await import("@/app/api/chat/route");
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

test("204 deletes the conversation and all its messages, uncached, with CORS headers", async () => {
  const c = await conversation(storeA);
  const other = await conversation(storeA);
  const res = await del(shopA, c.token);
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("vary")).toBe("Origin");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await counts(c.id)).toEqual({ conversations: 0, messages: 0 });
  expect(await counts(other.id)).toEqual({ conversations: 1, messages: 2 }); // only that conversation
});

test("a second DELETE → 204 (idempotent)", async () => {
  const c = await conversation(storeA);
  expect((await del(shopA, c.token)).status).toBe(204);
  const again = await del(shopA, c.token);
  expect(again.status).toBe(204);
  expect(again.headers.get("access-control-allow-origin")).toBe(ORIGIN);
});

test("a missing, invalid or other-store token → 401, and nothing is deleted", async () => {
  const b = await conversation(storeB);
  const a = await conversation(storeA);
  const tampered = a.token.slice(0, -2) + (a.token.endsWith("AA") ? "BB" : "AA");
  for (const tok of [null, "garbage", tampered, b.token]) {
    const res = await del(shopA, tok);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
  expect(await counts(a.id)).toEqual({ conversations: 1, messages: 2 });
  expect(await counts(b.id)).toEqual({ conversations: 1, messages: 2 });
});

test("an unknown shop → 404; a disallowed Origin, or none, → 403; nothing is deleted", async () => {
  const c = await conversation(storeA);
  expect((await del("nope.myshopify.com", c.token)).status).toBe(404);
  for (const origin of ["https://evil.com", "https://shop-b.example.com", null]) {
    const res = await del(shopA, c.token, origin);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(await counts(c.id)).toEqual({ conversations: 1, messages: 2 });
});

test("a conversation whose turn is running → 409 and it is not deleted", async () => {
  const c = await conversation(storeA, true);
  const res = await del(shopA, c.token);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "turn_in_progress" });
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(await counts(c.id)).toEqual({ conversations: 1, messages: 2 });
});

test("an expired turn claim doesn't block the delete", async () => {
  const c = await conversation(storeA);
  await admin`update conversations set busy_until = now() - interval '1 second' where id = ${c.id}`;
  expect((await del(shopA, c.token)).status).toBe(204);
  expect(await counts(c.id)).toEqual({ conversations: 0, messages: 0 });
});

test("a deleted conversation's token then gets 404 from GET history and from POST /api/chat", async () => {
  const c = await conversation(storeA);
  expect((await del(shopA, c.token)).status).toBe(204);

  const h = await history.GET(
    new Request(`http://localhost/api/chat/history?shop=${encodeURIComponent(shopA)}`, { headers: headersFor(c.token, ORIGIN) }),
  );
  expect(h.status).toBe(404);
  expect(await h.json()).toEqual({ error: "conversation_not_found" });

  const p = await chat.POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ shop: shopA, message: "hello again", conversationToken: c.token }),
    }),
  );
  expect(p.status).toBe(404);
  expect(await p.json()).toEqual({ error: "conversation_not_found" });
  expect(create).not.toHaveBeenCalled();
  expect(await counts(c.id)).toEqual({ conversations: 0, messages: 0 });
});

test("OPTIONS allows DELETE and the X-Conversation-Token header", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/chat/conversation", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  expect(res.headers.get("access-control-allow-headers")).toContain("X-Conversation-Token");
  expect(res.headers.get("vary")).toBe("Origin");
  const bad = await route.OPTIONS(new Request("http://localhost/api/chat/conversation", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  expect(bad.status).toBe(403);
});
