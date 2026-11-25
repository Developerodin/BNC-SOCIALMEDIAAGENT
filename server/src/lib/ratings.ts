// D95: a product's average rating and review count, read from the metafields review apps leave on products and stored
// normalized (0-5 scale) on the products row at sync time. Formats come from the apps' documentation, not from a live
// store: Shopify's standard reviews.rating / reviews.rating_count (also written by Judge.me), Judge.me's and Stamped's
// badge HTML, Yotpo's, Stamped's and Loox's plain numbers, Okendo's summaryData JSON.
// ponytail: only the metafields the sync reads (the first 50 of a product) are seen. Upgrade path: a metafields(namespace:)
// query for the review namespaces.

type Meta = { namespace: string; key: string; value: string };
export type Rating = { rating: number; count: number };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
};
const json = (v: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
/** The value of `name="..."` in an HTML snippet. */
const attr = (html: string, name: string) => num(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(html)?.[1]);

/** A 0-5 rating, or null when the value is not a usable rating. `max` is the scale the app used. */
const normalize = (value: number | null, max = 5): number | null => {
  if (value === null || !(max > 0) || value <= 0 || value > max) return null;
  return Math.round((value / max) * 5 * 100) / 100;
};
const countOf = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 0 ? n : null);

/** Normalized rating and count from a product's metafields, or null when no review app's data is there (or it is unusable). */
export function parseRating(metafields: Meta[]): Rating | null {
  const get = (ns: string, key: string) => metafields.find((m) => m.namespace === ns && m.key === key)?.value;
  const pair = (rating: number | null, count: number | null): Rating | null => (rating !== null && count !== null && count > 0 ? { rating, count } : null);

  const candidates: (() => Rating | null)[] = [
    () => {
      const v = get("reviews", "rating");
      if (v === undefined) return null;
      const o = json(v); // type rating: {"scale_min":"1.0","scale_max":"5.0","value":"4.5"}; older apps wrote a bare number
      return pair(o ? normalize(num(o.value), num(o.scale_max) ?? 5) : normalize(num(v)), countOf(num(get("reviews", "rating_count"))));
    },
    () => {
      const html = get("judgeme", "badge") ?? "";
      return pair(normalize(attr(html, "data-average-rating")), countOf(attr(html, "data-number-of-reviews")));
    },
    () => {
      const o = json(get("okendo", "summaryData") ?? "");
      return pair(normalize(num(o?.averageRating)), countOf(num(o?.reviewCount)));
    },
    () => pair(normalize(num(get("yotpo", "reviews_average"))), countOf(num(get("yotpo", "reviews_count")))),
    () => {
      const html = get("stamped", "badge") ?? "";
      return (
        pair(normalize(num(get("stamped", "reviews_average"))), countOf(num(get("stamped", "reviews_count")))) ??
        pair(normalize(attr(html, "data-rating")), countOf(attr(html, "data-count")))
      );
    },
    () => pair(normalize(num(get("loox", "avg_rating"))), countOf(num(get("loox", "num_reviews")))),
  ];
  for (const c of candidates) {
    const r = c();
    if (r) return r;
  }
  return null;
}
