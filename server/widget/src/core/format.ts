// Formatting and the widget's own URL and colour checks (Task 25; D36, §7.7). The server checks these too; the widget
// checks again so nothing unsafe reaches an href, a src or a style.
import type { Card } from "../../../src/lib/widget-contract";

type Stock = NonNullable<Card["stock"]>;
type T = (key: string, vars?: Record<string, string | number>) => string;

/** The price with the currency symbol first and a dot decimal ("€1,452.43"), whatever the page's locale, so the same
 * amount reads the same everywhere in the chat. Null when the amount or currency is unusable. */
export function formatPrice(amount: string | number, currency: string): string | null {
  const n = Number(amount);
  if (amount === "" || !Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return null;
  }
}

/** UD10: "Only N left" below the threshold, otherwise "In stock"; null when stock is unknown. */
export function stockLabel(stock: Stock | null, threshold: number, t: T): string | null {
  if (!stock) return null;
  if (stock.kind === "sold_out" || (stock.kind === "count" && stock.n <= 0)) return t("sold_out");
  if (stock.kind === "count" && stock.n < threshold) return t("only_left", { n: stock.n });
  return t("in_stock");
}

/** An https: URL with no credentials, normalized, or null. */
export function safeHttpsUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** A URL that may be relative to the page (Liquid gives paths like /cart or the privacy policy's url), resolved against
 * `base`, then held to safeHttpsUrl. */
export function resolveHttpsUrl(u: string | null, base: string = location.href): string | null {
  if (!u) return null;
  try {
    return safeHttpsUrl(new URL(u, base).href);
  } catch {
    return null;
  }
}

/** An https: image on cdn.shopify.com, or on the page's own store at /cdn/shop/ (Liquid's image_url gives
 * `//<store>/cdn/shop/...`, protocol-relative), resolved against the page; or null. */
export function safeImageUrl(u: unknown): string | null {
  const href = typeof u === "string" ? resolveHttpsUrl(u) : null;
  if (!href) return null;
  const { hostname, pathname } = new URL(href);
  return hostname === "cdn.shopify.com" || (hostname === location.hostname && pathname.startsWith("/cdn/shop/")) ? href : null;
}

/** The chat's logo: the merchant's avatar, else the store's Shopify brand logo (page.logo), else null (the initial). */
export function brandLogo(avatarUrl: unknown, logo: unknown): string | null {
  return safeImageUrl(avatarUrl) ?? safeImageUrl(logo);
}

/** A #rrggbb colour, or null, before it goes into a style. */
export function safeHex(c: unknown): string | null {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** WCAG contrast ratio (1 to 21) between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** UD17: black or white text, whichever has the higher WCAG contrast on the accent, so never below 4.5:1 (WCAG AA).
 * Expects #rrggbb (see safeHex). The launcher uses this one too (white on a tie). */
export function textOn(accentHex: string): "#000000" | "#ffffff" {
  return contrastRatio(accentHex, "#000000") > contrastRatio(accentHex, "#ffffff") ? "#000000" : "#ffffff";
}
