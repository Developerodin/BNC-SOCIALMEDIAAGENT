import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHmac } from "node:crypto";

let admin: ReturnType<typeof postgres>;
let session: typeof import("@/lib/shopify/session");
let api: typeof import("@/lib/shopify/api");
let client: typeof import("@/db/client");
let jobs: typeof import("@/lib/jobs");

beforeAll(async () => {
  session = await import("@/lib/shopify/session");
  api = await import("@/lib/shopify/api");
  client = await import("@/db/client");
  jobs = await import("@/lib/jobs");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(secret: string, shop = "a.myshopify.com") {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: process.env.SHOPIFY_API_KEY,
    sub: "1", exp: now + 60, nbf: now - 5, iat: now, jti: "j", sid: "s",
  })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const req = (auth?: string) => new Request("http://localhost/api/app/me", { headers: auth ? { authorization: auth } : {} });
const status = (e: unknown) => (e instanceof Response ? e.status : e);

test("missing bearer token gives 401", async () => {
  expect(await session.authenticateEmbedded(req()).catch(status)).toBe(401);
});

test("forged bearer token gives 401", async () => {
  expect(await session.authenticateEmbedded(req(`Bearer ${idToken("wrong-secret")}`)).catch(status)).toBe(401);
});

const exchanged = () => ({
  session: { accessToken: "at", expires: new Date(Date.now() + 3_600_000), refreshToken: "rt",
    refreshTokenExpires: new Date(Date.now() + 86_400_000) },
}) as never;
const shopInfo = (name: string) => ({
  shop: { name, currencyCode: "USD", myshopifyDomain: "a.myshopify.com", primaryDomain: { host: "a.myshopify.com", localization: { defaultLocale: "en" } }, domains: [] },
});
const mockShopName = (impl: () => Promise<unknown>) =>
  vi.spyOn(api.shopify.clients, "Graphql").mockImplementation(class { request = impl; } as never);

beforeEach(async () => {
  vi.restoreAllMocks();
  await admin`truncate accounts, stores, store_tokens cascade`;
});

test("first load exchanges an expiring offline token and creates the store", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  const token = idToken(process.env.SHOPIFY_API_SECRET!);

  const first = await session.authenticateEmbedded(req(`Bearer ${token}`));
  expect(first.shop).toBe("a.myshopify.com");
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ shop: "a.myshopify.com", sessionToken: token, expiring: true }));
  const [s] = await admin`select id, active from stores`;
  expect(s).toEqual({ id: first.storeId, active: true });
  const [t] = await admin`select access_token_enc from store_tokens`;
  expect(t.access_token_enc.startsWith("k1:")).toBe(true);
  expect(await admin`select id from pgboss.job where name = 'store-sync' and singleton_key = ${first.storeId}`).toHaveLength(1);

  // Valid tokens now exist: no second exchange.
  expect(await session.authenticateEmbedded(req(`Bearer ${token}`))).toEqual(first);
  expect(exchange).toHaveBeenCalledTimes(1);
});

test("two simultaneous first loads exchange once", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return exchanged();
  });
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;
  const [x, y] = await Promise.all([session.authenticateEmbedded(req(auth)), session.authenticateEmbedded(req(auth))]);
  expect(x).toEqual(y);
  expect(exchange).toHaveBeenCalledTimes(1);
});

test("/api/app/me fetches a missing shop name, and retries on a later load after a failure", async () => {
  vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { GET } = await import("@/app/api/app/me/route");
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;

  mockShopName(async () => { throw new Error("graphql down"); });
  const failed = await GET(req(auth));
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ shop: "a.myshopify.com", name: null });

  const fetchName = vi.fn(async () => ({ data: shopInfo("A Shop") }));
  mockShopName(fetchName);
  expect(await (await GET(req(auth))).json()).toEqual({ shop: "a.myshopify.com", name: "A Shop" });
  expect((await admin`select name from stores`)[0].name).toBe("A Shop");

  // Saved: no further fetch.
  await GET(req(auth));
  expect(fetchName).toHaveBeenCalledTimes(1);
});

test("a fresh token exchange clears the reconnect flag, and only that reason", async () => {
  const { RECONNECT_NEEDED } = await import("@/lib/shopify/tokens");
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;
  const { storeId } = await session.authenticateEmbedded(req(auth));
  const expire = () => admin`update store_tokens set access_expires_at = now() - interval '1 hour', refresh_expires_at = now() - interval '1 hour'`;

  await admin`update stores set sync_error = ${RECONNECT_NEEDED} where id = ${storeId}`;
  await expire();
  await session.authenticateEmbedded(req(auth));
  expect((await admin`select sync_error from stores`)[0].sync_error).toBeNull();

  await admin`update stores set sync_error = 'Bulk operations are not enabled' where id = ${storeId}`;
  await expire();
  await session.authenticateEmbedded(req(auth));
  expect((await admin`select sync_error from stores`)[0].sync_error).toBe("Bulk operations are not enabled");
  expect(exchange).toHaveBeenCalledTimes(3);
});

test("valid tokens with a leftover reconnect flag clear it and resume the sync, without an exchange", async () => {
  const { RECONNECT_NEEDED } = await import("@/lib/shopify/tokens");
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;
  const { storeId } = await session.authenticateEmbedded(req(auth));
  await admin`delete from pgboss.job where name = 'store-sync' and singleton_key = ${storeId}`;
  await admin`update stores set sync_error = ${RECONNECT_NEEDED} where id = ${storeId}`;

  await session.authenticateEmbedded(req(auth));
  expect(exchange).toHaveBeenCalledTimes(1);
  expect((await admin`select sync_error from stores`)[0].sync_error).toBeNull();
  expect(await admin`select id from pgboss.job where name = 'store-sync' and singleton_key = ${storeId}`).toHaveLength(1);

  // Another reason is left alone, and nothing is queued for it.
  await admin`delete from pgboss.job where name = 'store-sync' and singleton_key = ${storeId}`;
  await admin`update stores set sync_error = 'other' where id = ${storeId}`;
  await session.authenticateEmbedded(req(auth));
  expect((await admin`select sync_error from stores`)[0].sync_error).toBe("other");
  expect(await admin`select id from pgboss.job where name = 'store-sync' and singleton_key = ${storeId}`).toHaveLength(0);
});

test("an access token inside the refresh window with an expired refresh token is exchanged", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;
  await session.authenticateEmbedded(req(auth));
  await admin`update store_tokens set access_expires_at = now() + interval '2 minutes', refresh_expires_at = now() - interval '1 hour'`;
  await session.authenticateEmbedded(req(auth));
  expect(exchange).toHaveBeenCalledTimes(2);
});

test("/api/app/me refreshes the shop info while the store language is missing, even with a name", async () => {
  vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue(exchanged());
  const { GET } = await import("@/app/api/app/me/route");
  const auth = `Bearer ${idToken(process.env.SHOPIFY_API_SECRET!)}`;
  await session.authenticateEmbedded(req(auth));
  await admin`update stores set name = 'Old name'`;

  const fetchInfo = vi.fn(async () => ({ data: shopInfo("New name") }));
  mockShopName(fetchInfo);
  expect(await (await GET(req(auth))).json()).toEqual({ shop: "a.myshopify.com", name: "New name" });
  expect((await admin`select primary_locale, currency_code, domains from stores`)[0])
    .toEqual({ primary_locale: "en", currency_code: "USD", domains: ["a.myshopify.com"] });

  await GET(req(auth));
  expect(fetchInfo).toHaveBeenCalledTimes(1);
});
