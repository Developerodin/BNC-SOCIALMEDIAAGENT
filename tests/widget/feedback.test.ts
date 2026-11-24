// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderFeedback } from "../../widget/src/feedback";
import { createApi } from "../../widget/src/core/api";
import { translator } from "../../widget/src/core/i18n";
import { tokenStore } from "../../widget/src/core/storage";
import type { WidgetCtx } from "../../src/lib/widget-contract";

const BASE = "https://app.example.com";
const SHOP = "a.myshopify.com";
const TOKEN = "secret-token-123";
const MSG = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn<typeof fetch>();
const announce = vi.fn<(text: string) => void>();

function ctx(locale = "en"): WidgetCtx {
  return {
    config: {} as WidgetCtx["config"],
    page: { shop: SHOP, locale } as WidgetCtx["page"],
    api: createApi(BASE, SHOP),
    t: translator(locale),
    announce,
  };
}

function mount(rating: -1 | 1 | null = null, c = ctx()) {
  const into = document.createElement("div");
  document.body.append(into);
  renderFeedback(into, MSG, rating, c);
  const [up, down] = Array.from(into.querySelectorAll("button"));
  return { into, up, down };
}

const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed");
const sent = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  announce.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  tokenStore(SHOP).set(TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore(SHOP).clear();
  document.body.innerHTML = "";
});

describe("renderFeedback (UD14, C27)", () => {
  it("renders two typed toggle buttons with i18n labels and nothing pressed", () => {
    const { up, down } = mount();
    expect(up.type).toBe("button");
    expect(up.getAttribute("aria-label")).toBe("Helpful");
    expect(down.getAttribute("aria-label")).toBe("Not helpful");
    expect(pressed(up)).toBe("false");
    expect(pressed(down)).toBe("false");
    expect(up.parentElement!.getAttribute("role")).toBe("group");
    expect(up.parentElement!.getAttribute("aria-label")).toBe("Rate this answer");
  });

  it("uses the storefront locale for the labels", () => {
    const { up, down } = mount(null, ctx("fr-FR"));
    expect(up.getAttribute("aria-label")).toBe("Utile");
    expect(down.getAttribute("aria-label")).toBe("Pas utile");
  });

  it("shows a restored history rating as pressed", () => {
    const { up, down } = mount(-1);
    expect(pressed(down)).toBe("true");
    expect(pressed(up)).toBe("false");
  });

  it("a click sends rating -1 with the token header, not in the URL", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { down } = mount();
    down.click();
    expect(pressed(down)).toBe("true"); // optimistic, before the response
    await settle();
    const { url, headers, body } = sent(0);
    expect(url).toBe(`${BASE}/api/chat/feedback?shop=${encodeURIComponent(SHOP)}`);
    expect(url).not.toContain(TOKEN);
    expect(headers.get("X-Conversation-Token")).toBe(TOKEN);
    expect(body).toEqual({ messageId: MSG, rating: -1 });
    expect(pressed(down)).toBe("true");
  });

  it("a second click on the pressed thumb sends null and clears it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { down } = mount();
    down.click();
    await settle();
    down.click();
    expect(pressed(down)).toBe("false");
    await settle();
    expect(sent(1).body).toEqual({ messageId: MSG, rating: null });
    expect(pressed(down)).toBe("false");
  });

  it("switching thumbs sends the other rating and only one is pressed", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { up, down } = mount(-1);
    up.click();
    await settle();
    expect(sent(0).body).toEqual({ messageId: MSG, rating: 1 });
    expect(pressed(up)).toBe("true");
    expect(pressed(down)).toBe("false");
  });

  it("a 500 rolls back aria-pressed and announces the failure", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const { up, down } = mount(-1);
    up.click();
    expect(pressed(up)).toBe("true");
    await settle();
    expect(pressed(up)).toBe("false");
    expect(pressed(down)).toBe("true");
    expect(announce).toHaveBeenCalledWith("Couldn't save");
  });

  it("a network error rolls back too", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { up } = mount();
    up.click();
    await settle();
    expect(pressed(up)).toBe("false");
    expect(announce).toHaveBeenCalledWith("Couldn't save");
  });

  it("announces thanks after a saved rating", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { up } = mount();
    up.click();
    await settle();
    expect(announce).toHaveBeenCalledWith("Thanks for your feedback");
  });

  it("without a stored token it sends nothing and stays unpressed", async () => {
    tokenStore(SHOP).clear();
    const { up } = mount();
    up.click();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pressed(up)).toBe("false");
    expect(announce).toHaveBeenCalledWith("Couldn't save");
  });

  it("ignores clicks while a save is in flight, so responses can't land out of order", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)));
    const { up, down } = mount();
    up.click();
    down.click();
    up.click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pressed(up)).toBe("true");
    resolve(new Response(null, { status: 204 }));
    await settle();
    expect(pressed(up)).toBe("true");
    expect(pressed(down)).toBe("false");
  });

  it("renders text only: a hostile label never becomes markup", () => {
    const c = ctx();
    c.t = () => `<img src=x onerror=alert(1)>`;
    const { into } = mount(null, c);
    expect(into.querySelector("img")).toBeNull();
  });

  it("a re-render into the same element replaces, not duplicates, the thumbs", () => {
    const { into } = mount();
    renderFeedback(into, MSG, 1, ctx());
    expect(into.querySelectorAll("button")).toHaveLength(2);
    expect(into.querySelectorAll("button")[0].getAttribute("aria-pressed")).toBe("true");
  });
});

describe("renderFeedback without a message id", () => {
  it("renders nothing for a null id (old widget, replay edge cases)", () => {
    const into = document.createElement("div");
    renderFeedback(into, null, null, ctx());
    expect(into.childNodes).toHaveLength(0);
  });
});
