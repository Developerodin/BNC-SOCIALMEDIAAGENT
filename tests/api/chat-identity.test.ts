import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";
import { proxySignature } from "@/lib/shopify/app-proxy";
import { encrypt } from "@/lib/crypto";
import { sha256Hex } from "@/lib/partner/secrets";

// Customer identity: session issue (mobile + website proxy), ownership isolation, the customer's conversation list.
// Shopify is mocked (fetch for the Storefront API, adminGraphql for storefrontAccessTokenCreate); nothing calls OpenAI.

const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));

let admin: ReturnType<typeof postgres>;
let client: typeof import("@/db/client");
let turn: typeof import("@/lib/chat/turn");
let tokens: typeof import("@/lib/chat/token");
let cust: typeof import("@/lib/chat/customer");
let sessionRoute: typeof import("@/app/api/chat/session/route");
let listRoute: typeof import("@/app/api/chat/conversations/route");
let historyRoute: typeof import("@/app/api/chat/history/route");
let deleteRoute: typeof import("@/app/api/chat/conversation/route");
let proxyRoute: typeof import("@/app/api/proxy/session/route");
let rl: typeof import("@/lib/partner/rate-limit");
let storeId: string;
let shop: string;
let store: Parameters<typeof import("@/lib/chat/turn").openTurn>[0];
const APP_KEY = "ackm_test-key-for-identity";
const ALICE = "gid://shopify/Customer/1001";
const BOB = "gid://shopify/Customer/1002";

const sessionOf = (gid: string) => cust.mintSession(storeId, gid).token;
const post = (body: unknown, h: Record<string, string> = { "x-askcart-app-key": APP_KEY }) =>
  sessionRoute.POST(new Request("http://x/api/chat/session", { method: "POST", headers: h, body: JSON.stringify(body) }));
const appGet = (route: { GET: (r: Request) => Promise<Response> }, path: string, h: Record<string, string>) =>
  route.GET(new Request(`http://x${path}${path.includes("?") ? "&" : "?"}shop=${shop}`, { headers: { "x-askcart-app-key": APP_KEY, ...h } }));

function storefront(customer: { id: string } | null, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ data: { customer } }), { status }));
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE=";
  client = await import("@/db/client");
  turn = await import("@/lib/chat/turn");
  tokens = await import("@/lib/chat/token");
  cust = await import("@/lib/chat/customer");
  sessionRoute = await import("@/app/api/chat/session/route");
  listRoute = await import("@/app/api/chat/conversations/route");
  historyRoute = await import("@/app/api/chat/history/route");
  deleteRoute = await import("@/app/api/chat/conversation/route");
  proxyRoute = await import("@/app/api/proxy/session/route");
  rl = await import("@/lib/partner/rate-limit");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  const [s] = await admin`update stores set mobile_key_hash = ${sha256Hex(APP_KEY)} where id = ${storeId} returning shop_domain`;
  shop = s.shop_domain;
  store = { id: storeId, shopDomain: shop, name: null, primaryLocale: null, currencyCode: null, settings: {} };
});
beforeEach(() => {
  rl.resetRateLimit();
  adminGraphql.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

/** A stored offline-token row, so the storefront token has somewhere to be cached. */
async function tokenRow() {
  await admin`delete from store_tokens where store_id = ${storeId}`;
  await admin`insert into store_tokens (store_id, access_token_enc, key_id) values (${storeId}, ${encrypt("offline", storeId)}, 'k1')`;
}

// --- POST /api/chat/session ---

test("session: a valid customer token gets a session for that customer; the storefront token is created once and cached encrypted", async () => {
  await tokenRow();
  adminGraphql.mockResolvedValue({ storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: "sf-secret" }, userErrors: [] } });
  const f = vi.fn(async (...[,]: [string, RequestInit?]) => new Response(JSON.stringify({ data: { customer: { id: ALICE } } })));
  vi.stubGlobal("fetch", f);

  const res = await post({ shop, customerAccessToken: "cat-1" });
  expect(res.status).toBe(200);
  const { sessionToken, expiresAt } = await res.json();
  expect(cust.verifySession(storeId, sessionToken)).toBe(ALICE);
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(adminGraphql).toHaveBeenCalledTimes(1);
  const [row] = await admin`select storefront_token_enc from store_tokens where store_id = ${storeId}`;
  expect(row.storefront_token_enc).toBeTruthy();
  expect(row.storefront_token_enc).not.toContain("sf-secret");

  // Second sign-in reuses the cached token: no new Admin call, and the Storefront call carries it.
  expect((await post({ shop, customerAccessToken: "cat-2" })).status).toBe(200);
  expect(adminGraphql).toHaveBeenCalledTimes(1);
  const init = f.mock.calls.at(-1)![1]!;
  expect((init.headers as Record<string, string>)["X-Shopify-Storefront-Access-Token"]).toBe("sf-secret");
});

test("session: a null customer, a blank or non-string token is 401 and never reaches a session", async () => {
  await tokenRow();
  await admin`update store_tokens set storefront_token_enc = ${encrypt("sf", storeId)} where store_id = ${storeId}`;
  vi.stubGlobal("fetch", storefront(null));
  const res = await post({ shop, customerAccessToken: "expired" });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid_customer" });
  expect((await post({ shop, customerAccessToken: "" })).status).toBe(401);
  expect((await post({ shop, customerAccessToken: 5 })).status).toBe(401);
});

test("session: a revoked storefront token is recreated once; a store still refusing it (scope not approved) is 503", async () => {
  await tokenRow();
  await admin`update store_tokens set storefront_token_enc = ${encrypt("old", storeId)} where store_id = ${storeId}`;
  adminGraphql.mockResolvedValue({ storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: "new" }, userErrors: [] } });
  const f = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}", { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { customer: { id: ALICE } } })));
  vi.stubGlobal("fetch", f);
  expect((await post({ shop, customerAccessToken: "c" })).status).toBe(200);
  expect(adminGraphql).toHaveBeenCalledTimes(1);

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "ACCESS_DENIED" }] }))));
  const res = await post({ shop, customerAccessToken: "c" });
  expect(res.status).toBe(503);
});

test("session: the customer token is never logged", async () => {
  await tokenRow();
  adminGraphql.mockRejectedValue(new Error("boom"));
  await admin`update store_tokens set storefront_token_enc = null where store_id = ${storeId}`;
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", storefront(null));
  expect((await post({ shop, customerAccessToken: "SUPER-SECRET-CAT" })).status).toBe(503);
  expect(JSON.stringify(spy.mock.calls)).not.toContain("SUPER-SECRET-CAT");
  spy.mockRestore();
});

test("session: no app key or a website Origin is refused", async () => {
  vi.stubGlobal("fetch", storefront({ id: ALICE }));
  expect((await post({ shop, customerAccessToken: "c" }, {})).status).toBe(403);
  const withOrigin = await post({ shop, customerAccessToken: "c" }, { "x-askcart-app-key": APP_KEY, origin: "https://evil.example.com" });
  expect(withOrigin.status).toBe(403);
});

// --- website App Proxy ---

function proxyReq(extra: Record<string, string>, opts: { secret?: string; ts?: number } = {}) {
  const p = new URLSearchParams({ shop, path_prefix: "/apps/askcart", timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)), ...extra });
  p.set("signature", proxySignature(p, opts.secret ?? process.env.SHOPIFY_API_SECRET!));
  return proxyRoute.GET(new Request(`http://x/api/proxy/session?${p}`));
}

test("proxy: a signed request with a logged-in customer gets that customer's session", async () => {
  const res = await proxyReq({ logged_in_customer_id: "1001" });
  expect(res.status).toBe(200);
  expect(cust.verifySession(storeId, (await res.json()).sessionToken)).toBe(ALICE);
});

test("proxy: no customer is 401; a bad signature or stale timestamp is 403", async () => {
  expect((await proxyReq({ logged_in_customer_id: "" })).status).toBe(401);
  expect((await proxyReq({ logged_in_customer_id: "1001" }, { secret: "wrong" })).status).toBe(403);
  expect((await proxyReq({ logged_in_customer_id: "1001" }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(403);
  const forged = new URLSearchParams({ shop, timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: "1001", signature: "00" });
  expect((await proxyRoute.GET(new Request(`http://x/api/proxy/session?${forged}`))).status).toBe(403);
});

// --- ownership ---

test("a turn with a session creates an owned conversation; a guest turn creates an unowned one", async () => {
  const owned = await turn.openTurn(store, { message: "hi", pageUrl: null, customer: ALICE });
  const guest = await turn.openTurn(store, { message: "hi", pageUrl: null });
  if (!owned.ok || !guest.ok) throw new Error("open failed");
  const rows = await admin`select id, owner_customer_id from conversations where id in (${owned.conversationId}, ${guest.conversationId})`;
  const owner = (id: string) => rows.find((r) => r.id === id)!.owner_customer_id;
  expect(owner(owned.conversationId)).toBe(ALICE);
  expect(owner(guest.conversationId)).toBeNull();
});

test("customer B can't continue, read or delete A's conversation; A can; no session still works with the token", async () => {
  const first = await turn.openTurn(store, { message: "secret plans", pageUrl: null, customer: ALICE });
  if (!first.ok) throw new Error("open failed");
  await admin`update conversations set busy_until = null where id = ${first.conversationId}`;
  const t = first.token;

  expect(await turn.openTurn(store, { token: t, message: "x", pageUrl: null, customer: BOB })).toEqual({ ok: false, status: 404 });
  expect(await turn.readHistory(storeId, t, BOB)).toEqual({ ok: false, status: 404 });
  expect(await turn.deleteConversation(storeId, t, BOB)).toEqual({ ok: false, status: 404 });
  const [{ n }] = await admin`select count(*)::int as n from messages where conversation_id = ${first.conversationId}`;
  expect(n).toBe(1); // B's attempt saved nothing

  // Over HTTP too: B's header on history and delete.
  const h = { "x-conversation-token": t, "x-askcart-customer": sessionOf(BOB) };
  expect((await appGet(historyRoute, "/api/chat/history", h)).status).toBe(404);
  const del = await deleteRoute.DELETE(new Request(`http://x/api/chat/conversation?shop=${shop}`, { method: "DELETE", headers: { "x-askcart-app-key": APP_KEY, ...h } }));
  expect(del.status).toBe(404);

  expect((await turn.readHistory(storeId, t, ALICE)).ok).toBe(true);
  expect((await turn.readHistory(storeId, t)).ok).toBe(true); // token alone, as today
  const again = await turn.openTurn(store, { token: t, message: "more", pageUrl: null, customer: ALICE });
  expect(again.ok).toBe(true);
});

test("a guest conversation stays open to any session holder with its token and stays unowned", async () => {
  const g = await turn.openTurn(store, { message: "hello", pageUrl: null });
  if (!g.ok) throw new Error("open failed");
  await admin`update conversations set busy_until = null where id = ${g.conversationId}`;
  expect((await turn.openTurn(store, { token: g.token, message: "again", pageUrl: null, customer: BOB })).ok).toBe(true);
  const [c] = await admin`select owner_customer_id from conversations where id = ${g.conversationId}`;
  expect(c.owner_customer_id).toBeNull();
});

test("a bad or expired session header is 401 invalid_session on history; no header is unchanged", async () => {
  const { conversationId, token: t } = tokens.mintToken(storeId);
  await admin`insert into conversations (id, store_id, token_hash) values (${conversationId}, ${storeId}, ${tokens.tokenHash(t)})`;
  const bad = await appGet(historyRoute, "/api/chat/history", { "x-conversation-token": t, "x-askcart-customer": "junk" });
  expect(bad.status).toBe(401);
  expect(await bad.json()).toEqual({ error: "invalid_session" });
  const expired = cust.mintSession(storeId, ALICE, Date.now() - 2 * cust.SESSION_TTL_MS).token;
  expect((await appGet(historyRoute, "/api/chat/history", { "x-conversation-token": t, "x-askcart-customer": expired })).status).toBe(401);
  expect((await appGet(historyRoute, "/api/chat/history", { "x-conversation-token": t })).status).toBe(200);
});

// --- GET /api/chat/conversations ---

test("the list returns only the caller's conversations, latest first, with titles and working tokens, paginated", async () => {
  await admin`delete from conversations where store_id = ${storeId}`;
  const mk = async (owner: string | null, title: string, at: number) => {
    const { conversationId, token: t } = tokens.mintToken(storeId);
    await admin`insert into conversations (id, store_id, token_hash, owner_customer_id, created_at) values (${conversationId}, ${storeId}, ${tokens.tokenHash(t)}, ${owner}, ${new Date(at)})`;
    await admin`insert into messages (store_id, conversation_id, role, content) values (${storeId}, ${conversationId}, 'user', ${title})`;
    await admin`insert into messages (store_id, conversation_id, role, content, created_at) values (${storeId}, ${conversationId}, 'user', 'later one', now() + interval '1 minute')`;
    return conversationId;
  };
  const base = Date.parse("2026-11-24T10:00:00Z");
  const a1 = await mk(ALICE, "first", base);
  const a2 = await mk(ALICE, "x".repeat(200), base + 1000);
  const a3 = await mk(ALICE, "third", base + 2000);
  await mk(BOB, "bob's chat", base + 3000);
  await mk(null, "guest chat", base + 4000);

  const get = (customer: string | null, q = "") =>
    appGet(listRoute, `/api/chat/conversations${q}`, customer ? { "x-askcart-customer": sessionOf(customer) } : {});
  expect((await get(null)).status).toBe(401);

  const page1 = await (await get(ALICE, "?limit=2")).json();
  expect(page1.conversations.map((c: { id: string }) => c.id)).toEqual([a3, a2]);
  expect(page1.conversations[0].title).toBe("third");
  expect(page1.conversations[1].title).toBe(`${"x".repeat(80)}…`);
  expect(page1.nextCursor).toBe(a2);
  const page2 = await (await get(ALICE, `?limit=2&cursor=${page1.nextCursor}`)).json();
  expect(page2.conversations.map((c: { id: string }) => c.id)).toEqual([a1]);
  expect(page2.nextCursor).toBeNull();

  // The returned token opens the conversation through the history endpoint, with the same session.
  const opened = await appGet(historyRoute, "/api/chat/history", { "x-conversation-token": page2.conversations[0].conversationToken, "x-askcart-customer": sessionOf(ALICE) });
  expect(opened.status).toBe(200);

  // Bob sees only his own; Alice's id as his cursor yields nothing rather than her ordering.
  const bob = await (await get(BOB)).json();
  expect(bob.conversations).toHaveLength(1);
  expect(bob.conversations[0].title).toBe("bob's chat");
  expect((await (await get(BOB, `?cursor=${a2}`)).json()).conversations).toEqual([]);
  expect((await get(ALICE, "?cursor=not-a-uuid")).status).toBe(400);
});
