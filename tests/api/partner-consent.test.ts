import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { HttpResponseError } from "@shopify/shopify-api";

// Task P5: the consent screen's API (GET/POST /api/app/partner-consent).

const SHOP_A = "consent-a.myshopify.com";
const SHOP_B = "consent-b.myshopify.com";
const CLIENT = `pc_${randomBytes(12).toString("base64url")}`;
const REDIRECT = "https://portal.example/askcart/callback";
const STATE = "st-<&> 42";
const ONLINE_TOKEN = "shpua_online_secret_value_never_logged";
const USER_ID = 4242;

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/partner-consent/route");
let api: typeof import("@/lib/shopify/api");
let client: typeof import("@/db/client");
let jobs: typeof import("@/lib/jobs");
const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(shop: string) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: process.env.SHOPIFY_API_KEY,
    sub: String(USER_ID), exp: now + 60, nbf: now - 5, iat: now, jti: randomUUID(), sid: "s",
  })}`;
  return `${body}.${createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(body).digest("base64url")}`;
}

let userScope = "read_products,read_orders";
let onlineError: unknown = null;
function mockExchange() {
  return vi.spyOn(api.shopify.auth, "tokenExchange").mockImplementation((async ({ requestedTokenType }: { requestedTokenType: string }) => {
    if (!requestedTokenType.includes("online")) throw new Error("offline exchange not expected: the store has tokens");
    if (onlineError) throw onlineError;
    return {
      session: {
        accessToken: ONLINE_TOKEN, isOnline: true,
        onlineAccessInfo: {
          expires_in: 86399, associated_user_scope: userScope,
          associated_user: { id: USER_ID, first_name: "Pat", last_name: "Doe", email: "pat@example.com", email_verified: true,
            account_owner: false, locale: "en", collaborator: false },
        },
      },
    };
  }) as never);
}

async function newRequest(shop: string, opts: { status?: string; expired?: boolean } = {}): Promise<string> {
  const [r] = await admin`
    insert into partner_connect_requests (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at)
    values (${CLIENT}, ${shop}, ${REDIRECT}, ${STATE}, ${"c".repeat(43)}, ${["read:orders", "read:products", "read:shop"]},
      ${opts.status ?? "pending"}, now() + ${opts.expired ? "-1 minute" : "10 minutes"}::interval)
    returning id`;
  return r.id;
}
const row = async (id: string) => (await admin`select * from partner_connect_requests where id = ${id}`)[0];

const getReq = (id: string, shop = SHOP_A) =>
  new Request(`http://localhost/api/app/partner-consent?request=${id}`, { headers: { authorization: `Bearer ${idToken(shop)}` } });
const postReq = (body: unknown, shop = SHOP_A) =>
  new Request("http://localhost/api/app/partner-consent", {
    method: "POST",
    headers: { authorization: `Bearer ${idToken(shop)}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  route = await import("@/app/api/app/partner-consent/route");
  api = await import("@/lib/shopify/api");
  client = await import("@/db/client");
  jobs = await import("@/lib/jobs");
  const { saveTokens } = await import("@/lib/shopify/tokens");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  for (const [shop, name] of [[SHOP_A, "Shop A"], [SHOP_B, "Shop B"]]) {
    const [acc] = await admin`insert into accounts default values returning id`;
    const [s] = await admin`insert into stores (account_id, shop_domain, name) values (${acc.id}, ${shop}, ${name}) returning id`;
    // A non-expiring offline token, so authenticateEmbedded never exchanges.
    await saveTokens(s.id, { accessToken: "offline", accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
  }
  await admin`
    insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
    values (${CLIENT}, 'Social Media Agent', ${"0".repeat(64)}, ${[REDIRECT]}, ${["read:orders", "read:products", "read:shop"]})`;
});

afterAll(async () => {
  for (const s of spies) {
    for (const call of s.mock.calls) {
      const text = call.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a) ?? String(a))).join(" ");
      expect(text).not.toContain(ONLINE_TOKEN);
      expect(text).not.toMatch(/code=/);
    }
  }
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
  userScope = "read_products,read_orders";
  onlineError = null;
  mockExchange();
});

test("GET returns the portal name, shop, scopes and expiry, with no-store", async () => {
  const id = await newRequest(SHOP_A);
  const res = await route.GET(getReq(id));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body).toEqual({
    clientName: "Social Media Agent",
    shop: { domain: SHOP_A, name: "Shop A" },
    scopes: ["read:orders", "read:products", "read:shop"],
    expiresAt: expect.any(String),
  });
  expect(JSON.stringify(body)).not.toContain(STATE);
});

test("GET without a session token is 401", async () => {
  const id = await newRequest(SHOP_A);
  const res = await route.GET(new Request(`http://localhost/api/app/partner-consent?request=${id}`));
  expect(res.status).toBe(401);
});

test("Review Focus 1: shop B's session can't read or decide shop A's request (404), and the row stays pending", async () => {
  const id = await newRequest(SHOP_A);
  expect((await route.GET(getReq(id, SHOP_B))).status).toBe(404);
  expect((await route.POST(postReq({ requestId: id, decision: "allow" }, SHOP_B))).status).toBe(404);
  expect((await route.POST(postReq({ requestId: id, decision: "deny" }, SHOP_B))).status).toBe(404);
  const r = await row(id);
  expect(r.status).toBe("pending");
  expect(r.code_hash).toBeNull();
});

test("unknown, malformed or non-pending requests are 404 on GET", async () => {
  expect((await route.GET(getReq(randomUUID()))).status).toBe(404);
  expect((await route.GET(getReq("not-a-uuid"))).status).toBe(404);
  expect((await route.GET(getReq(await newRequest(SHOP_A, { status: "denied" })))).status).toBe(404);
});

test("an expired request is 410 on GET and POST, and no code is minted", async () => {
  const id = await newRequest(SHOP_A, { expired: true });
  const get = await route.GET(getReq(id));
  expect(get.status).toBe(410);
  expect(await get.json()).toEqual({ error: "expired" });
  const post = await route.POST(postReq({ requestId: id, decision: "allow" }));
  expect(post.status).toBe(410);
  expect((await row(id)).code_hash).toBeNull();
});

test("allow approves, stores only the code's hash, and returns the redirect URL", async () => {
  const id = await newRequest(SHOP_A);
  const res = await route.POST(postReq({ requestId: id, decision: "allow" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { redirectUrl } = await res.json();
  const url = new URL(redirectUrl);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get("state")).toBe(STATE);
  expect(url.searchParams.get("shop")).toBe(SHOP_A);
  const code = url.searchParams.get("code")!;
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const r = await row(id);
  expect(r.status).toBe("approved");
  expect(r.code_hash).toBe(createHash("sha256").update(code).digest("hex"));
  expect(r.approved_by_user_id).toBe(String(USER_ID));
  expect(r.decided_at).not.toBeNull();
  const ttl = r.code_expires_at.getTime() - r.decided_at.getTime();
  expect(ttl).toBe(300_000);
  // The grant is created at the token exchange (P6), not here.
  expect((await admin`select count(*)::int as n from partner_grants where connect_request_id = ${id}`)[0].n).toBe(0);
});

test("the online exchange asks for an online token for this shop with this session token", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange");
  const id = await newRequest(SHOP_A);
  const req = postReq({ requestId: id, decision: "allow" });
  const token = req.headers.get("authorization")!.slice(7);
  await route.POST(req);
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({
    shop: SHOP_A, sessionToken: token, requestedTokenType: expect.stringContaining("online-access-token"),
  }));
});

test("a second allow (double click) is 409 and keeps the first code", async () => {
  const id = await newRequest(SHOP_A);
  await route.POST(postReq({ requestId: id, decision: "allow" }));
  const hash = (await row(id)).code_hash;
  const again = await route.POST(postReq({ requestId: id, decision: "allow" }));
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "already_decided" });
  expect((await row(id)).code_hash).toBe(hash);
});

test("two parallel allows: exactly one 200", async () => {
  const id = await newRequest(SHOP_A);
  const results = await Promise.all([1, 2].map(() => route.POST(postReq({ requestId: id, decision: "allow" }))));
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
});

test("deny sets denied and returns access_denied with the state", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange");
  const id = await newRequest(SHOP_A);
  const res = await route.POST(postReq({ requestId: id, decision: "deny" }));
  expect(res.status).toBe(200);
  const url = new URL((await res.json()).redirectUrl);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get("error")).toBe("access_denied");
  expect(url.searchParams.get("state")).toBe(STATE);
  expect(url.searchParams.get("shop")).toBe(SHOP_A);
  expect(url.searchParams.has("code")).toBe(false);
  const r = await row(id);
  expect(r.status).toBe("denied");
  expect(r.code_hash).toBeNull();
  expect(exchange).not.toHaveBeenCalled();
  expect((await route.POST(postReq({ requestId: id, decision: "allow" }))).status).toBe(409);
});

test("Review Focus 8: staff without read_orders get 403 staff_permission_missing, and no code is minted", async () => {
  userScope = "read_products";
  const id = await newRequest(SHOP_A);
  const res = await route.POST(postReq({ requestId: id, decision: "allow" }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "staff_permission_missing", missing: ["read_orders"] });
  const r = await row(id);
  expect(r.status).toBe("pending");
  expect(r.code_hash).toBeNull();
});

test("a write scope implies the read one (write_orders covers read_orders)", async () => {
  userScope = "write_products,write_orders";
  const id = await newRequest(SHOP_A);
  expect((await route.POST(postReq({ requestId: id, decision: "allow" }))).status).toBe(200);
});

test("an online exchange refused by Shopify is 403 approver_not_allowed, and nothing changes", async () => {
  onlineError = new HttpResponseError({ message: "ACCESS_DENIED", code: 403, statusText: "Forbidden", body: { error: "access_denied" } });
  const id = await newRequest(SHOP_A);
  const res = await route.POST(postReq({ requestId: id, decision: "allow" }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "approver_not_allowed" });
  expect((await row(id)).status).toBe("pending");
});

test("Shopify down during the online exchange is 502, and nothing changes", async () => {
  onlineError = new HttpResponseError({ message: "boom", code: 503, statusText: "Unavailable", body: {} });
  const id = await newRequest(SHOP_A);
  expect((await route.POST(postReq({ requestId: id, decision: "allow" }))).status).toBe(502);
  onlineError = new TypeError("fetch failed");
  expect((await route.POST(postReq({ requestId: id, decision: "allow" }))).status).toBe(502);
  expect((await row(id)).status).toBe("pending");
});

test("a bad body is 400", async () => {
  const id = await newRequest(SHOP_A);
  expect((await route.POST(postReq("not json"))).status).toBe(400);
  expect((await route.POST(postReq({ requestId: id, decision: "maybe" }))).status).toBe(400);
  expect((await route.POST(postReq({ decision: "allow" }))).status).toBe(400);
});
