import { cdnImage, httpsUrl, VARIANT_CAP, type LiveProduct, type LiveVariant } from "./live-products";

// MCP-only mode: one UCP catalog product (search_catalog / lookup_catalog payload) becomes the LiveProduct the card,
// budget and prompt code already understand. Pure: no I/O. Shaped from the tools/list outputSchema; every field is
// untrusted, so anything unexpected drops the variant or the product rather than reaching a card.
// What UCP does not give us, and so never appears: stock counts (Stock is in_stock or sold_out only).

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

const decimals = new Map<string, number>();
/** The currency's own fraction digits (JPY 0, USD 2, KWD 3), or null for a code Intl doesn't know. */
function fractionDigits(currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let d = decimals.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      return null;
    }
    decimals.set(currency, d);
  }
  return d;
}

/** A UCP money object ({amount: integer in minor units, currency}) as a decimal string like Admin's price ("19.99", "1000"), or null. */
export function moneyOf(m: unknown): { amount: number; currency: string; text: string } | null {
  const o = obj(m);
  if (!o || typeof o.amount !== "number" || !Number.isSafeInteger(o.amount) || o.amount < 0 || typeof o.currency !== "string") return null;
  const d = fractionDigits(o.currency);
  if (d === null) return null;
  const s = String(o.amount).padStart(d + 1, "0"); // integer math on the digits: no floating point in a price
  return { amount: o.amount, currency: o.currency, text: d === 0 ? s : `${s.slice(0, -d)}.${s.slice(-d)}` };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Only an `image` medium on Shopify's CDN; the product's first, else its first variant's. */
function imageOf(p: Obj, variants: Obj[]): string | null {
  for (const m of [...objs(p.media), ...variants.flatMap((v) => objs(v.media))]) {
    if (m.type === "image" && typeof m.url === "string") {
      const u = cdnImage(m.url);
      if (u) return u;
    }
  }
  return null;
}

/**
 * The card link: the payload's url when it is https on one of the store's hosts or *.myshopify.com (the payload is
 * untrusted, and a card must not send a shopper elsewhere); else https://{shop}/products/{handle} when the handle is
 * plain; else null (the product is dropped, a card without a link is not possible). Without `shop`, any https url.
 */
function productUrl(p: Obj, shop?: { domain: string; hosts: string[] }): string | null {
  const url = httpsUrl(typeof p.url === "string" ? p.url : null);
  if (!shop) return url;
  if (url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".myshopify.com") || shop.hosts.includes(host)) return url;
  }
  return typeof p.handle === "string" && /^[a-z0-9][a-z0-9_-]{0,254}$/i.test(p.handle) ? `https://${shop.domain}/products/${p.handle}` : null;
}

/**
 * LiveProduct for one UCP product, or null when it must not be shown: not a product GID, no title, no https url, a gift
 * card (unless includeGiftCards, D74), or no variant with a valid GID and price.
 * Variants with a bad GID or price are dropped one by one; a card without a numeric variant id could never add to cart.
 * A variant that needs a selling plan makes the product action 'view_options' (a subscription can't be added blindly).
 */
export function toLiveProduct(
  raw: unknown,
  opts: {
    includeGiftCards: boolean;
    /** The store's currency: a product priced in another one is refused, so a budget never compares GBP with USD. */
    currency?: string;
    /** The store's hosts: a product url must be on one of them (or *.myshopify.com); otherwise it is rebuilt from the handle. */
    shop?: { domain: string; hosts: string[] };
  },
): LiveProduct | null {
  const p = obj(raw);
  if (!p || typeof p.id !== "string" || !PRODUCT_GID.test(p.id)) return null;
  const title = text(p.title, 300).trim();
  const url = productUrl(p, opts.shop);
  if (!title || !url) return null;
  if (p.gift_card === true && !opts.includeGiftCards) return null;

  const all = objs(p.variants);
  const variants: LiveVariant[] = [];
  let currency: string | null = null;
  let sellingPlan = false;
  for (const v of all) {
    const id = typeof v.id === "string" ? VARIANT_GID.exec(v.id)?.[1] : undefined;
    const price = moneyOf(v.price);
    if (!id || !price || variants.length >= VARIANT_CAP) continue;
    currency ??= price.currency;
    if (price.currency !== currency) continue; // one currency per card
    const list = moneyOf(v.list_price);
    const available = obj(v.availability)?.available === true;
    if (obj(v.requires)?.selling_plan === true) sellingPlan = true;
    variants.push({
      id,
      title: text(v.title, 200),
      options: objs(v.options).map((o) => ({ name: text(o.name, 100), value: text(o.label, 100) })),
      available,
      stock: { kind: available ? "in_stock" : "sold_out" },
      price: price.text,
      compareAtPrice: list && list.currency === currency && list.amount > price.amount ? list.text : null,
    });
  }
  if (!variants.length || !currency || (opts.currency && currency !== opts.currency)) return null;

  const available = variants.some((v) => v.available);
  const options = objs(p.options).map((o) => ({
    name: text(o.name, 100),
    values: objs(o.values).map((x) => text(x.label, 100)),
  }));
  return {
    id: p.id,
    title,
    url,
    imageUrl: imageOf(p, all),
    currency,
    available,
    action: !available ? "none" : sellingPlan ? "view_options" : "add",
    hasOnlyDefaultVariant: variants.length === 1 && (options.length === 0 || (options.length === 1 && options[0].name === "Title" && options[0].values.join() === "Default Title")),
    options,
    variants,
    moreVariants: all.length > VARIANT_CAP,
  };
}
