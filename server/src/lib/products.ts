import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, forStore, type Conn } from "@/db/client";
import { products, stores } from "@/db/schema";
import { splitsPair } from "@/lib/chunking";

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
  isGiftCard: boolean;
  imageUrl: string | null;
  updatedAt: string;
  metafields: { namespace: string; key: string; type: string; value: string }[];
  /** Titles of the collections the product is in. Adding a product to a collection fires no products/update
   * webhook, so these can be up to one resync (daily by default) out of date. */
  collections: string[];
  /** Full path in Shopify's Standard Product Taxonomy, e.g. "Apparel & Accessories > Clothing > Shirts & Tops". */
  category: string | null;
};

/** GraphQL selection for one product (Admin API 2026-10), without metafields. */
export const PRODUCT_FIELDS = `
  id handle title description productType vendor tags status onlineStoreUrl publishedAt updatedAt isGiftCard
  category { fullName }
  options { name values }
  featuredMedia { preview { image { url } } }
`;

/** Maps a node selected with PRODUCT_FIELDS (plus separately fetched metafields) to a ShopifyProduct. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toShopifyProduct(node: any, metafields: ShopifyProduct["metafields"], collections: string[] = []): ShopifyProduct {
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
    isGiftCard: node.isGiftCard ?? false,
    imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    updatedAt: node.updatedAt,
    metafields,
    collections,
    category: node.category?.fullName ?? null,
  };
}

const MAX_METAFIELDS = 50;
const MAX_COLLECTIONS = 20;
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
  "rich_text_field",
  // Legacy types, still found on older stores.
  "string",
  "integer",
  "list.single_line_text_field",
  "list.number_integer",
  "list.number_decimal",
  // Reference types (metaobject_reference and the like) hold only GIDs; resolving them needs a design pass.
]);

/** Deterministic text that gets embedded; the hash of it decides whether a product needs re-embedding. */
export function buildContent(p: ShopifyProduct): string {
  const meta = p.metafields
    .filter((m) => METAFIELD_TYPES.has(m.type) && !m.namespace.startsWith("app--") && !/price/i.test(`${m.namespace}.${m.key}`))
    .map((m) => ({ name: `${m.namespace}.${m.key}`, value: cut(readable(m), MAX_VALUE) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_METAFIELDS);
  const field = (name: string, value: string) => (value.trim() ? [`${name}: ${value}`] : []);
  return [
    `Title: ${p.title}`,
    ...field("Description", p.description),
    ...field("Type", p.productType),
    ...field("Vendor", p.vendor),
    ...field("Tags", [...p.tags].sort().join(", ")),
    ...field("Category", p.category ?? ""),
    // Sorted, then capped, so the bulk and single-product paths give the same content for the same product.
    ...field("Collections", [...p.collections].sort().slice(0, MAX_COLLECTIONS).join(", ")),
    // A product without variants has one option, Title: Default Title, which says nothing about it.
    ...p.options
      .filter((o) => !(o.values.length === 1 && o.values[0] === "Default Title"))
      .map((o) => `Option ${o.name}: ${o.values.join(", ")}`),
    ...meta.map((m) => `${m.name}: ${m.value}`),
  ].join("\n");
}

/** The first n UTF-16 units of s, one shorter when n would split a surrogate pair. */
function cut(s: string, n: number): string {
  return s.slice(0, splitsPair(s, n) ? n - 1 : n);
}

/**
 * Plain text for a metafield value. Measurements hold JSON like {"value":159.0,"unit":"CENTIMETERS"}, which search matches
 * better as "159 centimeters"; lists hold JSON arrays, written "S, M"; rich text holds a JSON tree, flattened to its text.
 * Anything that doesn't parse as expected is kept as written.
 */
function readable(m: { type: string; value: string }): string {
  try {
    if (m.type === "dimension" || m.type === "weight" || m.type === "volume") {
      const { value, unit } = JSON.parse(m.value);
      if (value == null || unit == null) return m.value;
      return `${value} ${String(unit).toLowerCase().replace(/_/g, " ")}`;
    }
    if (m.type.startsWith("list.")) {
      const values = JSON.parse(m.value);
      return Array.isArray(values) ? values.join(", ") : m.value;
    }
    if (m.type === "rich_text_field") return richText(JSON.parse(m.value));
  } catch {
    // not JSON: keep the raw value
  }
  return m.value;
}

type RichNode = { type?: string; value?: string; children?: RichNode[] };
/** Text nodes concatenate inside a paragraph, heading, list item or link; blocks are joined by newlines. */
function richText(n: RichNode): string {
  if (n.type === "text") return n.value ?? "";
  const inline = n.type === "paragraph" || n.type === "heading" || n.type === "list-item" || n.type === "link";
  return (n.children ?? []).map(richText).join(inline ? "" : "\n");
}

/** Last write wins by Shopify's updatedAt, so a late webhook can't overwrite newer bulk data. */
export async function upsertProducts(storeId: string, ps: ShopifyProduct[], conn?: Conn): Promise<void> {
  if (ps.length === 0) return;
  // D71: password-protected stores get no onlineStoreUrl, so build the link from the shop domain and handle.
  // The myshopify domain redirects to the store's primary domain.
  const [shop] = ps.some((p) => !p.onlineStoreUrl)
    ? await (conn ?? db).select({ domain: stores.shopDomain }).from(stores).where(eq(stores.id, storeId))
    : [];
  const rows = ps.map((p) => {
    const content = buildContent(p);
    return {
      storeId,
      shopifyId: p.id,
      handle: p.handle,
      title: p.title,
      url: p.onlineStoreUrl ?? (shop ? `https://${shop.domain}/products/${encodeURIComponent(p.handle)}` : null),
      imageUrl: p.imageUrl,
      status: p.status,
      // onlineStoreUrl is null on password-protected stores (every dev store, and live stores before launch).
      // A scheduled product (publishedAt in the future) is not published yet.
      // ponytail: nothing fires when the scheduled time passes, so it flips to true only at the next products/update
      // webhook or resync (daily by default).
      published: p.publishedAt != null && new Date(p.publishedAt).getTime() <= Date.now(),
      isGiftCard: p.isGiftCard,
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
            isGiftCard: sql`excluded.is_gift_card`,
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
