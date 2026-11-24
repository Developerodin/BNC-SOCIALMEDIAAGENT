// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/products/tee"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCards } from "../../widget/src/cards";
import { translator } from "../../widget/src/core/i18n";
import { tokenStore } from "../../widget/src/core/storage";
import type { Card, PageContext, WidgetApi, WidgetConfig, WidgetCtx } from "@/lib/widget-contract";
import { jsonResponse } from "./core/helpers";

const SHOP = "demo.myshopify.com";
const IMG = "https://cdn.shopify.com/s/files/1/tee.jpg";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Variant = Card["variants"][number];

const variant = (id: string, options: [string, string][], available = true, over: Partial<Variant> = {}): Variant => ({
  id, title: options.map(([, v]) => v).join(" / ") || "Default Title",
  options: options.map(([name, value]) => ({ name, value })),
  available, stock: available ? { kind: "in_stock" } : { kind: "sold_out" }, price: "20.00", compareAtPrice: null, ...over,
});
const DEFAULT = variant("123", [["Title", "Default Title"]]);

function card(over: Partial<Card> = {}): Card {
  return {
    id: "gid://shopify/Product/1", title: "Linen tee", imageUrl: IMG, url: "https://demo.myshopify.com/products/tee",
    currency: "USD", available: true, action: "add", stock: { kind: "in_stock" }, price: "20.00", compareAtPrice: null,
    variants: [DEFAULT], moreVariants: false, ...over,
  };
}

const config = { stockThreshold: 5 } as WidgetConfig;
const page: PageContext = {
  shop: SHOP, locale: "en", country: "US", currency: "USD", productId: null,
  cartAddUrl: "/cart/add", cartUrl: "/cart", privacyUrl: null, designMode: false,
};
const fetchMock = vi.fn<typeof fetch>();
let logCartAdd: ReturnType<typeof vi.fn<WidgetApi["logCartAdd"]>>;
let announce: ReturnType<typeof vi.fn<(text: string) => void>>;

function ctx(over: Partial<PageContext> = {}): WidgetCtx {
  return {
    config, page: { ...page, ...over }, api: { logCartAdd } as unknown as WidgetApi, t: translator("en"), announce,
  };
}
function render(cards: Card[], c = ctx()) {
  const into = document.createElement("div");
  document.body.append(into);
  renderCards(into, cards, c);
  return into;
}
const addButton = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === "Add to cart") as HTMLButtonElement | undefined;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  logCartAdd = vi.fn<WidgetApi["logCartAdd"]>(async () => {});
  announce = vi.fn<(text: string) => void>();
  tokenStore(SHOP).set("tok-1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  tokenStore(SHOP).clear();
});

describe("layout (UD9, UD12)", () => {
  it("1 card → the single full-width layout", () => {
    const el = render([card()]);
    expect(el.querySelector(".ac-cards--single")).not.toBeNull();
    expect(el.querySelector(".ac-cards--carousel")).toBeNull();
    expect(el.querySelectorAll(".ac-card")).toHaveLength(1);
  });

  it("3 cards → a carousel with n of m labels and prev/next", () => {
    const el = render([card(), card({ id: "gid://shopify/Product/2" }), card({ id: "gid://shopify/Product/3" })]);
    expect(el.querySelector(".ac-cards--carousel")).not.toBeNull();
    const slides = [...el.querySelectorAll(".ac-card")];
    expect(slides.map((s) => s.getAttribute("aria-label"))).toEqual(["1 / 3", "2 / 3", "3 / 3"]);
    expect(el.querySelector('button[aria-label="Next product"]')).not.toBeNull();
    expect(el.querySelector('button[aria-label="Previous product"]')).not.toBeNull();
  });

  it("no cards → nothing", () => {
    expect(render([]).childElementCount).toBe(0);
  });

  it("shows title, price, compare-at price and the UD10 stock label", () => {
    const el = render([card({ compareAtPrice: "30.00", stock: { kind: "count", n: 2 } })]);
    expect(el.querySelector(".ac-card__title")?.textContent).toBe("Linen tee");
    expect(el.querySelector(".ac-card__price")?.textContent).toBe("$20.00");
    expect(el.querySelector("s")?.textContent).toBe("$30.00");
    expect(el.querySelector(".ac-card__stock")?.textContent).toBe("Only 2 left");
  });
});

describe("Review Focus 1: unsafe data", () => {
  it("a javascript: url renders no link, an evil.com image renders the placeholder, markup stays text", () => {
    const el = render([card({ title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", imageUrl: "https://evil.com/x.png" })]);
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".ac-card__img--placeholder")).not.toBeNull();
    expect(el.querySelector(".ac-card__title")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("a safe title link opens in the same tab with noopener noreferrer, image from cdn.shopify.com", () => {
    const el = render([card()]);
    const a = el.querySelector(".ac-card__title") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("https://demo.myshopify.com/products/tee");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBeNull();
    expect(el.querySelector("img")?.getAttribute("src")).toBe(IMG);
  });
});

describe("actions", () => {
  it("D72: a sold-out product shows the badge and no Add", () => {
    const el = render([card({ available: false, action: "none", stock: { kind: "sold_out" }, variants: [variant("123", [], false)] })]);
    expect(addButton(el)).toBeUndefined();
    expect(el.querySelector(".ac-card__badge")?.textContent).toBe("Sold out");
  });

  it("D72: a sold-out variant's option is disabled in the picker", () => {
    const el = render([card({ variants: [variant("1", [["Size", "S"]]), variant("2", [["Size", "M"]], false), variant("3", [["Size", "L"]])] })]);
    const select = el.querySelector("select") as HTMLSelectElement;
    const opts = [...select.options].filter((o) => o.value);
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([["S", false], ["M", true], ["L", false]]);
    expect(addButton(el)?.disabled).toBe(true); // nothing chosen yet
  });

  it("multi-option picker: a combination with no available variant is disabled", () => {
    const el = render([card({ variants: [
      variant("1", [["Size", "S"], ["Color", "Red"]]),
      variant("2", [["Size", "S"], ["Color", "Blue"]], false),
      variant("3", [["Size", "M"], ["Color", "Blue"]]),
    ] })]);
    const [size, color] = [...el.querySelectorAll("select")] as HTMLSelectElement[];
    size.value = "S";
    size.dispatchEvent(new Event("change"));
    const blue = [...color.options].find((o) => o.value === "Blue")!;
    expect(blue.disabled).toBe(true);
    color.value = "Red";
    color.dispatchEvent(new Event("change"));
    expect(addButton(el)?.disabled).toBe(false);
  });

  it("preselects the only available variant", () => {
    const el = render([card({ variants: [variant("1", [["Size", "S"]], false), variant("2", [["Size", "M"]])] })]);
    expect((el.querySelector("select") as HTMLSelectElement).value).toBe("M");
    expect(addButton(el)?.disabled).toBe(false);
  });

  it("a default-variant product has no picker", () => {
    const el = render([card()]);
    expect(el.querySelector("select")).toBeNull();
    expect(addButton(el)?.disabled).toBe(false);
  });

  it("D75: view_options → a View options link, no Add", () => {
    const el = render([card({ action: "view_options" })]);
    const link = [...el.querySelectorAll("a")].find((a) => a.textContent === "View options");
    expect(link?.getAttribute("href")).toBe("https://demo.myshopify.com/products/tee");
    expect(addButton(el)).toBeUndefined();
    expect(el.querySelector("select")).toBeNull();
  });

  it("D75: moreVariants → a View options link, no Add", () => {
    const el = render([card({ moreVariants: true, variants: [variant("1", [["Size", "S"]]), variant("2", [["Size", "M"]])] })]);
    expect([...el.querySelectorAll("a")].some((a) => a.textContent === "View options")).toBe(true);
    expect(addButton(el)).toBeUndefined();
  });

  it("C11 fallback card: no price, no stock, no Add, just the link", () => {
    const el = render([card({ price: null, currency: null, available: null, stock: null, action: "none", variants: [] })]);
    expect(el.querySelector(".ac-card__price")).toBeNull();
    expect(el.querySelector(".ac-card__stock")).toBeNull();
    expect(el.querySelector(".ac-card__badge")).toBeNull();
    expect(addButton(el)).toBeUndefined();
    expect(el.querySelector("a.ac-card__title")).not.toBeNull();
  });

  it("C26: a card currency other than the shopper's hides the price and keeps Add", () => {
    const el = render([card({ compareAtPrice: "30.00" })], ctx({ currency: "EUR" }));
    expect(el.querySelector(".ac-card__price")).toBeNull();
    expect(el.querySelector("s")).toBeNull();
    expect(el.querySelector(".ac-card__price-hint")?.textContent).toBe("See price on the product page");
    expect(addButton(el)).toBeDefined();
  });
});

describe("Review Focus 6: add to cart", () => {
  it("posts the numeric id, shows Added · View cart, fires cart:updated and logs one event", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const updated = vi.fn();
    window.addEventListener("cart:updated", updated);
    const el = render([card()]);
    addButton(el)!.click();
    await flush();
    window.removeEventListener("cart:updated", updated);

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ items: [{ id: 123, quantity: 1 }] });
    const status = el.querySelector(".ac-card__added")!;
    expect(status.textContent).toBe("Added · View cart");
    expect(status.querySelector("a")?.getAttribute("href")).toBe("https://demo.myshopify.com/cart");
    expect(updated).toHaveBeenCalledTimes(1);
    expect(logCartAdd).toHaveBeenCalledTimes(1);
    const [token, event] = logCartAdd.mock.calls[0];
    expect(token).toBe("tok-1");
    expect(event).toMatchObject({ messageId: null, productId: "gid://shopify/Product/1", variantId: "123", quantity: 1 });
    expect(event.eventId).toMatch(UUID);
    expect(announce).toHaveBeenCalledWith("Added");
  });

  it("adds the picked variant", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const el = render([card({ variants: [variant("11", [["Size", "S"]]), variant("22", [["Size", "M"]])] })]);
    const select = el.querySelector("select") as HTMLSelectElement;
    select.value = "M";
    select.dispatchEvent(new Event("change"));
    addButton(el)!.click();
    await flush();
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ items: [{ id: 22, quantity: 1 }] });
  });

  it("a double click → one request", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = render([card()]);
    const btn = addButton(el)!;
    btn.click();
    btn.click();
    expect(btn.disabled).toBe(true);
    resolve(jsonResponse(200, {}));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logCartAdd).toHaveBeenCalledTimes(1);
  });

  it("422 → the store's description is shown, nothing is logged, Add works again", async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { status: 422, message: "Cart Error", description: "All 1 Linen tee are in your cart." }));
    const el = render([card()]);
    addButton(el)!.click();
    await flush();
    expect(el.querySelector(".ac-card__error")?.textContent).toBe("All 1 Linen tee are in your cart.");
    expect(logCartAdd).not.toHaveBeenCalled();
    expect(addButton(el)?.disabled).toBe(false);
  });

  it("429 → please try again in a moment", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const el = render([card()]);
    addButton(el)!.click();
    await flush();
    expect(el.querySelector(".ac-card__error")?.textContent).toBe("Please try again in a moment.");
  });

  it("no token yet → the add still works, nothing is logged", async () => {
    tokenStore(SHOP).clear();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const el = render([card()]);
    addButton(el)!.click();
    await flush();
    expect(el.querySelector(".ac-card__added")).not.toBeNull();
    expect(logCartAdd).not.toHaveBeenCalled();
  });
});
