import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// Task P6: POST /api/partner/token (code exchange, refresh under the access_refresh switch) and DELETE (revoke the grant).
const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));

const REDIRECT = "https://portal.example/askcart/callback";
let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/partner/token/route");
let lib: typeof import("@/app/api/partner/token/tokens");
let secrets: typeof import("@/lib/partner/secrets");
let rl: typeof import("@/lib/rate-limit");
let client: typeof import("@/db/client");

type Client = { id: string; secret: string };
let PORTAL: Client;
let OTHER: Client;
let DISABLED: Client;
// Every bearer secret this file creates or receives; none may appear in any console call.
const seen: string[] = [];
const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));

async function newClient(disabled = false): Promise<Client> {
  const id = secrets.newClientId();
  const { secret, hash } = secrets.newClientSecret();
  seen.push(secret);
  await admin`
    insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes, disabled_at)
    values (${id}, 'Test portal', ${hash}, ${[REDIRECT]}, ${["read:orders", "read:products", "read:shop"]}, ${disabled ? new Date() : null})`;
  return { id, secret };
}

type Shop = { id: string; domain: string };
async function newShop(name: string | null = "B&C", currency: string | null = "INR"): Promise<Shop> {
  const domain = `t-${randomUUID().slice(0, 8)}.myshopify.com`;
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`
    insert into stores (account_id, shop_domain, name, currency_code) values (${acc.id}, ${domain}, ${name}, ${currency}) returning id`;
  return { id: s.id, domain };
}

type Code = { code: string; verifier: string; requestId: string };
async function approved(
  shop: Shop,
  o: { client?: Client; status?: string; expired?: boolean; scopes?: string[] } = {},
): Promise<Code> {
  const code = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  seen.push(code, verifier);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const [r] = await admin`
    insert into partner_connect_requests
      (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at, code_hash, code_expires_at, approved_by_user_id)
    values (${(o.client ?? PORTAL).id}, ${shop.domain}, ${REDIRECT}, 'st', ${challenge}, ${o.scopes ?? ["read:orders", "read:shop"]},
      ${o.status ?? "approved"}, now() + interval '10 minutes', ${secrets.sha256Hex(code)},
      ${o.expired ? admin`now() - interval '1 second'` : admin`now() + interval '5 minutes'`}, '4242')
    returning id`;
  return { code, verifier, requestId: r.id };
}

const exchangeBody = (c: Code, cl: Client = PORTAL) => ({
  grant_type: "authorization_code", code: c.code, client_id: cl.id, client_secret: cl.secret, redirect_uri: REDIRECT, code_verifier: c.verifier,
});
const postReq = (body: unknown, contentType = "application/json") =>
  new Request("http://x/api/partner/token", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
async function post(body: unknown, contentType?: string) {
  const res = await route.POST(postReq(body, contentType));
  const json = await res.json();
  for (const k of ["access_token", "refresh_token"]) if (typeof json[k] === "string") seen.push(json[k]);
  return { res, json };
}
const del = (auth?: string) =>
  route.DELETE(new Request("http://x/api/partner/token", { method: "DELETE", headers: auth ? { authorization: auth } : {} }));

/** What P7's guard will check: token row exists, not expired, grant not revoked, store active. */
async function isLive(token: string): Promise<boolean> {
  const [r] = await admin`
    select count(*)::int n from partner_tokens t join partner_grants g on g.id = t.grant_id join stores s on s.id = t.store_id
    where t.token_hash = ${secrets.sha256Hex(token)} and g.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and s.active`;
  return r.n === 1;
}
async function grantOf(token: string) {
  const [g] = await admin`
    select g.* from partner_grants g join partner_tokens t on t.grant_id = g.id where t.token_hash = ${secrets.sha256Hex(token)}`;
  return g;
}

beforeAll(async () => {
  route = await import("@/app/api/partner/token/route");
  lib = await import("@/app/api/partner/token/tokens");
  secrets = await import("@/lib/partner/secrets");
  rl = await import("@/lib/rate-limit");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  PORTAL = await newClient();
  OTHER = await newClient();
  DISABLED = await newClient(true);
});

afterAll(async () => {
  const ids = [PORTAL.id, OTHER.id, DISABLED.id];
  await admin`delete from partner_grants where client_id = any(${ids})`;
  await admin`delete from partner_connect_requests where client_id = any(${ids})`;
  await admin`delete from partner_clients where client_id = any(${ids})`;
  await admin.end();
  await client.sql.end();
  const logged = JSON.stringify(spies.map((s) => s.mock.calls));
  for (const s of seen) expect(logged).not.toContain(s);
});

beforeEach(() => {
  rl.resetRateLimit();
  adminGraphql.mockReset();
});

// ---------- exchange ----------

test("a valid code returns a Bearer ack_ token, the grant's shop and scopes, never cached; only the hash is stored", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  const { res, json } = await post(exchangeBody(c));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(json).toEqual({
    access_token: expect.stringMatching(/^ack_[A-Za-z0-9_-]{43}$/),
    token_type: "Bearer",
    shop: { domain: shop.domain, name: "B&C", currencyCode: "INR" },
    scopes: ["read:orders", "read:shop"],
  });
  const rows = await admin`select * from partner_tokens where store_id = ${shop.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "access",
    token_hash: secrets.sha256Hex(json.access_token),
    token_prefix: json.access_token.slice(0, 12),
    expires_at: null,
  });
  const dump = JSON.stringify(await admin`select * from partner_tokens t join partner_grants g on g.id = t.grant_id`);
  expect(dump).not.toContain(json.access_token);
  const g = await grantOf(json.access_token);
  expect(g).toMatchObject({ store_id: shop.id, client_id: PORTAL.id, connect_request_id: c.requestId, granted_by_user_id: "4242", revoked_at: null });
  const [r] = await admin`select status, exchanged_at from partner_connect_requests where id = ${c.requestId}`;
  expect(r.status).toBe("exchanged");
  expect(r.exchanged_at).not.toBeNull();
  expect(await isLive(json.access_token)).toBe(true);
});

test("shop name and currency missing from stores are fetched from Shopify", async () => {
  const shop = await newShop(null, null);
  adminGraphql.mockResolvedValue({ shop: { name: "Fetched", currencyCode: "USD" } });
  const { res, json } = await post(exchangeBody(await approved(shop)));
  expect(res.status).toBe(200);
  expect(json.shop).toEqual({ domain: shop.domain, name: "Fetched", currencyCode: "USD" });
});

test("a failed shop fetch is 503 temporarily_unavailable and leaves the code usable", async () => {
  const shop = await newShop(null, null);
  const c = await approved(shop);
  adminGraphql.mockRejectedValueOnce(new Error("boom"));
  const first = await post(exchangeBody(c));
  expect(first.res.status).toBe(503);
  expect(first.json).toEqual({ error: "temporarily_unavailable" });
  adminGraphql.mockResolvedValue({ shop: { name: "Fetched", currencyCode: "USD" } });
  expect((await post(exchangeBody(c))).res.status).toBe(200);
});

test("two parallel exchanges of one code: exactly one 200; the replay revokes the grant it issued", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  const results = await Promise.all([post(exchangeBody(c)), post(exchangeBody(c))]);
  const ok = results.filter((r) => r.res.status === 200);
  const bad = results.filter((r) => r.res.status === 400);
  expect(ok).toHaveLength(1);
  expect(bad[0].json).toEqual({ error: "invalid_grant" });
  const token = ok[0].json.access_token;
  // The losing parallel call is itself a replay (RFC 6749 4.1.2), so the grant is already revoked.
  expect(await grantOf(token)).toMatchObject({ revoked_reason: "code_replay" });
  expect(await isLive(token)).toBe(false);
  expect((await post(exchangeBody(c))).json).toEqual({ error: "invalid_grant" });
});

test("a replayed code is invalid_grant and revokes every token of its grant", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  const { json } = await post(exchangeBody(c));
  expect(await isLive(json.access_token)).toBe(true);
  const replay = await post(exchangeBody(c));
  expect(replay.res.status).toBe(400);
  expect(replay.json).toEqual({ error: "invalid_grant" });
  expect(await grantOf(json.access_token)).toMatchObject({ revoked_reason: "code_replay" });
  expect(await isLive(json.access_token)).toBe(false);
});

test("another client's credentials, a redirect_uri one character off, a wrong verifier, an expired, unknown or unapproved code: invalid_grant", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  const cases = [
    exchangeBody(c, OTHER),
    { ...exchangeBody(c), redirect_uri: REDIRECT + "/" },
    { ...exchangeBody(c), redirect_uri: REDIRECT.replace("callback", "callbacK") },
    { ...exchangeBody(c), code_verifier: randomBytes(48).toString("base64url") },
    { ...exchangeBody(c), code_verifier: "short" },
    exchangeBody(await approved(shop, { expired: true })),
    exchangeBody(await approved(shop, { status: "pending" })),
    exchangeBody(await approved(shop, { status: "denied" })),
    { ...exchangeBody(c), code: randomBytes(32).toString("base64url") },
  ];
  for (const body of cases) {
    const { res, json } = await post(body);
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "invalid_grant" });
  }
  // None of those consumed the code or created a grant.
  expect(await admin`select 1 from partner_grants where store_id = ${shop.id}`).toHaveLength(0);
  expect((await post(exchangeBody(c))).res.status).toBe(200);
});

test("a wrong secret, an unknown client or a disabled client is 401 invalid_client with WWW-Authenticate", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  for (const body of [
    { ...exchangeBody(c), client_secret: OTHER.secret },
    { ...exchangeBody(c), client_id: "pc_unknown" },
    exchangeBody(c, DISABLED),
  ]) {
    const { res, json } = await post(body);
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: "invalid_client" });
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic/);
  }
});

test("non-JSON, the wrong content type, a missing field, a body over 4 kB: 400 invalid_request", async () => {
  const c = await approved(await newShop());
  const { code: _code, ...noCode } = exchangeBody(c);
  void _code;
  const cases: [unknown, string?][] = [
    ["{not json", undefined],
    ["[]", undefined],
    [exchangeBody(c), "application/x-www-form-urlencoded"],
    [noCode, undefined],
    [{ ...exchangeBody(c), code_verifier: 5 }, undefined],
    [{ ...exchangeBody(c), pad: "x".repeat(5000) }, undefined],
  ];
  for (const [body, ct] of cases) {
    const { res, json } = await post(body, ct);
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "invalid_request" });
  }
});

test("any grant_type but authorization_code is unsupported_grant_type, including refresh_token under long_lived", async () => {
  const c = await approved(await newShop());
  for (const grant_type of ["password", "refresh_token", "client_credentials"]) {
    const { res, json } = await post({ ...exchangeBody(c), grant_type, refresh_token: "ackr_x" });
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "unsupported_grant_type" });
  }
});

test("a store uninstalled between consent and exchange: invalid_grant", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  await admin`update stores set active = false where id = ${shop.id}`;
  expect((await post(exchangeBody(c))).json).toEqual({ error: "invalid_grant" });
  expect(await admin`select 1 from partner_grants where store_id = ${shop.id}`).toHaveLength(0);
});

test("C33: reconnecting the same store to the same portal replaces the old grant; another portal's grant is untouched", async () => {
  const shop = await newShop();
  const first = (await post(exchangeBody(await approved(shop)))).json.access_token;
  const other = (await post(exchangeBody(await approved(shop, { client: OTHER }), OTHER))).json.access_token;
  const second = (await post(exchangeBody(await approved(shop)))).json.access_token;
  expect(await grantOf(first)).toMatchObject({ revoked_reason: "reconnect" });
  expect(await isLive(first)).toBe(false);
  expect(await isLive(second)).toBe(true);
  expect(await isLive(other)).toBe(true);
});

test("two different codes for one store and portal exchanged at once both succeed, leaving one active grant", async () => {
  const shop = await newShop();
  const [ca, cb] = [await approved(shop), await approved(shop)];
  const [a, b] = await Promise.all([post(exchangeBody(ca)), post(exchangeBody(cb))]);
  expect([a.res.status, b.res.status]).toEqual([200, 200]);
  const active = await admin`select id from partner_grants where store_id = ${shop.id} and revoked_at is null`;
  expect(active).toHaveLength(1);
  expect([await isLive(a.json.access_token), await isLive(b.json.access_token)].filter(Boolean)).toHaveLength(1);
});

test("over 60 exchanges a minute for one client: 429 rate_limited with Retry-After, after client authentication", async () => {
  const c = await approved(await newShop());
  const unknown = { ...exchangeBody(c), code: "nope" };
  for (let i = 0; i < 60; i++) expect((await post(unknown)).res.status).toBe(400);
  // A wrong secret doesn't spend or see the budget.
  expect((await post({ ...unknown, client_secret: "pcs_wrong" })).res.status).toBe(401);
  const { res, json } = await post(unknown);
  expect(res.status).toBe(429);
  expect(json).toEqual({ error: "rate_limited" });
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
});

// ---------- revoke ----------

async function connected() {
  const shop = await newShop();
  const token = (await post(exchangeBody(await approved(shop)))).json.access_token as string;
  const g = await grantOf(token);
  // Extra tokens of the same grant, as access_refresh would issue: an expired access token and a refresh token.
  const expired = "ack_" + randomBytes(32).toString("base64url");
  const refresh = "ackr_" + randomBytes(32).toString("base64url");
  seen.push(expired, refresh);
  await admin`
    insert into partner_tokens (grant_id, store_id, kind, token_hash, token_prefix, expires_at) values
      (${g.id}, ${shop.id}, 'access', ${secrets.sha256Hex(expired)}, ${expired.slice(0, 12)}, now() - interval '1 minute'),
      (${g.id}, ${shop.id}, 'refresh', ${secrets.sha256Hex(refresh)}, ${refresh.slice(0, 12)}, null)`;
  return { shop, token, expired, refresh, grantId: g.id as string };
}

test("DELETE with the access token: 204, and every token of that grant stops", async () => {
  const k = await connected();
  const res = await del(`Bearer ${k.token}`);
  expect(res.status).toBe(204);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const [g] = await admin`select revoked_at, revoked_reason from partner_grants where id = ${k.grantId}`;
  expect(g.revoked_reason).toBe("portal");
  expect(g.revoked_at).not.toBeNull();
  for (const t of [k.token, k.refresh]) expect(await isLive(t)).toBe(false);
});

test("DELETE with an expired access token or with the refresh token: 204, and the grant is revoked", async () => {
  for (const pick of ["expired", "refresh"] as const) {
    const k = await connected();
    expect((await del(`Bearer ${k[pick]}`)).status).toBe(204);
    const [g] = await admin`select revoked_reason from partner_grants where id = ${k.grantId}`;
    expect(g.revoked_reason).toBe("portal");
    expect(await isLive(k.token)).toBe(false);
  }
});

test("DELETE is idempotent and leaks nothing: twice, unknown token, legacy secret all 204; no header is 400", async () => {
  const k = await connected();
  const other = (await post(exchangeBody(await approved(k.shop, { client: OTHER }), OTHER))).json.access_token;
  expect((await del(`Bearer ${k.token}`)).status).toBe(204);
  const [first] = await admin`select revoked_at from partner_grants where id = ${k.grantId}`;
  expect((await del(`Bearer ${k.token}`)).status).toBe(204);
  const [again] = await admin`select revoked_at, revoked_reason from partner_grants where id = ${k.grantId}`;
  expect(again).toEqual({ revoked_at: first.revoked_at, revoked_reason: "portal" });
  expect((await del(`Bearer ack_${randomBytes(32).toString("base64url")}`)).status).toBe(204);
  expect((await del("Bearer some-legacy-secret")).status).toBe(204);
  // The same store's grant for another portal is untouched.
  expect(await isLive(other)).toBe(true);
  for (const auth of [undefined, "Basic abc", "Bearer "]) {
    const res = await del(auth);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  }
});

// ---------- the access_refresh switch (C32 (c)), called through tokenPost with the model ----------

async function postModel(body: unknown) {
  const res = await lib.tokenPost(postReq(body), "access_refresh");
  const json = await res.json();
  for (const k of ["access_token", "refresh_token"]) if (typeof json[k] === "string") seen.push(json[k]);
  return { res, json };
}
const refreshBody = (refresh_token: string, cl: Client = PORTAL) => ({
  grant_type: "refresh_token", refresh_token, client_id: cl.id, client_secret: cl.secret,
});

test("access_refresh: the exchange adds a 1 h access token and a refresh token; replaying the code kills both", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  const { res, json } = await postModel(exchangeBody(c));
  expect(res.status).toBe(200);
  expect(json).toMatchObject({ token_type: "Bearer", expires_in: 3600, refresh_token: expect.stringMatching(/^ackr_[A-Za-z0-9_-]{43}$/) });
  const [row] = await admin`select expires_at from partner_tokens where token_hash = ${secrets.sha256Hex(json.access_token)}`;
  const ms = new Date(row.expires_at).getTime() - Date.now();
  expect(ms).toBeGreaterThan(3_500_000);
  expect(ms).toBeLessThanOrEqual(3_600_000);
  expect((await postModel(exchangeBody(c))).json).toEqual({ error: "invalid_grant" });
  expect(await isLive(json.access_token)).toBe(false);
  expect(await isLive(json.refresh_token)).toBe(false);
});

test("access_refresh: refresh rotates on the same grant; the old refresh token reused revokes the grant", async () => {
  const shop = await newShop();
  const first = (await postModel(exchangeBody(await approved(shop)))).json;
  const r = await postModel(refreshBody(first.refresh_token));
  expect(r.res.status).toBe(200);
  expect(r.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, shop: { domain: shop.domain }, scopes: ["read:orders", "read:shop"] });
  expect(r.json.refresh_token).not.toBe(first.refresh_token);
  expect((await grantOf(r.json.access_token)).id).toBe((await grantOf(first.access_token)).id);
  const [old] = await admin`select replaced_at from partner_tokens where token_hash = ${secrets.sha256Hex(first.refresh_token)}`;
  expect(old.replaced_at).not.toBeNull();
  expect(await isLive(r.json.access_token)).toBe(true);

  const replay = await postModel(refreshBody(first.refresh_token));
  expect(replay.json).toEqual({ error: "invalid_grant" });
  expect(await grantOf(first.access_token)).toMatchObject({ revoked_reason: "refresh_replay" });
  expect(await isLive(r.json.access_token)).toBe(false);
});

test("access_refresh: an access token as refresh, another client's refresh token, an unknown one: invalid_grant, grant untouched", async () => {
  const shop = await newShop();
  const t = (await postModel(exchangeBody(await approved(shop)))).json;
  for (const body of [refreshBody(t.access_token), refreshBody(t.refresh_token, OTHER), refreshBody("ackr_" + "a".repeat(43))]) {
    const { res, json } = await postModel(body);
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "invalid_grant" });
  }
  expect(await isLive(t.access_token)).toBe(true);
  expect((await postModel(refreshBody(t.refresh_token))).res.status).toBe(200);
});

test("logs carry a replay warning but never a token, code, verifier or secret", async () => {
  const shop = await newShop();
  const c = await approved(shop);
  await post(exchangeBody(c));
  const before = spies[2].mock.calls.length;
  await post(exchangeBody(c));
  expect(spies[2].mock.calls.length).toBeGreaterThan(before);
});
