// @vitest-environment happy-dom
// Task 30: the chat panel (UD3, UD4, UD13, UD16, UD17, UD18, D81, D83, D84). The API is mocked; cards and thumbs go
// through the CardsRenderer / FeedbackRenderer seams, injected here as spies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../widget/src/widget";
import { addToCart, resetCartCache } from "../../widget/src/cart";
import type { Panel } from "../../widget/src/panel/panel";
import { CSS } from "../../widget/src/panel/styles";
import type { Renderers } from "../../widget/src/panel/messages";
import type { FeedbackRenderer, HistoryItem, PageContext, WidgetApi, WidgetConfig } from "@/lib/widget-contract";
import { ev, jsonResponse, sseResponse } from "./core/helpers";
import { translator } from "../../widget/src/core/i18n";

const SHOP = "demo.myshopify.com";
const TOKEN_KEY = `askcart:${SHOP}:token`;

function config(over: Partial<WidgetConfig> = {}): WidgetConfig {
  return {
    v: 1, enabled: true, apiBase: "https://app.example.com", name: "Demo Store", accent: "#0A0A0A", avatarUrl: null,
    launcher: { style: "pill", label: null, side: "right", offset: 20, scope: "all" },
    welcome: "Hi! Ask me anything.", suggested: ["Do you ship to France?"], teaser: { enabled: false, text: null, delaySec: 8 },
    stockThreshold: 5, retentionDays: 30, ...over,
  };
}
function pageCtx(over: Partial<PageContext> = {}): PageContext {
  return {
    shop: SHOP, locale: "en", country: "US", currency: "USD", productId: null,
    cartAddUrl: "/cart/add", cartUrl: "/cart", privacyUrl: "https://demo.example/policies/privacy-policy", designMode: false, ...over,
  };
}

function mockApi(over: Partial<WidgetApi> = {}): WidgetApi & { [K in keyof WidgetApi]: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(),
    history: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => true),
    rate: vi.fn(async () => true),
    logCartAdd: vi.fn(async () => {}),
    latest: vi.fn(async () => null as string | null),
    faq: vi.fn(async () => []),
    ...over,
  } as never;
}

let host: HTMLElement;
let launcher: HTMLButtonElement;
let panel: Panel;
let renderCards: ReturnType<typeof vi.fn<Renderers["renderCards"]>>;
let renderFeedback: ReturnType<typeof vi.fn<FeedbackRenderer>>;

function setup(api: WidgetApi, cfg = config(), page = pageCtx()) {
  host = document.createElement("askcart-host");
  const shadow = host.attachShadow({ mode: "open" });
  launcher = document.createElement("button");
  launcher.className = "l";
  shadow.append(launcher);
  document.body.append(host);
  panel = mount(host, cfg, page, { api, launcher, renderCards, renderFeedback, wait: async () => {} });
  return panel;
}

const sh = () => host.shadowRoot!;
const q = <T extends Element = HTMLElement>(sel: string) => sh().querySelector<T>(sel);
const qa = (sel: string) => Array.from(sh().querySelectorAll<HTMLElement>(sel));
const input = () => q<HTMLTextAreaElement>("textarea")!;
const sendBtn = () => q<HTMLButtonElement>("button.send")!;
const bubbles = () => qa(".msg");
const assistantTexts = () => qa(".msg.bot .txt").map((e) => e.textContent);

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input"));
  sendBtn().click();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
  resetCartCache();
  localStorage.clear();
  sessionStorage.clear();
  renderCards = vi.fn<Renderers["renderCards"]>((into, cards) => {
    const d = document.createElement("div");
    d.className = "stub-cards";
    d.textContent = String(cards.length);
    into.append(d);
  });
  renderFeedback = vi.fn<FeedbackRenderer>((into) => {
    const d = document.createElement("div");
    d.className = "stub-thumbs";
    into.append(d);
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true })); // reduced motion: the panel hides at once (the animated close has its own tests)
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1280, height: 800 });
});
afterEach(() => {
  panel?.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rendering safety (Review Focus 1)", () => {
  it("a text delta with markup is shown as literal text and creates no element", async () => {
    const api = mockApi({
      send: vi.fn(async () => sseResponse([ev("text", { delta: "<img src=x onerror=alert(1)>" }), ev("done", { conversationToken: "t1", messageId: "m1" })])),
    });
    await setup(api).open();
    await type("hi");
    expect(assistantTexts()).toEqual(["<img src=x onerror=alert(1)>"]);
    expect(sh().querySelector("img")).toBeNull();
  });

  it("merchant name and welcome with markup stay text, and a non-CDN avatar is not loaded", async () => {
    await setup(mockApi(), config({ name: "<b>Shop</b>", welcome: "<script>x()</script>", avatarUrl: "https://evil.com/a.png" })).open();
    expect(q(".name")!.textContent).toBe("Your <b>Shop</b> AI expert");
    expect(q(".welcome")!.textContent).toBe("<script>x()</script>");
    expect(sh().querySelector("img, b, script")).toBeNull();
  });

  it("a cdn.shopify.com avatar is shown", async () => {
    await setup(mockApi(), config({ avatarUrl: "https://cdn.shopify.com/s/files/a.png" })).open();
    expect(q<HTMLImageElement>("img.avatar")!.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/a.png");
  });
});

describe("sending (D81)", () => {
  it("shows the user bubble, then the answer, then cards after done, then thumbs, and saves the token", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const card = { id: "gid://shopify/Product/1", title: "Mug" };
    const api = mockApi({
      send: vi.fn(async () => {
        const enc = new TextEncoder();
        let step = 0;
        return new Response(
          new ReadableStream({
            async pull(c) {
              if (step === 0) c.enqueue(enc.encode(ev("text", { delta: "Hel" })));
              else if (step === 1) c.enqueue(enc.encode(ev("product", card)));
              else if (step === 2) {
                await gate;
                c.enqueue(enc.encode(ev("text", { delta: "lo" }) + ev("done", { conversationToken: "t1", messageId: "m1" })));
              } else c.close();
              step++;
            },
          }),
          { status: 200 },
        );
      }),
    });
    await setup(api).open();
    input().value = "hello?";
    input().dispatchEvent(new Event("input"));
    sendBtn().click();
    await flush();
    expect(qa(".msg.user").map((e) => e.textContent)).toEqual(["hello?"]);
    expect(sendBtn().disabled).toBe(true);
    expect(renderCards).not.toHaveBeenCalled(); // cards wait for `done` (UD12)
    finish();
    await flush();
    expect(assistantTexts()).toEqual(["Hello"]);
    expect(renderCards).toHaveBeenCalledTimes(1);
    expect(renderCards.mock.calls[0][1]).toEqual([card]);
    expect(renderCards.mock.calls[0][3]).toBe("m1"); // cart adds from these cards are linked to the answer
    expect(renderFeedback).toHaveBeenCalledWith(expect.any(HTMLElement), "m1", null, expect.anything());
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t1");
    expect(api.send.mock.calls[0][0]).toMatchObject({ message: "hello?", token: null, productId: null, country: "US" });
    expect(input().value).toBe("");
  });

  it("each message gets a fresh requestId and the stored token", async () => {
    localStorage.setItem(TOKEN_KEY, "t0");
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "ok" }), ev("done", { conversationToken: "t0", messageId: null })])) });
    await setup(api).open();
    await type("a");
    await type("b");
    const [a, b] = api.send.mock.calls.map((c) => c[0]);
    expect(a.token).toBe("t0");
    expect(a.requestId).not.toBe(b.requestId);
    expect(renderFeedback).not.toHaveBeenCalled(); // no messageId, no thumbs
  });

  it("a dropped stream retried with the same requestId replaces the partial bubble (Review Focus 5)", async () => {
    const api = mockApi({
      send: vi
        .fn()
        .mockResolvedValueOnce(sseResponse([ev("text", { delta: "Hel" })], { error: true }))
        .mockResolvedValueOnce(sseResponse([ev("text", { delta: "Hello" }), ev("done", { conversationToken: "t1", messageId: "m1" })])),
    });
    await setup(api).open();
    await type("hi");
    expect(qa(".msg.bot")).toHaveLength(1);
    expect(assistantTexts()).toEqual(["Hello"]);
    const [a, b] = api.send.mock.calls.map((c) => c[0]);
    expect(b.requestId).toBe(a.requestId);
  });

  it("a daily-cap error shows the resting line with no Retry, and keeps the token", async () => {
    const api = mockApi({ send: vi.fn().mockResolvedValueOnce(sseResponse([ev("error", { code: "daily_cap", conversationToken: "t5" })])) });
    await setup(api).open();
    await type("hi");
    expect(q(".err")!.textContent).toContain("resting until tomorrow");
    expect(q(".err button")).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t5");
  });

  it("unavailable shows a Retry that reuses the requestId and keeps the token from the error event", async () => {
    const api = mockApi({
      send: vi
        .fn()
        .mockResolvedValueOnce(sseResponse([ev("error", { conversationToken: "t9" })]))
        .mockResolvedValueOnce(sseResponse([ev("text", { delta: "Now ok" }), ev("done", { conversationToken: "t9", messageId: "m2" })])),
    });
    await setup(api).open();
    await type("hi");
    expect(q(".err")!.textContent).toContain("unavailable");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t9");
    expect(sendBtn().disabled).toBe(true); // empty input
    q<HTMLButtonElement>(".err button")!.click();
    await flush();
    expect(q(".err")).toBeNull();
    expect(assistantTexts()).toEqual(["Now ok"]);
    expect(qa(".msg.user")).toHaveLength(1);
    const [a, b] = api.send.mock.calls.map((c) => c[0]);
    expect(b.requestId).toBe(a.requestId);
    expect(b.token).toBe("t9");
  });

  it("413 shows the too-long message", async () => {
    await setup(mockApi({ send: vi.fn(async () => jsonResponse(413, {})) })).open();
    await type("x");
    expect(q(".err")!.textContent).toBe("That message is too long. Please shorten it.");
  });

  it("an answer with cards and no text renders without an empty bubble (D85)", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("product", { id: "p" }), ev("done", { conversationToken: "t", messageId: "m" })])) });
    await setup(api).open();
    await type("x");
    expect(qa(".msg.bot .txt")).toHaveLength(0);
    expect(renderCards).toHaveBeenCalledTimes(1);
  });

  it("Enter sends, Shift+Enter does not", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("done", { conversationToken: "t", messageId: null })])) });
    await setup(api).open();
    input().value = "line";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    await flush();
    expect(api.send).not.toHaveBeenCalled();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it("the input is capped at 2,000 characters and shows a counter after 1,800", async () => {
    await setup(mockApi()).open();
    expect(input().maxLength).toBe(2000);
    input().value = "a".repeat(1700);
    input().dispatchEvent(new Event("input"));
    expect(q(".count")!.hidden).toBe(true);
    input().value = "a".repeat(1850);
    input().dispatchEvent(new Event("input"));
    expect(q(".count")!.hidden).toBe(false);
    expect(q(".count")!.textContent).toBe("1850/2000");
  });

  it("a suggested question is sent when tapped, and the suggestions go away", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("done", { conversationToken: "t", messageId: null })])) });
    await setup(api).open();
    const chip = qa(".sugg button").find((b) => b.textContent === "Do you ship to France?")!;
    chip.click();
    await flush();
    expect(api.send.mock.calls[0][0].message).toBe("Do you ship to France?");
    expect(q(".sugg")).toBeNull();
  });

  it("on a product page, up to 3 FAQ questions join the suggestions, and the product is the context (D7, C25)", async () => {
    const api = mockApi({
      faq: vi.fn(async () => [1, 2, 3, 4].map((i) => ({ question: `Q${i}?`, answer: "a" }))),
      send: vi.fn(async () => sseResponse([ev("done", { conversationToken: "t", messageId: null })])),
    });
    await setup(api).open({ productId: "42" });
    expect(api.faq).toHaveBeenCalledWith("42");
    expect(qa(".sugg button").map((b) => b.textContent)).toEqual(["Do you ship to France?", "Q1?", "Q2?", "Q3?"]);
    expect(api.send).not.toHaveBeenCalled(); // C25: nothing is sent automatically
    await type("hi");
    expect(api.send.mock.calls[0][0].productId).toBe("42");
  });
});

describe("product switch divider and jump to latest", () => {
  const items: HistoryItem[] = [
    { id: "u1", role: "user", content: "first?", status: "ok", cards: [], rating: null },
    { id: "a1", role: "assistant", content: "one", status: "ok", cards: [], rating: null },
  ];
  const viewing = { title: "Tee", image: null, price: 1999 };
  const dividers = () => qa(".divider").map((d) => d.textContent);
  afterEach(() => panel.close()); // a panel left open keeps its window listeners and would lock scrolling in the next test

  it("marks a move to another product once, not on a reload of the same page", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    localStorage.setItem(`askcart:${SHOP}:lastProduct`, "9");
    const api = mockApi({ history: vi.fn(async () => items) });
    await setup(api, config(), pageCtx({ productId: "1", viewing })).open();
    expect(dividers()).toEqual(["You're viewing: Tee"]);
    panel.close();
    host.remove();
    await setup(api, config(), pageCtx({ productId: "1", viewing })).open();
    expect(dividers()).toEqual([]);
  });

  it("adds none on the first product seen or without a conversation", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    await setup(mockApi({ history: vi.fn(async () => items) }), config(), pageCtx({ productId: "1", viewing })).open();
    expect(dividers()).toEqual([]);
    panel.close();
    host.remove();
    localStorage.setItem(`askcart:${SHOP}:lastProduct`, "9");
    localStorage.removeItem(TOKEN_KEY);
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing })).open();
    expect(dividers()).toEqual([]);
  });

  it("shows the jump button only while scrolled up and scrolls to the end on click", async () => {
    await setup(mockApi()).open();
    const log = q(".log")!;
    const jump = q<HTMLButtonElement>(".jump")!;
    expect(jump.hidden).toBe(true);
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(log, "clientHeight", { value: 400, configurable: true });
    log.scrollTop = 100;
    log.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(false);
    log.scrollTo = vi.fn() as never;
    jump.click();
    expect(log.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: expect.any(String) });
    expect(jump.hidden).toBe(true);
    log.scrollTop = 590;
    log.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(true);
  });
});

describe("history (UD13)", () => {
  const items: HistoryItem[] = [
    { id: "u1", role: "user", content: "first?", status: "ok", cards: [], rating: null },
    { id: "a1", role: "assistant", content: "one", status: "ok", cards: [{ id: "p1" } as never], rating: 1 },
    { id: "u2", role: "user", content: "second?", status: "ok", cards: [], rating: null },
    { id: "a2", role: "assistant", content: "two", status: "cut_off", cards: [{ id: "p2" } as never, { id: "p3" } as never], rating: null },
  ];

  it("2 turns render 4 bubbles with their cards, ratings and the cut-off note", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    const api = mockApi({ history: vi.fn(async () => items) });
    await setup(api).open();
    expect(api.history).toHaveBeenCalledWith("tok");
    expect(bubbles()).toHaveLength(4);
    expect(renderCards).toHaveBeenCalledTimes(2);
    expect(renderCards.mock.calls.map((c) => c[3])).toEqual(["a1", "a2"]);
    expect(renderFeedback).toHaveBeenCalledTimes(1); // not for the cut-off answer
    expect(renderFeedback.mock.calls[0].slice(1, 3)).toEqual(["a1", 1]);
    expect(q(".cut")!.textContent).toBe("This answer was cut off.");
    expect(q(".sugg")).toBeNull(); // suggestions are for an empty chat
  });

  it("404 drops the token and starts an empty chat", async () => {
    localStorage.setItem(TOKEN_KEY, "dead");
    await setup(mockApi({ history: vi.fn(async () => "reset" as const) })).open();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(bubbles()).toHaveLength(0);
    expect(q(".welcome")!.textContent).toBe("Hi! Ask me anything.");
  });

  it("no local token but a signed-in shopper's latest chat: it is opened and kept", async () => {
    const api = mockApi({ latest: vi.fn(async () => "app-tok") });
    await setup(api).open();
    expect(api.history).toHaveBeenCalledWith("app-tok");
    expect(localStorage.getItem(`askcart:${SHOP}:token`)).toBe("app-tok");
  });

  it("a local token wins: the latest chat is not looked up", async () => {
    localStorage.setItem(`askcart:${SHOP}:token`, "tok");
    const api = mockApi();
    await setup(api).open();
    expect(api.latest).not.toHaveBeenCalled();
  });

  it("no token, no history call", async () => {
    const api = mockApi();
    await setup(api).open();
    expect(api.history).not.toHaveBeenCalled();
  });

  it("open and closed are saved for the next page", async () => {
    await setup(mockApi()).open();
    expect(JSON.parse(localStorage.getItem(`askcart:${SHOP}:ui`)!).open).toBe(true);
    panel.close();
    expect(JSON.parse(localStorage.getItem(`askcart:${SHOP}:ui`)!).open).toBe(false);
  });
});

describe("menu (C22)", () => {
  async function openMenu() {
    q<HTMLButtonElement>("button.menu")!.click();
    await flush(2);
  }
  const item = (label: string) => qa("[role=menuitem]").find((b) => b.textContent === label)!;

  it("Delete chat confirms, calls DELETE with the token, then empties the chat and drops the token (D84)", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const api = mockApi({ history: vi.fn(async () => [{ id: "u", role: "user", content: "x", status: "ok", cards: [], rating: null }] as HistoryItem[]) });
    await setup(api).open();
    expect(bubbles()).toHaveLength(1);
    await openMenu();
    item("Delete chat").click();
    await flush();
    expect(confirm).toHaveBeenCalled();
    expect(api.deleteConversation).toHaveBeenCalledWith("tok");
    expect(bubbles()).toHaveLength(0);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(q(".welcome")).not.toBeNull();
  });

  it("Delete chat sends the token in the X-Conversation-Token header with the real client", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    vi.stubGlobal("confirm", () => true);
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/history") ? jsonResponse(200, { messages: [] }) : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    panel = mount(host, config(), pageCtx());
    await panel.open();
    q<HTMLButtonElement>("button.menu")!.click();
    item("Delete chat").click();
    await flush();
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(String(del[0])).toBe(`https://app.example.com/api/chat/conversation?shop=${SHOP}`);
    expect((del[1]!.headers as Record<string, string>)["X-Conversation-Token"]).toBe("tok");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("a cancelled confirm deletes nothing", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    vi.stubGlobal("confirm", () => false);
    const api = mockApi();
    await setup(api).open();
    await openMenu();
    item("Delete chat").click();
    await flush();
    expect(api.deleteConversation).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
  });

  it("a failed delete keeps the token and says so", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    vi.stubGlobal("confirm", () => true);
    await setup(mockApi({ deleteConversation: vi.fn(async () => false) })).open();
    await openMenu();
    item("Delete chat").click();
    await flush();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(q(".err")!.textContent).toBe("Couldn't delete the chat. Please try again.");
  });

  // A first answer that sends meta, then hangs until the request is aborted (as fetch errors the body on abort).
  function metaThenHang(token: string) {
    return vi.fn(async (args: Parameters<WidgetApi["send"]>[0]) => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(ev("meta", { conversationToken: token }) + ev("text", { delta: "Thinking" })));
            args.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { status: 200 },
      );
    });
  }

  it("D84: Delete chat during the first answer aborts it, then deletes the conversation named by meta", async () => {
    vi.stubGlobal("confirm", () => true);
    const order: string[] = [];
    const api = mockApi({ send: metaThenHang("tmeta") });
    api.deleteConversation.mockImplementation(async () => {
      order.push(`delete:${(api.send.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted}`);
      return true;
    });
    await setup(api).open();
    await type("hi");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tmeta"); // saved as soon as meta arrived
    expect(assistantTexts()).toEqual(["Thinking"]);
    await openMenu();
    item("Delete chat").click();
    await flush();
    expect(api.deleteConversation).toHaveBeenCalledWith("tmeta");
    expect(order).toEqual(["delete:true"]); // the turn was aborted first
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(bubbles()).toHaveLength(0);
    expect(q(".err")).toBeNull();
    expect(sendBtn().disabled).toBe(true); // empty input; but not stuck busy:
    input().value = "again";
    input().dispatchEvent(new Event("input"));
    expect(sendBtn().disabled).toBe(false);
  });

  it("D84: a 409 (the server still holds the turn) is retried with backoff, then the 204 deletes", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    vi.stubGlobal("confirm", () => true);
    const statuses = [409, 204];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) =>
      String(url).includes("/history")
        ? jsonResponse(200, { messages: [] })
        : init?.method === "DELETE"
          ? new Response(statuses[0] === 409 ? JSON.stringify({ error: "turn_in_progress" }) : null, { status: statuses.shift()! })
          : jsonResponse(500, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const waits: number[] = [];
    host = document.createElement("div");
    document.body.append(host);
    panel = mount(host, config(), pageCtx(), { wait: async (ms) => void waits.push(ms) });
    await panel.open();
    q<HTMLButtonElement>("button.menu")!.click();
    item("Delete chat").click();
    await flush();
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(2);
    expect(waits).toEqual([500]);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(q(".err")).toBeNull();
  });

  it("D84: a delete that keeps failing gives up after 0.5, 1 and 2 s and says so", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    vi.stubGlobal("confirm", () => true);
    const waits: number[] = [];
    const api = mockApi({ deleteConversation: vi.fn(async () => false) });
    host = document.createElement("askcart-host");
    host.attachShadow({ mode: "open" });
    document.body.append(host);
    panel = mount(host, config(), pageCtx(), { api, renderCards, renderFeedback, wait: async (ms) => void waits.push(ms) });
    await panel.open();
    await openMenu();
    item("Delete chat").click();
    await flush();
    expect(api.deleteConversation).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([500, 1000, 2000]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(q(".err")!.textContent).toBe("Couldn't delete the chat. Please try again.");
  });

  it("New chat only drops the token locally", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    const api = mockApi({ history: vi.fn(async () => [{ id: "u", role: "user", content: "x", status: "ok", cards: [], rating: null }] as HistoryItem[]) });
    await setup(api).open();
    q<HTMLButtonElement>("button.newchat")!.click();
    await flush();
    expect(api.deleteConversation).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(bubbles()).toHaveLength(0);
    expect(q(".sugg")).not.toBeNull();
  });

  it("the menu is labelled, toggles aria-expanded and closes on Escape without closing the panel", async () => {
    await setup(mockApi()).open();
    const btn = q<HTMLButtonElement>("button.menu")!;
    expect(btn.getAttribute("aria-label")).toBe("Chat options");
    await openMenu();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    item("Delete chat").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(q(".panel")!.hidden).toBe(false);
  });

  it("Escape from a menu item returns focus to the menu button", async () => {
    await setup(mockApi()).open();
    await openMenu();
    item("Delete chat").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(sh().activeElement).toBe(q("button.menu"));
  });
});

describe("header and empty state", () => {
  it("shows the store's initial as a monogram when there is no avatar, 'Your {store} AI expert' and the AI line", async () => {
    await setup(mockApi(), config({ name: "maison bleue" })).open();
    expect(q(".avatar.initial")!.textContent).toBe("M");
    expect(q("img.avatar")).toBeNull();
    expect(q(".hd .name")!.textContent).toBe("Your maison bleue AI expert");
    expect(q(".hd .sub")).toBeNull(); // the AI notice moved above the input
    expect(q(".ft .notice")!.nextElementSibling!.classList.contains("row")).toBe(true);
  });

  it("the header says it in every language and always keeps the AI notice above the input", async () => {
    const expected: Record<string, string> = {
      en: "Your Demo Store AI expert", fr: "Votre expert IA Demo Store", de: "Ihr KI-Experte von Demo Store",
      es: "Tu experto IA de Demo Store", it: "Il tuo esperto IA Demo Store", nl: "Jouw AI-expert van Demo Store",
    };
    for (const [locale, name] of Object.entries(expected)) {
      document.body.innerHTML = "";
      await setup(mockApi(), config(), pageCtx({ locale })).open();
      expect(q(".hd .name")!.textContent).toBe(name);
      expect(q(".ft .notice")!.textContent).toContain(translator(locale)("ai_notice"));
      expect(q(".ft .notice")!.hidden).toBe(false);
      panel.destroy();
    }
  });

  it("shows 'You're viewing' with photo, title and price from page.viewing, hidden when absent", async () => {
    const viewing = { title: "Linen <b>tee</b>", image: "https://cdn.shopify.com/s/files/tee.jpg", price: 2000 };
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing })).open();
    const card = q(".viewing")!;
    expect(card.hidden).toBe(false);
    expect(q(".vw-label")!.textContent).toBe("$20.00 · You're viewing");
    expect(q(".vw-title")!.textContent).toBe("Linen <b>tee</b>");
    expect(q(".vw-title")!.nextElementSibling).toBe(q(".vw-label"));
    expect(card.querySelector("img")!.getAttribute("src")).toBe(viewing.image);
    expect(card.querySelector("b")).toBeNull();
    panel.destroy();
    document.body.innerHTML = "";
    await setup(mockApi()).open();
    expect(q(".viewing")!.hidden).toBe(true);
  });

  it("an unsafe viewing image is not loaded, and a viewing without a title is hidden", async () => {
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing: { title: "Tee", image: "https://evil.com/a.png", price: null } })).open();
    expect(q(".viewing")!.hidden).toBe(false);
    expect(q(".viewing img")).toBeNull();
    expect(q(".vw-price")).toBeNull();
    panel.destroy();
    document.body.innerHTML = "";
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing: { title: " ", image: null, price: null } })).open();
    expect(q(".viewing")!.hidden).toBe(true);
  });

  it("the viewing card follows the page's product: opening the chat for another product hides it", async () => {
    const p = setup(mockApi(), config(), pageCtx({ productId: "1", viewing: { title: "Tee", image: null, price: null } }));
    await p.open({});
    expect(q(".viewing")!.hidden).toBe(false);
    await p.open({ productId: "2" });
    expect(q(".viewing")!.hidden).toBe(true);
  });

  it("a card thumbnail opens the detail sheet inside the panel and Add to cart posts the picked variant", async () => {
    const card = {
      id: "gid://shopify/Product/1", title: "Mug", imageUrl: null, url: "https://demo.example/products/mug", currency: "USD", available: true,
      action: "add", stock: { kind: "in_stock" }, price: "5.00", compareAtPrice: null, moreVariants: false,
      variants: [{ id: "77", title: "Default Title", options: [{ name: "Title", value: "Default Title" }], available: true, stock: { kind: "in_stock" }, price: "5.00", compareAtPrice: null }],
    };
    const { renderCards: real } = await import("../../widget/src/cards");
    renderCards = vi.fn<Renderers["renderCards"]>(real as never);
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/cart.js") ? jsonResponse(200, { items: [] }) : jsonResponse(200, { items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("product", card), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api, config(), pageCtx({ cartAddUrl: "https://demo.example/cart/add.js" })).open();
    await type("a mug");
    q<HTMLButtonElement>(".ac-tile")!.click();
    expect(q(".panel > .ac-sheet")).not.toBeNull();
    expect(q(".log")!.hasAttribute("inert")).toBe(true);
    qa(".ac-sheet button").find((b) => b.textContent === "Add to cart")!.click();
    await flush();
    const add = fetchMock.mock.calls.find(([u, init]) => String(u).includes("/cart/add") && init?.method === "POST")!;
    expect(JSON.parse(String(add[1]!.body))).toMatchObject({ items: [{ id: 77 }] });
    q<HTMLButtonElement>(".ac-sheet__back")!.click();
    expect(q(".log")!.hasAttribute("inert")).toBe(false);
  });

  it("header actions: cart link, New chat and close", async () => {
    await setup(mockApi(), config(), pageCtx({ cartUrl: "https://demo.example/cart" })).open();
    expect(q<HTMLAnchorElement>("a.cart")!.getAttribute("href")).toBe("https://demo.example/cart");
    expect(q<HTMLAnchorElement>("a.cart")!.getAttribute("aria-label")).toBe("Cart");
    expect(q("button.newchat")!.getAttribute("aria-label")).toBe("New chat");
    expect(q<HTMLButtonElement>("button.close")!.hidden).toBe(false);
  });

  it("the cart link is hidden when there is no cart URL (the hosted page)", async () => {
    await setup(mockApi(), config(), pageCtx({ cartUrl: "", hosted: true })).open();
    expect(q<HTMLAnchorElement>("a.cart")!.hidden).toBe(true);
  });

  describe("cart count on the cart icon", () => {
    const badge = () => q("a.cart .cbadge")!;
    const stubCart = (item_count: number) => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [{ variant_id: 1, quantity: item_count }], item_count })));
    };
    const openCart = async (over: Partial<PageContext> = {}) => {
      await setup(mockApi(), config(), pageCtx({ cartUrl: "https://demo.example/cart", ...over })).open();
      await flush();
    };

    it("shows the cart's item_count when the panel opens, and names it on the link", async () => {
      stubCart(3);
      await openCart();
      expect(badge().hidden).toBe(false);
      expect(badge().textContent).toBe("3");
      expect(q("a.cart")!.getAttribute("aria-label")).toBe("Cart, 3 items");
    });

    it("says '1 item' for one", async () => {
      stubCart(1);
      await openCart();
      expect(q("a.cart")!.getAttribute("aria-label")).toBe("Cart, 1 item");
    });

    it("is hidden at 0 and the link keeps its plain name", async () => {
      stubCart(0);
      await openCart();
      expect(badge().hidden).toBe(true);
      expect(q("a.cart")!.getAttribute("aria-label")).toBe("Cart");
    });

    it("reads 9+ above 9", async () => {
      stubCart(12);
      await openCart();
      expect(badge().textContent).toBe("9+");
      expect(q("a.cart")!.getAttribute("aria-label")).toBe("Cart, 12 items");
    });

    it("goes up by the quantity after a successful add from the chat, not after a failed one", async () => {
      let count = 2; // what cart.js says now: a successful add makes it 3 higher, and the badge re-reads it
      const add = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
        count += 3;
        return jsonResponse(200, { items: [] });
      });
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
        String(url).endsWith("/cart.js") ? jsonResponse(200, { items: [], item_count: count }) : add(url, init)));
      await openCart();
      expect(badge().textContent).toBe("2");
      add.mockResolvedValueOnce(jsonResponse(422, { description: "No." }));
      await addToCart({ cartAddUrl: "/cart/add" }, "5", 3);
      await flush();
      expect(badge().textContent).toBe("2");
      await addToCart({ cartAddUrl: "/cart/add" }, "5", 3);
      await flush();
      expect(badge().textContent).toBe("5");
      expect(q("a.cart")!.getAttribute("aria-label")).toBe("Cart, 5 items");
    });

    it("is re-read each time the panel opens", async () => {
      stubCart(1);
      const p = setup(mockApi(), config(), pageCtx({ cartUrl: "https://demo.example/cart" }));
      await p.open(); await flush();
      expect(badge().textContent).toBe("1");
      stubCart(4);
      p.close();
      await p.open();
      await flush();
      expect(badge().textContent).toBe("4");
    });

    it("is not read or shown on the hosted page", async () => {
      const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { items: [], item_count: 3 }));
      vi.stubGlobal("fetch", f);
      await openCart({ hosted: true });
      await flush();
      expect(badge().hidden).toBe(true);
      expect(f.mock.calls.some(([u]) => String(u).endsWith("/cart.js"))).toBe(false);
    });
  });

  it("the placeholder is 'Ask a question…' until the first message, then 'Continue the conversation'", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "Hi" }), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api).open();
    expect(input().placeholder).toBe("Ask a question…");
    await type("hello");
    expect(input().placeholder).toBe("Continue the conversation");
    q<HTMLButtonElement>("button.newchat")!.click();
    expect(input().placeholder).toBe("Ask a question…");
  });

  it("a chat with history starts on 'Continue the conversation'", async () => {
    localStorage.setItem(TOKEN_KEY, "tok");
    const api = mockApi({ history: vi.fn(async () => [{ id: "u", role: "user", content: "x", status: "ok", cards: [], rating: null }] as HistoryItem[]) });
    await setup(api).open();
    expect(input().placeholder).toBe("Continue the conversation");
  });

  it("plain-text answers and outlined shopper pills are styled at class level", () => {
    expect(CSS).toMatch(/\.msg\.user\{[^}]*border:1px solid[^}]*background:transparent/);
    expect(CSS).toMatch(/\.msg\.user\{[^}]*align-self:flex-end/);
    expect(CSS).not.toMatch(/\.msg\.bot \.txt\{[^}]*(background|border)/);
  });

  it("uses the avatar image when the config has one", async () => {
    await setup(mockApi(), config({ avatarUrl: "https://cdn.shopify.com/s/a.png" })).open();
    expect(q<HTMLImageElement>("img.avatar")!.src).toBe("https://cdn.shopify.com/s/a.png");
    expect(q(".avatar.initial")).toBeNull();
  });

  it("the welcome and the chips sit together at the top of an empty chat", async () => {
    await setup(mockApi(), config({ suggested: ["A?", "B?", "C?"] })).open();
    await flush();
    expect(q(".log")!.firstElementChild!.className).toBe("welcome");
    expect(qa(".sugg button").map((b) => b.textContent)).toEqual(["A?", "B?", "C?"]);
  });

  it("the status line goes away at the first token", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "Hi" }), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api).open();
    await type("hello");
    expect(q(".status")).toBeNull();
    expect(assistantTexts()).toEqual(["Hi"]);
  });

  it("the status row shows the default text at once, follows status events (skipping unknown steps) and is replaced by the first text", async () => {
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start: (k) => void (c = k) });
    const api = mockApi({ send: vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) });
    await setup(api).open();
    await type("hello");
    const t = translator("en");
    const row = () => q(".status")!;
    expect(row().textContent).toBe("Understanding your question…");
    expect(row().getAttribute("role")).toBe("status");
    expect(row().getAttribute("aria-live")).toBe("polite");
    expect(row().querySelector("svg")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    for (const [step, key] of [["searching", "status_searching"], ["checking", "status_checking"], ["policies", "status_policies"], ["collection", "status_collection"], ["orders", "status_orders"], ["writing", "status_writing"]] as const) {
      c.enqueue(enc.encode(ev("status", { step })));
      await flush();
      expect(row().textContent).toBe(t(key));
    }
    expect(row().textContent).toBe("Writing the answer…");
    c.enqueue(enc.encode(ev("status", { step: "teleporting" })));
    await flush();
    expect(row().textContent).toBe("Writing the answer…");
    c.enqueue(enc.encode(ev("text", { delta: "Hi" })));
    await flush();
    expect(q(".status")).toBeNull();
    expect(assistantTexts()).toEqual(["Hi"]);
    c.enqueue(enc.encode(ev("done", { conversationToken: "t1", messageId: "m1" })));
    c.close();
    await flush();
  });


  it("every animation in the panel CSS is switched off under prefers-reduced-motion", async () => {
    await setup(mockApi()).open();
    const css = q("style")!.textContent!;
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(css).toContain("animation:in .22s cubic-bezier(0.22,1,0.36,1)");
    expect(reduced).toContain(".panel,.panel.full:not(.drawer),.msg.in,.status,.err,.cards.in,.nw,.scrim{animation:none}");
    expect(reduced).toContain(".stx{animation:none;background:none");
  });
});

describe("a11y (UD17)", () => {
  it("Tab from the last control wraps to the first, Shift+Tab from the first wraps to the last", async () => {
    await setup(mockApi()).open();
    const focusables = qa(".panel button:not([disabled]):not([hidden]), .panel textarea, .panel a[href]").filter((e) => !e.closest("[hidden]"));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }));
    expect(sh().activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, composed: true }));
    expect(sh().activeElement).toBe(last);
  });

  it("Esc closes and returns focus to the launcher", async () => {
    await setup(mockApi()).open();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(q(".panel")!.hidden).toBe(true);
    expect(sh().activeElement).toBe(launcher);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });

  it("open focuses the input, and focus: false (a reopen on page load) leaves focus alone", async () => {
    await setup(mockApi()).open();
    expect(sh().activeElement).toBe(input());
    panel.close();
    document.body.focus();
    await panel.open({ focus: false });
    expect(sh().activeElement).not.toBe(input());
  });

  it("the live region gets the final answer once, not every delta, and the log itself is not live", async () => {
    const api = mockApi({
      send: vi.fn(async () =>
        sseResponse([ev("text", { delta: "Hel" }), ev("text", { delta: "lo" }), ev("done", { conversationToken: "t", messageId: null })]),
      ),
    });
    await setup(api).open();
    const live = q("[aria-live=polite]")!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(live.textContent ?? "")).observe(live, { childList: true, characterData: true, subtree: true });
    await type("hi");
    expect(seen.filter((s) => s !== "")).toEqual(["Hello"]);
    expect(q("[role=log]")!.getAttribute("aria-live")).toBe("off");
  });

  it("every button has an accessible name", async () => {
    await setup(mockApi()).open();
    q<HTMLButtonElement>("button.menu")!.click();
    for (const b of qa("button")) {
      if (b === launcher) continue;
      expect((b.getAttribute("aria-label") || b.textContent || "").trim()).not.toBe("");
    }
  });

  it("the panel is a labelled dialog, and the accent text colour comes from textOn", async () => {
    await setup(mockApi(), config({ accent: "#FFE600" })).open();
    const p = q(".panel")!;
    expect(p.getAttribute("role")).toBe("dialog");
    expect(p.getAttribute("aria-label")).toBe("Demo Store");
    expect(p.style.getPropertyValue("--ac-fg")).toBe("#000000");
  });

  it("a bad accent never reaches CSS", async () => {
    await setup(mockApi(), config({ accent: "red;}x{" })).open();
    expect(q(".panel")!.style.getPropertyValue("--ac")).toBe("#0A0A0A");
  });

  it("input and suggestion borders reach 3:1 on white, and the textarea is 16 px so iOS doesn't zoom", async () => {
    await setup(mockApi()).open();
    const css = sh().querySelector("style")!.textContent!;
    expect(css).not.toMatch(/#ccc|#c9c9c9/i);
    expect(css).toMatch(/textarea\{[^}]*font-size:16px/);
    expect(css).toMatch(/\.sugg button\{[^}]*border:1px solid #8a8a8a/);
    expect(css).toMatch(/\.ac-card__select\{[^}]*border:1px solid #8a8a8a/);
  });

  it("reduced motion turns the animations off in the stylesheet", async () => {
    await setup(mockApi()).open();
    const css = qa("style").map((s) => s.textContent).join("");
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).not.toMatch(/\d(rem|em)\b/);
  });
});

describe("notice (UD16, D83)", () => {
  it("always shows the AI line and the retention period, and links a safe privacy URL", async () => {
    await setup(mockApi(), config({ retentionDays: 90 })).open();
    const n = q(".notice")!;
    expect(n.textContent).toContain("You're chatting with an AI assistant.");
    expect(n.textContent).toContain("Chats are kept for 90 days.");
    const a = n.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://demo.example/policies/privacy-policy");
    expect(a.rel).toContain("noopener");
  });

  it("a javascript: privacy URL gives no link, but the AI line stays", async () => {
    await setup(mockApi(), config(), pageCtx({ privacyUrl: "javascript:alert(1)" })).open();
    expect(q(".notice a")).toBeNull();
    expect(q(".notice")!.textContent).toContain("You're chatting with an AI assistant.");
  });

  it("no privacy URL, no link", async () => {
    await setup(mockApi(), config(), pageCtx({ privacyUrl: null })).open();
    expect(q(".notice a")).toBeNull();
  });
});

describe("i18n (UD18)", () => {
  it("German labels, merchant text unchanged", async () => {
    await setup(mockApi(), config(), pageCtx({ locale: "de" })).open();
    expect(sendBtn().getAttribute("aria-label")).toBe("Senden");
    expect(q(".notice")!.textContent).toContain("Du chattest mit einem KI-Assistenten.");
    expect(q(".welcome")!.textContent).toBe("Hi! Ask me anything.");
    expect(q(".name")!.textContent).toBe("Ihr KI-Experte von Demo Store");
  });
});

describe("layout (UD3, UD4)", () => {
  it("desktop: a floating panel with a close button and no back arrow", async () => {
    await setup(mockApi()).open();
    expect(q(".panel")!.classList.contains("full")).toBe(false);
    expect(q<HTMLButtonElement>("button.back")!.hidden).toBe(true);
    expect(q<HTMLButtonElement>("button.close")!.hidden).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("a 375 px viewport gives the full-screen panel with a back arrow and locks page scrolling", async () => {
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 375, height: 700 });
    await setup(mockApi()).open();
    expect(q(".panel")!.classList.contains("full")).toBe(true);
    expect(q<HTMLButtonElement>("button.back")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>("button.close")!.hidden).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
    q<HTMLButtonElement>("button.back")!.click();
    expect(q(".panel")!.hidden).toBe(true);
    expect(document.documentElement.style.overflow).toBe("");
  });
});

describe("offline", () => {
  it("an offline event disables Send and shows a banner; online re-enables it", async () => {
    await setup(mockApi()).open();
    input().value = "hi";
    input().dispatchEvent(new Event("input"));
    expect(sendBtn().disabled).toBe(false);
    window.dispatchEvent(new Event("offline"));
    expect(sendBtn().disabled).toBe(true);
    expect(q(".offline")!.hidden).toBe(false);
    window.dispatchEvent(new Event("online"));
    expect(sendBtn().disabled).toBe(false);
    expect(q(".offline")!.hidden).toBe(true);
  });
});

describe("widget entry (window.AskCart)", () => {
  it("open() mounts once into the launcher's host, with the real card renderer, and close() returns focus", async () => {
    const root = document.createElement("div");
    root.id = "askcart-root";
    root.dataset.config = JSON.stringify(config());
    root.dataset.page = JSON.stringify(pageCtx());
    document.body.append(root);
    host = document.createElement("askcart-host");
    const shadow = host.attachShadow({ mode: "open" });
    launcher = document.createElement("button");
    launcher.className = "l";
    shadow.append(launcher);
    document.body.append(host);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [] })));

    const AskCart = (window as unknown as { AskCart: { open(a: unknown): void; close(): void; mount: unknown } }).AskCart;
    expect(typeof AskCart.mount).toBe("function");
    AskCart.open({ productId: null });
    AskCart.open({ productId: null, focus: false });
    await flush();
    expect(sh().querySelectorAll(".panel")).toHaveLength(1);
    expect(q(".panel")!.hidden).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(qa("style").some((s) => s.textContent!.includes(".ac-card"))).toBe(true);
    AskCart.close();
    expect(q(".panel")!.hidden).toBe(true);
    expect(sh().activeElement).toBe(launcher);
  });
});

describe("inline (the hosted page)", () => {
  it("fills the window on a desktop, has no close or back button, and can't be closed", async () => {
    host = document.createElement("askcart-host");
    document.body.append(host);
    panel = mount(host, config(), pageCtx({ hosted: true }), { api: mockApi(), renderCards, renderFeedback, inline: true });
    await panel.open({ focus: false });
    expect(q(".panel")!.classList.contains("full")).toBe(true);
    expect(q(".panel")!.classList.contains("inline")).toBe(true);
    expect(q<HTMLButtonElement>("button.close")!.hidden).toBe(true);
    expect(q<HTMLButtonElement>("button.back")!.hidden).toBe(true);
    panel.close();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(q(".panel")!.hidden).toBe(false);
  });
});

describe("expanded mode", () => {
  // Expand / Collapse lives in the header menu now.
  const openMenu = () => q<HTMLButtonElement>("button.menu")!.click();
  const item = () => qa(".mlist button")[0] as HTMLButtonElement;
  const UI_KEY = `askcart:${SHOP}:ui`;

  it("toggles the wide class, aria-pressed and label, and persists the choice", async () => {
    await setup(mockApi()).open();
    expect(q("button.wide-btn")).toBeNull();
    openMenu();
    expect(item().hidden).toBe(false);
    expect(item().textContent).toBe("Expand");
    item().click();
    expect(q(".panel")!.classList.contains("wide")).toBe(true);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!).wide).toBe(true);
    openMenu();
    expect(item().textContent).toBe("Collapse");
    item().click();
    expect(q(".panel")!.classList.contains("wide")).toBe(false);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!).wide).toBe(false);
  });

  it("restores the saved choice when the panel opens, and Escape still closes", async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({ wide: true }));
    await setup(mockApi()).open();
    expect(q(".panel")!.classList.contains("wide")).toBe(true);
    openMenu();
    expect(item().textContent).toBe("Collapse");
    q<HTMLButtonElement>("button.menu")!.click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(q(".panel")!.hidden).toBe(true);
  });

  it("is hidden on a narrow screen (already a full sheet) and never applies there", async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({ wide: true }));
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 400, height: 800 });
    await setup(mockApi()).open(); // beforeEach puts the viewport back
    openMenu();
    expect(item().hidden).toBe(true);
    expect(q(".panel")!.classList.contains("wide")).toBe(false);
  });

  it("is hidden on the hosted page", async () => {
    host = document.createElement("askcart-host");
    host.attachShadow({ mode: "open" });
    document.body.append(host);
    panel = mount(host, config(), pageCtx({ hosted: true }), { api: mockApi(), renderCards, renderFeedback, inline: true });
    await panel.open();
    openMenu();
    expect(item().hidden).toBe(true);
  });

  it("has Expand/Collapse labels in every locale", async () => {
    const { DICTS } = await import("../../widget/src/core/i18n");
    for (const d of Object.values(DICTS) as Record<string, string>[]) {
      expect(d.expand).toBeTruthy();
      expect(d.collapse).toBeTruthy();
    }
  });
});

describe("drawer mode and send-on-open (the Ask our AI agent block)", () => {
  const title = { eyebrow: "More questions?", heading: "Ask our AI agent" };
  const done = () => vi.fn(async () => sseResponse([ev("done", { conversationToken: "t", messageId: null })]));
  const panelEl = () => q(".panel")!;

  it("a drawer accepts the block's title but shows the same header as everywhere, with the AI line", async () => {
    await setup(mockApi()).open({ mode: "drawer", title: { eyebrow: "<b>More</b>", heading: "Ask <img src=x onerror=alert(1)>" } });
    expect(panelEl().classList.contains("drawer")).toBe(true);
    expect(q(".hd .name")!.textContent).toBe("Your Demo Store AI expert");
    expect(q(".hd .sub")).toBeNull();
    expect(sh().querySelector(".hd img, .hd b")).toBeNull();
  });

  it("the AI line is in the header in the drawer and in the floating panel", async () => {
    const p = setup(mockApi());
    await p.open({ mode: "drawer", title });
    expect(q(".hd .sub")).toBeNull();
    await p.open({});
    expect(q(".hd .sub")).toBeNull();
    expect(CSS).not.toMatch(/\.sub\{[^}]*display:none/);
  });

  it("the dialog is described by the AI notice, so a screen reader announces it on open, in both modes", async () => {
    const p = setup(mockApi());
    for (const args of [{}, { mode: "drawer" as const, title }]) {
      await p.open(args);
      const id = panelEl().getAttribute("aria-describedby")!;
      const notice = sh().getElementById(id)!;
      expect(notice.classList.contains("notice")).toBe(true);
      expect(notice.textContent).toContain("You're chatting with an AI assistant.");
    }
  });

  it("opening without a mode afterwards is the normal floating panel with the assistant's header", async () => {
    const p = setup(mockApi());
    await p.open({ mode: "drawer", title });
    await p.open({});
    expect(panelEl().classList.contains("drawer")).toBe(false);
    expect(q(".hd .name")!.textContent).toBe("Your Demo Store AI expert");
    expect(q(".hd .sub")).toBeNull();
  });

  it("a message is sent once the chat has loaded, scoped to the product, with no suggestions left", async () => {
    const api = mockApi({ send: done() });
    await setup(api).open({ productId: "42", mode: "drawer", title, message: "What are the dimensions?" });
    await flush();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0][0]).toMatchObject({ message: "What are the dimensions?", productId: "42" });
    expect(bubbles()[0].textContent).toContain("What are the dimensions?");
    expect(q(".sugg")).toBeNull();
  });

  it("calling open twice while the chat is still loading sends one message (the latest)", async () => {
    const api = mockApi({ send: done(), latest: vi.fn(() => new Promise<string | null>((r) => setTimeout(() => r(null), 20))) });
    const p = setup(api);
    const a = p.open({ productId: "42", mode: "drawer", title, message: "First?" });
    const b = p.open({ productId: "42", mode: "drawer", title, message: "Second?" });
    const c = p.open({ productId: "42", mode: "drawer", title, message: "Second?" });
    await Promise.all([a, b, c]);
    await flush();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0][0].message).toBe("Second?");
  });

  it("open with a message on an already loaded chat sends it", async () => {
    const api = mockApi({ send: done() });
    const p = setup(api);
    await p.open({ productId: "42" });
    await p.open({ productId: "42", mode: "drawer", title, message: "Is it in stock?" });
    await flush();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0][0].message).toBe("Is it in stock?");
  });

  it("an open without a message sends nothing", async () => {
    const api = mockApi({ send: done() });
    await setup(api).open({ productId: "42", mode: "drawer", title });
    await flush();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("reduced motion switches the drawer's slide off", () => {
    expect(CSS).toMatch(/prefers-reduced-motion:reduce\).*\.panel\.drawer,\.panel\.full\.drawer,:host\(:dir\(rtl\)\) \.panel\.drawer\{animation:none\}/);
  });
});

describe("a second question while an answer streams, offline, and focus", () => {
  const title = { eyebrow: "More questions?", heading: "Ask our AI agent" };
  const answer = (text: string, id: string) => sseResponse([ev("text", { delta: text }), ev("done", { conversationToken: "t", messageId: id })]);

  it("a message from the block while an answer streams is sent when that answer is done (latest wins)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn()
      .mockImplementationOnce(async () => (await gate, answer("one", "m1")))
      .mockImplementation(async () => answer("two", "m2"));
    const p = setup(mockApi({ send }));
    await p.open({ productId: "42", mode: "drawer", title, message: "First?" });
    await flush();
    await p.open({ productId: "42", mode: "drawer", title, message: "Second?" });
    await p.open({ productId: "42", mode: "drawer", title, message: "Third?" });
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].message).toBe("Third?");
  });

  it("offline: the message is put into the input box instead of being dropped", async () => {
    const send = vi.fn();
    const p = setup(mockApi({ send }));
    await p.open();
    window.dispatchEvent(new Event("offline"));
    await p.open({ message: "Is it in stock?" });
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe("Is it in stock?");
  });

  it("a failed turn leaves the waiting question in the input", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn().mockImplementation(async () => (await gate, new Response(null, { status: 500 })));
    const p = setup(mockApi({ send }));
    await p.open({ message: "First?" });
    await flush();
    await p.open({ message: "Second?" });
    release();
    await flush(60);
    expect(input().value).toBe("Second?");
  });

  it("closing gives focus back to the element that had it when the panel opened, else the launcher", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const p = setup(mockApi());
    outside.focus();
    await p.open({ focus: false });
    p.close();
    expect(document.activeElement).toBe(outside);
    outside.remove();
    await p.open({ focus: false });
    const spy = vi.spyOn(launcher, "focus");
    p.close();
    expect(spy).toHaveBeenCalled(); // nothing on the page had focus: the launcher
  });
});

describe("the \"added to your cart\" note", () => {
  const cart = "https://demo.myshopify.com/cart";
  const notes = () => qa(".note");
  const reply = () => vi.fn(async () => sseResponse([ev("text", { delta: "Here" }), ev("product", { id: "p" }), ev("done", { conversationToken: "t", messageId: "m1" })]));

  it("a live add appends the note right after that answer, with View cart, announced politely", async () => {
    renderCards = vi.fn<Renderers["renderCards"]>((into, _cards, _ctx, _id, onAdded) => {
      const b = document.createElement("button");
      b.className = "fake-add";
      b.addEventListener("click", () => onAdded?.("<b>Mug</b>", cart));
      into.append(b);
    });
    await setup(mockApi({ send: reply() }), config(), pageCtx({ cartUrl: cart })).open();
    await type("mug?");
    expect(notes()).toHaveLength(0);
    q<HTMLButtonElement>(".fake-add")!.click();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toBe("✓ <b>Mug</b> added to your cart · View cart");
    expect(notes()[0].getAttribute("role")).toBe("status");
    expect(notes()[0].previousElementSibling!.classList.contains("msg")).toBe(true);
    expect(notes()[0].querySelector("a")!.getAttribute("href")).toBe(cart);
    expect(notes()[0].querySelector("b")).toBeNull(); // the title is text, not markup
    q<HTMLButtonElement>(".fake-add")!.click();
    expect(notes()).toHaveLength(2);
  });

  it("history renders one note per cartAdds entry after that answer, and none without", async () => {
    const item = (id: string, over: Partial<HistoryItem> = {}): HistoryItem => ({ id, role: "assistant", content: "ok", status: "ok", cards: [], rating: null, ...over });
    const history = [
      { id: "u", role: "user", content: "hi", status: "ok", cards: [], rating: null } as HistoryItem,
      item("a1", { cartAdds: [{ title: "Mug" }, { title: "Tee <i>x</i>" }] }),
      item("a2"),
    ];
    localStorage.setItem(TOKEN_KEY, "tok");
    await setup(mockApi({ history: vi.fn(async () => history) }), config(), pageCtx({ cartUrl: cart })).open();
    expect(notes().map((n) => n.textContent)).toEqual(["✓ Mug added to your cart · View cart", "✓ Tee <i>x</i> added to your cart · View cart"]);
    expect(notes()[0].querySelector("a")!.getAttribute("href")).toBe(cart);
    expect(notes()[1].nextElementSibling!.classList.contains("msg")).toBe(true); // a2's bubble follows
    expect(sh().querySelector(".note i")).toBeNull();
  });
});

describe("header logo, composer and the viewing thumbnail", () => {
  const LOGO = "https://cdn.shopify.com/s/files/brand-logo.png";

  it("logo: the avatar wins, then the shop's brand logo, then the initial", async () => {
    await setup(mockApi(), config({ avatarUrl: "https://cdn.shopify.com/s/files/av.png" }), pageCtx({ logo: LOGO })).open();
    expect(q<HTMLImageElement>("img.avatar")!.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/av.png");
    panel.destroy();
    document.body.innerHTML = "";
    await setup(mockApi(), config(), pageCtx({ logo: LOGO })).open();
    expect(q<HTMLImageElement>("img.avatar")!.getAttribute("src")).toBe(LOGO);
    expect(q(".avatar.initial")).toBeNull();
    panel.destroy();
    document.body.innerHTML = "";
    await setup(mockApi(), config(), pageCtx({ logo: "https://evil.com/l.png" })).open();
    expect(q("img.avatar")).toBeNull();
    expect(q(".avatar.initial")!.textContent).toBe("D");
  });

  it("a logo is shown whole (contain, no circle) and only the initial is a circle", () => {
    expect(CSS).toMatch(/\.avatar\{[^}]*object-fit:contain/);
    expect(CSS).not.toMatch(/\.avatar\{[^}]*border-radius:50%/);
    expect(CSS).toMatch(/\.avatar\.initial\{[^}]*border-radius:50%/);
  });

  it("the 'You're viewing' thumbnail loads from Liquid's protocol-relative store URL", async () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("https://shop.example/products/tee");
    const viewing = { title: "Tee", image: "//shop.example/cdn/shop/files/tee.jpg?width=160", price: 2000 };
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing })).open();
    expect(q(".viewing img")!.getAttribute("src")).toBe("https://shop.example/cdn/shop/files/tee.jpg?width=160");
  });

  it("the viewing line is just 'You're viewing' when there is no price", async () => {
    await setup(mockApi(), config(), pageCtx({ productId: "1", viewing: { title: "Tee", image: null, price: null } })).open();
    expect(q(".vw-label")!.textContent).toBe("You're viewing");
  });

  it("header actions: cart, new chat, menu, divider, close, with the menu holding Expand and Delete chat", async () => {
    await setup(mockApi()).open();
    const names = qa(".actions > *").map((e) => e.getAttribute("aria-label") ?? e.className);
    expect(names).toEqual(["Cart", "New chat", "mwrap", "sep", "Close"]);
    expect(q("svg path[stroke-width='1.5']")).not.toBeNull(); // thin outline icons
    q<HTMLButtonElement>("button.menu")!.click();
    expect(qa(".mlist button").map((b) => b.textContent)).toEqual(["Expand", "Delete chat"]);
  });

  it("the composer: the AI notice and its privacy link sit above the input, and Send is inside the input's pill", async () => {
    await setup(mockApi()).open();
    const kids = Array.from(q(".ft")!.children).map((e) => e.className);
    expect(kids.indexOf("notice")).toBeLessThan(kids.indexOf("row"));
    expect(q(".notice")!.textContent).toContain("You're chatting with an AI assistant.");
    expect(q(".notice a")!.textContent).toBe("Privacy policy");
    expect(q(".row")!.contains(q("button.send"))).toBe(true);
    expect(q(".row")!.contains(input())).toBe(true);
    expect(CSS).toMatch(/textarea\{[^}]*border:0;[^}]*font-size:16px/);
    expect(CSS).toMatch(/\.send\{position:absolute;inset-inline-end:6px;/);
  });
});

describe("panel motion", () => {
  type FakeAnim = { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn>; reverse: ReturnType<typeof vi.fn> };
  const animate = () => {
    const anims: FakeAnim[] = [];
    const fn = vi.fn(() => {
      const a: FakeAnim = { onfinish: null, cancel: vi.fn(), reverse: vi.fn() };
      anims.push(a);
      return a;
    });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = fn;
    return { fn, anims };
  };
  const motionOk = () => vi.stubGlobal("matchMedia", () => ({ matches: false }));
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it("close() animates out, hides when the animation ends, and gives focus back at once", async () => {
    const { fn, anims } = animate();
    motionOk();
    await setup(mockApi()).open();
    panel.close();
    const el = q(".panel")!;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((fn.mock.calls[0] as unknown[])[0])).toContain("scale(.97)");
    expect(el.hidden).toBe(false);
    expect(el.inert).toBe(true);
    expect(JSON.parse(localStorage.getItem(`askcart:${SHOP}:ui`)!).open).toBe(false); // state is already closed
    anims[0].onfinish!();
    expect(el.hidden).toBe(true);
    expect(el.inert).toBe(false);
    expect(anims[0].cancel).toHaveBeenCalled(); // no held end frame left to hide the reopened panel
  });

  it("the drawer slides out to the right", async () => {
    const { fn } = animate();
    motionOk();
    await setup(mockApi()).open({ mode: "drawer" });
    panel.close();
    // a card 16px in from the edge: it has to clear its own gap too; the exit is 240ms
    expect(JSON.stringify((fn.mock.calls[0] as unknown[])[0])).toContain("translateX(calc((100% + 16px)))");
    expect((fn.mock.calls[0] as unknown[])[1]).toMatchObject({ duration: 240 });
  });

  it("keeps the page locked while the drawer slides out, and unlocks when it is gone", async () => {
    const { anims } = animate();
    motionOk();
    await setup(mockApi()).open({ mode: "drawer" });
    expect(document.documentElement.style.overflow).toBe("hidden");
    panel.close();
    expect(document.documentElement.style.overflow).toBe("hidden");
    anims[0].onfinish!();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("the phone's drawer (full screen) leaves by 100%, in 220ms", async () => {
    const { fn } = animate();
    motionOk();
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 390, height: 844 });
    await setup(mockApi()).open({ mode: "drawer" });
    panel.close();
    expect(JSON.stringify((fn.mock.calls[0] as unknown[])[0])).toContain("translateX(calc((100%)))");
    expect((fn.mock.calls[0] as unknown[])[1]).toMatchObject({ duration: 220 });
  });

  it("opening again during the exit plays it backwards (no jump), then drops the held end frame", async () => {
    const { anims } = animate();
    motionOk();
    await setup(mockApi()).open();
    panel.close();
    await panel.open();
    expect(anims[0].reverse).toHaveBeenCalled();
    expect(anims[0].cancel).not.toHaveBeenCalled(); // still on its way back
    expect(q(".panel")!.hidden).toBe(false);
    expect(q(".panel")!.inert).toBe(false);
    anims[0].onfinish!();
    expect(anims[0].cancel).toHaveBeenCalled();
    panel.close(); // and it can close again
    expect(anims).toHaveLength(2);
  });

  it("reduced motion: no animation, hidden at once", async () => {
    const { fn } = animate();
    await setup(mockApi()).open(); // beforeEach stubs reduce
    panel.close();
    expect(fn).not.toHaveBeenCalled();
    expect(q(".panel")!.hidden).toBe(true);
  });

  it("a panel restored on a page load (focus:false) skips its entrance animation, and the next open animates", async () => {
    const p = setup(mockApi());
    await p.open({ focus: false });
    expect(q(".panel")!.classList.contains("still")).toBe(true);
    p.close();
    expect(q(".panel")!.classList.contains("still")).toBe(false);
    await p.open();
    expect(q(".panel")!.classList.contains("still")).toBe(false);
  });

  it("uses custom easing curves, not the built-in ease-out", () => {
    expect(CSS).toContain("animation:in .22s cubic-bezier(0.22,1,0.36,1)");
    expect(CSS).toContain("animation:sl .3s cubic-bezier(0.32,0.72,0,1)");
    expect(CSS).not.toMatch(/animation:(in|sl|inf) [.\d]+s ease-out/);
  });

  it("live messages fade in, history is drawn instantly", async () => {
    const api = mockApi({
      history: vi.fn(async () => [{ id: "u", role: "user", content: "old", status: "ok", cards: [], rating: null }] as HistoryItem[]),
      send: vi.fn(async () => sseResponse([ev("text", { delta: "Hi" }), ev("done", { conversationToken: "t", messageId: null })])),
    });
    localStorage.setItem(TOKEN_KEY, "tok");
    await setup(api).open();
    await flush();
    expect(q(".msg.user")!.classList.contains("in")).toBe(false);
    await type("new question");
    const users = qa(".msg.user");
    expect(users[1].classList.contains("in")).toBe(true);
    expect(q(".msg.bot .txt")!.classList.contains("in")).toBe(true);
  });

  it("the desktop drawer mode is remembered for the next page load", async () => {
    const UI = `askcart:${SHOP}:ui`;
    const p = setup(mockApi());
    await p.open({ mode: "drawer" });
    expect(JSON.parse(localStorage.getItem(UI)!).drawer).toBe(true);
    await p.open({});
    expect(JSON.parse(localStorage.getItem(UI)!).drawer).toBe(false);
  });
});


describe("the cart summary on a chat message", () => {
  const cartJson = { items: [{ variant_id: 1, quantity: 2, product_title: "Wax", variant_title: "Large", final_line_price: 139990 }], item_count: 2, total_price: 139990, currency: "USD" };

  it("is sent from a store page, read fresh from cart.js", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, cartJson)));
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "ok" }), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api).open();
    await type("what's in my cart?");
    const price = expect.stringMatching(/1,399.90$/);
    expect(api.send.mock.calls[0][0].cart).toEqual({ items: [{ title: "Wax", variant: "Large", quantity: 2, price }], total: price });
  });

  it("is not sent, and cart.js is not read, on the hosted page", async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, cartJson));
    vi.stubGlobal("fetch", f);
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "ok" }), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api, config(), pageCtx({ cartUrl: "", hosted: true })).open();
    await type("what's in my cart?");
    expect(api.send.mock.calls[0][0].cart).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u).endsWith("/cart.js"))).toBe(false);
  });
});

describe("the desktop drawer: backdrop, scroll lock, modal semantics", () => {
  const scrim = () => q(".scrim")!;
  const phone = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 390, height: 844 });

  it("dims the page behind the drawer, and a click on the backdrop closes it", async () => {
    await setup(mockApi()).open({ mode: "drawer" });
    expect(scrim().hidden).toBe(false);
    expect(q(".panel")!.getAttribute("aria-modal")).toBe("true");
    scrim().click();
    expect(q(".panel")!.hidden).toBe(true);
    expect(scrim().hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(`askcart:${SHOP}:ui`)!).open).toBe(false);
  });

  it("locks the page scroll while the desktop drawer is open, padding for the scrollbar it hides, and restores both", async () => {
    document.documentElement.style.paddingRight = "3px";
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1265 });
    await setup(mockApi()).open({ mode: "drawer" });
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.paddingRight).toBe("15px");
    panel.close();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.documentElement.style.paddingRight).toBe("3px");
    delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
    document.documentElement.style.paddingRight = "";
  });

  it("the floating bubble has no backdrop, no scroll lock and is not aria-modal; full screen is modal", async () => {
    await setup(mockApi()).open();
    expect(scrim().hidden).toBe(true);
    expect(document.documentElement.style.overflow).toBe("");
    expect(q(".panel")!.hasAttribute("aria-modal")).toBe(false);
    panel.destroy();
    document.body.innerHTML = "";
    phone();
    await setup(mockApi()).open();
    expect(q(".panel")!.getAttribute("aria-modal")).toBe("true");
    expect(scrim().hidden).toBe(true); // full screen has nothing behind it
  });

  it("hides the launcher while the desktop drawer is open (the edge tab would show in its gutter) and shows it again on close", async () => {
    await setup(mockApi()).open({ mode: "drawer" });
    expect(launcher.style.visibility).toBe("hidden");
    panel.close();
    expect(launcher.style.visibility).toBe("");
    await panel.open({ mode: "drawer" });
    expect(launcher.style.visibility).toBe("hidden");
    await panel.open({ mode: "floating" }); // a floating panel leaves it alone
    expect(launcher.style.visibility).toBe("");
  });

  it("a phone's drawer is the full-screen sheet: no backdrop, still modal and locked", async () => {
    phone();
    await setup(mockApi()).open({ mode: "drawer" });
    expect(q(".panel")!.classList.contains("full")).toBe(true);
    expect(scrim().hidden).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("is a 560px floating card with the measured spring, 16px in from the edge", () => {
    expect(CSS).toContain(".panel.drawer{top:16px;bottom:16px;right:16px;left:auto;width:min(560px,calc(100vw - 32px))");
    expect(CSS).toContain("border-radius:16px");
    expect(CSS).toContain("animation:sl .64s cubic-bezier(0.3,0.48,0.08,1)");
    expect(CSS).toContain("linear(0,.1 6.3%,.288 12.5%");
    expect(CSS).toContain("0 16px 32px -16px rgba(0,0,0,.12),0 8px 16px -8px rgba(24,24,37,.08)");
    expect(CSS).toContain("@keyframes sl{from{transform:translateX(calc(100% + 16px))}}");
    expect(CSS).toContain(".scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.3)");
  });

  it("does not animate the panel's width or height (expand snaps instead of re-laying out every frame)", () => {
    expect(CSS).not.toMatch(/transition:[^;}]*(width|height)/);
  });
});

describe("closing and the 'You're viewing' price", () => {
  it("tells the page it was closed, so the launcher can dock as the edge tab", async () => {
    const seen = vi.fn();
    window.addEventListener("askcart:closed", seen);
    const p = setup(mockApi());
    await p.open();
    expect(seen).not.toHaveBeenCalled();
    p.close();
    window.removeEventListener("askcart:closed", seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("formats the viewing price from cents and the page's currency, with a dot decimal in any locale", async () => {
    const viewing = { title: "Tee", image: null, price: 1999 };
    await setup(mockApi(), config(), pageCtx({ productId: "1", currency: "EUR", locale: "fr", viewing })).open();
    expect(q(".vw-label")!.textContent).toBe("€19.99 · Vous consultez");
  });

  it("shows no price when the page has no currency", async () => {
    await setup(mockApi(), config(), pageCtx({ productId: "1", currency: null, viewing: { title: "Tee", image: null, price: 1999 } })).open();
    expect(q(".vw-label")!.textContent).toBe("You're viewing");
  });
});

describe("the cards' similar-products icon", () => {
  const card = { id: "gid://shopify/Product/7", title: "Linen tee" };
  const answer = () => sseResponse([ev("product", card), ev("text", { delta: "Here" }), ev("done", { conversationToken: "t1", messageId: "m1" })]);

  it("sends an ordinary message in the shopper's language plus the product's id, and shows it as the shopper's own message", async () => {
    const send = vi.fn(async (_req: { similarTo?: string | null; requestId?: string }) => answer());
    await setup(mockApi({ send }), config(), pageCtx({ locale: "fr" })).open();
    await type("bonjour");
    const onSimilar = renderCards.mock.calls[0][5]!; // the panel hands every answer's cards its handler
    send.mockClear();

    onSimilar(card as never);
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ message: "Montre-moi des produits similaires à Linen tee", similarTo: "gid://shopify/Product/7", token: "t1" });
    expect(qa(".msg.user").map((e) => e.textContent)).toEqual(["bonjour", "Montre-moi des produits similaires à Linen tee"]);
  });

  it("an ordinary message carries no similarTo", async () => {
    const send = vi.fn(async (_req: { similarTo?: string | null; requestId?: string }) => answer());
    await setup(mockApi({ send })).open();
    await type("hello");
    expect(send.mock.calls[0][0].similarTo ?? null).toBeNull();
  });

  it("is ignored while an answer is still streaming, so nothing is sent twice", async () => {
    const send = vi.fn(async (_req: { similarTo?: string | null; requestId?: string }) => answer());
    await setup(mockApi({ send })).open();
    await type("hello");
    const onSimilar = renderCards.mock.calls[0][5]!;
    send.mockClear();
    send.mockImplementationOnce(() => new Promise<Response>(() => {})); // a turn that never ends
    await type("one more");
    onSimilar(card as never);
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // only "one more"
  });

  it("a failed turn's Retry resends the same similarTo", async () => {
    const send = vi.fn(async (_req: { similarTo?: string | null; requestId?: string }) => answer());
    await setup(mockApi({ send })).open();
    await type("hello");
    const onSimilar = renderCards.mock.calls[0][5]!;
    send.mockClear();
    send.mockResolvedValue(new Response("{}", { status: 503 }));
    onSimilar(card as never);
    await flush();
    send.mockImplementation(async () => answer());
    q<HTMLButtonElement>(".retry, button.retry")!.click();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ similarTo: "gid://shopify/Product/7", requestId: send.mock.calls[0][0].requestId });
  });
});
