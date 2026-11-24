import type { SearchHit } from "@/lib/retrieval";
import type { LiveProduct } from "@/lib/shopify/live-products";
import type { PromptProducts } from "./prompt";

/** D87: the shopper's budget in the store currency's major units. At least one bound is set. */
export type Budget = { min?: number; max?: number };
export type PriceSort = "cheapest" | "priciest";

/**
 * The price a budget is compared with: the lowest price among the product's available variants, or the lowest price of
 * all its variants when none is available (a sold-out product still has a price, and the model may suggest alternatives).
 * null when the product has no variants or no parsable price.
 */
export function productPrice(p: LiveProduct): number | null {
  const available = p.variants.filter((v) => v.available);
  const prices = (available.length ? available : p.variants).map((v) => Number(v.price)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}

function inBudget(price: number | null, b: Budget): boolean {
  if (price === null) return false; // no price known: it can't be shown to fit the budget
  return (b.min === undefined || price >= b.min) && (b.max === undefined || price <= b.max);
}

/** "₹500–₹1,000", "at most ₹1,000", "at least ₹500". Unknown currency codes fall back to "1000 XYZ". */
function formatBudget(b: Budget, currency: string): string {
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n} ${currency}`;
    }
  };
  if (b.min !== undefined && b.max !== undefined) return `${fmt(b.min)}–${fmt(b.max)}`;
  if (b.max !== undefined) return `at most ${fmt(b.max)}`;
  return `at least ${fmt(b.min!)}`;
}

/**
 * D87, after the live check: drops products whose price (productPrice) is outside the budget and, for a "cheapest" or
 * "priciest" question, reorders the hits by price, since buildInput numbers products in hit order. Returns a `note` for
 * the model when the budget left nothing, when products are sorted, or when prices couldn't be checked (C11 fallback:
 * nothing is filtered or sorted then).
 * `// ponytail:` only the search hits are filtered (runTurn searches 30 for these questions, not 8), so "cheapest" means
 * the cheapest of what search found, not of the whole catalog, and a budget can empty a list the catalog could fill. Prices are kept out of the index (D87); a price
 * filter in search would need the live price there.
 * `// ponytail:` the current product, when it isn't a hit, stays last (buildInput) rather than sorted in with the hits.
 */
export function applyBudget(opts: {
  hits: SearchHit[];
  live: PromptProducts;
  budget: Budget | null;
  sort: PriceSort | null;
  currency: string | null;
}): { hits: SearchHit[]; live: PromptProducts; note?: string } {
  const { hits, live, budget, sort } = opts;
  if (!budget && !sort) return { hits, live };
  if (!live.ok) return { hits, live, note: "Prices could not be checked, so the shopper's budget or price order was not applied." };

  let products = live.products;
  const notes: string[] = [];
  if (budget) {
    products = new Map([...products].filter(([, p]) => inBudget(productPrice(p), budget)));
    if (products.size === 0 && live.products.size > 0) {
      notes.push(`No products are within the shopper's budget of ${formatBudget(budget, opts.currency ?? "")}.`);
    }
  }

  let ordered = hits;
  if (sort && products.size > 0) {
    const key = (h: SearchHit) => {
      const p = products.get(h.productId);
      const price = p ? productPrice(p) : null;
      if (price === null) return Infinity; // unpriced or dropped: last either way
      return sort === "cheapest" ? price : -price;
    };
    // Stable, so equal prices keep search order. Compared, not subtracted: Infinity - Infinity is NaN.
    ordered = [...hits].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return x === y ? 0 : x < y ? -1 : 1;
    });
    notes.push(`Products are listed from the ${sort === "cheapest" ? "cheapest to the most expensive" : "most expensive to the cheapest"}.`);
  }

  return { hits: ordered, live: { ok: true, products }, ...(notes.length ? { note: notes.join(" ") } : {}) };
}
