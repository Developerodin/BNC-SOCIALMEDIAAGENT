import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHmac } from "node:crypto";

let admin: ReturnType<typeof postgres>;
let session: typeof import("@/lib/shopify/session");
let api: typeof import("@/lib/shopify/api");
let client: typeof import("@/db/client");

beforeAll(async () => {
  session = await import("@/lib/shopify/session");
  api = await import("@/lib/shopify/api");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
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

  const fetchName = vi.fn(async () => ({ data: { shop: { name: "A Shop" } } }));
  mockShopName(fetchName);
  expect(await (await GET(req(auth))).json()).toEqual({ shop: "a.myshopify.com", name: "A Shop" });
  expect((await admin`select name from stores`)[0].name).toBe("A Shop");

  // Saved: no further fetch.
  await GET(req(auth));
  expect(fetchName).toHaveBeenCalledTimes(1);
});
