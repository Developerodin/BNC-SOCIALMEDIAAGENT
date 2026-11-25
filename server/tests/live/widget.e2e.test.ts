import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import postgres from "postgres";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { PageContext, WidgetConfig } from "@/lib/widget-contract";

// Task 33: the BUILT storefront widget against the RUNNING app (real chat route, real OpenAI, real dev-store data),
// in happy-dom instead of a browser. Skipped unless WIDGET_E2E_BASE is the app's https origin (the `shopify app dev`
// tunnel, see "Using URL:" in its log). Costs one chat turn (a few cents). Run it with:
//   WIDGET_E2E_BASE=https://<tunnel>.trycloudflare.com npx vitest run tests/live/widget.e2e.test.ts
// Needs `npm run build:widget` first (tests/widget/bundle-size.test.ts also builds). Writes one conversation to the dev
// DB and deletes it again through the widget's "Delete chat".
//
// How it maps to the storefront: the page origin is the dev store's and every request carries that Origin, so the
// server's CORS check (stores.domains) is the real one (see corsFetch for why it isn't happy-dom's fetch). The extension assets are served from a happy-dom virtual
// server on a cdn.shopify.com URL, so the launcher injects askcart-widget.js exactly as on a theme. A second Window
// with the first one's storage stands in for "navigate to another page" (UD13 remount).

const BASE = process.env.WIDGET_E2E_BASE?.replace(/\/$/, "");
const SHOP = process.env.WIDGET_E2E_SHOP ?? "ask-cart-hv7ufqqy.myshopify.com";
const ORIGIN = `https://${SHOP}`;
const CDN = "https://cdn.shopify.com/extensions/askcart-e2e/assets/";
const ASSETS = path.resolve(__dirname, "../../../shopify/extensions/askcart/assets");
const QUESTION = "What's your cheapest snowboard?";
const T = 180_000;

type Call = { method: string; url: string; status: number; body: string | null };

let dev: ReturnType<typeof postgres>; // the dev DB (not the test DB): read-only checks of what the app wrote
let config: WidgetConfig;
let page: PageContext;

beforeAll(async () => {
  if (!BASE) return;
  // vitest.config points DATABASE_ADMIN_URL at the test DB (and loadEnv prefers process.env), so read .env itself.
  const devUrl = /^DATABASE_ADMIN_URL=(.*)$/m.exec(readFileSync(path.resolve(__dirname, "../../.env"), "utf8"))?.[1].trim();
  if (!devUrl) throw new Error("DATABASE_ADMIN_URL missing from .env");
  dev = postgres(devUrl, { max: 1 });
  const [store] = await dev`select settings, name, currency_code from stores where shop_domain = ${SHOP}`;
  if (!store) throw new Error(`no store ${SHOP} in the dev DB`);
  const { buildWidgetConfig } = await import("@/lib/widget-config");
  config = buildWidgetConfig({ settings: store.settings, name: store.name }, BASE);
  page = {
    shop: SHOP, locale: "en", country: "IN", currency: store.currency_code ?? "INR", productId: null,
    cartAddUrl: "/cart/add", cartUrl: "/cart", privacyUrl: null, designMode: false,
  };
});
afterAll(async () => {
  await dev?.end();
  if (BASE) await (await import("@/db/client")).sql.end();
});

/**
 * The widget's requests to our server go through Node's fetch, not happy-dom's: happy-dom 21's response stream calls
 * controller.close() again after the reader was cancelled (FetchBodyUtility.nodeToWebStream), and the widget cancels the
 * SSE reader on `done` as a browser allows, which crashes the run with "Controller is already closed". Node's fetch
 * doesn't do CORS, so this does the browser's steps itself: it sends the page's Origin, preflights every request that
 * isn't "simple" (JSON body or X-Conversation-Token), and rejects like a browser when the server doesn't allow it.
 */
async function corsFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const given = new Headers(init.headers as HeadersInit);
  const custom = [...given.keys()].filter((h) => h !== "content-type" || given.get(h) !== "text/plain").sort();
  if (custom.length || !["GET", "HEAD", "POST"].includes(method)) {
    const pre = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": custom.join(",") },
    });
    const allowM = (pre.headers.get("access-control-allow-methods") ?? "").toUpperCase().split(/\s*,\s*/);
    const allowH = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/\s*,\s*/);
    const ok = pre.ok && pre.headers.get("access-control-allow-origin") === ORIGIN
      && (["GET", "HEAD", "POST"].includes(method) || allowM.includes(method)) && custom.every((h) => allowH.includes(h));
    if (!ok) throw new TypeError(`CORS preflight refused ${method} ${url} (${pre.status})`);
  }
  // The widget's AbortSignal belongs to the happy-dom realm; bridge it to a Node one.
  const ac = new AbortController();
  const signal = init.signal as AbortSignal | null | undefined;
  if (signal?.aborted) ac.abort();
  signal?.addEventListener("abort", () => ac.abort());
  given.set("Origin", ORIGIN);
  const res = await fetch(url, { method, headers: given, body: init.body as BodyInit | null | undefined, signal: ac.signal });
  if (res.headers.get("access-control-allow-origin") !== ORIGIN) throw new TypeError(`CORS refused ${method} ${url} (${res.status})`);
  return res;
}

/** A storefront page with the embed's output, the launcher loaded the way Shopify loads the schema `javascript`. */
async function openStorefront(storage?: { local: Record<string, string>; session: Record<string, string> }) {
  const win = new Window({
    url: `${ORIGIN}/`,
    // Trusted code only (our own built bundles), so the insecure-VM warning is silenced.
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, fetch: { virtualServers: [{ url: CDN, directory: ASSETS }] } },
  });
  for (const [k, v] of Object.entries(storage?.local ?? {})) win.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(storage?.session ?? {})) win.sessionStorage.setItem(k, v);
  (win as unknown as { confirm: () => boolean }).confirm = () => true; // "Delete chat" asks first

  const calls: Call[] = [];
  win.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(BASE!)) throw new Error(`unexpected fetch ${url}`);
    const res = await corsFetch(url, init);
    calls.push({ method: init.method ?? "GET", url, status: res.status, body: typeof init.body === "string" ? init.body : null });
    return res;
  }) as unknown as typeof win.fetch;

  const doc = win.document;
  doc.write("<!doctype html><html><head><title>Dev store</title></head><body><main><h1>Home</h1></main></body></html>");
  const root = doc.createElement("div");
  root.id = "askcart-root";
  root.hidden = true;
  root.setAttribute("data-config", JSON.stringify(config));
  root.setAttribute("data-page", JSON.stringify(page));
  root.setAttribute("data-widget-src", CDN + "askcart-widget.js");
  root.setAttribute("data-label", "Ask us anything");
  root.setAttribute("data-aria-label", "Open the chat assistant");
  root.setAttribute("data-teaser", "Questions? We can help.");
  root.setAttribute("data-teaser-close", "Dismiss");
  doc.body.append(root);
  const s = doc.createElement("script");
  s.src = CDN + "askcart-launcher.js";
  s.defer = true;
  doc.body.append(s);
  await win.happyDOM.waitUntilComplete();
  await until(() => doc.querySelector("askcart-host")?.shadowRoot?.querySelector("button.l"), "launcher button", 10_000);

  const sh = () => doc.querySelector("askcart-host")!.shadowRoot!;
  return {
    win,
    calls,
    sh,
    q: <E extends Element = HTMLElement>(sel: string) => sh().querySelector(sel) as unknown as E | null,
    qa: (sel: string) => Array.from(sh().querySelectorAll(sel)) as unknown as HTMLElement[],
    storage: () => ({ local: dump(win.localStorage), session: dump(win.sessionStorage) }),
  };
}

function dump(s: Storage): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) o[s.key(i)!] = s.getItem(s.key(i)!)!;
  return o;
}

async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!BASE)("storefront widget end to end (Task 33, live)", () => {
  it("chats with the real backend: answer, cards, thumbs, remount, delete", async () => {
    // --- page view: nothing reaches our server before the click (Global Constraints) ---
    const a = await openStorefront();
    await new Promise((r) => setTimeout(r, 500));
    expect(a.calls).toEqual([]);
    expect(a.win.document.querySelector(`script[src="${CDN}askcart-widget.js"]`)).toBeNull();

    // --- click the launcher: the chat bundle is injected from the CDN URL and the panel opens ---
    a.q<HTMLButtonElement>("button.l")!.click();
    await until(() => a.q(".panel") && a.q("textarea"), "panel");
    expect(a.win.document.querySelectorAll(`script[src="${CDN}askcart-widget.js"]`).length).toBe(1);

    // --- ask; the answer streams from the real route, then the cards ---
    const input = a.q<HTMLTextAreaElement>("textarea")!;
    input.value = QUESTION;
    input.dispatchEvent(new a.win.Event("input") as unknown as Event);
    a.q<HTMLButtonElement>("button.send")!.click();
    const thumbs = await until(() => a.qa(".msg.bot .askcart-feedback__btn").length === 2 && a.qa(".msg.bot .askcart-feedback__btn"), "answer with thumbs", T - 30_000);

    const chat = a.calls.find((c) => c.url.startsWith(`${BASE}/api/chat`) && c.method === "POST" && !c.url.includes("/feedback"))!;
    expect(chat.status).toBe(200);
    expect(JSON.parse(chat.body!)).toMatchObject({ shop: SHOP, message: QUESTION, pageUrl: `${ORIGIN}/` });
    const answer = a.qa(".msg.bot .txt").map((e) => e.textContent).join("\n");
    expect(answer.length).toBeGreaterThan(10);
    expect(a.qa(".msg.bot.pending")).toEqual([]);

    const cards = a.qa(".ac-card").map((c) => ({
      title: c.querySelector(".ac-card__title")?.textContent ?? "",
      href: c.querySelector("a.ac-card__title")?.getAttribute("href") ?? null,
      price: c.querySelector(".ac-card__price")?.textContent ?? null,
      compareAt: c.querySelector(".ac-card__compare")?.textContent ?? null,
      stock: c.querySelector(".ac-card__stock")?.textContent || null,
      img: c.querySelector("img.ac-card__img")?.getAttribute("src") ?? null,
      add: c.querySelector("button.ac-card__add")?.textContent ?? null,
    }));
    console.log("ANSWER:", answer);
    console.log("CARDS:", JSON.stringify(cards, null, 2));
    expect(cards.length).toBeGreaterThan(0);
    // A live price in the store currency (INR), formatted for the page locale: "₹" and digits.
    expect(cards.some((c) => c.price && /₹\s?[\d,]+(\.\d{2})?/.test(c.price))).toBe(true);
    for (const c of cards) if (c.href) expect(c.href.startsWith("https://")).toBe(true);
    for (const c of cards) if (c.img) expect(c.img.startsWith("https://cdn.shopify.com/")).toBe(true);

    const token = a.win.localStorage.getItem(`askcart:${SHOP}:token`);
    expect(token).toBeTruthy();
    expect(a.calls.every((c) => !c.url.includes(token!))).toBe(true); // Review Focus 3

    // --- thumbs up hits the real feedback route and lands in the DB ---
    thumbs[0].click();
    await until(() => a.calls.find((c) => c.url.includes("/api/chat/feedback")) && !a.q(".askcart-feedback[aria-busy]"), "feedback call", 30_000);
    const fb = a.calls.find((c) => c.url.includes("/api/chat/feedback"))!;
    expect(fb).toMatchObject({ method: "POST", status: 204 });
    const { messageId, rating } = JSON.parse(fb.body!);
    expect(rating).toBe(1);
    expect(thumbs[0].getAttribute("aria-pressed")).toBe("true");
    const [row] = await dev`select rating, conversation_id, cards from messages where id = ${messageId}`;
    expect(row.rating).toBe(1);
    console.log("DB CARDS:", JSON.stringify(row.cards, null, 2));
    const conversationId = row.conversation_id as string;

    // --- "navigate": a new page with the same storage remounts with the history (UD13) ---
    const storage = a.storage();
    await a.win.happyDOM.close();
    const b = await openStorefront(storage);
    if (!b.q(".panel")) b.q<HTMLButtonElement>("button.l")!.click(); // reopened by UD13, or opened by hand
    await until(() => b.qa(".msg.bot .txt").length > 0, "restored history", 30_000);
    expect(b.calls.some((c) => c.url.includes("/api/chat/history") && c.status === 200)).toBe(true);
    expect(b.qa(".msg.user").map((e) => e.textContent)).toEqual([QUESTION]);
    expect(b.qa(".msg.bot .txt").map((e) => e.textContent).join("\n")).toBe(answer);
    expect(b.qa(".ac-card").length).toBe(cards.length);
    await until(() => b.q(".askcart-feedback__btn[aria-pressed='true']"), "restored thumbs-up", 5_000);

    // --- Delete chat: the server deletes the conversation, the widget forgets the token ---
    b.q<HTMLButtonElement>("button.menu")!.click();
    const del = b.qa(".mlist button").find((e) => /delete/i.test(e.textContent ?? ""))!;
    del.click();
    await until(() => b.calls.find((c) => c.method === "DELETE"), "delete call", 30_000);
    await until(() => b.qa(".msg").length === 0, "chat cleared", 10_000);
    expect(b.calls.find((c) => c.method === "DELETE")!.status).toBe(204);
    expect(b.win.localStorage.getItem(`askcart:${SHOP}:token`)).toBeNull();
    const [{ n }] = await dev`select count(*)::int as n from conversations where id = ${conversationId}`;
    const [{ m }] = await dev`select count(*)::int as m from messages where conversation_id = ${conversationId}`;
    expect([n, m]).toEqual([0, 0]);
    await b.win.happyDOM.close();
  }, T);
});
