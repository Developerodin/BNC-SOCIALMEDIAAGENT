import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { forStore, type Conn } from "@/db/client";
import { products } from "@/db/schema";

export type ShopifyProduct = {
  id: string;
  handle: string;
  title: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  options: { name: string; values: string[] }[];
  status: string;
  onlineStoreUrl: string | null;
  /** Set when published to the Online Store. Unlike onlineStoreUrl, it is not null on password-protected stores. */
  publishedAt: string | null;
  imageUrl: string | null;
  updatedAt: string;
  metafields: { namespace: string; key: string; type: string; value: string }[];
};

/** GraphQL selection for one product (Admin API 2026-10), without metafields. */
export const PRODUCT_FIELDS = `
  id handle title description productType vendor tags status onlineStoreUrl publishedAt updatedAt
  options { name values }
  featuredMedia { preview { image { url } } }
`;

/** Maps a node selected with PRODUCT_FIELDS (plus separately fetched metafields) to a ShopifyProduct. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toShopifyProduct(node: any, metafields: ShopifyProduct["metafields"]): ShopifyProduct {
  return {
    id: node.id,
    handle: node.handle,
    title: node.title,
    description: node.description,
    productType: node.productType,
    vendor: node.vendor,
    tags: node.tags,
    options: node.options,
    status: node.status,
    onlineStoreUrl: node.onlineStoreUrl ?? null,
    publishedAt: node.publishedAt ?? null,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    updatedAt: node.updatedAt,
    metafields,
  };
}

const MAX_METAFIELDS = 50;
const MAX_VALUE = 500;
const METAFIELD_TYPES = new Set([
  "single_line_text_field",
  "multi_line_text_field",
  "number_integer",
  "number_decimal",
  "boolean",
  "dimension",
  "weight",
  "volume",
  "list.single_line_text_field",
]);

/** Deterministic text that gets embedded; the hash of it decides whether a product needs re-embedding. */
export function buildContent(p: ShopifyProduct): string {
  const meta = p.metafields
    .filter((m) => METAFIELD_TYPES.has(m.type) && !m.namespace.startsWith("app--") && !/price/i.test(`${m.namespace}.${m.key}`))
    .map((m) => ({ name: `${m.namespace}.${m.key}`, value: m.value.slice(0, MAX_VALUE) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_METAFIELDS);
  return [
    `Title: ${p.title}`,
    `Description: ${p.description}`,
    `Type: ${p.productType}`,
    `Vendor: ${p.vendor}`,
    `Tags: ${[...p.tags].sort().join(", ")}`,
    ...p.options.map((o) => `Option ${o.name}: ${o.values.join(", ")}`),
    ...meta.map((m) => `${m.name}: ${m.value}`),
  ].join("\n");
}

/** Last write wins by Shopify's updatedAt, so a late webhook can't overwrite newer bulk data. */
export async function upsertProducts(storeId: string, ps: ShopifyProduct[], conn?: Conn): Promise<void> {
  if (ps.length === 0) return;
  const rows = ps.map((p) => {
    const content = buildContent(p);
    return {
      storeId,
      shopifyId: p.id,
      handle: p.handle,
      title: p.title,
      url: p.onlineStoreUrl,
      imageUrl: p.imageUrl,
      status: p.status,
      // onlineStoreUrl is null on password-protected stores (every dev store, and live stores before launch).
      published: p.publishedAt != null,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      shopifyUpdatedAt: new Date(p.updatedAt),
    };
  });
  await forStore(
    storeId,
    (tx) =>
      tx
        .insert(products)
        .values(rows)
        .onConflictDoUpdate({
          target: [products.storeId, products.shopifyId],
          set: {
            handle: sql`excluded.handle`,
            title: sql`excluded.title`,
            url: sql`excluded.url`,
            imageUrl: sql`excluded.image_url`,
            status: sql`excluded.status`,
            published: sql`excluded.published`,
            content: sql`excluded.content`,
            contentHash: sql`excluded.content_hash`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            syncedAt: sql`now()`,
          },
          setWhere: sql`excluded.shopify_updated_at >= ${products.shopifyUpdatedAt}`,
        }),
    conn,
  );
}

export async function deleteProduct(storeId: string, shopifyId: string): Promise<void> {
  await forStore(storeId, (tx) => tx.delete(products).where(eq(products.shopifyId, shopifyId)));
}

/** Deletes rows the last full sync didn't touch; returns how many. */
export async function sweepProducts(storeId: string, before: Date): Promise<number> {
  const gone = await forStore(storeId, (tx) =>
    tx.delete(products).where(and(eq(products.storeId, storeId), lt(products.syncedAt, before))).returning({ id: products.shopifyId }),
  );
  return gone.length;
}
