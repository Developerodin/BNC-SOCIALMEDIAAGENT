import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";

// D70/D73 gatekeeping shared by every /api/partner route: store from env only, Bearer secret, rate limit, no-store.
const adminGraphql = vi.fn();
vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: (...a: unknown[]) => adminGraphql(...a) }));

const SHOP = "bc-partner.myshopify.com";
const SECRET = "s3cret-partner-value-long-enough";
let storeId: string;
let admin: ReturnType<typeof postgres>;
let shopRoute: typeof import("@/app/api/partner/shop/route");
let ordersRoute: typeof import("@/app/api/partner/orders/route");
let rl: typeof import("@/lib/partner/rate-limit");
let client: typeof import("@/db/client");

beforeAll(async () => {
  shopRoute = await import("@/app/api/partner/shop/route");
  ordersRoute = await import("@/app/api/partner/orders/route");
  rl = await import("@/lib/partner/rate-limit");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${SHOP}) returning id`;
  storeId = s.id;
  const [acc2] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain) values (${acc2.id}, 'other.myshopify.com')`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  vi.stubEnv("PARTNER_STORE_DOMAIN", SHOP);
  vi.stubEnv("PARTNER_API_SECRET", SECRET);
  rl.resetRateLimit();
  adminGraphql.mockReset();
  adminGraphql.mockResolvedValue({ shop: { name: "B&C", currencyCode: "INR" } });
});

const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  new Request(`http://x/api/partner/${path}`, { headers });

test("no Authorization header is 401, and Shopify is never called", async () => {
  const res = await shopRoute.GET(get("shop", {}));
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(adminGraphql).not.toHaveBeenCalled();
});

test("a wrong secret, a non-Bearer scheme, or an unset PARTNER_API_SECRET is 401", async () => {
  expect((await shopRoute.GET(get("shop", { authorization: "Bearer wrong" }))).status).toBe(401);
  expect((await shopRoute.GET(get("shop", { authorization: `Basic ${SECRET}` }))).status).toBe(401);
  expect((await shopRoute.GET(get("shop", { authorization: `Bearer ${SECRET}x` }))).status).toBe(401);
  vi.stubEnv("PARTNER_API_SECRET", "");
  expect((await shopRoute.GET(get("shop", { authorization: "Bearer " }))).status).toBe(401);
  expect((await shopRoute.GET(get("shop"))).status).toBe(401);
  expect(adminGraphql).not.toHaveBeenCalled();
});

test("an unset PARTNER_STORE_DOMAIN is 404 for every request, even with the right secret", async () => {
  vi.stubEnv("PARTNER_STORE_DOMAIN", "");
  expect((await shopRoute.GET(get("shop"))).status).toBe(404);
  expect((await shopRoute.GET(get("shop", {}))).status).toBe(404);
  expect((await ordersRoute.GET(get("orders?updatedSince=2026-11-01T00:00:00Z"))).status).toBe(404);
});

test("the request can't choose the shop: query, headers and host are ignored", async () => {
  const req = new Request(`http://other.myshopify.com/api/partner/shop?shop=other.myshopify.com`, {
    headers: { authorization: `Bearer ${SECRET}`, "x-shopify-shop-domain": "other.myshopify.com" },
  });
  const res = await shopRoute.GET(req);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "B&C", currencyCode: "INR" });
  expect(adminGraphql).toHaveBeenCalledTimes(1);
  expect(adminGraphql.mock.calls[0].slice(0, 2)).toEqual([storeId, SHOP]);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("a store the app isn't installed on (or uninstalled) is 503 with Retry-After", async () => {
  vi.stubEnv("PARTNER_STORE_DOMAIN", "missing.myshopify.com");
  const res = await shopRoute.GET(get("shop"));
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBeTruthy();
});

test("the 61st request in a minute is 429 with Retry-After", async () => {
  for (let i = 0; i < 60; i++) expect((await shopRoute.GET(get("shop"))).status).toBe(200);
  const res = await shopRoute.GET(get("shop"));
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("the token never appears in a response or the log, even when Shopify fails", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  adminGraphql.mockRejectedValueOnce(new Error("boom"));
  const res = await shopRoute.GET(get("shop"));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "upstream_error" });
  expect(JSON.stringify(err.mock.calls)).not.toMatch(/shpat_|accessToken/);
  err.mockRestore();
});
