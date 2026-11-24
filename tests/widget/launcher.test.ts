// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../widget/src/launcher/launcher";
import type { PageContext, WidgetConfig } from "@/lib/widget-contract";

const SRC = "https://cdn.shopify.com/extensions/x/assets/askcart-widget.js";
const SHOP = "demo.myshopify.com";

function config(over: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    v: 1, enabled: true, apiBase: "https://app.example.com", name: "Demo", accent: "#0A0A0A", avatarUrl: null,
    launcher: { style: "pill", label: null, side: "right", offset: 20 },
    welcome: null, suggested: [], teaser: { enabled: false, text: null, delaySec: 8 },
    stockThreshold: 5, retentionDays: 30, ...over,
  };
}
const page: PageContext = {
  shop: SHOP, locale: "en", country: "US", currency: "USD", productId: null,
  cartAddUrl: "/cart/add", cartUrl: "/cart", privacyUrl: null, designMode: false,
};

// Mirrors the Liquid output: the strings come from locales/ as data attributes.
function mountRoot(cfg: WidgetConfig | string = config()) {
  const root = document.createElement("div");
  root.id = "askcart-root";
  root.hidden = true;
  root.dataset.config = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
  root.dataset.page = JSON.stringify(page);
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
    mountRoot(config({ launcher: { style: "pill", label: null, side: "left", offset: 60 } }));
    const stop = start();
    expect(button().style.left).toBe("20px");
    expect(button().style.right).toBe("");
    expect(button().style.bottom).toBe("60px");
    expect(document.body.lastElementChild?.tagName.toLowerCase()).toBe("askcart-host");
    stop?.();
  });

  it("the pill shows the merchant label", () => {
    mountRoot(config({ launcher: { style: "pill", label: "Need help?", side: "right", offset: 20 } }));
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
    mountRoot(config({ launcher: { style: "icon", label: null, side: "right", offset: 20 } }));
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
