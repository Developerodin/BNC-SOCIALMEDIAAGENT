// Add to cart (Task 31; D30, UD11, C21). A plain POST to the theme's locale-aware cart/add.js with the numeric variant id.
// C21: on a theme that configured Shopify's `updateCart` action itself (`isDefault()` is false), that action is used
// instead, so the theme's cart icon refreshes in place. Shopify's default handler is never called: on a theme it doesn't
// recognise it reloads the whole page mid-chat.
import type { PageContext } from "../../src/lib/widget-contract";

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

let inCart: Promise<Set<string>> | null = null;

/**
 * The variant ids in the shopper's cart, read from the theme's cart.js once per page and kept up to date by our own adds.
 * Empty when the cart can't be read. A change made outside the chat (the theme's own buttons) shows after the next page
 * load, which every add from the cart page already causes.
 */
export function cartVariantIds(page: CartTarget): Promise<Set<string>> {
  inCart ??= Promise.resolve() // a fetch that throws synchronously is caught too
    .then(() => fetch(cartPath(page) + ".js", { headers: { Accept: "application/json" }, credentials: "same-origin" }))
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { items?: { variant_id?: unknown }[] } | null) => new Set((c?.items ?? []).map((i) => String(i.variant_id))))
    .catch(() => new Set<string>());
  return inCart;
}

/** Tests only: forget the cached cart. */
export function resetCartCache() {
  inCart = null;
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
    if (inCart) void inCart.then((ids) => ids.add(variantId));
    // Themes don't redraw their cart page after a plain add.js, so the shopper on /cart would see a stale list. Reload it
    // (the panel reopens on the next page, UD13). A theme's own updateCart refreshes itself, so no reload then.
    // setTimeout: the caller's follow-ups (the keepalive cart-event log, the embed's reply) run first.
    if (viaPlainAdd && onCartPage(page)) setTimeout(() => location.reload(), 0);
  }
  return result;
}
