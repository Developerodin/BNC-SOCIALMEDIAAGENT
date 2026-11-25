// @vitest-environment happy-dom
// Task 30: the chat panel (UD3, UD4, UD13, UD16, UD17, UD18, D81, D83, D84). The API is mocked; cards and thumbs go
// through the CardsRenderer / FeedbackRenderer seams, injected here as spies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../widget/src/widget";
import type { Panel } from "../../widget/src/panel/panel";
import type { Renderers } from "../../widget/src/panel/messages";
import type { FeedbackRenderer, HistoryItem, PageContext, WidgetApi, WidgetConfig } from "@/lib/widget-contract";
import { ev, jsonResponse, sseResponse } from "./core/helpers";

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
    expect(q(".name")!.textContent).toBe("<b>Shop</b>");
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
    await openMenu();
    item("New chat").click();
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
    item("New chat").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(q(".panel")!.hidden).toBe(false);
  });

  it("Escape from a menu item returns focus to the menu button", async () => {
    await setup(mockApi()).open();
    await openMenu();
    item("New chat").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(sh().activeElement).toBe(q("button.menu"));
  });
});

describe("header and empty state", () => {
  it("shows the store's initial on the accent when there is no avatar, plus the subtitle and online dot", async () => {
    await setup(mockApi(), config({ name: "maison bleue" })).open();
    expect(q(".avatar.initial")!.textContent).toBe("M");
    expect(q("img.avatar")).toBeNull();
    expect(q(".hd .sub")!.textContent).toBe("AI shopping assistant");
    expect(q(".hd .dot")).not.toBeNull();
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

  it("the typing dots go away at the first token", async () => {
    const api = mockApi({ send: vi.fn(async () => sseResponse([ev("text", { delta: "Hi" }), ev("done", { conversationToken: "t1", messageId: "m1" })])) });
    await setup(api).open();
    await type("hello");
    expect(q(".typing")).toBeNull();
    expect(assistantTexts()).toEqual(["Hi"]);
  });

  it("every animation in the panel CSS is switched off under prefers-reduced-motion", async () => {
    await setup(mockApi()).open();
    const css = q("style")!.textContent!;
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(css).toContain("animation:in");
    expect(reduced).toContain(".panel,.typing span{animation:none}");
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
    expect(q(".name")!.textContent).toBe("Demo Store");
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
  const btn = () => q<HTMLButtonElement>("button.wide-btn")!;
  const UI_KEY = `askcart:${SHOP}:ui`;

  it("toggles the wide class, aria-pressed and label, and persists the choice", async () => {
    await setup(mockApi()).open();
    expect(btn().hidden).toBe(false);
    expect(btn().getAttribute("aria-pressed")).toBe("false");
    expect(btn().getAttribute("aria-label")).toBe("Expand");
    btn().click();
    expect(q(".panel")!.classList.contains("wide")).toBe(true);
    expect(btn().getAttribute("aria-pressed")).toBe("true");
    expect(btn().getAttribute("aria-label")).toBe("Collapse");
    expect(JSON.parse(localStorage.getItem(UI_KEY)!).wide).toBe(true);
    btn().click();
    expect(q(".panel")!.classList.contains("wide")).toBe(false);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!).wide).toBe(false);
  });

  it("restores the saved choice when the panel opens, and Escape still closes", async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({ wide: true }));
    await setup(mockApi()).open();
    expect(q(".panel")!.classList.contains("wide")).toBe(true);
    expect(btn().getAttribute("aria-pressed")).toBe("true");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(q(".panel")!.hidden).toBe(true);
  });

  it("is hidden on a narrow screen (already a full sheet) and never applies there", async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({ wide: true }));
    const w = window.innerWidth;
    window.innerWidth = 400;
    try {
      await setup(mockApi()).open();
      expect(btn().hidden).toBe(true);
      expect(q(".panel")!.classList.contains("wide")).toBe(false);
    } finally {
      window.innerWidth = w;
    }
  });

  it("is hidden on the hosted page", async () => {
    host = document.createElement("askcart-host");
    host.attachShadow({ mode: "open" });
    document.body.append(host);
    panel = mount(host, config(), pageCtx({ hosted: true }), { api: mockApi(), renderCards, renderFeedback, inline: true });
    await panel.open();
    expect(btn().hidden).toBe(true);
  });

  it("has Expand/Collapse labels in every locale", async () => {
    const { DICTS } = await import("../../widget/src/core/i18n");
    for (const d of Object.values(DICTS) as Record<string, string>[]) {
      expect(d.expand).toBeTruthy();
      expect(d.collapse).toBeTruthy();
    }
  });
});
