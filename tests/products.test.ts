import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

let admin: ReturnType<typeof postgres>;
let products: typeof import("@/lib/products");
let client: typeof import("@/db/client");
let schema: typeof import("@/db/schema");

beforeAll(async () => {
  products = await import("@/lib/products");
  client = await import("@/db/client");
  schema = await import("@/db/schema");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

async function newStore(domain: string) {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${domain}) returning id`;
  return s.id as string;
}

function product(over: Partial<import("@/lib/products").ShopifyProduct> = {}): import("@/lib/products").ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    handle: "tee",
    title: "Tee",
    description: "A soft tee",
    productType: "Shirt",
    vendor: "Acme",
    tags: ["b", "a"],
    options: [{ name: "Size", values: ["S", "M"] }],
    status: "ACTIVE",
    onlineStoreUrl: "https://shop.example.com/products/tee",
    publishedAt: "2026-01-01T00:00:00Z",
    imageUrl: null,
    updatedAt: "2026-01-02T00:00:00Z",
    metafields: [],
    collections: [],
    category: null,
    ...over,
  };
}

const mf = (namespace: string, key: string, type: string, value: string) => ({ namespace, key, type, value });

test("buildContent is stable under tag and metafield order", () => {
  const m1 = mf("custom", "fabric", "single_line_text_field", "cotton");
  const m2 = mf("custom", "care", "multi_line_text_field", "wash cold");
  const a = products.buildContent(product({ tags: ["a", "b"], metafields: [m1, m2] }));
  const b = products.buildContent(product({ tags: ["b", "a"], metafields: [m2, m1] }));
  expect(a).toBe(b);
});

test("buildContent leaves out json metafields, app-- namespaces and price", () => {
  const out = products.buildContent(
    product({
      metafields: [
        mf("custom", "blob", "json", "SECRETJSON"),
        mf("app--123", "x", "single_line_text_field", "APPNS"),
        mf("custom", "price", "number_decimal", "PRICEVAL"),
        mf("custom", "fabric", "single_line_text_field", "cotton"),
      ],
    }),
  );
  expect(out).not.toContain("SECRETJSON");
  expect(out).not.toContain("APPNS");
  expect(out).not.toContain("PRICEVAL");
  expect(out).toContain("cotton");
});

test("buildContent leaves out empty fields and Shopify's Default Title option", () => {
  const out = products.buildContent(
    product({ description: "", tags: [], productType: "", vendor: "", options: [{ name: "Title", values: ["Default Title"] }] }),
  );
  expect(out).toBe("Title: Tee");
});

test("buildContent writes measurements as words and lists collections", () => {
  const out = products.buildContent(
    product({
      collections: ["Winter", "Best sellers"],
      metafields: [mf("test_data", "length", "dimension", '{"value":159.0,"unit":"CENTIMETERS"}')],
    }),
  );
  expect(out).toContain("test_data.length: 159 centimeters");
  expect(out).toContain("Collections: Best sellers, Winter");
});

test("buildContent cuts a metafield value to 500 characters", () => {
  const out = products.buildContent(product({ metafields: [mf("custom", "long", "multi_line_text_field", "x".repeat(600))] }));
  expect(out).toContain("x".repeat(500));
  expect(out).not.toContain("x".repeat(501));
});

test("upsertProducts stores one row with published flag and a 64-char hash", async () => {
  const storeId = await newStore("up.myshopify.com");
  await products.upsertProducts(storeId, [product()]);
  const rows = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(rows).toHaveLength(1);
  expect(rows[0].published).toBe(true);
  expect(rows[0].contentHash).toHaveLength(64);

  await products.upsertProducts(storeId, [product({ onlineStoreUrl: null, publishedAt: null, updatedAt: "2026-01-03T00:00:00Z" })]);
  const again = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(again).toHaveLength(1);
  expect(again[0].published).toBe(false);
});

test("a password-protected store's product (no onlineStoreUrl, but a publishedAt) counts as published", async () => {
  const storeId = await newStore("pw.myshopify.com");
  await products.upsertProducts(storeId, [product({ onlineStoreUrl: null })]);
  const [row] = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(row.published).toBe(true);
  // D71: no onlineStoreUrl, so the link is built from the shop domain and handle.
  expect(row.url).toBe("https://pw.myshopify.com/products/tee");
});

test("a product with an onlineStoreUrl keeps Shopify's link", async () => {
  const storeId = await newStore("live.myshopify.com");
  await products.upsertProducts(storeId, [product()]);
  const [row] = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(row.url).toBe("https://shop.example.com/products/tee");
});

test("an older updatedAt does not overwrite, a newer one does", async () => {
  const storeId = await newStore("ver.myshopify.com");
  await products.upsertProducts(storeId, [product()]);
  const read = () => client.forStore(storeId, (tx) => tx.select().from(schema.products).where(eq(schema.products.shopifyId, "gid://shopify/Product/1")));
  const first = (await read())[0];

  await products.upsertProducts(storeId, [product({ title: "Old news", updatedAt: "2026-01-01T00:00:00Z" })]);
  expect((await read())[0].title).toBe("Tee");

  await products.upsertProducts(storeId, [product({ title: "New Tee", updatedAt: "2026-01-03T00:00:00Z" })]);
  const last = (await read())[0];
  expect(last.title).toBe("New Tee");
  expect(last.contentHash).not.toBe(first.contentHash);
});

test("sweepProducts deletes only older rows of its own store", async () => {
  const a = await newStore("sa.myshopify.com");
  const b = await newStore("sb.myshopify.com");
  await products.upsertProducts(a, [product({ id: "gid://shopify/Product/1" })]);
  await products.upsertProducts(b, [product({ id: "gid://shopify/Product/9" })]);
  await new Promise((r) => setTimeout(r, 20));
  const t = new Date();
  await products.upsertProducts(a, [product({ id: "gid://shopify/Product/2", updatedAt: "2026-01-02T00:00:00Z" })]);

  expect(await products.sweepProducts(a, t)).toBe(1);
  const left = await client.forStore(a, (tx) => tx.select().from(schema.products));
  expect(left.map((r) => r.shopifyId)).toEqual(["gid://shopify/Product/2"]);
  expect(await client.forStore(b, (tx) => tx.select().from(schema.products))).toHaveLength(1);

  await products.deleteProduct(a, "gid://shopify/Product/2");
  expect(await client.forStore(a, (tx) => tx.select().from(schema.products))).toHaveLength(0);
});

test("toShopifyProduct maps a PRODUCT_FIELDS node, null-safe on the image", () => {
  const node = {
    id: "gid://shopify/Product/5",
    handle: "h",
    title: "T",
    description: "D",
    productType: "P",
    vendor: "V",
    tags: ["x"],
    options: [{ name: "Size", values: ["S"] }],
    status: "ACTIVE",
    onlineStoreUrl: null,
    publishedAt: null,
    updatedAt: "2026-01-02T00:00:00Z",
    featuredMedia: { preview: { image: { url: "https://cdn/x.png" } } },
  };
  const m = [mf("custom", "k", "boolean", "true")];
  const p = products.toShopifyProduct(node, m);
  expect(p.imageUrl).toBe("https://cdn/x.png");
  expect(p.onlineStoreUrl).toBeNull();
  expect(p.publishedAt).toBeNull();
  expect(products.PRODUCT_FIELDS).toContain("publishedAt");
  expect(p.metafields).toBe(m);
  expect(products.toShopifyProduct({ ...node, featuredMedia: null }, []).imageUrl).toBeNull();
  expect(products.toShopifyProduct({ ...node, featuredMedia: { preview: null } }, []).imageUrl).toBeNull();
  expect(products.PRODUCT_FIELDS).toContain("featuredMedia");
});

test("buildContent adds the taxonomy category when present", () => {
  expect(products.buildContent(product({ category: "Apparel & Accessories > Clothing > Shirts & Tops" }))).toContain(
    "Category: Apparel & Accessories > Clothing > Shirts & Tops",
  );
  expect(products.buildContent(product({ category: null }))).not.toContain("Category:");
  expect(products.PRODUCT_FIELDS).toContain("category { fullName }");
  expect(products.toShopifyProduct({ ...product(), category: { fullName: "A > B" } }, []).category).toBe("A > B");
  expect(products.toShopifyProduct({ ...product(), category: null }, []).category).toBeNull();
});

test("buildContent flattens rich text, keeps legacy types and joins list values as plain text", () => {
  const rich = JSON.stringify({
    type: "root",
    children: [
      { type: "heading", level: 2, children: [{ type: "text", value: "Care" }] },
      { type: "paragraph", children: [{ type: "text", value: "Wash " }, { type: "text", value: "cold", bold: true }] },
      { type: "list", listType: "unordered", children: [{ type: "list-item", children: [{ type: "text", value: "No bleach" }] }] },
    ],
  });
  const out = products.buildContent(
    product({
      metafields: [
        mf("custom", "care", "rich_text_field", rich),
        mf("legacy", "s", "string", "old text"),
        mf("legacy", "i", "integer", "42"),
        mf("custom", "sizes", "list.single_line_text_field", '["S","M"]'),
        mf("custom", "counts", "list.number_integer", "[1,2]"),
        mf("custom", "ratios", "list.number_decimal", '["1.5","2.25"]'),
        mf("custom", "ref", "metaobject_reference", "gid://shopify/Metaobject/1"),
      ],
    }),
  );
  expect(out).toContain("custom.care: Care\nWash cold\nNo bleach");
  expect(out).not.toContain('"type"');
  expect(out).toContain("legacy.s: old text");
  expect(out).toContain("legacy.i: 42");
  expect(out).toContain("custom.sizes: S, M");
  expect(out).toContain("custom.counts: 1, 2");
  expect(out).toContain("custom.ratios: 1.5, 2.25");
  expect(out).not.toContain("Metaobject");
});

test("a measurement without value or unit is kept as written", () => {
  const out = products.buildContent(
    product({ metafields: [mf("m", "a", "weight", '{"value":2}'), mf("m", "b", "dimension", '{"unit":"CM"}')] }),
  );
  expect(out).toContain('m.a: {"value":2}');
  expect(out).toContain('m.b: {"unit":"CM"}');
  expect(out).not.toContain("undefined");
});

test("buildContent never cuts an emoji in half at the 500-character limit", () => {
  const out = products.buildContent(product({ metafields: [mf("custom", "e", "multi_line_text_field", "x" + "😀".repeat(300))] }));
  const value = out.split("custom.e: ")[1];
  expect(value).toBe("x" + "😀".repeat(249));
});

test("buildContent sorts collections, then keeps the first 20", () => {
  const cols = Array.from({ length: 25 }, (_, i) => `C${String(i).padStart(2, "0")}`);
  const out = products.buildContent(product({ collections: [...cols].reverse() }));
  expect(out).toContain(`Collections: ${cols.slice(0, 20).join(", ")}`);
  expect(out).not.toContain("C20");
});

test("a scheduled product (publishedAt in the future) is not published yet", async () => {
  const storeId = await newStore("sched.myshopify.com");
  await products.upsertProducts(storeId, [product({ publishedAt: new Date(Date.now() + 86_400_000).toISOString() })]);
  const [row] = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(row.published).toBe(false);
});

test("the built product link encodes the handle", async () => {
  const storeId = await newStore("enc.myshopify.com");
  await products.upsertProducts(storeId, [product({ onlineStoreUrl: null, handle: "tée bleue" })]);
  const [row] = await client.forStore(storeId, (tx) => tx.select().from(schema.products));
  expect(row.url).toBe("https://enc.myshopify.com/products/t%C3%A9e%20bleue");
});
