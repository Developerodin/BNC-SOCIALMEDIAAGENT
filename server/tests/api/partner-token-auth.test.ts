import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newToken, type TokenKind } from "@/lib/partner/secrets";

// Plan Task P7: per-store `ack_` tokens on the read endpoints. The store comes only from the token; expiry, the
// grant's revocation, the store's install state, the endpoint's scope and a per-token rate limit are all checked.
const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));

const SHOP_A = "token-a.myshopify.com";
const SHOP_B = "token-b.myshopify.com";
const CLIENT = "pc_p7testclient0000";
const LEGACY_SECRET = "s3cret-partner-value-long-enough";
const ALL = ["read:orders", "read:products", "read:shop"];

let admin: ReturnType<typeof postgres>;
let shopRoute: typeof import("@/app/api/partner/shop/route");
let ordersRoute: typeof import("@/app/api/partner/orders/route");
let productsRoute: typeof import("@/app/api/partner/products/route");
let rl: typeof import("@/lib/rate-limit");
let client: typeof import("@/db/client");
let storeA: string;
let storeB: string;
const issued: string[] = []; // every token minted here, to prove none leaks into logs or responses
const logSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeAll(async () => {
  shopRoute = await import("@/app/api/partner/shop/route");
  ordersRoute = await import("@/app/api/partner/orders/route");
  productsRoute = await import("@/app/api/partner/products/route");
  rl = await import("@/lib/rate-limit");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  await admin`insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
    values (${CLIENT}, 'P7 test portal', ${"0".repeat(64)}, ${["https://portal.example/cb"]}, ${ALL})
    on conflict (client_id) do nothing`;
  const [a] = await admin`insert into accounts default values returning id`;
  [{ id: storeA }] = await admin`insert into stores (account_id, shop_domain) values (${a.id}, ${SHOP_A}) returning id`;
  const [b] = await admin`insert into accounts default values returning id`;
  [{ id: storeB }] = await admin`insert into stores (account_id, shop_domain) values (${b.id}, ${SHOP_B}) returning id`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  vi.stubEnv("PARTNER_STORE_DOMAIN", "");
  vi.stubEnv("PARTNER_API_SECRET", "");
  rl.resetRateLimit();
  adminGraphql.mockReset();
  adminGraphql.mockResolvedValue({ shop: { name: "Shop", currencyCode: "INR" } });
  for (const m of ["log", "info", "warn", "error", "debug"] as const) logSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  const logged = JSON.stringify(logSpies.map((s) => s.mock.calls));
  for (const t of issued) expect(logged).not.toContain(t);
  for (const s of logSpies.splice(0)) s.mockRestore();
});

/** A grant on `storeId` with one token under it; returns the plain token and the row ids. */
async function mint(
  storeId: string,
  shop: string,
  opts: { scopes?: string[]; kind?: TokenKind; expiresAt?: Date | null } = {},
): Promise<{ token: string; tokenId: string; grantId: string }> {
  // One active grant per store and client (C33): revoke any earlier one, as a reconnect would.
  await admin`update partner_grants set revoked_at = now(), revoked_reason = 'reconnect'
    where store_id = ${storeId} and client_id = ${CLIENT} and revoked_at is null`;
  const [g] = await admin`insert into partner_grants (store_id, shop_domain, client_id, scopes)
    values (${storeId}, ${shop}, ${CLIENT}, ${opts.scopes ?? ALL}) returning id`;
  const t = newToken(opts.kind ?? "access");
  issued.push(t.token);
  const [row] = await admin`insert into partner_tokens (grant_id, store_id, kind, token_hash, token_prefix, expires_at)
    values (${g.id}, ${storeId}, ${opts.kind ?? "access"}, ${t.hash}, ${t.prefix}, ${opts.expiresAt ?? null}) returning id`;
  return { token: t.token, tokenId: row.id, grantId: g.id };
}

const get = (path: string, token: string, extra: Record<string, string> = {}) =>
  new Request(`http://x/api/partner/${path}`, { headers: { authorization: `Bearer ${token}`, ...extra } });

async function expectInvalidToken(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "invalid_token" });
  expect(adminGraphql).not.toHaveBeenCalled();
}

test("Review Focus 5: an A token reads A even when ?shop=, a shop header and the host all say B", async () => {
  const { token } = await mint(storeA, SHOP_A);
  const req = new Request(`http://${SHOP_B}/api/partner/shop?shop=${SHOP_B}`, {
    headers: { authorization: `Bearer ${token}`, "x-shopify-shop-domain": SHOP_B },
  });
  const res = await shopRoute.GET(req);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "Shop", currencyCode: "INR" });
  expect(adminGraphql).toHaveBeenCalledTimes(1);
  expect(adminGraphql.mock.calls[0].slice(0, 2)).toEqual([storeA, SHOP_A]);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("each store's token reads its own store", async () => {
  const b = await mint(storeB, SHOP_B);
  expect((await shopRoute.GET(get("shop", b.token))).status).toBe(200);
  expect(adminGraphql.mock.calls[0].slice(0, 2)).toEqual([storeB, SHOP_B]);
});

test("a revoked grant is 401 invalid_token with WWW-Authenticate", async () => {
  const { token, grantId } = await mint(storeA, SHOP_A);
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  adminGraphql.mockClear();
  await admin`update partner_grants set revoked_at = now(), revoked_reason = 'portal' where id = ${grantId}`;
  await expectInvalidToken(await shopRoute.GET(get("shop", token)));
});

test("an expired access token is 401; one expiring in the future still works", async () => {
  const expired = await mint(storeA, SHOP_A, { expiresAt: new Date(Date.now() - 1000) });
  await expectInvalidToken(await shopRoute.GET(get("shop", expired.token)));
  const fresh = await mint(storeA, SHOP_A, { expiresAt: new Date(Date.now() + 3_600_000) });
  expect((await shopRoute.GET(get("shop", fresh.token))).status).toBe(200);
});

test("an ackr_ refresh token used as Bearer is 401, even with a live grant", async () => {
  const { token } = await mint(storeA, SHOP_A, { kind: "refresh" });
  expect(token.startsWith("ackr_")).toBe(true);
  await expectInvalidToken(await shopRoute.GET(get("shop", token)));
});

test("an unknown or malformed ack_ token is 401 invalid_token", async () => {
  await expectInvalidToken(await shopRoute.GET(get("shop", newToken("access").token)));
  await expectInvalidToken(await shopRoute.GET(get("shop", "ack_short")));
  await expectInvalidToken(await shopRoute.GET(get("shop", "ackr_short")));
});

test("a token whose store is inactive (uninstalled) is 401", async () => {
  const { token } = await mint(storeB, SHOP_B);
  await admin`update stores set active = false where id = ${storeB}`;
  try {
    await expectInvalidToken(await shopRoute.GET(get("shop", token)));
  } finally {
    await admin`update stores set active = true where id = ${storeB}`;
  }
});

test("a read:shop-only token on /orders or /products is 403 insufficient_scope; /shop works", async () => {
  const { token } = await mint(storeA, SHOP_A, { scopes: ["read:shop"] });
  const o = await ordersRoute.GET(get("orders?updatedSince=2026-11-01T00:00:00Z", token));
  expect(o.status).toBe(403);
  expect(o.headers.get("cache-control")).toBe("no-store");
  expect(await o.json()).toEqual({ error: "insufficient_scope", scope: "read:orders" });
  const p = await productsRoute.GET(get("products", token));
  expect(p.status).toBe(403);
  expect(await p.json()).toEqual({ error: "insufficient_scope", scope: "read:products" });
  expect(adminGraphql).not.toHaveBeenCalled();
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
});

test("a read:orders-only token on /shop is 403 with scope read:shop", async () => {
  const { token } = await mint(storeA, SHOP_A, { scopes: ["read:orders"] });
  const res = await shopRoute.GET(get("shop", token));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "insufficient_scope", scope: "read:shop" });
});

test("two tokens each get their own 60 per minute; the 61st is 429 with Retry-After", async () => {
  const a = await mint(storeA, SHOP_A);
  const b = await mint(storeB, SHOP_B);
  for (let i = 0; i < 60; i++) expect((await shopRoute.GET(get("shop", a.token))).status).toBe(200);
  const over = await shopRoute.GET(get("shop", a.token));
  expect(over.status).toBe(429);
  expect(await over.json()).toEqual({ error: "rate_limited" });
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await shopRoute.GET(get("shop", b.token))).status).toBe(200);
});

test("last_used_at is written once in two quick calls, and again once it is over an hour old", async () => {
  const { token, tokenId } = await mint(storeA, SHOP_A);
  const lastUsed = async () => (await admin`select last_used_at from partner_tokens where id = ${tokenId}`)[0].last_used_at as Date | null;
  expect(await lastUsed()).toBeNull();
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  const first = await lastUsed();
  expect(first).not.toBeNull();
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  expect((await lastUsed())!.getTime()).toBe(first!.getTime());

  await admin`update partner_tokens set last_used_at = now() - interval '2 hours' where id = ${tokenId}`;
  const old = await lastUsed();
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  expect((await lastUsed())!.getTime()).toBeGreaterThan(old!.getTime());
});

test("a refused token (scope) doesn't touch last_used_at", async () => {
  const { token, tokenId } = await mint(storeA, SHOP_A, { scopes: ["read:shop"] });
  expect((await ordersRoute.GET(get("orders?updatedSince=2026-11-01T00:00:00Z", token))).status).toBe(403);
  const [row] = await admin`select last_used_at from partner_tokens where id = ${tokenId}`;
  expect(row.last_used_at).toBeNull();
});

test("C31: the legacy secret keeps working beside tokens, and a token works with the legacy env unset", async () => {
  const { token } = await mint(storeA, SHOP_A);
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  // Legacy off: a non-token Bearer is today's 401 unauthorized.
  const off = await shopRoute.GET(get("shop", LEGACY_SECRET));
  expect(off.status).toBe(401);
  expect(await off.json()).toEqual({ error: "unauthorized" });

  vi.stubEnv("PARTNER_STORE_DOMAIN", SHOP_B);
  vi.stubEnv("PARTNER_API_SECRET", LEGACY_SECRET);
  adminGraphql.mockClear();
  expect((await shopRoute.GET(get("shop", LEGACY_SECRET))).status).toBe(200);
  expect(adminGraphql.mock.calls[0].slice(0, 2)).toEqual([storeB, SHOP_B]);
  // A token still reads its own store, not the legacy one.
  adminGraphql.mockClear();
  expect((await shopRoute.GET(get("shop", token))).status).toBe(200);
  expect(adminGraphql.mock.calls[0].slice(0, 2)).toEqual([storeA, SHOP_A]);
});

test("no token appears in any response body or header", async () => {
  const { token } = await mint(storeA, SHOP_A, { scopes: ["read:shop"] });
  for (const res of [
    await shopRoute.GET(get("shop", token)),
    await ordersRoute.GET(get("orders?updatedSince=2026-11-01T00:00:00Z", token)),
    await shopRoute.GET(get("shop", token + "x")),
  ]) {
    const text = (await res.text()) + JSON.stringify([...res.headers]);
    expect(text).not.toContain(token);
  }
});
