import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// docs/mobile-api.md: the store's mobile app key. The admin route creates, shows and revokes it; storeFor (every
// storefront chat route) accepts it on requests without an Origin. Exercised through GET /api/faq, which needs no OpenAI.

let embeddedStore: string;
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: embeddedStore, shop: "x.myshopify.com" };
  }),
}));

let admin: ReturnType<typeof postgres>;
let keyRoute: typeof import("@/app/api/app/mobile-key/route");
let faqRoute: typeof import("@/app/api/faq/route");
let cors: typeof import("@/lib/chat/cors");
let rl: typeof import("@/lib/rate-limit");
let client: typeof import("@/db/client");
let storeA: string;
let storeB: string;
let shopA: string;
const ORIGIN = "https://shop-a.example.com";

const adminReq = (method: string, auth = true) =>
  new Request("http://x/api/app/mobile-key", { method, headers: auth ? { authorization: "Bearer t" } : {} });

function faq(shop: string, h: { key?: string; origin?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (h.key) headers["x-askcart-app-key"] = h.key;
  if (h.origin) headers.origin = h.origin;
  if (h.ip) headers["x-forwarded-for"] = `${h.ip}, 10.0.0.1`;
  return faqRoute.GET(new Request(`http://localhost/api/faq?shop=${encodeURIComponent(shop)}&product=42`, { headers }));
}

/** Creates a key for `storeId` through the admin route and returns it. */
async function createKey(storeId: string): Promise<string> {
  embeddedStore = storeId;
  const res = await keyRoute.POST(adminReq("POST"));
  expect(res.status).toBe(201);
  return (await res.json()).key;
}

beforeAll(async () => {
  keyRoute = await import("@/app/api/app/mobile-key/route");
  faqRoute = await import("@/app/api/faq/route");
  cors = await import("@/lib/chat/cors");
  rl = await import("@/lib/rate-limit");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const [s] = await admin`update stores set domains = ${["shop-a.example.com"]} where id = ${storeA} returning shop_domain`;
  shopA = s.shop_domain;
});
beforeEach(() => rl.resetRateLimit());
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("the admin route needs the embedded session", async () => {
  for (const m of ["GET", "POST", "DELETE"] as const) expect((await keyRoute[m](adminReq(m, false))).status).toBe(401);
});

test("create shows the key once and stores only its hash; GET shows the prefix; DELETE clears it", async () => {
  embeddedStore = storeA;
  expect(await (await keyRoute.GET(adminReq("GET"))).json()).toEqual({ prefix: null, createdAt: null });

  const created = await keyRoute.POST(adminReq("POST"));
  expect(created.headers.get("cache-control")).toBe("no-store");
  const { key, prefix } = await created.json();
  expect(key).toMatch(/^ackm_[A-Za-z0-9_-]{43}$/);
  expect(prefix).toBe(key.slice(0, 12));
  const [row] = await admin`select mobile_key_hash from stores where id = ${storeA}`;
  expect(row.mobile_key_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.mobile_key_hash).not.toContain(key);

  const shown = await (await keyRoute.GET(adminReq("GET"))).json();
  expect(shown.prefix).toBe(prefix);
  expect(JSON.stringify(shown)).not.toContain(key);

  expect((await keyRoute.DELETE(adminReq("DELETE"))).status).toBe(204);
  expect(await (await keyRoute.GET(adminReq("GET"))).json()).toEqual({ prefix: null, createdAt: null });
});

test("the right key with no Origin is let in, without CORS headers", async () => {
  const key = await createKey(storeA);
  const res = await faq(shopA, { key });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("a wrong, missing, other store's, replaced or revoked key is refused", async () => {
  const otherKey = await createKey(storeB);
  const old = await createKey(storeA);
  const current = await createKey(storeA); // replaces `old`
  expect((await faq(shopA, { key: "ackm_" + "x".repeat(43) })).status).toBe(403);
  expect((await faq(shopA)).status).toBe(403);
  expect((await faq(shopA, { key: otherKey })).status).toBe(403);
  expect((await faq(shopA, { key: old })).status).toBe(403);
  expect((await faq(shopA, { key: current })).status).toBe(200);
  embeddedStore = storeA;
  await keyRoute.DELETE(adminReq("DELETE"));
  expect((await faq(shopA, { key: current })).status).toBe(403);
});

test("with an Origin the key is ignored: the website check decides", async () => {
  const key = await createKey(storeA);
  expect((await faq(shopA, { key, origin: "https://evil.example.com" })).status).toBe(403);
  const site = await faq(shopA, { key, origin: ORIGIN });
  expect(site.status).toBe(200);
  expect(site.headers.get("access-control-allow-origin")).toBe(ORIGIN);
});

test("per-IP limit: 429 with Retry-After past the limit, other IPs unaffected", async () => {
  const key = await createKey(storeA);
  for (let i = 0; i < cors.MOBILE_IP_LIMIT; i++) expect((await faq(shopA, { key, ip: "1.1.1.1" })).status).toBe(200);
  const over = await faq(shopA, { key, ip: "1.1.1.1" });
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: "rate_limited" });
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await faq(shopA, { key, ip: "2.2.2.2" })).status).toBe(200);
});

test("per-store limit holds across IPs", async () => {
  const key = await createKey(storeA);
  for (let i = 0; i < cors.MOBILE_STORE_LIMIT; i++) {
    expect((await faq(shopA, { key, ip: `10.${Math.floor(i / 250)}.${i % 250}.1` })).status).toBe(200);
  }
  expect((await faq(shopA, { key, ip: "9.9.9.9" })).status).toBe(429);
});

test("a website Origin is limited too: per IP with a 429 and Retry-After, and per store across IPs", async () => {
  for (let i = 0; i < cors.WEB_IP_LIMIT; i++) expect((await faq(shopA, { origin: ORIGIN, ip: "1.1.1.1" })).status).toBe(200);
  const over = await faq(shopA, { origin: ORIGIN, ip: "1.1.1.1" });
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: "rate_limited" });
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await faq(shopA, { origin: ORIGIN, ip: "2.2.2.2" })).status).toBe(200);

  rl.resetRateLimit();
  for (let i = 0; i < cors.WEB_STORE_LIMIT; i++) {
    expect((await faq(shopA, { origin: ORIGIN, ip: `10.${Math.floor(i / 250)}.${i % 250}.1` })).status).toBe(200);
  }
  expect((await faq(shopA, { origin: ORIGIN, ip: "9.9.9.9" })).status).toBe(429);
});

test("a refused Origin costs nothing against the limits", async () => {
  for (let i = 0; i < cors.WEB_IP_LIMIT + 5; i++) expect((await faq(shopA, { origin: "https://evil.example.com", ip: "1.1.1.1" })).status).toBe(403);
  expect((await faq(shopA, { origin: ORIGIN, ip: "1.1.1.1" })).status).toBe(200);
});
