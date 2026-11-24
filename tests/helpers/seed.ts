import type postgres from "postgres";
import { randomUUID } from "node:crypto";

export async function newStore(admin: ReturnType<typeof postgres>, active = true) {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`
    insert into stores (account_id, shop_domain, active) values (${acc.id}, ${`s-${randomUUID()}.myshopify.com`}, ${active}) returning id`;
  return s.id as string;
}

export const gid = (id: string) => `gid://shopify/Product/${id}`;

/** A Shopify Admin API product node, active and published unless told otherwise. */
export const node = (
  id: string,
  o: { title?: string; description?: string; status?: string; onlineStoreUrl?: string | null; publishedAt?: string | null; updatedAt?: string } = {},
) => ({
  id: gid(id),
  handle: `h${id}`,
  title: o.title ?? `Tee ${id}`,
  description: o.description ?? `Soft cotton tee ${id}`,
  productType: "Shirt",
  vendor: "Acme",
  tags: [],
  options: [],
  status: o.status ?? "ACTIVE",
  onlineStoreUrl: o.onlineStoreUrl === undefined ? `https://shop.example.com/products/h${id}` : o.onlineStoreUrl,
  publishedAt: o.publishedAt === undefined ? "2026-01-01T00:00:00Z" : o.publishedAt,
  updatedAt: o.updatedAt ?? "2026-01-02T00:00:00Z",
  featuredMedia: null,
});

export async function upsert(storeId: string, ...nodes: ReturnType<typeof node>[]) {
  const products = await import("@/lib/products");
  return products.upsertProducts(storeId, nodes.map((n) => products.toShopifyProduct(n, [])));
}
