// public/embed.js: the one-line embed for sites that aren't on Shopify's theme system (docs/embed.md).
//   <script src="https://<askcart-host>/embed.js" data-shop="my-store.myshopify.com" defer></script>
// A launcher button; the first click loads the hosted chat page (/chat/<shop>) in an iframe panel. Nothing is requested
// before a click, and no dependencies. Text goes through textContent only; `data-shop` is checked before it reaches a URL.
const s = document.currentScript as HTMLScriptElement | null;
const shop = s?.dataset.shop ?? "";

if (s && /^[a-z0-9-]+\.myshopify\.com$/.test(shop) && !document.getElementById("askcart-embed")) {
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
  btn.setAttribute("aria-expanded", "false");
  let frame: HTMLIFrameElement | null = null;
  btn.addEventListener("click", () => {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = label;
      frame.src = new URL("/chat/" + shop, s.src).href;
      host.append(frame);
    } else frame.hidden = !frame.hidden;
    const open = !frame.hidden;
    btn.textContent = open ? "×" : label;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close" : label);
  });
  host.append(style, btn);
  document.body.append(host);
}
