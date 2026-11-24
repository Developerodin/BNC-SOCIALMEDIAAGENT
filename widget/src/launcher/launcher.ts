// The launcher (Task 26: UD1, UD2, UD6, UD13). It loads with every page, so it stays under 4 KB gzip and makes no
// request to our server: the chat script (askcart-widget.js, on Shopify's CDN per C20) is injected only on a click,
// an `askcart:open` event (UD5 block), or when the panel was open on the previous page (UD13).
// Text only: every string goes through textContent, and the accent is checked before it reaches CSS.
import type { PageContext, WidgetConfig } from "../../../src/lib/widget-contract";
import { safeHex, textOn } from "../core/format";
import { uiState } from "../core/storage";

type OpenArgs = { productId: string | null; focus?: boolean };
type AskCartApi = { open(a: OpenArgs): void };

const DEFAULT_ACCENT = "#0A0A0A";

const CSS =
  ":host{all:initial}" +
  ".l,.t{position:fixed;z-index:2147483000;font:inherit;font-size:15px;line-height:20px;box-sizing:border-box}" +
  ".l{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;min-width:48px;padding:0 20px;" +
  "border:0;border-radius:24px;background:var(--ac-bg);color:var(--ac-fg);cursor:pointer;" +
  "box-shadow:0 4px 16px rgba(0,0,0,.2);font-weight:600;margin:0;text-transform:none;letter-spacing:normal}" +
  ".l.i{padding:0;width:56px;height:56px;border-radius:28px}" +
  ".l:focus-visible,.t button:focus-visible{outline:3px solid var(--ac-bg);outline-offset:3px}" +
  ".t{display:flex;align-items:flex-start;gap:8px;max-width:280px;padding:12px 12px 12px 16px;border-radius:12px;" +
  "background:#fff;color:#111;box-shadow:0 4px 16px rgba(0,0,0,.18);animation:f .2s ease-out}" +
  ".t button{flex:none;width:24px;height:24px;border:0;border-radius:12px;background:transparent;color:#555;" +
  "cursor:pointer;font:inherit;font-size:18px;line-height:24px;padding:0;margin:0}" +
  "@keyframes f{from{opacity:0;transform:translateY(8px)}}" +
  "@media (prefers-reduced-motion:reduce){.t{animation:none}}";

function chatIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "26");
  svg.setAttribute("height", "26");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z");
  svg.append(path);
  return svg;
}

/** Draws the launcher from `#askcart-root`. Returns a cleanup function, or nothing when there is nothing to draw. */
export function start(): (() => void) | undefined {
  const root = document.getElementById("askcart-root");
  if (!root || document.querySelector("askcart-host")) return;
  let cfg: WidgetConfig, page: PageContext;
  try {
    cfg = JSON.parse(root.dataset.config ?? "");
    page = JSON.parse(root.dataset.page ?? "");
  } catch {
    return;
  }
  if (!cfg || !cfg.enabled || !cfg.launcher || !page || typeof page.shop !== "string") return;
  const d = root.dataset;
  const ui = uiState(page.shop); // the same storage the panel writes (core/storage.ts)
  const left = cfg.launcher.side === "left";
  const offset = Math.min(200, Math.max(0, Number(cfg.launcher.offset) || 0));
  const accent = safeHex(cfg.accent) ?? DEFAULT_ACCENT;

  // A custom tag name keeps theme selectors like `div { ... }` off the host. Task 30 mounts the panel in this shadow root.
  const host = document.createElement("askcart-host");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "l";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.style.setProperty("--ac-bg", accent);
  btn.style.setProperty("--ac-fg", textOn(accent));
  btn.style.bottom = offset + "px";
  btn.style[left ? "left" : "right"] = "20px";
  if (cfg.launcher.style === "icon") {
    btn.classList.add("i");
    btn.setAttribute("aria-label", d.ariaLabel || "Open the chat assistant");
    btn.append(chatIcon());
  } else {
    // The visible label is the accessible name (WCAG 2.5.3), so no aria-label that would differ from it.
    btn.textContent = cfg.launcher.label || d.label || "Ask us anything";
  }
  shadow.append(style, btn);
  document.body.append(host);

  // --- lazy load ---
  let script: HTMLScriptElement | null = null;
  let loaded = false;
  let pending: OpenArgs | null = null;
  const api = () => (window as unknown as { AskCart?: AskCartApi }).AskCart;

  function openChat(args: OpenArgs) {
    hideTeaser(true);
    if (loaded && api()) return api()!.open(args);
    pending = args; // the latest request wins while the script loads
    if (script || !d.widgetSrc) return;
    script = document.createElement("script");
    script.async = true;
    script.src = d.widgetSrc;
    script.addEventListener("load", () => {
      loaded = true;
      const a = pending;
      pending = null;
      if (a && api()) api()!.open(a);
    });
    script.addEventListener("error", () => {
      // Let the next click try again (a flaky network shouldn't leave a dead button for the whole page view).
      script?.remove();
      script = null;
    });
    document.head.append(script);
  }

  // A <button> already turns Enter and Space into a click.
  btn.addEventListener("click", () => openChat({ productId: null }));
  const onOpenEvent = (e: Event) => {
    const id = (e as CustomEvent<{ productId?: unknown } | null>).detail?.productId;
    openChat({ productId: typeof id === "string" || typeof id === "number" ? String(id) : null });
  };
  window.addEventListener("askcart:open", onOpenEvent);

  // --- teaser (UD6, C28) ---
  let teaser: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hideTeaser(forever: boolean) {
    clearTimeout(timer);
    teaser?.remove();
    teaser = null;
    if (forever) ui.teaserSeen.set(true);
  }

  const t = cfg.teaser;
  if (t && t.enabled && !ui.open.get() && !ui.teaserSeen.get() && !ui.teaserShownThisVisit.get()) {
    const delay = Math.min(120, Math.max(0, Number(t.delaySec) || 0)) * 1000;
    timer = setTimeout(() => {
      ui.teaserShownThisVisit.set(true);
      teaser = document.createElement("div");
      teaser.className = "t";
      teaser.setAttribute("role", "status");
      teaser.style.bottom = offset + 64 + "px";
      teaser.style[left ? "left" : "right"] = "20px";
      const text = document.createElement("span");
      text.textContent = t.text || d.teaser || "";
      const close = document.createElement("button");
      close.type = "button";
      close.setAttribute("aria-label", d.teaserClose || "Dismiss");
      close.textContent = "×";
      close.addEventListener("click", () => hideTeaser(true));
      teaser.append(text, close);
      shadow.append(teaser);
    }, delay);
  }

  // --- reopen (UD13): only after the shopper used the chat, so this is the one page-view load we allow ---
  if (ui.open.get()) openChat({ productId: null, focus: false });

  return () => {
    clearTimeout(timer);
    window.removeEventListener("askcart:open", onOpenEvent);
    host.remove();
  };
}
