import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "./helpers/seed";

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let shopInfo: typeof import("@/lib/shop-info");
let client: typeof import("@/db/client");
let gql: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  shopInfo = await import("@/lib/shop-info");
  client = await import("@/db/client");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

beforeEach(() => gql.mockReset());

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const shop = (o: { localization?: { defaultLocale: string } | null } = {}) => ({
  shop: {
    name: "Acme",
    currencyCode: "EUR",
    myshopifyDomain: "acme.myshopify.com",
    primaryDomain: { host: "Shop.Acme.com", localization: o.localization === undefined ? { defaultLocale: "de" } : o.localization },
    domains: [{ host: "acme.myshopify.com" }, { host: "shop.acme.com" }, { host: "ACME.fr" }],
  },
});

test("refreshShopInfo saves deduplicated, lowercased domains, the store language and the currency", async () => {
  const storeId = await newStore(admin);
  gql.mockResolvedValueOnce(shop());

  const info = await shopInfo.refreshShopInfo(storeId, "acme.myshopify.com");

  expect(gql).toHaveBeenCalledTimes(1);
  expect(gql.mock.calls[0][2]).toMatch(/primaryDomain \{ host localization \{ defaultLocale \} \}/);
  const domains = ["acme.fr", "acme.myshopify.com", "shop.acme.com"];
  expect({ ...info, domains: [...info.domains].sort() }).toEqual({ name: "Acme", domains, primaryLocale: "de", currencyCode: "EUR" });
  const [s] = await admin`select name, domains, primary_locale, currency_code from stores where id = ${storeId}`;
  expect({ ...s, domains: [...s.domains].sort() }).toEqual({ name: "Acme", domains, primary_locale: "de", currency_code: "EUR" });
});

test("refreshShopInfo saves a null store language when the primary domain has no localization", async () => {
  const storeId = await newStore(admin);
  await admin`update stores set primary_locale = 'en' where id = ${storeId}`;
  gql.mockResolvedValueOnce(shop({ localization: null }));

  const info = await shopInfo.refreshShopInfo(storeId, "acme.myshopify.com");

  expect(info.primaryLocale).toBeNull();
  const [s] = await admin`select primary_locale from stores where id = ${storeId}`;
  expect(s.primary_locale).toBeNull();
});

test("refreshShopInfo leaves the stored values alone when Shopify fails", async () => {
  const storeId = await newStore(admin);
  await admin`update stores set name = 'Old', domains = '{old.example.com}' where id = ${storeId}`;
  gql.mockRejectedValueOnce(new Error("Throttled"));

  await expect(shopInfo.refreshShopInfo(storeId, "acme.myshopify.com")).rejects.toThrow("Throttled");

  const [s] = await admin`select name, domains from stores where id = ${storeId}`;
  expect(s).toEqual({ name: "Old", domains: ["old.example.com"] });
});
