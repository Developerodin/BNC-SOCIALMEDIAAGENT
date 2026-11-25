// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/products/tee"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARDS_CSS, renderCards } from "../../widget/src/cards";
import { refreshCart, resetCartCache } from "../../widget/src/cart";
import { translator } from "../../widget/src/core/i18n";
import { tokenStore } from "../../widget/src/core/storage";
import type { Card, PageContext, WidgetApi, WidgetConfig, WidgetCtx } from "@/lib/widget-contract";
import { jsonResponse, openSheets } from "./core/helpers";

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
// GET /cart.js (the "In your cart" lookup) is answered here; every other request goes to fetchMock.
let cartItems: { variant_id: number }[] = [];
let cartReads = 0;
let logCartAdd: ReturnType<typeof vi.fn<WidgetApi["logCartAdd"]>>;
let announce: ReturnType<typeof vi.fn<(text: string) => void>>;

function ctx(over: Partial<PageContext> = {}): WidgetCtx {
  return {
    config, page: { ...page, ...over }, api: { logCartAdd } as unknown as WidgetApi, t: translator("en"), announce,
  };
}
/** Renders the thumbnails and opens every detail sheet, so the full cards can be queried. */
function render(cards: Card[], c = ctx(), messageId?: string | null) {
  const into = renderRow(cards, c, messageId);
  openSheets(into);
  return into;
}
function renderRow(cards: Card[], c = ctx(), messageId?: string | null) {
  const into = document.createElement("div");
  document.body.append(into);
  renderCards(into, cards, c, messageId);
  return into;
}
const addButton = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>("button.ac-card__add") ?? undefined; // the sheet's; the card's own is .ac-tile__add
const flush = () => new Promise((r) => setTimeout(r, 0));
const slideOut = () => new Promise((r) => setTimeout(r, 450)); // the sheet leaves after its 200 ms slide (400 ms at most)

beforeEach(() => {
  fetchMock.mockReset();
  resetCartCache();
  cartItems = [];
  cartReads = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/cart.js")) {
      cartReads++;
      return Promise.resolve(jsonResponse(200, { items: cartItems }));
    }
    return fetchMock(url, init);
  });
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
  it("cards are a row of thumbnails with name and price; the full card is not built until a thumbnail is tapped", () => {
    const el = renderRow([card(), card({ id: "gid://shopify/Product/2", title: "Wool hat", price: "9.50" })]);
    const tiles = [...el.querySelectorAll<HTMLElement>(".ac-tile")];
    expect(tiles.map((t) => t.querySelector(".ac-tile__title")!.textContent)).toEqual(["Linen tee", "Wool hat"]);
    expect(tiles.map((t) => t.querySelector(".ac-tile__price")!.textContent)).toEqual(["$20.00", "$9.50"]);
    expect(tiles[0].querySelector("img")!.getAttribute("src")).toBe(IMG);
    expect(el.querySelector(".ac-card")).toBeNull();
    expect(CARDS_CSS).toMatch(/\.ac-tile__title\{[^}]*-webkit-line-clamp:2/);
  });

  it("premium tile: 168 px wide (148 px on phones), square 14 px image, snap row, 36 px arrows, zoom only without reduced motion", () => {
    expect(CARDS_CSS).toMatch(/\.ac-cards__slide\{[^}]*flex:0 0 168px/);
    expect(CARDS_CSS).toMatch(/@media \(max-width:639px\)\{\.ac-cards__slide\{flex-basis:148px/);
    expect(CARDS_CSS).toMatch(/\.ac-tile__media\{[^}]*aspect-ratio:1;border-radius:14px/);
    expect(CARDS_CSS).toMatch(/\.ac-tile__img\{[^}]*object-fit:cover/);
    expect(CARDS_CSS).toMatch(/\.ac-cards__track\{[^}]*gap:12px[^}]*scroll-snap-type:x/);
    expect(CARDS_CSS).toMatch(/\.ac-cards__nav\{[^}]*width:36px;height:36px/);
    expect(CARDS_CSS).toMatch(/prefers-reduced-motion:no-preference\)\{[^}]*transition:transform \.2s[^}]*\}\.ac-tile:hover \.ac-tile__img\{transform:scale\(1\.03\)/);
    expect(CARDS_CSS).toMatch(/\.ac-tile:focus-visible\{outline/);
  });

  it("an on-sale product shows the compare-at price struck through next to the price; a sold-out one says Sold out instead", () => {
    const el = renderRow([card({ price: "15.00", compareAtPrice: "20.00" }), card({ id: "gid://shopify/Product/2", available: false })]);
    const [sale, sold] = [...el.querySelectorAll<HTMLElement>(".ac-tile")];
    expect(sale.querySelector(".ac-tile__price")!.textContent).toBe("$15.00");
    expect(sale.querySelector("s.ac-tile__compare")!.textContent).toBe("$20.00");
    expect(sold.querySelector(".ac-tile__price")!.textContent).toBe("Sold out");
    expect(sold.querySelector(".ac-tile__compare")).toBeNull();
  });

  it("a title is text, never markup, on the tile too", () => {
    const el = renderRow([card({ title: "<img src=x onerror=alert(1)>" })]);
    const tile = el.querySelector(".ac-tile")!;
    expect(tile.querySelector(".ac-tile__title")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(tile.querySelectorAll("img")).toHaveLength(1); // only the product image
    expect(tile.querySelector("img")!.getAttribute("src")).toBe(IMG);
  });

  it("a thumbnail opens the detail sheet; Back closes it, keeps the card state and returns focus to the thumbnail", async () => {
    const el = renderRow([card({ variants: [variant("1", [["Size", "S"]]), variant("2", [["Size", "M"]])] })]);
    const tile = el.querySelector<HTMLButtonElement>(".ac-tile")!;
    tile.click();
    const sheet = el.querySelector(".ac-sheet")!;
    expect(sheet.querySelector(".ac-card__img")).not.toBeNull();
    expect(sheet.querySelector<HTMLAnchorElement>(".ac-sheet__view")!.href).toBe("https://demo.myshopify.com/products/tee");
    const select = sheet.querySelector<HTMLSelectElement>("select")!;
    select.value = "M";
    select.dispatchEvent(new Event("change"));
    sheet.querySelector<HTMLButtonElement>(".ac-sheet__back")!.click();
    expect(el.querySelector(".ac-sheet.out")).not.toBeNull(); // sliding out, not cut
    await slideOut();
    expect(el.querySelector(".ac-sheet")).toBeNull();
    expect(tile.getAttribute("aria-haspopup")).toBe("dialog");
    tile.click();
    expect(el.querySelector<HTMLSelectElement>(".ac-sheet select")!.value).toBe("M");
  });

  it("Escape closes the sheet only", async () => {
    const el = renderRow([card()]);
    el.querySelector<HTMLElement>(".ac-tile")!.click();
    const outer = vi.fn();
    el.addEventListener("keydown", outer);
    el.querySelector(".ac-sheet")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await slideOut();
    expect(el.querySelector(".ac-sheet")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("the arrows stay hidden while the row fits", () => {
    const el = renderRow([card(), card({ id: "gid://shopify/Product/2" }), card({ id: "gid://shopify/Product/3" })]);
    expect(el.querySelector<HTMLElement>('button[aria-label="Next product"]')!.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>('button[aria-label="Previous product"]')!.hidden).toBe(true);
  });

  it("the arrows scroll smoothly, or instantly when the shopper prefers reduced motion", () => {
    const behaviours: (string | undefined)[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, "scrollBy").mockImplementation(function (o?: ScrollToOptions | number) {
      behaviours.push(typeof o === "object" ? o.behavior : undefined);
    } as never);
    const three = [card(), card({ id: "gid://shopify/Product/2" }), card({ id: "gid://shopify/Product/3" })];
    const next = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-label="Next product"]')!.click();
    next(render(three));
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q }) as MediaQueryList,
    );
    next(render(three));
    spy.mockRestore();
    expect(behaviours).toEqual(["smooth", "auto"]);
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
    expect(select.value).toBe("S"); // the first available variant is preselected, so Add is ready
    expect(addButton(el)?.disabled).toBe(false);
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
    expect(addButton(el)!.textContent).toBe("Added"); // ✓ Added on the button itself
    const row = el.querySelector(".ac-card__cartrow")!;
    expect(row.textContent).toBe("In your cart · View cart");
    expect(row.querySelector("a")?.getAttribute("href")).toBe("https://demo.myshopify.com/cart");
    expect(el.querySelector(".ac-card__status")!.textContent).toBe(""); // the status line carries errors only
    expect(updated).toHaveBeenCalledTimes(1);
    expect(logCartAdd).toHaveBeenCalledTimes(1);
    const [token, event] = logCartAdd.mock.calls[0];
    expect(token).toBe("tok-1");
    expect(event).toMatchObject({ messageId: null, productId: "gid://shopify/Product/1", variantId: "123", quantity: 1 });
    expect(event.eventId).toMatch(UUID);
    expect(announce).toHaveBeenCalledWith("Added");
  });

  it("the cart event names the answer the card came with", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const el = render([card()], ctx(), "msg-42");
    addButton(el)!.click();
    await flush();
    expect(logCartAdd.mock.calls[0][1]).toMatchObject({ messageId: "msg-42", variantId: "123" });
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
    expect(btn.getAttribute("aria-busy")).toBe("true"); // a spinner, not a disabled look
    expect(btn.querySelector(".ac-spin")).not.toBeNull();
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
    expect(addButton(el)!.textContent).toBe("Added");
    expect(logCartAdd).not.toHaveBeenCalled();
  });
});

describe("UD13: the panel doesn't reopen over a product the shopper chose", () => {
  const UI = `askcart:${SHOP}:ui`;
  const stay = (e: Event) => e.preventDefault(); // keep happy-dom on this page
  beforeEach(() => {
    localStorage.setItem(UI, JSON.stringify({ open: true, teaserSeen: true }));
    document.addEventListener("click", stay);
  });
  afterEach(() => {
    document.removeEventListener("click", stay);
    localStorage.removeItem(UI);
  });
  const ui = () => JSON.parse(localStorage.getItem(UI)!);

  // The panel is full screen below 640 px (UD4): only there would it cover the chosen product's page.
  const width = (px: number) => vi.stubGlobal("innerWidth", px);

  it("on a phone the product title link closes it for the next page", () => {
    width(375);
    render([card()]).querySelector<HTMLAnchorElement>("a.ac-card__title")!.click();
    expect(ui()).toEqual({ open: false, teaserSeen: true });
  });

  it("on a phone the View options link closes it for the next page", () => {
    width(639);
    render([card({ action: "view_options" })]).querySelector<HTMLAnchorElement>("a.ac-card__options")!.click();
    expect(ui().open).toBe(false);
  });

  it("on a desktop (640 px and up) the floating panel stays open after either link", () => {
    width(640);
    render([card()]).querySelector<HTMLAnchorElement>("a.ac-card__title")!.click();
    expect(ui().open).toBe(true);
    width(1280);
    render([card({ action: "view_options" })]).querySelector<HTMLAnchorElement>("a.ac-card__options")!.click();
    expect(ui().open).toBe(true);
  });

  it("View cart keeps today's reopen", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const el = render([card()]);
    addButton(el)!.click();
    await flush();
    el.querySelector<HTMLAnchorElement>("a.ac-card__cart")!.click();
    expect(ui().open).toBe(true);
  });

  it("the picker placeholder reads 'Choose <option>' and a hint says what to pick first", () => {
    const el = render([card({ variants: [variant("1", [["Color", "Red"]]), variant("2", [["Color", "Blue"]])] })]);
    const select = el.querySelector("select") as HTMLSelectElement;
    expect(select.options[0].textContent).toBe("Choose Color");
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(el.querySelector(".ac-card__hint")?.textContent).toBe("Choose Color first");
    expect(addButton(el)?.getAttribute("aria-describedby")).toBe(el.querySelector(".ac-card__hint")!.id);
    select.value = "Red";
    select.dispatchEvent(new Event("change"));
    expect(el.querySelector(".ac-card__hint")?.textContent).toBe("");
  });

  it("starts on the first available variant: every option is filled and Add is ready", () => {
    const el = render([card({ variants: [
      variant("1", [["Size", "S"], ["Color", "Red"]]),
      variant("2", [["Size", "M"], ["Color", "Red"]]),
      variant("3", [["Size", "L"], ["Color", "Blue"]], false),
    ] })]);
    const [size, color] = [...el.querySelectorAll("select")] as HTMLSelectElement[];
    expect(color.value).toBe("Red");
    expect(size.value).toBe("S");
    expect(addButton(el)?.disabled).toBe(false);
  });
});

describe("already in the cart", () => {
  const tileBadge = (el: HTMLElement, i = 0) => el.querySelectorAll<HTMLElement>(".ac-tile")[i].querySelector<HTMLElement>(".ac-tile__badge")!;
  const sheetLine = (el: HTMLElement, i = 0) => el.querySelectorAll<HTMLElement>(".ac-card__cartrow")[i];

  it("a product with a variant in the cart (quantity 1) shows a check badge 'In your cart' on the image, and the sheet says it above Add", async () => {
    cartItems = [{ variant_id: 123, quantity: 1 } as never];
    const el = render([card()]);
    await flush();
    expect(tileBadge(el).hidden).toBe(false);
    expect(tileBadge(el).textContent).toBe("In your cart");
    expect(tileBadge(el).querySelector("svg")).not.toBeNull();
    expect(tileBadge(el).parentElement!.classList.contains("ac-tile__media")).toBe(true);
    expect(sheetLine(el).textContent).toBe("In your cart · View cart");
    expect(sheetLine(el).nextElementSibling).toBe(addButton(el));
  });

  it("a quantity above 1 reads '2 in your cart'", async () => {
    cartItems = [{ variant_id: 123, quantity: 2 } as never];
    const el = render([card()]);
    await flush();
    expect(tileBadge(el).textContent).toBe("2 in your cart");
    expect(sheetLine(el).textContent).toBe("2 in your cart · View cart");
  });

  it("any variant of a multi-variant product counts, quantities add up; other products have no badge", async () => {
    cartItems = [{ variant_id: 22, quantity: 1 } as never, { variant_id: 21, quantity: 2 } as never];
    const multi = card({ variants: [variant("21", [["Size", "S"]]), variant("22", [["Size", "M"]])] });
    const other = card({ id: "gid://shopify/Product/2", variants: [variant("99", [["Title", "Default Title"]])] });
    const el = render([multi, other]);
    await flush();
    expect(tileBadge(el, 0).textContent).toBe("3 in your cart");
    expect(tileBadge(el, 1).hidden).toBe(true);
    expect(sheetLine(el, 1).hidden).toBe(true);
  });

  it("the badge appears right after a successful add, and counts up on the next one", async () => {
    const el = render([card()]);
    await flush();
    expect(tileBadge(el).hidden).toBe(true);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    addButton(el)!.click();
    await flush();
    expect(tileBadge(el).textContent).toBe("In your cart");
    expect(sheetLine(el).textContent).toBe("In your cart · View cart");
    addButton(el)!.click();
    await flush();
    expect(tileBadge(el).textContent).toBe("2 in your cart");
    expect(cartReads).toBe(1); // the add result and the cached cart, no re-read
  });

  it("no badge after a failed add", async () => {
    const el = render([card()]);
    await flush();
    fetchMock.mockResolvedValue(jsonResponse(422, { description: "No." }));
    addButton(el)!.click();
    await flush();
    expect(tileBadge(el).hidden).toBe(true);
    expect(sheetLine(el).hidden).toBe(true);
  });

  it("an add from the cart's re-read shows up too (the panel reopened)", async () => {
    const el = render([card()]);
    await flush();
    cartItems = [{ variant_id: 123, quantity: 1 } as never];
    refreshCart(page);
    await flush();
    expect(tileBadge(el).textContent).toBe("In your cart");
  });

  it("reads the cart once for all cards, and not at all on the hosted page", async () => {
    render([card(), card({ id: "gid://shopify/Product/2" })]);
    await flush();
    expect(cartReads).toBe(1);
    resetCartCache();
    const el = render([card()], ctx({ hosted: true }));
    await flush();
    expect(cartReads).toBe(1);
    expect(tileBadge(el).hidden).toBe(true);
  });
});

describe("onAdded (the note in the chat log)", () => {
  it("is called once with the title and cart link after a successful add, not after a failed one", async () => {
    const onAdded = vi.fn();
    const into = document.createElement("div");
    document.body.append(into);
    renderCards(into, [card()], ctx(), "m1", onAdded);
    openSheets(into);
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { status: 422, message: "Cart Error", description: "No." }));
    addButton(into)!.click();
    await flush();
    expect(onAdded).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    addButton(into)!.click();
    await flush();
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onAdded).toHaveBeenCalledWith("Linen tee", "https://demo.myshopify.com/cart");
  });
});

describe("the card's own button", () => {
  const tileAdd = (el: HTMLElement, i = 0) => el.querySelectorAll<HTMLButtonElement>(".ac-tile__add")[i];
  const multi = () => card({ variants: [variant("11", [["Color", "Beige"]]), variant("12", [["Color", "Black"]])] });

  it("a single-variant product adds straight from the card, a sibling of the tile button, and shows Added on it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const el = renderRow([card()]);
    const add = tileAdd(el);
    expect(add.textContent).toBe("Add to cart");
    expect(add.parentElement!.querySelector(".ac-tile")!.contains(add)).toBe(false);
    add.click();
    expect(add.getAttribute("aria-busy")).toBe("true");
    expect(add.querySelector(".ac-spin")).not.toBeNull();
    await flush();
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ items: [{ id: 123, quantity: 1 }] });
    expect(add.textContent).toBe("Added");
    expect(add.hasAttribute("aria-busy")).toBe(false);
    expect(logCartAdd).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Added");
    expect(el.querySelector(".ac-sheet")).toBeNull(); // nothing opened
  });

  it("Added goes back to the label after about 1.5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      const add = tileAdd(renderRow([card()]));
      add.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(add.textContent).toBe("Added");
      await vi.advanceTimersByTimeAsync(1600);
      expect(add.textContent).toBe("Add to cart");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an add from the card is one request on a double click, and an error shows under the button", async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { description: "All 1 Linen tee are in your cart." }));
    const el = renderRow([card()]);
    const add = tileAdd(el);
    add.click();
    add.click();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".ac-tile__err")!.textContent).toBe("All 1 Linen tee are in your cart.");
    expect(add.textContent).toBe("Add to cart");
    expect(announce).toHaveBeenCalledWith("All 1 Linen tee are in your cart.");
  });

  it("a product with options says View options and opens the sheet; Back returns focus to that button", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q }) as MediaQueryList);
    const el = renderRow([multi()]);
    const btn = tileAdd(el);
    expect(btn.textContent).toBe("View options");
    btn.click();
    expect(el.querySelector(".ac-sheet .ac-card__add")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>(".ac-sheet__back")!.click();
    expect(document.activeElement).toBe(btn);
    vi.restoreAllMocks();
  });

  it("sold out has no card button; a fallback card (no price) and a view_options card say View options", () => {
    const el = renderRow([
      card({ available: false, action: "none", variants: [variant("1", [], false)] }),
      card({ id: "p2", price: null, currency: null, available: null, stock: null, action: "none", variants: [] }),
      card({ id: "p3", action: "view_options" }),
    ]);
    expect(el.querySelectorAll(".ac-cards__slide")[0].querySelector(".ac-tile__add")).toBeNull();
    expect(tileAdd(el, 0).textContent).toBe("View options");
    expect(tileAdd(el, 1).textContent).toBe("View options");
  });

  it("on the hosted page without the bridge the card button says Buy on the store", () => {
    expect(tileAdd(renderRow([card()], ctx({ hosted: true }))).textContent).toBe("Buy on the store");
  });
});

describe("the sheet's variant and the cart row", () => {
  const multi = () => card({ variants: [variant("11", [["Color", "Beige"]]), variant("12", [["Color", "Black"]]), variant("13", [["Color", "Grey"]], false)] });
  const colour = (el: HTMLElement) => el.querySelector<HTMLSelectElement>(".ac-sheet select")!.value;
  const row = (el: HTMLElement) => el.querySelector<HTMLElement>(".ac-card__cartrow")!;

  it("starts on the first available variant, so Add to cart is ready", () => {
    const el = render([multi()]);
    expect(colour(el)).toBe("Beige");
    expect(addButton(el)!.disabled).toBe(false);
  });

  it("preselects the variant that is in the cart, even after a reload", async () => {
    cartItems = [{ variant_id: 12, quantity: 1 }] as never;
    const el = render([multi()]);
    await flush();
    expect(colour(el)).toBe("Black");
    expect(addButton(el)!.disabled).toBe(false);
    expect(row(el).textContent).toBe("In your cart · View cart");
    expect(row(el).querySelector("a")!.getAttribute("href")).toBe("https://demo.myshopify.com/cart");
  });

  it("takes the variant with the most units and skips a sold-out one", async () => {
    cartItems = [{ variant_id: 11, quantity: 1 }, { variant_id: 12, quantity: 3 }, { variant_id: 13, quantity: 9 }] as never;
    const el = render([multi()]);
    await flush();
    expect(colour(el)).toBe("Black");
  });

  it("never overrides a choice the shopper made in the sheet when the cart arrives late", async () => {
    cartItems = [{ variant_id: 12, quantity: 1 }] as never;
    const el = render([multi()]);
    const select = el.querySelector<HTMLSelectElement>(".ac-sheet select")!;
    select.value = "Beige";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(colour(el)).toBe("Beige");
    refreshCart(page);
    await flush();
    expect(colour(el)).toBe("Beige");
  });

  it("the row survives a re-render (as after View product and a page load): it is drawn from the cart, not from the click", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const first = render([card()]);
    addButton(first)!.click();
    await flush();
    document.body.replaceChildren();
    resetCartCache();
    cartItems = [{ variant_id: 123, quantity: 1 }] as never; // what the store's cart.js says on the next page
    const again = render([card()]);
    await flush();
    expect(row(again).hidden).toBe(false);
    expect(row(again).textContent).toBe("In your cart · View cart");
    expect(addButton(again)!.disabled).toBe(false);
  });

  it("has no row while the product is not in the cart", async () => {
    const el = render([card()]);
    await flush();
    expect(row(el).hidden).toBe(true);
  });
});

describe("reduced motion", () => {
  it("closing the sheet is instant, with no slide-out class", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q }) as MediaQueryList);
    const el = renderRow([card()]);
    el.querySelector<HTMLElement>(".ac-tile")!.click();
    el.querySelector<HTMLButtonElement>(".ac-sheet__back")!.click();
    expect(el.querySelector(".ac-sheet")).toBeNull();
    vi.restoreAllMocks();
  });

  it("the sheet slide, the spinner, the swap and the card entrance all have a reduced-motion rule", () => {
    const reduced = CARDS_CSS.slice(CARDS_CSS.lastIndexOf("@media (prefers-reduced-motion:reduce)"));
    expect(reduced).toMatch(/\.ac-spin\{animation:none/);
    expect(reduced).toMatch(/\.ac-swap\{animation-name:ac-fade/);
    expect(reduced).toMatch(/\.cards\.in \.ac-cards__slide\{animation-name:ac-fade/);
    expect(CARDS_CSS).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.ac-sheet\{transform:none;opacity:0/);
  });

  it("the card entrance applies only to a live answer's .cards.in box", () => {
    expect(CARDS_CSS).toMatch(/\.cards\.in \.ac-cards__slide\{animation:ac-up/);
    expect(CARDS_CSS).not.toMatch(/(^|\n)\.ac-cards__slide\{[^}]*animation/);
  });
});
