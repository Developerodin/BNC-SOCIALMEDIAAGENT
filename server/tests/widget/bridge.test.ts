// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://demo.myshopify.com/","settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSync } from "esbuild";
import path from "node:path";
import { renderCards } from "../../widget/src/cards";
import { translator } from "../../widget/src/core/i18n";
import { openSheets } from "./core/helpers";
import type { Card, PageContext, WidgetApi, WidgetConfig, WidgetCtx } from "@/lib/widget-contract";

// The cart bridge (docs/embed.md): embed.js on the store's page answers the hosted chat's "add to cart" requests.

const APP = "https://askcart.example.com";
const STORE = "https://demo.myshopify.com";
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("store-page side (embed.js)", () => {
  const code = buildSync({
    entryPoints: [path.resolve(__dirname, "../../widget/src/embed.ts")],
    bundle: true, write: false, format: "iife", platform: "browser",
  }).outputFiles[0].text;
  let fetchMock: ReturnType<typeof vi.fn>;
  let frame: HTMLIFrameElement;
  let posted: ReturnType<typeof vi.fn>;

  function boot(shopify: object | null = { country: "FR", routes: { root: "/fr/" } }) {
    delete (window as { Shopify?: unknown }).Shopify;
    if (shopify) (window as { Shopify?: unknown }).Shopify = shopify;
    (window as { ShopifyAnalytics?: unknown }).ShopifyAnalytics = { meta: { product: { id: 4567 } } };
    const s = document.createElement("script");
    s.setAttribute("data-shop", "demo.myshopify.com");
    document.body.append(s);
    Object.defineProperty(s, "src", { value: `${APP}/embed.js` });
    Object.defineProperty(document, "currentScript", { value: s, configurable: true });
    try {
      (0, eval)(code);
    } finally {
      delete (document as { currentScript?: unknown }).currentScript;
    }
    document.querySelector<HTMLButtonElement>("#askcart-embed button")!.click();
    frame = document.querySelector("iframe")!;
    posted = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: posted }, configurable: true });
  }
  const send = (data: unknown, over: { source?: unknown; origin?: string } = {}) =>
    window.dispatchEvent(Object.assign(new Event("message"), { data, source: frame.contentWindow, origin: APP, ...over }));
  const valid = { type: "askcart:add", id: "n1", variantId: "123", qty: 2 };

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    delete (window as { Shopify?: unknown }).Shopify;
    delete (window as { ShopifyAnalytics?: unknown }).ShopifyAnalytics;
    document.body.replaceChildren();
  });

  it("passes bridge, country and product to the iframe only on a Shopify storefront", () => {
    boot();
    expect(new URL(frame.src).search).toBe("?bridge=1&country=FR&product=4567");
    document.body.replaceChildren();
    boot(null);
    expect(frame.src).toBe(`${APP}/chat/demo.myshopify.com`);
  });

  it("a malformed country is not passed on", () => {
    boot({ country: "fr; drop", routes: { root: "/" } });
    expect(new URL(frame.src).searchParams.get("country")).toBeNull();
  });

  it("adds a valid request through the theme cart code and replies to the app origin only", async () => {
    boot();
    send(valid);
    await flush();
    expect(fetchMock.mock.calls[0][0]).toBe("/fr/cart/add.js");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ items: [{ id: 123, quantity: 2 }] });
    expect(posted).toHaveBeenCalledWith({ type: "askcart:added", id: "n1", ok: true }, APP);
  });

  it("acks at once, before the cart call finishes, to the app origin only", async () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // a cart call that never returns
    boot();
    send(valid);
    await flush();
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith({ type: "askcart:received", id: "n1" }, APP);
  });

  it("relays the store's 422 message", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ description: "Sold out" }), { status: 422 }));
    boot();
    send(valid);
    await flush();
    expect(posted).toHaveBeenCalledWith({ type: "askcart:added", id: "n1", ok: false, message: "Sold out" }, APP);
  });

  it.each([
    ["wrong origin", valid, { origin: "https://evil.example" }],
    ["wrong source", valid, { source: window }],
    ["wrong type", { ...valid, type: "askcart:buy" }, {}],
    ["no id", { ...valid, id: undefined }, {}],
    ["non-numeric variant", { ...valid, variantId: "12a" }, {}],
    ["numeric variant", { ...valid, variantId: 123 }, {}],
    ["variant too long", { ...valid, variantId: "1".repeat(21) }, {}],
    ["qty 0", { ...valid, qty: 0 }, {}],
    ["qty 11", { ...valid, qty: 11 }, {}],
    ["fractional qty", { ...valid, qty: 1.5 }, {}],
    ["string qty", { ...valid, qty: "2" }, {}],
    ["a string", "askcart:add", {}],
    ["null", null, {}],
  ])("ignores %s: no cart call and no reply", async (_n, data, over) => {
    boot();
    send(data, over);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it("never answers off Shopify", async () => {
    boot(null);
    send(valid);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it("never answers while the iframe is closed", async () => {
    boot();
    document.querySelector<HTMLButtonElement>("#askcart-embed button")!.click();
    send(valid);
    await flush();
    expect(posted).not.toHaveBeenCalled();
  });
});

describe("hosted page side (cards)", () => {
  const base: PageContext = {
    shop: "demo.myshopify.com", locale: "en", country: null, currency: "USD", productId: null,
    cartAddUrl: "", cartUrl: "", privacyUrl: null, designMode: false, hosted: true,
  };
  const bridged = { bridge: true, parentOrigins: [STORE] };
  const card: Card = {
    id: "gid://shopify/Product/1", title: "Linen tee", imageUrl: null, url: `${STORE}/products/tee`,
    currency: "USD", available: true, action: "add", stock: { kind: "in_stock" }, price: "20.00", compareAtPrice: null,
    variants: [{ id: "11", title: "Default", options: [], available: true, stock: { kind: "in_stock" }, price: "20.00", compareAtPrice: null }],
    moreVariants: false,
  };
  let post: ReturnType<typeof vi.spyOn>;
  let open: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    open = vi.fn();
    vi.stubGlobal("open", open);
    post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function setup(over: Partial<PageContext> = bridged) {
    const into = document.createElement("div");
    const ctx: WidgetCtx = { config: { stockThreshold: 5 } as WidgetConfig, page: { ...base, ...over }, api: {} as WidgetApi, t: translator("en"), announce: () => {} };
    renderCards(into, [card], ctx);
    openSheets(into);
    return { btn: into.querySelector<HTMLButtonElement>("button.ac-card__add")!, status: into.querySelector(".ac-card__status")! };
  }
  const click = (btn: HTMLElement, trusted = true) => {
    const ev = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(ev, "isTrusted", { value: trusted });
    btn.dispatchEvent(ev);
  };
  const reply = (id: unknown, o: { source?: unknown; origin?: string; ok?: boolean; message?: string } = {}) =>
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: o.source ?? window, origin: o.origin ?? STORE, data: { type: "askcart:added", id, ok: o.ok ?? true, message: o.message },
    }));
  const ack = (id: unknown, o: { source?: unknown; origin?: string } = {}) =>
    window.dispatchEvent(Object.assign(new Event("message"), {
      source: o.source ?? window, origin: o.origin ?? STORE, data: { type: "askcart:received", id },
    }));
  const sentId = () => (post.mock.calls[0][0] as { id: string }).id;

  it("a trusted click posts the request to the store origin and shows Added + View cart on success", async () => {
    const { btn, status } = setup();
    expect(btn.textContent).toBe("Add to cart");
    click(btn);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([{ type: "askcart:add", id: expect.any(String), variantId: "11", qty: 1 }, STORE]);
    reply(sentId());
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toContain("Added");
    const a = status.querySelector<HTMLAnchorElement>("a")!;
    expect(a.href).toBe(`${STORE}/cart`);
    expect(a.target).toBe("_top");
    expect(open).not.toHaveBeenCalled();
  });

  it("an untrusted (scripted) click does nothing", () => {
    const { btn } = setup();
    click(btn, false);
    btn.click(); // happy-dom's own click is untrusted as well
    expect(post).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("shows the store's 422 message", async () => {
    const { btn, status } = setup();
    click(btn);
    reply(sentId(), { ok: false, message: "Only 1 left" });
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe("Only 1 left");
  });

  it.each([
    ["source", { source: {} }],
    ["origin", { origin: "https://evil.example" }],
  ])("ignores a reply or ack with the wrong %s, then falls back to Buy on the store", async (_n, o) => {
    const { btn, status } = setup();
    click(btn);
    ack(sentId(), o);
    reply(sentId(), o);
    await vi.advanceTimersByTimeAsync(1500);
    expect(btn.disabled).toBe(true); // still waiting for an ack
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.textContent).toBe("");
    expect(btn.textContent).toBe("Buy on the store");
  });

  it("ignores a reply or ack with another id", async () => {
    const { btn, status } = setup();
    click(btn);
    ack("other");
    reply("other");
    await vi.advanceTimersByTimeAsync(2100);
    expect(status.textContent).toBe("");
    expect(btn.textContent).toBe("Buy on the store");
  });

  it("no ack: falls back for the next click only, then the bridge is tried again", async () => {
    const { btn } = setup();
    click(btn);
    await vi.advanceTimersByTimeAsync(2100);
    expect(btn.textContent).toBe("Buy on the store");
    click(btn); // the fallback: the product link, no bridge call
    expect(open).toHaveBeenCalledWith(`${STORE}/products/tee?variant=11`, "_blank", "noopener,noreferrer");
    expect(post).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Add to cart");
    click(btn); // retry
    expect(post).toHaveBeenCalledTimes(2);
    ack((post.mock.calls[1][0] as { id: string }).id);
    reply((post.mock.calls[1][0] as { id: string }).id);
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.nextElementSibling!.textContent).toContain("Added");
  });

  describe("a slow cart (acked)", () => {
    let log: ReturnType<typeof vi.fn>;
    function setupLogged() {
      localStorage.setItem("askcart:demo.myshopify.com:token", "tok");
      log = vi.fn().mockResolvedValue(undefined);
      const into = document.createElement("div");
      const ctx: WidgetCtx = { config: { stockThreshold: 5 } as WidgetConfig, page: { ...base, ...bridged }, api: { logCartAdd: log } as unknown as WidgetApi, t: translator("en"), announce: () => {} };
      renderCards(into, [card], ctx, "m1");
      openSheets(into);
      return { btn: into.querySelector<HTMLButtonElement>("button.ac-card__add")!, status: into.querySelector(".ac-card__status")! };
    }
    afterEach(() => localStorage.clear());

    it("a final reply after 10 s is still a success, logged once", async () => {
      const { btn, status } = setupLogged();
      click(btn);
      ack(sentId());
      await vi.advanceTimersByTimeAsync(10000);
      expect(btn.textContent).toBe("Adding…");
      reply(sentId());
      await vi.advanceTimersByTimeAsync(0);
      expect(status.textContent).toContain("Added");
      expect(log).toHaveBeenCalledTimes(1);
    });

    it("an ack with no final reply shows Check your cart with the cart link, logs once, and a late reply changes nothing", async () => {
      const { btn, status } = setupLogged();
      click(btn);
      ack(sentId());
      await vi.advanceTimersByTimeAsync(15100);
      expect(status.textContent).toContain("Check your cart");
      expect(status.querySelector<HTMLAnchorElement>("a")!.href).toBe(`${STORE}/cart`);
      expect(btn.textContent).toBe("Add to cart"); // not flipped to Buy on the store
      expect(log).toHaveBeenCalledTimes(1);
      reply(sentId());
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it("a failed final reply after an ack is not logged", async () => {
      const { btn, status } = setupLogged();
      click(btn);
      ack(sentId());
      reply(sentId(), { ok: false, message: "Sold out" });
      await vi.advanceTimersByTimeAsync(0);
      expect(status.textContent).toBe("Sold out");
      expect(log).not.toHaveBeenCalled();
    });
  });

  it("without the bridge hint the hosted card is unchanged", () => {
    const { btn } = setup({});
    expect(btn.textContent).toBe("Buy on the store");
    btn.click();
    expect(open).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
