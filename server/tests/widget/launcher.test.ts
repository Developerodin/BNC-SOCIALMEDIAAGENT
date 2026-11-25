// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../widget/src/launcher/launcher";
import type { PageContext, WidgetConfig } from "@/lib/widget-contract";

const SRC = "https://cdn.shopify.com/extensions/x/assets/askcart-widget.js";
const SHOP = "demo.myshopify.com";

function config(over: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    v: 1, enabled: true, apiBase: "https://app.example.com", name: "Demo", accent: "#0A0A0A", avatarUrl: null,
    launcher: { style: "pill", label: null, side: "right", offset: 20, scope: "all" },
    welcome: null, suggested: [], teaser: { enabled: false, text: null, delaySec: 8 },
    stockThreshold: 5, retentionDays: 30, ...over,
  };
}
const page: PageContext = {
  shop: SHOP, locale: "en", country: "US", currency: "USD", productId: null,
  cartAddUrl: "/cart/add", cartUrl: "/cart", privacyUrl: null, designMode: false,
};

// Mirrors the Liquid output: the strings come from locales/ as data attributes.
function mountRoot(cfg: WidgetConfig | string = config(), pageOver: Partial<PageContext> = {}) {
  const root = document.createElement("div");
  root.id = "askcart-root";
  root.hidden = true;
  root.dataset.config = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
  root.dataset.page = JSON.stringify({ ...page, ...pageOver });
  root.dataset.widgetSrc = SRC;
  root.dataset.label = "Ask us anything";
  root.dataset.ariaLabel = "Open the chat assistant";
  root.dataset.teaser = "Questions? We can help.";
  root.dataset.teaserClose = "Dismiss";
  document.body.append(root);
}

const shadow = () => document.querySelector("askcart-host")!.shadowRoot!;
const button = () => shadow().querySelector<HTMLButtonElement>("button.l")!;
const teaser = () => shadow().querySelector<HTMLElement>(".t");
const scripts = () => document.querySelectorAll(`script[src="${SRC}"]`);

const MANUAL = Symbol("manual");
function blockFakeError(e: Event) {
  if (e.target instanceof HTMLScriptElement && !(e as unknown as Record<symbol, boolean>)[MANUAL]) e.stopPropagation();
}
function fail(el: Element) {
  const e = new Event("error");
  (e as unknown as Record<symbol, boolean>)[MANUAL] = true;
  el.dispatchEvent(e);
}

// Plays the part of askcart-widget.js finishing its load.
function widgetLoaded() {
  const open = vi.fn();
  (window as unknown as { AskCart: unknown }).AskCart = { open, close: vi.fn(), mount: vi.fn() };
  scripts()[0].dispatchEvent(new Event("load"));
  return open;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.querySelectorAll("script").forEach((s) => s.remove());
  localStorage.clear();
  sessionStorage.clear();
  delete (window as unknown as { AskCart?: unknown }).AskCart;
  // happy-dom refuses to fetch scripts and fires `error` on the tag; drop that so the test can fire `load` itself.
  document.addEventListener("error", blockFakeError, true);
});
afterEach(() => {
  document.removeEventListener("error", blockFakeError, true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("launcher (UD1, UD2)", () => {
  it("is drawn on the left with a 60 px offset when configured", () => {
    mountRoot(config({ launcher: { style: "pill", label: null, side: "left", offset: 60, scope: "all" } }));
    const stop = start();
    expect(button().style.left).toBe("20px");
    expect(button().style.right).toBe("");
    expect(button().style.bottom).toBe("60px");
    expect(document.body.lastElementChild?.tagName.toLowerCase()).toBe("askcart-host");
    stop?.();
  });

  it("the pill shows the merchant label", () => {
    mountRoot(config({ launcher: { style: "pill", label: "Need help?", side: "right", offset: 20, scope: "all" } }));
    start();
    expect(button().textContent).toBe("Need help?");
    expect(button().type).toBe("button");
    expect(button().querySelector("svg")).not.toBeNull(); // icon + label pill
  });

  it("the pill shows the translated default when the label is null", () => {
    mountRoot();
    start();
    expect(button().textContent).toBe("Ask us anything");
  });

  it("the icon style has no visible text and an aria label", () => {
    mountRoot(config({ launcher: { style: "icon", label: null, side: "right", offset: 20, scope: "all" } }));
    start();
    expect(button().getAttribute("aria-label")).toBe("Open the chat assistant");
    expect(button().querySelector("svg")).not.toBeNull();
  });

  it("uses text colour picked for contrast on the accent (UD17)", () => {
    mountRoot(config({ accent: "#FFE600" }));
    start();
    expect(button().style.getPropertyValue("--ac-fg")).toBe("#000000"); // core/format's textOn
  });

  it("a bad accent falls back to the default rather than reaching CSS", () => {
    mountRoot(config({ accent: "red;}body{display:none" }));
    start();
    expect(button().style.getPropertyValue("--ac-bg")).toBe("#0A0A0A");
  });
});

describe("lazy load", () => {
  it("nothing is loaded until the shopper clicks", () => {
    mountRoot();
    start();
    expect(scripts()).toHaveLength(0);
  });

  it("a double click injects the widget script exactly once, then opens it", () => {
    mountRoot();
    start();
    button().click();
    button().click();
    expect(scripts()).toHaveLength(1);
    const open = widgetLoaded();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ productId: null });
  });

  it("a click after the widget loaded calls open straight away", () => {
    mountRoot();
    start();
    button().click();
    const open = widgetLoaded();
    button().click();
    expect(open).toHaveBeenCalledTimes(2);
    expect(scripts()).toHaveLength(1);
  });

  it("a failed load can be retried by clicking again", () => {
    mountRoot();
    start();
    button().click();
    fail(scripts()[0]);
    button().click();
    expect(scripts()).toHaveLength(1); // the failed tag was removed and a fresh one added
  });

  it("askcart:open with a product id is passed to AskCart.open (UD5)", () => {
    mountRoot();
    start();
    window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId: "123" } }));
    const open = widgetLoaded();
    expect(open).toHaveBeenCalledWith({ productId: "123" });
  });
});

describe("teaser (UD6, C28)", () => {
  it("never appears when it's off", () => {
    vi.useFakeTimers();
    mountRoot();
    start();
    vi.advanceTimersByTime(60_000);
    expect(teaser()).toBeNull();
  });

  it("appears after the delay when it's on, with the merchant text", () => {
    vi.useFakeTimers();
    mountRoot(config({ teaser: { enabled: true, text: "Free shipping questions?", delaySec: 5 } }));
    start();
    vi.advanceTimersByTime(4_900);
    expect(teaser()).toBeNull();
    vi.advanceTimersByTime(200);
    expect(teaser()?.textContent).toContain("Free shipping questions?");
    expect(scripts()).toHaveLength(0); // it never opens the chat
  });

  it("uses the translated default text when the merchant text is null", () => {
    vi.useFakeTimers();
    mountRoot(config({ teaser: { enabled: true, text: null, delaySec: 1 } }));
    start();
    vi.advanceTimersByTime(1_000);
    expect(teaser()?.textContent).toContain("Questions? We can help.");
  });

  it("never appears again after the shopper closed it", () => {
    vi.useFakeTimers();
    const cfg = config({ teaser: { enabled: true, text: "Hi", delaySec: 1 } });
    mountRoot(cfg);
    const stop = start();
    vi.advanceTimersByTime(1_000);
    shadow().querySelector<HTMLButtonElement>(".t button")!.click();
    expect(teaser()).toBeNull();
    stop?.();

    // the next page, and a new visit
    sessionStorage.clear();
    document.body.innerHTML = "";
    mountRoot(cfg);
    start();
    vi.advanceTimersByTime(10_000);
    expect(teaser()).toBeNull();
  });

  it("shows once per visit: not again on the next page", () => {
    vi.useFakeTimers();
    const cfg = config({ teaser: { enabled: true, text: "Hi", delaySec: 1 } });
    mountRoot(cfg);
    const stop = start();
    vi.advanceTimersByTime(1_000);
    expect(teaser()).not.toBeNull();
    stop?.();

    document.body.innerHTML = "";
    mountRoot(cfg);
    start();
    vi.advanceTimersByTime(10_000);
    expect(teaser()).toBeNull();
  });

  it("is removed and never shown again once the chat is opened", () => {
    vi.useFakeTimers();
    const cfg = config({ teaser: { enabled: true, text: "Hi", delaySec: 1 } });
    mountRoot(cfg);
    start();
    vi.advanceTimersByTime(1_000);
    button().click();
    expect(teaser()).toBeNull();
    sessionStorage.clear();
    document.body.innerHTML = "";
    mountRoot(cfg);
    start();
    vi.advanceTimersByTime(10_000);
    expect(teaser()).toBeNull();
  });
});

describe("reopen (UD13)", () => {
  it("uiState.open = true loads the widget on start and opens it without moving focus", () => {
    localStorage.setItem(`askcart:${SHOP}:ui`, JSON.stringify({ open: true }));
    mountRoot();
    start();
    expect(scripts()).toHaveLength(1);
    const open = widgetLoaded();
    expect(open).toHaveBeenCalledWith({ productId: null, focus: false });
  });

  it("does not load the widget on start when the panel was closed", () => {
    localStorage.setItem(`askcart:${SHOP}:ui`, JSON.stringify({ open: false }));
    mountRoot();
    start();
    expect(scripts()).toHaveLength(0);
  });

  it("works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mountRoot();
    expect(() => start()).not.toThrow();
    expect(button()).not.toBeNull();
  });
});

describe("no-ops", () => {
  it("a missing root does nothing and doesn't throw", () => {
    expect(() => start()).not.toThrow();
    expect(document.querySelector("askcart-host")).toBeNull();
  });

  it("a config that doesn't parse does nothing", () => {
    mountRoot("{not json");
    expect(() => start()).not.toThrow();
    expect(document.querySelector("askcart-host")).toBeNull();
  });

  it("a second start on the same page does not draw a second launcher", () => {
    mountRoot();
    start();
    start();
    expect(document.querySelectorAll("askcart-host")).toHaveLength(1);
  });
});

describe("launcher scope", () => {
  const withScope = (scope: "all" | "product" | "none") => config({ launcher: { style: "pill", label: null, side: "right", offset: 20, scope } });
  const hasButton = () => shadow().querySelector("button.l") !== null;

  it("all: the button shows on every page", () => {
    mountRoot(withScope("all"));
    start();
    expect(hasButton()).toBe(true);
  });

  it("a config from before scope existed behaves like all", () => {
    const old = config();
    delete (old.launcher as { scope?: string }).scope;
    mountRoot(old);
    start();
    expect(hasButton()).toBe(true);
  });

  it("product: the button shows only on a product page", () => {
    mountRoot(withScope("product"));
    const stop = start();
    expect(hasButton()).toBe(false);
    stop?.();
    document.body.innerHTML = "";
    mountRoot(withScope("product"), { productId: "42" });
    start();
    expect(hasButton()).toBe(true);
  });

  it("none: no button and no teaser, but askcart:open still loads the chat and passes the block's args", () => {
    vi.useFakeTimers();
    mountRoot({ ...withScope("none"), teaser: { enabled: true, text: "Hi", delaySec: 1 } });
    start();
    vi.advanceTimersByTime(5_000);
    expect(hasButton()).toBe(false);
    expect(teaser()).toBeNull();
    const title = { eyebrow: "More questions?", heading: "Ask our AI agent" };
    window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId: 42, message: "What size?", mode: "drawer", title } }));
    expect(scripts().length).toBeGreaterThan(0); // earlier tests leave their launchers listening, so not exactly 1
    const open = widgetLoaded();
    expect(open).toHaveBeenCalledWith({ productId: "42", message: "What size?", mode: "drawer", title });
  });

  it("drops a message that is not a non-empty string, an unknown mode and a malformed title", () => {
    mountRoot(withScope("none"));
    start();
    window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId: "1", message: "   ", mode: "weird", title: { eyebrow: 1 } } }));
    expect(widgetLoaded()).toHaveBeenCalledWith({ productId: "1" });
  });
});

describe("automatic Ask our AI agent block", () => {
  const AI_SRC = "https://cdn.shopify.com/extensions/x/assets/askcart-ask-ai.js";
  const template = () =>
    `<template data-askcart-ask-ai-auto data-script="${AI_SRC}"><link rel="stylesheet" href="x.css"><div class="askcart-ai" data-askcart-ask-ai></div></template>`;
  const form = `<form action="/cart/add" method="post"><button>Add to cart</button></form>`;
  const aiScripts = () => document.querySelectorAll(`script[src="${AI_SRC}"]`);

  it("is inserted right after the buy form, and its script is loaded", () => {
    document.body.insertAdjacentHTML("beforeend", `<main><div id="price"></div>${form}<p id="after"></p></main>` + template());
    mountRoot();
    start();
    expect(document.querySelector("#after")!.previousElementSibling?.hasAttribute("data-askcart-ask-ai")).toBe(true);
    expect(document.querySelector("form")!.nextElementSibling?.matches("link")).toBe(true);
    expect(aiScripts()).toHaveLength(1);
  });

  it("goes after Dawn's <product-form> wrapper, not inside it, and prefers the form in main", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<header><form action="/cart/add"></form></header><main><product-form id="pf">${form}</product-form></main>` + template(),
    );
    mountRoot();
    start();
    expect(document.querySelector("#pf [data-askcart-ask-ai]")).toBeNull();
    expect(document.querySelector("#pf")!.nextElementSibling?.matches("link")).toBe(true);
    expect(document.querySelectorAll("main [data-askcart-ask-ai]")).toHaveLength(1);
    expect(document.querySelector("header [data-askcart-ask-ai]")).toBeNull();
  });

  it("is not inserted when the merchant placed the block by hand", () => {
    document.body.insertAdjacentHTML("beforeend", `<main>${form}</main><div data-askcart-ask-ai id="mine"></div>` + template());
    mountRoot();
    start();
    expect(document.querySelectorAll("[data-askcart-ask-ai]")).toHaveLength(1);
    expect(aiScripts()).toHaveLength(0);
  });

  it("inserts nothing when the page has no buy form", () => {
    document.body.insertAdjacentHTML("beforeend", `<main><form action="/search"></form></main>` + template());
    mountRoot();
    start();
    expect(document.querySelectorAll("[data-askcart-ask-ai]")).toHaveLength(0);
    expect(aiScripts()).toHaveLength(0);
  });

  it("does nothing without the template (setting off, or not a product page)", () => {
    document.body.insertAdjacentHTML("beforeend", `<main>${form}</main>`);
    mountRoot();
    start();
    expect(document.querySelectorAll("[data-askcart-ask-ai]")).toHaveLength(0);
    expect(document.querySelectorAll("script[src*='askcart-ask-ai']")).toHaveLength(0);
  });
});

describe("logo tab launcher", () => {
  const tabCfg = (side: "right" | "left" = "right", over: Partial<WidgetConfig> = {}) =>
    config({ launcher: { style: "tab", label: null, side, offset: 60, scope: "all" }, ...over });

  it("is a labelled tab docked to the right edge, with no inline offset, and the chat icon when there is no logo", () => {
    mountRoot(tabCfg());
    start();
    expect(button().classList.contains("tab")).toBe(true);
    expect(button().classList.contains("sl")).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Open the chat assistant");
    expect(button().style.bottom).toBe("");
    expect(button().style.right).toBe("");
    expect(button().textContent).toBe("");
    expect(button().querySelector("svg")).not.toBeNull();
    expect(button().querySelector("img")).toBeNull();
  });

  it("is docked to the left edge when the side is left", () => {
    mountRoot(tabCfg("left"));
    start();
    expect(button().classList.contains("sl")).toBe(true);
  });

  it("shows the avatar, else the shop's brand logo (page.logo), and never an unsafe URL", () => {
    mountRoot(tabCfg("right", { avatarUrl: "https://cdn.shopify.com/s/files/av.png" }), { logo: "https://cdn.shopify.com/s/files/logo.png" });
    start();
    expect(button().querySelector("img")!.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/av.png");
    document.body.innerHTML = "";
    mountRoot(tabCfg(), { logo: "https://cdn.shopify.com/s/files/logo.png" });
    start();
    expect(button().querySelector("img")!.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/logo.png");
    document.body.innerHTML = "";
    mountRoot(tabCfg(), { logo: "https://evil.com/logo.png" });
    start();
    expect(button().querySelector("img")).toBeNull();
  });

  it("is mid-height, with an accent dot, and its CSS has reduced-motion and a 44px+ target", () => {
    mountRoot(tabCfg());
    start();
    const css = shadow().querySelector("style")!.textContent!;
    expect(css).toMatch(/\.l\.tab\{top:50%;bottom:auto;right:0;width:56px;height:64px/);
    expect(css).toContain(".l.tab::after");
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.l,.t{animation:none;transition:none}}");
    expect(css).toContain("@media (hover:hover) and (prefers-reduced-motion:no-preference){.l:hover");
  });

  it("opens the chat on a click like the other styles", () => {
    mountRoot(tabCfg());
    start();
    button().click();
    expect(scripts()).toHaveLength(1);
  });

  it("the teaser sits next to the tab, not at the bottom", () => {
    vi.useFakeTimers();
    mountRoot(tabCfg("right", { teaser: { enabled: true, text: "Hi", delaySec: 1 } }));
    start();
    vi.advanceTimersByTime(1500);
    expect(teaser()!.style.top).toBe("50%");
    expect(teaser()!.style.right).toBe("64px");
    expect(teaser()!.style.bottom).toBe("");
  });
});

describe("restoring the chat on a page load", () => {
  it("reopens it as the drawer when it was a drawer", () => {
    localStorage.setItem(`askcart:${SHOP}:ui`, JSON.stringify({ open: true, drawer: true }));
    mountRoot();
    start();
    expect(widgetLoaded()).toHaveBeenCalledWith({ productId: null, focus: false, mode: "drawer" });
  });

  it("reopens the floating panel otherwise", () => {
    localStorage.setItem(`askcart:${SHOP}:ui`, JSON.stringify({ open: true, drawer: false }));
    mountRoot();
    start();
    expect(widgetLoaded()).toHaveBeenCalledWith({ productId: null, focus: false });
  });
});

describe("automatic block placement on Dawn-like markup", () => {
  const AI_SRC = "https://cdn.shopify.com/extensions/x/assets/askcart-ask-ai.js";
  const template = `<template data-askcart-ask-ai-auto data-script="${AI_SRC}"><link rel="stylesheet" href="x.css"><div class="askcart-ai" data-askcart-ask-ai></div></template>`;
  const dawn = `<main><div class="product__info-container">
    <div class="price-block"><p class="price">$20.00</p><p>Tax included.</p>
      <form action="/cart/add" id="product-form-installment-1" class="installment"><input type="hidden" name="id" value="1"></form></div>
    <div id="buy"><product-form class="product-form"><form action="/cart/add" id="product-form-1">
      <button type="submit" name="add">Add to cart</button><div class="shopify-payment-button"><button type="button">Buy it now</button></div>
    </form></product-form></div>
    <div id="after">Description</div></div></main>`;

  it("skips the hidden installment form and lands after the Buy buttons, including Buy it now", () => {
    document.body.insertAdjacentHTML("beforeend", dawn + template);
    mountRoot();
    start();
    const block = document.querySelector("[data-askcart-ask-ai]")!;
    expect(block.closest(".price-block")).toBeNull();
    expect(block.closest("product-form")).toBeNull();
    // right after the buy-buttons wrapper, before the description
    expect(document.querySelector("product-form")!.nextElementSibling!.matches("link")).toBe(true);
    expect(document.querySelector("#buy")!.contains(block)).toBe(true);
    expect(block.parentElement!.nextElementSibling!.id).toBe("after");
  });

  it("lands after a Buy it now button that sits outside the product-form wrapper", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<main><div id="buy"><product-form><form action="/cart/add"><button type="submit">Add</button></form></product-form>
        <div id="pay"><div class="shopify-payment-button"><button>Buy it now</button></div></div></div><p id="after"></p></main>` + template,
    );
    mountRoot();
    start();
    const block = document.querySelector("[data-askcart-ask-ai]")!;
    expect(document.querySelector("#pay")!.nextElementSibling!.matches("link")).toBe(true);
    expect(block.parentElement!.nextElementSibling!.id).toBe("after");
  });
});

