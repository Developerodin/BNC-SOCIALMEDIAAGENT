// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/products/tee"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, CART_CHANGED, cartState, cartSummaryNow, cartVariantIds, refreshCart, resetCartCache } from "../../widget/src/cart";
import type { PageContext } from "@/lib/widget-contract";
import { jsonResponse } from "./core/helpers";

const page: PageContext = {
  shop: "demo.myshopify.com", locale: "en", country: "US", currency: "USD", productId: null,
  cartAddUrl: "/fr/cart/add", cartUrl: "/fr/cart", privacyUrl: null, designMode: false,
};
const fetchMock = vi.fn<typeof fetch>();
type W = { Shopify?: unknown };
const addCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/add"));

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
      expect(addCalls()).toHaveLength(0); // only the cart re-read goes out
    });

    it("is never used while it's Shopify's default (it may reload the page)", async () => {
      const updateCart = shopify(true, async () => ({ cart: {} }));
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      await addToCart(page, "123", 1);
      expect(updateCart).not.toHaveBeenCalled();
      expect(addCalls()).toHaveLength(1);
    });

    it("returns the first userError as the message, with no fallback add", async () => {
      shopify(false, async () => ({ userErrors: [{ message: "Sold out" }] }));
      expect(await addToCart(page, "123", 1)).toEqual({ ok: false, status: 422, message: "Sold out" });
      expect(fetchMock).not.toHaveBeenCalled(); // a refused add re-reads nothing
    });

    it("falls back to cart/add.js when the action couldn't run at all", async () => {
      shopify(false, async () => {
        throw new TypeError("not ready");
      });
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      expect(await addToCart(page, "123", 1)).toEqual({ ok: true });
      expect(addCalls()).toHaveLength(1);
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
  it("reads the locale-aware cart.js once, and the cart is read again after our successful adds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1 }, { variant_id: 2 }] }));
    expect([...(await cartVariantIds(page))]).toEqual(["1", "2"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/fr/cart.js");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] })); // the add
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1 }, { variant_id: 2 }, { variant_id: 7 }] })); // the re-read
    await addToCart(page, "7", 1);
    expect([...(await cartVariantIds(page))]).toEqual(["1", "2", "7"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cartState exposes quantities per variant and the cart's item_count; a successful add re-reads the cart (no double count) and announces it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1, quantity: 2 }, { variant_id: 2, quantity: 1 }], item_count: 3 }));
    const s = await cartState(page);
    expect([...s.quantities]).toEqual([["1", 2], ["2", 1]]);
    expect(s.itemCount).toBe(3);
    const changed = vi.fn();
    window.addEventListener(CART_CHANGED, changed);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] })); // an add
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1, quantity: 4 }, { variant_id: 2, quantity: 1 }], item_count: 5 })); // the read after it
    await addToCart(page, "1", 2);
    fetchMock.mockResolvedValueOnce(jsonResponse(422, {})); // a refused add
    await addToCart(page, "1", 5);
    const now = await cartState(page);
    await Promise.resolve();
    window.removeEventListener(CART_CHANGED, changed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(now.quantities.get("1")).toBe(4);
    expect(now.itemCount).toBe(5);
  });

  it("an add that finishes while a read is in flight is counted once", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1, quantity: 1 }], item_count: 1 })); // the first read (already includes the add below)
    const first = cartState(page);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] })); // the add
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ variant_id: 1, quantity: 1 }], item_count: 1 })); // the read after it
    await addToCart(page, "1", 1);
    await first;
    expect((await cartState(page)).itemCount).toBe(1);
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

describe("cartSummaryNow", () => {
  const line = (over: object) => ({ variant_id: 1, quantity: 1, product_title: "Tee", variant_title: "Default Title", final_line_price: 63000, line_price: 63000, ...over });

  it("reads cart.js and gives compact lines: no Default Title, formatted prices and total, at most 20 lines, short titles", async () => {
    const items = [line({ quantity: 2, product_title: "Wax", variant_title: "Large", final_line_price: 139990 }), line({ product_title: "T".repeat(200) }), ...Array.from({ length: 25 }, () => line({}))];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items, item_count: 28, total_price: 202985, currency: "USD" }));
    const s = await cartSummaryNow(page);
    expect(fetchMock.mock.calls[0][0]).toBe("/fr/cart.js");
    expect(s!.items).toHaveLength(20);
    expect(s!.items[0]).toEqual({ title: "Wax", variant: "Large", quantity: 2, price: expect.stringMatching(/^(US)?[$]1,399.90$/) });
    expect(s!.items[1]).toEqual({ title: "T".repeat(80), quantity: 1, price: expect.stringMatching(/^(US)?[$]630.00$/) });
    expect(s!.total).toMatch(/^(US)?[$]2,029.85$/);
  });

  it("falls back to line_price, and is null for an empty, unreadable or currency-less cart", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ ...line({}), final_line_price: undefined }], total_price: 63000, currency: "USD" }));
    expect((await cartSummaryNow(page))!.items[0].price).toMatch(/^(US)?[$]630.00$/);
    resetCartCache(); // a read this young would be reused
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], total_price: 0, currency: "USD" }));
    expect(await cartSummaryNow(page)).toBeNull();
    resetCartCache();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [line({})], total_price: 63000 }));
    expect(await cartSummaryNow(page)).toBeNull();
    resetCartCache();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await cartSummaryNow(page)).toBeNull();
  });

  it("reuses a read from the last few seconds (the panel just opened) and reads again after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, { items: [line({})], total_price: 63000, currency: "USD" }));
      refreshCart(page); // what opening the panel does
      await cartSummaryNow(page);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 6000);
      await cartSummaryNow(page);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
