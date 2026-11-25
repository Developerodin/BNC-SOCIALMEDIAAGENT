import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { db, forStore } from "@/db/client";
import { productSales, products, stores } from "@/db/schema";
import { numberProducts } from "./number-products";
import { productBlock, sanitizeData } from "./prompt";
import type { ToolContext } from "./tools";

// D95: trending_products (the store's own sales of the last 30 days, product_sales, rebuilt daily by sales.ts) and
// top_rated_products (review-app ratings stored on the products rows at sync time, ratings.ts). Both list products live-checked
// and numbered like search_products, so [[product:<n>]] cards work. Neither gives sales numbers, and only the rating tool
// states a rating and its review count (both are the store's own review data).

const CANDIDATES = 12; // read from the table: the live check drops some (unpublished, gone, gift cards)
const SHOWN = 5;
export const MIN_REVIEWS = 3;
const MAX_RESULT_CHARS = 3900;

const NO_SALES_YET = "No sales ranking is available for this store yet. Do not say any product is a best seller or trending; offer to help the shopper find a product another way.";
const NONE_SOLD = "The store had no sales in the last 30 days, so there is no ranking. Do not say any product is a best seller or trending.";
const NO_RATINGS = "No product in this store has review ratings. Do not say any product is top rated or well reviewed; offer to help the shopper find a product another way.";
const FEW_REVIEWS = `No product has at least ${MIN_REVIEWS} reviews yet, so there is no ranking. Do not say any product is top rated.`;
const NONE_SHOWABLE = "None of these products can be shown right now.";
const UNAVAILABLE = "Product search is unavailable right now.";

/** Blocks for the products that survived numbering, whole ones only, within the result size. */
async function listed(ids: string[], ctx: ToolContext, head: string, extra: (id: string) => string = () => ""): Promise<string> {
  const numberOf = await numberProducts(ids, ctx);
  if (!numberOf) return UNAVAILABLE;
  const blocks = ids
    .filter((id) => numberOf.has(id))
    .slice(0, SHOWN)
    .map((id) => productBlock({ n: numberOf.get(id)!, id, texts: [], live: ctx.live, threshold: ctx.threshold, shopperCurrency: ctx.shopperCurrency }) + extra(id));
  if (!blocks.length) return NONE_SHOWABLE;
  let out = head;
  for (const b of blocks) {
    if (out.length + b.length + 2 > MAX_RESULT_CHARS) break;
    out += `\n\n${b}`;
  }
  return out;
}

/** trending_products: the store's best-selling products of the last 30 days, best first, from the daily snapshot. */
export async function trendingProducts(ctx: ToolContext): Promise<string> {
  const [s] = await db.select({ at: stores.salesSnapshotAt }).from(stores).where(eq(stores.id, ctx.store.id));
  if (!s?.at) return NO_SALES_YET;
  const rows = await forStore(ctx.store.id, (tx) =>
    tx
      .select({ id: productSales.productId })
      .from(productSales)
      .where(eq(productSales.storeId, ctx.store.id))
      .orderBy(desc(productSales.units), desc(productSales.orderCount), productSales.productId)
      .limit(CANDIDATES),
  );
  if (!rows.length) return NONE_SOLD;
  return listed(rows.map((r) => r.id), ctx, "The store's best-selling products of the last 30 days, best first. Say what the order is based on (sales); do not give sales numbers.");
}

/** top_rated_products: the products with the highest average rating among those with at least MIN_REVIEWS reviews. */
export async function topRatedProducts(ctx: ToolContext): Promise<string> {
  const base = [eq(products.storeId, ctx.store.id), eq(products.status, "ACTIVE"), eq(products.published, true), eq(products.isGiftCard, false), isNotNull(products.rating)];
  const rows = await forStore(ctx.store.id, (tx) =>
    tx
      .select({ id: products.shopifyId, rating: products.rating, count: products.ratingCount })
      .from(products)
      .where(and(...base, gte(products.ratingCount, MIN_REVIEWS)))
      .orderBy(desc(products.rating), desc(products.ratingCount), products.shopifyId)
      .limit(CANDIDATES),
  );
  if (!rows.length) {
    const [any] = await forStore(ctx.store.id, (tx) => tx.select({ id: products.shopifyId }).from(products).where(and(...base)).limit(1));
    return any ? FEW_REVIEWS : NO_RATINGS;
  }
  const by = new Map(rows.map((r) => [r.id, r]));
  const rating = (id: string) => {
    const r = by.get(id)!;
    return sanitizeData(`\nRATING: ${Number(r.rating).toFixed(1)}/5 from ${r.count} reviews`);
  };
  return listed(rows.map((r) => r.id), ctx, `The store's best-rated products (average review rating, at least ${MIN_REVIEWS} reviews), best first.`, rating);
}
