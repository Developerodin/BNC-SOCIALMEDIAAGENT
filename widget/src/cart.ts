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
  result ??= await viaAjax(page, variantId, quantity);
  if (result.ok) {
    window.dispatchEvent(new CustomEvent("cart:updated", { detail: { variantId, quantity, source: "askcart" } }));
  }
  return result;
}
