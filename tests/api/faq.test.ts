import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// GET /api/faq (Task 28, D32, D7): public, CORS like chat, cached 5 minutes, one product's FAQ in `position` order.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/faq/route");
let client: typeof import("@/db/client");
let storeA: string;
let storeB: string;
let shopA: string;
let shopB: string;
const ORIGIN = "https://shop-a.example.com";
const P = "gid://shopify/Product/42";

function get(shop: string, product: string | null, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  const q = `shop=${encodeURIComponent(shop)}${product === null ? "" : `&product=${encodeURIComponent(product)}`}`;
  return route.GET(new Request(`http://localhost/api/faq?${q}`, { headers }));
}

async function faq(storeId: string, productId: string, question: string, position: number) {
  await admin`insert into faqs (store_id, product_id, question, answer, position)
              values (${storeId}, ${productId}, ${question}, ${`answer to ${question}`}, ${position})`;
}

beforeAll(async () => {
  route = await import("@/app/api/faq/route");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const shop = async (id: string, domains: string[]) => {
    const [s] = await admin`update stores set domains = ${domains} where id = ${id} returning shop_domain`;
    return s.shop_domain as string;
  };
  shopA = await shop(storeA, ["shop-a.example.com"]);
  shopB = await shop(storeB, ["shop-b.example.com"]);
  await faq(storeA, P, "third", 2);
  await faq(storeA, P, "first", 0);
  await faq(storeA, P, "second", 1);
  await faq(storeA, "gid://shopify/Product/43", "other product", 0);
  await faq(storeB, P, "store B's", 0);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("returns the product's items in position order, from a numeric id or a GID, cached with CORS", async () => {
  for (const product of ["42", P]) {
    const res = await get(shopA, product);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: ["first", "second", "third"].map((q) => ({ question: q, answer: `answer to ${q}` })),
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
});

test("store B's FAQ never comes back for store A's shop", async () => {
  const a = await (await get(shopA, "42")).json();
  expect(a.items.map((i: { question: string }) => i.question)).not.toContain("store B's");
  const b = await (await get(shopB, "42", "https://shop-b.example.com")).json();
  expect(b.items).toEqual([{ question: "store B's", answer: "answer to store B's" }]);
});

test("at most 20 items", async () => {
  for (let i = 0; i < 25; i++) await faq(storeA, "gid://shopify/Product/50", `q${i}`, i);
  const { items } = await (await get(shopA, "50")).json();
  expect(items).toHaveLength(20);
  expect(items[0].question).toBe("q0");
  expect(items[19].question).toBe("q19");
});

test("an unknown product → empty items, still cached", async () => {
  const res = await get(shopA, "999");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [] });
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
});

test("a missing or malformed product → 400, not cached", async () => {
  for (const product of [null, "", "abc", "gid://shopify/Collection/1", "42; drop table faqs"]) {
    const res = await get(shopA, product);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
});

test("a bad Origin → 403, an unknown shop → 404", async () => {
  for (const origin of ["https://evil.com", "https://shop-b.example.com", "http://shop-a.example.com", null]) {
    const res = await get(shopA, "42", origin);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect((await get("nope.myshopify.com", "42")).status).toBe(404);
  expect((await get("evil.com", "42")).status).toBe(404);
});

test("OPTIONS allows GET from a store's domain only", async () => {
  const res = await route.OPTIONS(new Request("http://localhost/api/faq", { method: "OPTIONS", headers: { origin: ORIGIN } }));
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  const bad = await route.OPTIONS(new Request("http://localhost/api/faq", { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
  expect(bad.status).toBe(403);
});
