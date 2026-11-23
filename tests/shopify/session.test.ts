import { afterAll, beforeAll, expect, test, vi } from "vitest";
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

test("first load exchanges an expiring offline token, creates the store and saves its name", async () => {
  const exchange = vi.spyOn(api.shopify.auth, "tokenExchange").mockResolvedValue({
    session: { accessToken: "at", expires: new Date(Date.now() + 3_600_000), refreshToken: "rt",
      refreshTokenExpires: new Date(Date.now() + 86_400_000) },
  } as never);
  vi.spyOn(api.shopify.clients, "Graphql").mockImplementation(
    class { request = async () => ({ data: { shop: { name: "A Shop" } } }); } as never,
  );
  const token = idToken(process.env.SHOPIFY_API_SECRET!);

  const first = await session.authenticateEmbedded(req(`Bearer ${token}`));
  expect(first.shop).toBe("a.myshopify.com");
  expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ shop: "a.myshopify.com", sessionToken: token, expiring: true }));
  const [s] = await admin`select id, name, active from stores`;
  expect(s).toEqual({ id: first.storeId, name: "A Shop", active: true });
  const [t] = await admin`select access_token_enc from store_tokens`;
  expect(t.access_token_enc.startsWith("k1:")).toBe(true);

  // Valid tokens now exist: no second exchange.
  expect(await session.authenticateEmbedded(req(`Bearer ${token}`))).toEqual(first);
  expect(exchange).toHaveBeenCalledTimes(1);
});
