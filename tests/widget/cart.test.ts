// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/products/tee"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart } from "../../widget/src/cart";
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
});
