import { and, eq, inArray } from "drizzle-orm";
import { GraphqlQueryError, HttpThrottlingError } from "@shopify/shopify-api";
import { forStore } from "@/db/client";
import { products } from "@/db/schema";
import { adminGraphql } from "./admin";
import { ReconnectNeededError } from "./tokens";

/** C12: variants fetched per product. Products with more get "View options" (moreVariants). */
export const VARIANT_CAP = 50;
const TIMEOUT_MS = 3000;

export type Stock = { kind: "count"; n: number } | { kind: "in_stock" } | { kind: "sold_out" };
export type LiveVariant = {
  id: string; // numeric, as /cart/add.js needs (D30)
  title: string;
  options: { name: string; value: string }[];
  available: boolean;
  stock: Stock;
  price: string;
  compareAtPrice: string | null;
};
export type LiveProduct = {
  id: string; // GID
  title: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  available: boolean;
  action: "add" | "view_options" | "none";
  hasOnlyDefaultVariant: boolean;
  options: { name: string; values: string[] }[];
  variants: LiveVariant[];
  moreVariants: boolean;
};
export type LiveCheckResult =
  | { ok: true; products: Map<string, LiveProduct> }
  | { ok: false; reason: "throttled" | "reconnect" | "timeout" | "error" };

/** C11 (b): the card shown when liveCheck returns ok: false. Our own copy only: no price, stock or action. */
export type FallbackCard = { id: string; title: string; url: string; imageUrl: string | null };

// §7.6 / D44 / D77: one request per turn for every product. onlineStoreUrl is only fetched for logging (D71).
const query = (variantCap: number) => `query LiveProducts($ids: [ID!]!, $ctx: ContextualPublicationContext!, $withCtx: Boolean!) {
  nodes(ids: $ids) {
    ... on Product {
      id status publishedAt isGiftCard requiresSellingPlan tracksInventory hasOnlyDefaultVariant onlineStoreUrl
      featuredMedia { preview { image { url } } }
      options { name values }
      publishedInContext(context: $ctx) @include(if: $withCtx)
      variants(first: ${variantCap}) {
        pageInfo { hasNextPage }
        nodes {
          id title availableForSale inventoryQuantity inventoryPolicy inventoryItem { tracked }
          price compareAtPrice selectedOptions { name value }
        }
      }
    }
  }
}`;

type VariantNode = {
  id: string;
  title: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  inventoryItem: { tracked: boolean };
  price: string;
  compareAtPrice: string | null;
  selectedOptions: { name: string; value: string }[];
};
type ProductNode = {
  id: string;
  status: string;
  publishedAt: string | null;
  isGiftCard: boolean;
  requiresSellingPlan: boolean;
  hasOnlyDefaultVariant: boolean;
  onlineStoreUrl: string | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  options: { name: string; values: string[] }[];
  publishedInContext?: boolean;
  variants: { pageInfo: { hasNextPage: boolean }; nodes: VariantNode[] };
};
type Row = { id: string; title: string; url: string | null; imageUrl: string | null; status: string; published: boolean; isGiftCard: boolean };

/** D71: card links are https only. */
export function httpsUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Images are shown only from Shopify's CDN. */
export function cdnImage(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "cdn.shopify.com" ? u : null;
  } catch {
    return null;
  }
}

function readRows(storeId: string, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return forStore(storeId, (tx) =>
    tx
      .select({
        id: products.shopifyId,
        title: products.title,
        url: products.url,
        imageUrl: products.imageUrl,
        status: products.status,
        published: products.published,
        isGiftCard: products.isGiftCard,
      })
      .from(products)
      .where(and(eq(products.storeId, storeId), inArray(products.shopifyId, ids))),
  );
}

function stockOf(v: VariantNode): Stock {
  if (!v.availableForSale) return { kind: "sold_out" };
  // Still for sale at 0 or below (or unknown) means Shopify sells anyway; never show "only 0 left".
  if (v.inventoryItem.tracked && v.inventoryPolicy === "DENY" && (v.inventoryQuantity ?? 0) > 0) return { kind: "count", n: v.inventoryQuantity! };
  return { kind: "in_stock" };
}

export function isThrottled(e: unknown): boolean {
  if (e instanceof HttpThrottlingError) return true;
  if (!(e instanceof GraphqlQueryError)) return false;
  // shopify-api puts GraphQL errors (HTTP 200) under body.errors.graphQLErrors; accept a plain errors array too.
  const errs = e.body?.errors?.graphQLErrors ?? e.body?.errors;
  return Array.isArray(errs) && errs.some((x) => x?.extensions?.code === "THROTTLED");
}

/**
 * The live card check (§7.6): one Admin `nodes(ids:)` call for all of a turn's products. Returns only products this shopper
 * can see: ACTIVE, published (not in the future), in the shopper's market when a country is given (D77; skipped without one,
 * C16 a), not a gift card unless asked (D74), and in our table with an https link (D71). Sold-out products are kept (D72).
 * Never throws: a failure returns a reason and the turn falls back to fallbackCards (C11 b).
 * `currency` is the store's currency (stores.currency_code); Admin `price` is in the store's default currency.
 * `variantCap` (default VARIANT_CAP) lowers the variants requested per product, for checks of many products at once (Shopify
 * limits one query to 1,000 requested points; products with more variants then get moreVariants).
 * `// ponytail:` one call per turn with no cache; if many shoppers ask about the same products at once, add a 30–60 s
 * per-store cache keyed by product id.
 */
export async function liveCheck(
  storeId: string,
  shop: string,
  ids: string[],
  opts: { country?: string; includeGiftCards: boolean; currency: string; signal?: AbortSignal; variantCap?: number },
): Promise<LiveCheckResult> {
  if (opts.signal?.aborted) return { ok: false, reason: "timeout" };
  let rows: Map<string, Row>;
  try {
    rows = new Map((await readRows(storeId, [...new Set(ids)])).map((r) => [r.id, r]));
  } catch {
    return { ok: false, reason: "error" };
  }
  const known = [...rows.keys()];
  if (known.length === 0) return { ok: true, products: new Map() };

  // 3 s timeout combined with the request's signal. adminGraphql takes no signal, so the Shopify request itself isn't
  // cancelled: it finishes in the background and its result is dropped.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let data: { nodes: (ProductNode | null)[] };
  try {
    const call = adminGraphql<{ nodes: (ProductNode | null)[] }>(storeId, shop, query(opts.variantCap ?? VARIANT_CAP), {
      ids: known,
      ctx: opts.country ? { country: opts.country } : {},
      withCtx: !!opts.country,
    });
    call.catch(() => {}); // a late rejection after a timeout must not go unhandled
    const aborted = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true }));
    data = await Promise.race([call, aborted]);
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "timeout" };
    if (e instanceof ReconnectNeededError) return { ok: false, reason: "reconnect" };
    if (isThrottled(e)) return { ok: false, reason: "throttled" };
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const now = Date.now();
  const out = new Map<string, LiveProduct>();
  for (const n of data.nodes ?? []) {
    if (!n?.id) continue; // deleted product
    const row = rows.get(n.id);
    const url = httpsUrl(row?.url ?? null);
    if (!row || !url) continue;
    if (n.status !== "ACTIVE" || !n.publishedAt || Date.parse(n.publishedAt) > now) continue;
    if (opts.country && n.publishedInContext !== true) continue;
    if (n.isGiftCard && !opts.includeGiftCards) continue;
    const variants: LiveVariant[] = n.variants.nodes.map((v) => ({
      id: v.id.slice(v.id.lastIndexOf("/") + 1),
      title: v.title,
      options: v.selectedOptions,
      available: v.availableForSale,
      stock: stockOf(v),
      price: v.price,
      compareAtPrice: v.compareAtPrice,
    }));
    const available = variants.some((v) => v.available);
    out.set(n.id, {
      id: n.id,
      title: row.title,
      url,
      imageUrl: cdnImage(n.featuredMedia?.preview?.image?.url),
      currency: opts.currency,
      available,
      action: !available ? "none" : n.requiresSellingPlan ? "view_options" : "add",
      hasOnlyDefaultVariant: n.hasOnlyDefaultVariant,
      options: n.options,
      variants,
      moreVariants: n.variants.pageInfo.hasNextPage,
    });
  }
  return { ok: true, products: out };
}

function stockWord(s: Stock, threshold: number): string {
  if (s.kind === "sold_out") return "sold out";
  if (s.kind === "count" && s.n < threshold) return `only ${s.n} left`;
  return "in stock";
}

/** "€629.95" in the product's currency (locale "en"); a code Intl doesn't know falls back to "629.95 XYZ". null for an unparsable amount. */
function moneyText(amount: string, currency: string): string | null {
  if (!amount || !Number.isFinite(Number(amount))) return null;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * "€629.95": the variant's current price. No "was" price: announcing a reduction from the merchant's compare-at price is
 * the merchant's to do (EU price-indication rules), so the model never sees it. null when there is no usable price.
 */
function priceText(v: LiveVariant, currency: string): string | null {
  return moneyText(v.price, currency);
}

/** "€19.00–€29.00" (one amount when they match): the lowest to the highest variant price; null when none parses. */
function priceRange(p: LiveProduct): string | null {
  const nums = p.variants.map((v) => Number(v.price)).filter(Number.isFinite);
  const lo = nums.length ? moneyText(String(Math.min(...nums)), p.currency) : null;
  const hi = nums.length ? moneyText(String(Math.max(...nums)), p.currency) : null;
  return lo && hi ? (lo === hi ? lo : `${lo}–${hi}`) : null;
}

/**
 * The product's `LIVE:` line for the model (D93). C14 (a): stock as the card shows it, a count only below the threshold
 * (UD10, default 5), otherwise "in stock". The price comes first ("€629.95; in stock"). When variants differ
 * in price each carries its own ("S: €19.00, in stock; M: €29.00, in stock"); a sold-out product keeps its price (a range
 * when variants differ). C26: when the shopper's currency is known and differs from the product's, the price is left out
 * (the card shows it) and only stock remains; unknown means include.
 */
export function toPromptStock(p: LiveProduct, threshold: number, shopperCurrency?: string | null): string {
  const priced = !shopperCurrency || shopperCurrency === p.currency;
  const prices = p.variants.map((v) => (priced ? priceText(v, p.currency) : null));
  const uniform = prices.every((t) => t === prices[0]);
  if (!p.available) return [uniform ? prices[0] : priced ? priceRange(p) : null, "sold out"].filter(Boolean).join("; ");
  const stock =
    p.hasOnlyDefaultVariant || p.variants.length === 1
      ? stockWord(p.variants[0].stock, threshold)
      : p.variants.map((v, i) => `${v.title}: ${!uniform && prices[i] ? `${prices[i]}, ` : ""}${stockWord(v.stock, threshold)}`).join("; ");
  let line = [uniform ? prices[0] : null, stock].filter(Boolean).join("; ");
  if (p.moreVariants) line += "; more variants on the product page";
  if (p.action === "view_options") line += "; view options (subscription)";
  return line;
}

/**
 * C11 (b): cards from our own table when liveCheck fails. Title, link and image only; no price, stock or action, and the
 * model must say nothing about price or stock. Uses the synced status/published/gift-card flags since nothing live is known.
 */
export async function fallbackCards(storeId: string, ids: string[], opts: { includeGiftCards: boolean }): Promise<Map<string, FallbackCard>> {
  const rows = new Map((await readRows(storeId, [...new Set(ids)])).map((r) => [r.id, r]));
  const out = new Map<string, FallbackCard>();
  for (const id of ids) {
    const r = rows.get(id);
    const url = httpsUrl(r?.url ?? null);
    if (!r || !url || out.has(id) || r.status !== "ACTIVE" || !r.published || (r.isGiftCard && !opts.includeGiftCards)) continue;
    out.set(id, { id, title: r.title, url, imageUrl: cdnImage(r.imageUrl) });
  }
  return out;
}
