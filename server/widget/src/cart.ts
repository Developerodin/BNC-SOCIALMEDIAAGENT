// Add to cart (Task 31; D30, UD11, C21). A plain POST to the theme's locale-aware cart/add.js with the numeric variant id.
// C21: on a theme that configured Shopify's `updateCart` action itself (`isDefault()` is false), that action is used
// instead, so the theme's cart icon refreshes in place. Shopify's default handler is never called: on a theme it doesn't
// recognise it reloads the whole page mid-chat.
import { formatPrice } from "./core/format";
import type { CartSummary, PageContext } from "../../src/lib/widget-contract";

// Only the add url is needed, so the embed's bridge (embed.ts) can reuse this on a storefront without a full PageContext.
export type CartTarget = Pick<PageContext, "cartAddUrl">;
export type CartResult = { ok: true } | { ok: false; status: number; message: string | null };

type UpdateCart = ((input: { lines: { merchandiseId: string; quantity: number }[] }) => Promise<unknown>) & {
  isDefault?: () => boolean;
};

function themeUpdateCart(): UpdateCart | null {
  try {
    const fn = (window as { Shopify?: { actions?: { updateCart?: UpdateCart } } }).Shopify?.actions?.updateCart;
    return typeof fn === "function" && typeof fn.isDefault === "function" && fn.isDefault() === false ? fn : null;
  } catch {
    return null;
  }
}

/** The locale-aware cart path: the add url without "/add" (e.g. /fr/cart/add → /fr/cart). */
const cartPath = (page: CartTarget) => page.cartAddUrl.replace(/\/add$/, "");

/** True on the store's cart page. */
function onCartPage(page: CartTarget): boolean {
  return location.pathname.replace(/\/$/, "") === cartPath(page);
}

let inCart: Promise<CartState> | null = null;
let readAt = 0; // when `inCart` was requested (ms), so a message sent right after opening reuses that read

/** What the theme's cart.js says: quantity per variant id, and the total item count (the header badge). */
export type CartState = { quantities: Map<string, number>; itemCount: number; summary: CartSummary | null };

/** Fired on window after our own add and after a re-read, so cards and the header badge redraw. */
export const CART_CHANGED = "askcart:cart";

type CartJson = {
  items?: { variant_id?: unknown; quantity?: unknown; product_title?: unknown; variant_title?: unknown; final_line_price?: unknown; line_price?: unknown }[];
  item_count?: unknown;
  total_price?: unknown;
  currency?: unknown;
};

const MAX_SUMMARY_LINES = 20;
const MAX_SUMMARY_TITLE = 80;
const short = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_TITLE) : "");

/** cart.js prices are in minor units (cents): formatted as the shopper sees money, e.g. "₹1,399.90". */
function money(cents: unknown, currency: string): string {
  const n = Number(cents) / 100;
  return formatPrice(n, currency) ?? `${n.toFixed(2)} ${currency}`;
}

/** The compact cart the chat request carries (CartSummary), or null when there is nothing to say. */
function summaryOf(c: CartJson): CartSummary | null {
  const currency = typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency) ? c.currency : null;
  if (!currency || !Array.isArray(c.items) || !c.items.length || !Number.isFinite(Number(c.total_price))) return null;
  const items: CartSummary["items"] = [];
  for (const i of c.items.slice(0, MAX_SUMMARY_LINES)) {
    const title = short(i.product_title);
    const quantity = Number(i.quantity);
    const price = i.final_line_price ?? i.line_price;
    if (!title || !(quantity >= 1) || !Number.isFinite(Number(price))) continue;
    const variant = short(i.variant_title);
    items.push({ title, ...(variant && variant !== "Default Title" ? { variant } : {}), quantity: Math.floor(quantity), price: money(price, currency) });
  }
  return items.length ? { items, total: money(c.total_price, currency) } : null;
}

function readCart(page: CartTarget): Promise<CartState> {
  return Promise.resolve() // a fetch that throws synchronously is caught too
    .then(() => fetch(cartPath(page) + ".js", { headers: { Accept: "application/json" }, credentials: "same-origin" }))
    .then((r) => (r.ok ? r.json() : null))
    .then((c: CartJson | null) => {
      const quantities = new Map<string, number>();
      for (const i of c?.items ?? []) {
        const id = String(i.variant_id);
        quantities.set(id, (quantities.get(id) ?? 0) + (Number(i.quantity) || 0));
      }
      const itemCount = typeof c?.item_count === "number" ? c.item_count : [...quantities.values()].reduce((a, n) => a + n, 0);
      return { quantities, itemCount, summary: c ? summaryOf(c) : null };
    })
    .catch(() => ({ quantities: new Map<string, number>(), itemCount: 0, summary: null }));
}

/** A cart read this young is reused for a chat message instead of reading again (opening the chat reads it too). */
const FRESH_MS = 5000;

/**
 * The cart as it is right now, for a chat message: a cart.js read (the same one cartState uses), which also refreshes the
 * cached state. Null when it can't be read, is empty, or takes over 1.5 s: the message is never held up by the cart.
 * A read started in the last few seconds (the panel opening, our own add) is reused. Ceiling: a change made on the page
 * itself within those seconds is missed by this one message; our own adds always re-read.
 */
export function cartSummaryNow(page: CartTarget): Promise<CartSummary | null> {
  const read = inCart && Date.now() - readAt < FRESH_MS ? inCart : startRead(page);
  return Promise.race([read.then((s) => s.summary), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
}

function startRead(page: CartTarget): Promise<CartState> {
  readAt = Date.now();
  return (inCart = readCart(page));
}

/**
 * The shopper's cart, read from the theme's cart.js once per page and read again after our own adds and whenever the panel
 * opens. Empty when the cart can't be read. A change made outside the chat (the theme's own buttons) shows after the next
 * page load, which every add from the cart page already causes, or when the panel next opens (refreshCart).
 */
export function cartState(page: CartTarget): Promise<CartState> {
  return inCart ?? startRead(page);
}

/** The variant ids in the shopper's cart. */
export function cartVariantIds(page: CartTarget): Promise<Set<string>> {
  return cartState(page).then((s) => new Set(s.quantities.keys()));
}

/** Reads the cart again (the panel opened: the shopper may have changed it on the page) and tells the listeners. */
export function refreshCart(page: CartTarget): void {
  void startRead(page).then(() => window.dispatchEvent(new Event(CART_CHANGED)));
}

/** Tests only: forget the cached cart. */
export function resetCartCache() {
  inCart = null;
  readAt = 0;
}

async function viaAjax(page: CartTarget, variantId: string, quantity: number): Promise<CartResult> {
  let res: Response;
  try {
    res = await fetch(page.cartAddUrl + ".js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items: [{ id: Number(variantId), quantity }] }),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, message: null };
  }
  if (res.ok) return { ok: true };
  let message: string | null = null;
  if (res.status === 422) {
    // "Cart Error" with a description already in the store's language (sold out, quantity capped, unknown variant).
    try {
      const body = (await res.json()) as { description?: unknown };
      if (typeof body.description === "string" && body.description.trim()) message = body.description;
    } catch {}
  }
  return { ok: false, status: res.status, message };
}

/**
 * Adds one variant and, on success, fires `cart:updated` on window (UD11). Never throws. The caller logs the cart event.
 * A rejected `updateCart` means the action couldn't run at all (Shopify's docs: network failure, malformed payload, not
 * ready yet), so nothing was added and the plain add is tried. A `userErrors` answer means the cart refused it: no retry.
 */
export async function addToCart(page: CartTarget, variantId: string, quantity: number): Promise<CartResult> {
  if (!/^\d+$/.test(variantId)) return { ok: false, status: 0, message: null }; // D30: numeric ids only
  let result: CartResult | null = null;
  const updateCart = themeUpdateCart();
  if (updateCart) {
    try {
      const out = (await updateCart({ lines: [{ merchandiseId: `gid://shopify/ProductVariant/${variantId}`, quantity }] })) as
        | { userErrors?: { message?: unknown }[] }
        | undefined;
      const err = out?.userErrors?.[0];
      result = err ? { ok: false, status: 422, message: typeof err.message === "string" ? err.message : null } : { ok: true };
    } catch {
      result = null;
    }
  }
  const viaPlainAdd = result === null;
  result ??= await viaAjax(page, variantId, quantity);
  if (result.ok) {
    window.dispatchEvent(new CustomEvent("cart:updated", { detail: { variantId, quantity, source: "askcart" } }));
    // Read the cart again instead of adding to the cached state: a read that was already in flight may include this add,
    // and counting it twice showed "2 in your cart". refreshCart tells the cards and the badge when the read is back.
    refreshCart(page);
    // Themes don't redraw their cart page after a plain add.js, so the shopper on /cart would see a stale list. Reload it
    // (the panel reopens on the next page, UD13). A theme's own updateCart refreshes itself, so no reload then.
    // setTimeout: the caller's follow-ups (the keepalive cart-event log, the embed's reply) run first.
    if (viaPlainAdd && onCartPage(page)) setTimeout(() => location.reload(), 0);
  }
  return result;
}
