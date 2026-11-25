// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://customer-site.example.com/","settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";
import path from "node:path";
import { renderCards } from "../../widget/src/cards";
import { translator } from "../../widget/src/core/i18n";
import { openSheets } from "./core/helpers";
import type { Card, PageContext, WidgetApi, WidgetConfig, WidgetCtx } from "@/lib/widget-contract";

// Outside Shopify: the card opens the product on the store (docs/embed.md), and public/embed.js adds the launcher + iframe.

const page: PageContext = {
  shop: "demo.myshopify.com", locale: "en", country: null, currency: "USD", productId: null,
  cartAddUrl: "", cartUrl: "", privacyUrl: null, designMode: false, hosted: true,
};
const variant = (id: string, size: string, available = true): Card["variants"][number] => ({
  id, title: size, options: [{ name: "Size", value: size }], available,
  stock: { kind: "in_stock" }, price: "20.00", compareAtPrice: null,
});
const card: Card = {
  id: "gid://shopify/Product/1", title: "Linen tee", imageUrl: null, url: "https://demo.myshopify.com/products/tee",
  currency: "USD", available: true, action: "add", stock: { kind: "in_stock" }, price: "20.00", compareAtPrice: null,
  variants: [variant("11", "S"), variant("12", "M")], moreVariants: false,
};
const ctx = (over: Partial<PageContext> = {}): WidgetCtx => ({
  config: { stockThreshold: 5 } as WidgetConfig, page: { ...page, ...over }, api: {} as WidgetApi, t: translator("en"), announce: () => {},
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("cards on the hosted page", () => {
  let open: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    open = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal("fetch", fetchMock);
  });

  function pick(into: HTMLElement, value: string) {
    const select = into.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new Event("change"));
  }

  it("the button is labelled for the store and opens the product with the chosen variant in a new tab, no cart call", () => {
    const into = document.createElement("div");
    renderCards(into, [card], ctx());
    openSheets(into);
    const btn = into.querySelector<HTMLButtonElement>("button.ac-card__add")!;
    expect(btn.textContent).toBe("Buy on the store");
    pick(into, "M");
    btn.click();
    expect(open).toHaveBeenCalledWith("https://demo.myshopify.com/products/tee?variant=12", "_blank", "noopener,noreferrer");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(btn.textContent).toBe("Buy on the store");
  });

  it("product links open in a new tab, so they can't replace the chat inside the iframe", () => {
    const into = document.createElement("div");
    renderCards(into, [card], ctx());
    openSheets(into);
    expect(into.querySelector<HTMLAnchorElement>("a.ac-card__title")!.target).toBe("_blank");
  });

  it("an existing query on the product url is kept", () => {
    const into = document.createElement("div");
    renderCards(into, [{ ...card, url: "https://demo.myshopify.com/products/tee?utm=x" }], ctx());
    openSheets(into);
    pick(into, "S");
    into.querySelector<HTMLButtonElement>("button.ac-card__add")!.click();
    expect(open.mock.calls[0][0]).toBe("https://demo.myshopify.com/products/tee?utm=x&variant=11");
  });

  it("the theme embed is unchanged: Add to cart posts to the cart and same-tab links", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const into = document.createElement("div");
    renderCards(into, [card], ctx({ hosted: undefined, cartAddUrl: "/cart/add" }));
    openSheets(into);
    const btn = into.querySelector<HTMLButtonElement>("button.ac-card__add")!;
    expect(btn.textContent).toBe("Add to cart");
    expect(into.querySelector<HTMLAnchorElement>("a.ac-card__title")!.target).toBe("");
    pick(into, "M");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("embed.js", () => {
  const code = buildSync({
    entryPoints: [path.resolve(__dirname, "../../widget/src/embed.ts")],
    bundle: true, write: false, format: "iife", platform: "browser",
  }).outputFiles[0].text;

  function run(attrs: Record<string, string>, noBody = false) {
    const s = document.createElement("script");
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    document.body.append(s);
    Object.defineProperty(s, "src", { value: "https://askcart.example.com/embed.js" }); // happy-dom won't load a real src
    Object.defineProperty(document, "currentScript", { value: s, configurable: true });
    if (noBody) Object.defineProperty(document, "body", { value: null, configurable: true });
    try {
      (0, eval)(code);
    } finally {
      delete (document as { currentScript?: unknown }).currentScript;
      if (noBody) delete (document as { body?: unknown }).body;
    }
  }

  it("adds a launcher and loads nothing until it is clicked", () => {
    run({ "data-shop": "demo.myshopify.com" });
    expect(document.querySelector("#askcart-embed button")!.textContent).toBe("Chat");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("a click opens the hosted page for the shop in an iframe; another click closes it and the label comes back", () => {
    run({ "data-shop": "demo.myshopify.com", "data-label": "Ask us" });
    const btn = document.querySelector<HTMLButtonElement>("#askcart-embed button")!;
    btn.click();
    const frame = document.querySelector("iframe")!;
    expect(frame.src).toBe("https://askcart.example.com/chat/demo.myshopify.com");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toBe("\u00d7");
    expect(btn.getAttribute("aria-label")).toBe("Ask us"); // the name stays in the site's language; aria-expanded says open
    btn.click();
    expect(frame.hidden).toBe(true);
    expect(btn.textContent).toBe("Ask us");
    btn.click();
    expect(frame.hidden).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it.each(["", "evil.com", "a.myshopify.com/../x", "a.myshopify.com.evil.com"])("a bad data-shop %j adds nothing", (shop) => {
    run({ "data-shop": shop });
    expect(document.getElementById("askcart-embed")).toBeNull();
  });

  it("the iframe takes focus on open, and the hosted page's Escape message closes it", () => {
    run({ "data-shop": "demo.myshopify.com" });
    const btn = document.querySelector<HTMLButtonElement>("#askcart-embed button")!;
    btn.click();
    const frame = document.querySelector("iframe")!;
    const focus = vi.spyOn(frame, "focus");
    btn.click();
    btn.click();
    expect(focus).toHaveBeenCalledTimes(1);
    const send = (data: string, source: unknown) => window.dispatchEvent(Object.assign(new Event("message"), { data, source, origin: "https://askcart.example.com" }));
    send("askcart:close", window); // not from the iframe
    expect(frame.hidden).toBe(false);
    send("askcart:close", frame.contentWindow);
    expect(frame.hidden).toBe(true);
  });

  it("a bad data-shop is explained in the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    run({ "data-shop": "evil.com" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-shop"));
  });

  it("waits for the body when the script runs in the head", () => {
    run({ "data-shop": "demo.myshopify.com" }, true);
    expect(document.getElementById("askcart-embed")).toBeNull();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(document.getElementById("askcart-embed")).not.toBeNull();
  });

  it("a second copy of the script adds no second launcher", () => {
    run({ "data-shop": "demo.myshopify.com" });
    run({ "data-shop": "demo.myshopify.com" });
    expect(document.querySelectorAll("#askcart-embed")).toHaveLength(1);
  });
});
