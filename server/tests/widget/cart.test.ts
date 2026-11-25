// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/products/tee"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, CART_CHANGED, cartState, cartVariantIds, refreshCart, resetCartCache } from "../../widget/src/cart";
import type { PageContext } from "@/lib/widget-contract";
import { jsonResponse } from "./core/helpers";

const page: PageContext = {
  shop: "demo.myshopify.com", locale: "en", country: "US", currency: "USD", productId: null,
  cartAddUrl: "/fr/cart/add", cartUrl: "/fr/cart", privacyUrl: null, designMode: false,
};
const fetchMock = vi.fn<typeof fetch>();
type W = { Shopify?: unknown };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetCartCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as W).Shopify;
});

describe("addToCart", () => {
  it("posts the numeric variant id to the locale-aware cart/add.js, same-origin", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
    const res = await addToCart(page, "123", 1);
    expect(res).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/fr/cart/add.js");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ items: [{ id: 123, quantity: 1 }] });
  });

  it("fires cart:updated on success (UD11)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("cart:updated", on);
    await addToCart(page, "123", 2);
    window.removeEventListener("cart:updated", on);
    expect(seen).toEqual([{ variantId: "123", quantity: 2, source: "askcart" }]);
  });

  it("returns the store's 422 description as is, and fires no event", async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { status: 422, message: "Cart Error", description: "Le produit est épuisé." }));
    const on = vi.fn();
    window.addEventListener("cart:updated", on);
    const res = await addToCart(page, "123", 1);
    window.removeEventListener("cart:updated", on);
    expect(res).toEqual({ ok: false, status: 422, message: "Le produit est épuisé." });
    expect(on).not.toHaveBeenCalled();
  });

  it("reports 429 and network failures without a message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    expect(await addToCart(page, "123", 1)).toEqual({ ok: false, status: 429, message: null });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await addToCart(page, "123", 1)).toEqual({ ok: false, status: 0, message: null });
  });

  it("refuses a non-numeric variant id without a request", async () => {
    expect(await addToCart(page, "gid://shopify/ProductVariant/1", 1)).toEqual({ ok: false, status: 0, message: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("C21: Shopify.actions.updateCart", () => {
    function shopify(isDefault: boolean, impl: (...a: unknown[]) => Promise<unknown>) {
      const updateCart = Object.assign(vi.fn(impl), { isDefault: () => isDefault });
      (window as W).Shopify = { actions: { updateCart } };
      return updateCart;
    }

    it("is used instead of cart/add.js when the theme configured it", async () => {
      const updateCart = shopify(false, async () => ({ cart: {} }));
      expect(await addToCart(page, "123", 1)).toEqual({ ok: true });
      expect(updateCart).toHaveBeenCalledWith({ lines: [{ merchandiseId: "gid://shopify/ProductVariant/123", quantity: 1 }] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is never used while it's Shopify's default (it may reload the page)", async () => {
      const updateCart = shopify(true, async () => ({ cart: {} }));
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      await addToCart(page, "123", 1);
      expect(updateCart).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns the first userError as the message, with no fallback add", async () => {
      shopify(false, async () => ({ userErrors: [{ message: "Sold out" }] }));
      expect(await addToCart(page, "123", 1)).toEqual({ ok: false, status: 422, message: "Sold out" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("falls back to cart/add.js when the action couldn't run at all", async () => {
      shopify(false, async () => {
        throw new TypeError("not ready");
      });
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      expect(await addToCart(page, "123", 1)).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("reload on the cart page (themes don't redraw /cart after add.js)", () => {
    let reload: ReturnType<typeof vi.fn<() => void>>;
    beforeEach(() => {
      vi.useFakeTimers();
      reload = vi.fn<() => void>();
      vi.spyOn(window.location, "reload").mockImplementation(reload);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      history.replaceState(null, "", "/products/tee");
    });

    it("reloads after a successful add on the locale-aware cart page", async () => {
      history.replaceState(null, "", "/fr/cart");
      fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
      await addToCart(page, "123", 1);
      expect(reload).not.toHaveBeenCalled(); // the caller's follow-ups run first
      vi.runAllTimers();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("doesn't reload on other pages, or after a failed add", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));
      await addToCart(page, "123", 1); // on /products/tee
      history.replaceState(null, "", "/fr/cart/");
      fetchMock.mockResolvedValue(jsonResponse(422, { description: "Sold out" }));
      await addToCart(page, "123", 1);
      vi.runAllTimers();
      expect(reload).not.toHaveBeenCalled();
    });

    it("doesn't reload when the theme's own updateCart did the add", async () => {
      history.replaceState(null, "", "/fr/cart");
      const updateCart = Object.assign(vi.fn(async () => ({ cart: {} })), { isDefault: () => false });
      (window as W).Shopify = { actions: { updateCart } };
      await addToCart(page, "123", 1);
      vi.runAllTimers();
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe("cartVariantIds", () => {
  it("reads the locale-aware cart.js once, and our successful adds join the set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1 }, { variant_id: 2 }] }));
    expect([...(await cartVariantIds(page))]).toEqual(["1", "2"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/fr/cart.js");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] })); // the add
    await addToCart(page, "7", 1);
    expect([...(await cartVariantIds(page))]).toEqual(["1", "2", "7"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cartState exposes quantities per variant and the cart's item_count; adds update both and announce the change", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1, quantity: 2 }, { variant_id: 2, quantity: 1 }], item_count: 3 }));
    const s = await cartState(page);
    expect([...s.quantities]).toEqual([["1", 2], ["2", 1]]);
    expect(s.itemCount).toBe(3);
    const changed = vi.fn();
    window.addEventListener(CART_CHANGED, changed);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] })); // an add
    await addToCart(page, "1", 2);
    fetchMock.mockResolvedValueOnce(jsonResponse(422, {})); // a refused add
    await addToCart(page, "1", 5);
    window.removeEventListener(CART_CHANGED, changed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(s.quantities.get("1")).toBe(4);
    expect(s.itemCount).toBe(5);
  });

  it("refreshCart re-reads cart.js and announces it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], item_count: 0 }));
    expect((await cartState(page)).itemCount).toBe(0);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 9, quantity: 4 }], item_count: 4 }));
    const changed = new Promise((r) => window.addEventListener(CART_CHANGED, r, { once: true }));
    refreshCart(page);
    await changed;
    expect((await cartState(page)).itemCount).toBe(4);
  });

  it("an unreadable cart is an empty set, never an error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect((await cartVariantIds(page)).size).toBe(0);
  });
});
