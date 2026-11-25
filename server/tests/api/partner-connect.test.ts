import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHash } from "node:crypto";

// Task P4: GET /partner/connect. Review focus 4 (no open redirect), PKCE S256, state passthrough, request saved.
const CLIENT = "pc_testclient000001";
const DISABLED = "pc_disabledclient01";
const REDIRECT = "https://portal.example/askcart/callback";
const ACTIVE_SHOP = "active-shop.myshopify.com";
const INACTIVE_SHOP = "gone-shop.myshopify.com";
const CHALLENGE = createHash("sha256").update("v".repeat(50)).digest("base64url");

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/partner/connect/route");
let client: typeof import("@/db/client");
const logs: unknown[][] = [];

beforeAll(async () => {
  route = await import("@/app/partner/connect/route");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  await admin`truncate partner_connect_requests, partner_clients cascade`;
  await admin`insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
    values (${CLIENT}, 'Portal', 'x', ${[REDIRECT, "https://portal.example/other?x=1"]}, ${["read:orders", "read:shop"]})`;
  await admin`insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes, disabled_at)
    values (${DISABLED}, 'Off', 'x', ${[REDIRECT]}, ${["read:shop"]}, now())`;
  const [a1] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain, active) values (${a1.id}, ${ACTIVE_SHOP}, true)`;
  const [a2] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain, active) values (${a2.id}, ${INACTIVE_SHOP}, false)`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  logs.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
});
afterEach(() => vi.restoreAllMocks());

function params(over: Record<string, string | null> = {}) {
  const base: Record<string, string | null> = {
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    shop: ACTIVE_SHOP,
    state: "st-123",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== null) q.set(k, v);
  return q;
}
const call = (q: URLSearchParams | string) =>
  route.GET(new Request(`https://test.example.com/partner/connect?${q.toString()}`));

test.each([
  ["unknown client", { client_id: "pc_nope" }],
  ["disabled client", { client_id: DISABLED }],
  ["missing client", { client_id: null }],
  ["missing redirect_uri", { redirect_uri: null }],
  ["trailing slash", { redirect_uri: REDIRECT + "/" }],
  ["different case", { redirect_uri: REDIRECT.replace("portal", "Portal") }],
  ["extra query", { redirect_uri: REDIRECT + "?a=1" }],
  ["other host", { redirect_uri: "https://evil.example/askcart/callback" }],
])("%s: 400 page, no Location", async (_n, over) => {
  const res = await call(params(over));
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toMatch(/text\/html/);
  const body = await res.text();
  expect(body).toContain("This connect link is not valid");
  expect(body).not.toContain("evil.example");
  expect(body).not.toContain("pc_nope");
});

test("a duplicated redirect_uri is refused with the 400 page", async () => {
  const q = params();
  q.append("redirect_uri", "https://evil.example/cb");
  const res = await call(q);
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
});

function errorRedirect(res: Response) {
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  return loc.searchParams;
}

test.each([
  ["bad shop", { shop: "evil.com" }, "invalid_request", "invalid_shop"],
  ["shop with path", { shop: "a.myshopify.com/x" }, "invalid_request", "invalid_shop"],
  ["missing shop", { shop: null }, "invalid_request", "invalid_shop"],
  ["missing challenge", { code_challenge: null }, "invalid_request", "invalid_code_challenge"],
  ["short challenge", { code_challenge: "abc" }, "invalid_request", "invalid_code_challenge"],
  ["plain method", { code_challenge_method: "plain" }, "invalid_request", "unsupported_code_challenge_method"],
  ["missing method", { code_challenge_method: null }, "invalid_request", "unsupported_code_challenge_method"],
  ["reserved scope", { scope: "read:orders write:orders" }, "invalid_scope", "invalid_scope"],
  ["scope not allowed for client", { scope: "read:products" }, "invalid_scope", "invalid_scope"],
])("%s: 302 to redirect_uri with the error and state", async (_n, over, error, desc) => {
  const res = await call(params(over));
  const p = errorRedirect(res);
  expect(p.get("error")).toBe(error);
  expect(p.get("error_description")).toBe(desc);
  expect(p.get("state")).toBe("st-123");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
});

test("missing or invalid state: invalid_state, no state echoed", async () => {
  for (const state of [null, "", "a".repeat(513), "bad\u0001state"]) {
    const p = errorRedirect(await call(params({ state, shop: "evil.com" })));
    expect(p.get("error")).toBe("invalid_request");
    expect(p.get("error_description")).toBe("invalid_state");
    expect(p.has("state")).toBe(false);
  }
});

test("state with & = % + and spaces round-trips byte for byte on an error redirect", async () => {
  const state = "a&b=c%20d+e f/?#~";
  const res = await call(params({ state, shop: "nope" }));
  expect(errorRedirect(res).get("state")).toBe(state);
});

test("a redirect_uri that already has a query keeps it and gains the error params", async () => {
  const res = await call(params({ redirect_uri: "https://portal.example/other?x=1", shop: "nope" }));
  const loc = new URL(res.headers.get("location")!);
  expect(loc.searchParams.get("x")).toBe("1");
  expect(loc.searchParams.get("error_description")).toBe("invalid_shop");
});

test("active store: saves a pending request and redirects to the consent deep link", async () => {
  const state = "a&b=c%20d";
  const res = await call(params({ state, shop: "Active-Shop.myshopify.com" }));
  expect(res.status).toBe(302);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin).toBe("https://admin.shopify.com");
  expect(loc.pathname).toBe("/store/active-shop/apps/test-api-key/app/partner-consent");
  const id = loc.searchParams.get("request")!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const [row] = await admin`select *, extract(epoch from (expires_at - now())) as ttl from partner_connect_requests where id = ${id}`;
  expect(row.status).toBe("pending");
  expect(row.client_id).toBe(CLIENT);
  expect(row.shop_domain).toBe(ACTIVE_SHOP);
  expect(row.redirect_uri).toBe(REDIRECT);
  expect(row.state).toBe(state);
  expect(row.code_challenge).toBe(CHALLENGE);
  expect(row.scopes).toEqual(["read:orders", "read:shop"]); // the client's default
  expect(Number(row.ttl)).toBeGreaterThan(590);
  expect(Number(row.ttl)).toBeLessThanOrEqual(600);
  expect(row.code_hash).toBeNull();

  expect(JSON.stringify(logs)).not.toContain(id);
});

test("an explicit scope narrows the saved set", async () => {
  const res = await call(params({ scope: "read:shop" }));
  const id = new URL(res.headers.get("location")!).searchParams.get("request")!;
  const [row] = await admin`select scopes from partner_connect_requests where id = ${id}`;
  expect(row.scopes).toEqual(["read:shop"]);
});

test.each([
  ["inactive store", INACTIVE_SHOP, "gone-shop"],
  ["missing store", "brand-new.myshopify.com", "brand-new"],
])("%s: saves the request and redirects to the install link", async (_n, shop, handle) => {
  const res = await call(params({ shop }));
  expect(res.status).toBe(302);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("location")).toBe(
    `https://admin.shopify.com/store/${handle}/oauth/install?client_id=test-api-key`,
  );
  const rows = await admin`select status from partner_connect_requests where shop_domain = ${shop}`;
  expect(rows.map((r) => r.status)).toEqual(["pending"]);
});

test("rows expired more than a day ago are deleted on insert; recent ones stay", async () => {
  const insert = (expires: string) => admin`
    insert into partner_connect_requests (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at)
    values (${CLIENT}, 'old.myshopify.com', ${REDIRECT}, 's', ${CHALLENGE}, ${["read:shop"]}, 'expired', now() - ${expires}::interval)
    returning id`;
  const [old] = await insert("25 hours");
  const [recent] = await insert("23 hours");
  await call(params());
  const left = await admin`select id from partner_connect_requests where id in (${old.id}, ${recent.id})`;
  expect(left.map((r) => r.id)).toEqual([recent.id]);
});

test("nothing is saved when a param is invalid", async () => {
  const [{ n: before }] = await admin`select count(*)::int as n from partner_connect_requests`;
  await call(params({ code_challenge_method: "plain" }));
  await call(params({ client_id: "pc_nope" }));
  const [{ n: after }] = await admin`select count(*)::int as n from partner_connect_requests`;
  expect(after).toBe(before);
});
