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

describe("the reasons menu after a thumbs-down", () => {
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const menuOf = (into: HTMLElement) => into.querySelector<HTMLElement>("[role=menu]");
  const items = (into: HTMLElement) => Array.from(into.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
  async function openMenu(c = ctx()) {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const m = mount(null, c);
    m.down.click();
    await settle();
    return m;
  }

  it("opens after a saved thumbs-down with the five reasons, first one focused, thumb marked expanded", async () => {
    const { into, down } = await openMenu();
    expect(menuOf(into)!.getAttribute("aria-label")).toBe("Why wasn't this helpful?");
    expect(items(into).map((b) => b.textContent)).toEqual([
      "Wrong products shown",
      "Wrong price or stock",
      "Didn't understand me",
      "Answer too long or unclear",
      "Other",
    ]);
    expect(document.activeElement).toBe(items(into)[0]);
    expect(down.getAttribute("aria-expanded")).toBe("true");
    expect(down.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("does not open for a thumbs-up, a clear, or a failed save", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const a = mount();
    a.up.click();
    await settle();
    expect(menuOf(a.into)).toBeNull();
    const b = mount(-1);
    b.down.click(); // clears
    await settle();
    expect(menuOf(b.into)).toBeNull();
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const c = mount();
    c.down.click();
    await settle();
    expect(menuOf(c.into)).toBeNull();
  });

  it("translates the menu", async () => {
    const { into } = await openMenu(ctx("de"));
    expect(items(into).map((b) => b.textContent)).toEqual([
      "Falsche Produkte angezeigt",
      "Falscher Preis oder Bestand",
      "Hat mich nicht verstanden",
      "Antwort zu lang oder unklar",
      "Sonstiges",
    ]);
  });

  it("picking a reason sends -1 with it, closes the menu, returns focus to the thumb and announces thanks", async () => {
    const { into, down } = await openMenu();
    items(into)[2].click();
    expect(menuOf(into)).toBeNull();
    expect(document.activeElement).toBe(down);
    await settle();
    expect(sent(1).body).toEqual({ messageId: MSG, rating: -1, reason: "misunderstood" });
    expect(pressed(down)).toBe("true");
    expect(announce).toHaveBeenLastCalledWith("Thanks for your feedback");
  });

  it("a failed reason save announces it and keeps the thumbs-down", async () => {
    const { into, down } = await openMenu();
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    items(into)[4].click();
    await settle();
    expect(announce).toHaveBeenLastCalledWith("Couldn't save");
    expect(pressed(down)).toBe("true");
  });

  it("arrows, Home and End move focus and wrap", async () => {
    const { into } = await openMenu();
    const list = items(into);
    key(list[0], "ArrowDown");
    expect(document.activeElement).toBe(list[1]);
    key(list[1], "ArrowUp");
    key(list[0], "ArrowUp");
    expect(document.activeElement).toBe(list[4]);
    key(list[4], "ArrowDown");
    expect(document.activeElement).toBe(list[0]);
    key(list[0], "End");
    expect(document.activeElement).toBe(list[4]);
    key(list[4], "Home");
    expect(document.activeElement).toBe(list[0]);
  });

  it("Escape closes it without a reason, focuses the thumb, keeps the thumbs-down, and doesn't reach the panel", async () => {
    const { into, down } = await openMenu();
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    key(items(into)[1], "Escape");
    document.body.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(menuOf(into)).toBeNull();
    expect(document.activeElement).toBe(down);
    expect(pressed(down)).toBe("true");
    expect(down.getAttribute("aria-expanded")).toBe("false");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second request
  });

  it("Tab closes it and returns to the thumb", async () => {
    const { into, down } = await openMenu();
    key(items(into)[0], "Tab");
    expect(menuOf(into)).toBeNull();
    expect(document.activeElement).toBe(down);
  });

  it("a pointer press outside closes it; one inside the thumbs doesn't", async () => {
    const { into, up } = await openMenu();
    up.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(menuOf(into)).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(menuOf(into)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pressing the thumb again closes the menu and clears the rating, with no reason sent", async () => {
    const { into, down } = await openMenu();
    down.click();
    expect(menuOf(into)).toBeNull();
    await settle();
    expect(sent(1).body).toEqual({ messageId: MSG, rating: null });
  });

  it("switching to thumbs-up closes the menu", async () => {
    const { into, up } = await openMenu();
    up.click();
    expect(menuOf(into)).toBeNull();
    await settle();
    expect(sent(1).body).toEqual({ messageId: MSG, rating: 1 });
  });

  it("menu items are text only", async () => {
    const c = ctx();
    c.t = (k) => (k.startsWith("reason_") ? `<img src=x onerror=alert(1)>` : k);
    const { into } = await openMenu(c);
    expect(into.querySelector("img")).toBeNull();
    expect(items(into)[0].textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("renderFeedback without a message id", () => {
  it("renders nothing for a null id (old widget, replay edge cases)", () => {
    const into = document.createElement("div");
    renderFeedback(into, null, null, ctx());
    expect(into.childNodes).toHaveLength(0);
  });
});
