// public/embed.js: the one-line embed for sites that aren't on Shopify's theme system (docs/embed.md).
//   <script src="https://<askcart-host>/embed.js" data-shop="my-store.myshopify.com" defer></script>
// A launcher button; the first click loads the hosted chat page (/chat/<shop>) in an iframe panel. Nothing is requested
// before a click, and no dependencies. Text goes through textContent only; `data-shop` is checked before it reaches a URL.
// The merchant must have allowed this site first (the page refuses to be framed elsewhere).
import { addToCart } from "./cart";

const s = document.currentScript as HTMLScriptElement | null;
const shop = s?.dataset.shop ?? "";

type ShopifyGlobals = { country?: unknown; routes?: { root?: unknown } };
const storefront = () => (window as { Shopify?: ShopifyGlobals }).Shopify;

/**
 * Cart bridge, store-page side (docs/embed.md). Only on a Shopify storefront; elsewhere it never answers, so the chat
 * falls back to "Buy on the store". The caller has already checked origin and source. Strict schema, nothing else is read.
 */
async function answerAdd(frame: HTMLIFrameElement, appOrigin: string, data: unknown) {
  const shopify = storefront();
  const d = data as { type?: unknown; id?: unknown; variantId?: unknown; qty?: unknown } | null;
  if (!shopify || typeof shopify.routes?.root !== "string") return;
  if (!d || typeof d !== "object" || d.type !== "askcart:add") return;
  if (typeof d.id !== "string" || d.id.length < 1 || d.id.length > 64) return;
  if (typeof d.variantId !== "string" || !/^\d{1,20}$/.test(d.variantId)) return;
  if (typeof d.qty !== "number" || !Number.isInteger(d.qty) || d.qty < 1 || d.qty > 10) return;
  // The same cart code the theme widget uses (cart.ts): updateCart / cart:updated, 422 messages from the store.
  const res = await addToCart({ cartAddUrl: shopify.routes.root + "cart/add" }, d.variantId, d.qty);
  const reply: { type: string; id: string; ok: boolean; message?: string } = { type: "askcart:added", id: d.id, ok: res.ok };
  if (!res.ok && res.message) reply.message = res.message;
  // Always the app's own origin, never "*": the cart outcome isn't for anyone else.
  frame.contentWindow?.postMessage(reply, appOrigin);
}

function start(s: HTMLScriptElement) {
  if (document.getElementById("askcart-embed")) return;
  const label = s.dataset.label || "Chat";
  const host = document.createElement("div");
  host.id = "askcart-embed";
  const style = document.createElement("style");
  // z-index near the max so the site's own headers don't cover it. Under 640px (the widget's FULL_BELOW) the panel fills
  // the screen above the button, which stays visible and turns into the close button.
  style.textContent =
    "#askcart-embed button{position:fixed;z-index:2147483000;right:20px;bottom:20px;min-width:48px;height:48px;padding:0 20px;" +
    "border:0;border-radius:24px;background:#0a0a0a;color:#fff;font:600 15px/20px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2)}" +
    "#askcart-embed iframe{position:fixed;z-index:2147483001;right:20px;bottom:80px;width:380px;height:600px;max-height:calc(100% - 100px);" +
    "border:0;border-radius:16px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.24)}" +
    "#askcart-embed iframe[hidden]{display:none}" +
    "@media(max-width:639px){#askcart-embed iframe{inset:0 0 76px;width:100%;height:auto;max-height:none;border-radius:0}}";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.setAttribute("aria-label", label); // the state is aria-expanded, so the name needs no translated "Close"
  btn.setAttribute("aria-expanded", "false");
  let frame: HTMLIFrameElement | null = null;
  function toggle() {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = label;
      const url = new URL("/chat/" + shop, s.src);
      // Hints for the hosted page (it treats them as untrusted): only on a Shopify storefront, and only well-formed values.
      const shopify = storefront();
      if (shopify) {
        url.searchParams.set("bridge", "1");
        if (typeof shopify.country === "string" && /^[A-Z]{2}$/.test(shopify.country)) url.searchParams.set("country", shopify.country);
        const pid = String((window as { ShopifyAnalytics?: { meta?: { product?: { id?: unknown } } } }).ShopifyAnalytics?.meta?.product?.id ?? "");
        if (/^\d{1,20}$/.test(pid)) url.searchParams.set("product", pid);
      }
      frame.src = url.href;
      host.append(frame);
    } else frame.hidden = !frame.hidden;
    const open = !frame.hidden;
    btn.textContent = open ? "×" : label;
    btn.setAttribute("aria-expanded", String(open));
    if (open) frame.focus(); // keyboard and screen-reader users land in the chat
    else btn.focus();
  }
  btn.addEventListener("click", toggle);
  // Escape inside the iframe never reaches this page, so the hosted page (hosted.ts) tells us.
  // Both checks matter: the origin proves it's our app, the source proves it's this iframe and not another window of it.
  const appOrigin = new URL(s.src).origin;
  window.addEventListener("message", (e) => {
    if (!frame || frame.hidden || e.source !== frame.contentWindow || e.origin !== appOrigin) return;
    if (e.data === "askcart:close") toggle();
    else void answerAdd(frame, appOrigin, e.data);
  });
  host.append(style, btn);
  document.body.append(host);
}

if (!s || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
  console.warn("AskCart: data-shop must be your store's .myshopify.com domain.");
} else if (document.body) start(s);
else document.addEventListener("DOMContentLoaded", () => start(s), { once: true });
