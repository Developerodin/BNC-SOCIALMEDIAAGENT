// The launcher (Task 26: UD1, UD2, UD6, UD13). It loads with every page, so it stays under 4 KB gzip and makes no
// request to our server: the chat script (askcart-widget.js, on Shopify's CDN per C20) is injected only on a click,
// an `askcart:open` event (UD5 block), or when the panel was open on the previous page (UD13).
// Text only: every string goes through textContent, and the accent is checked before it reaches CSS.
import type { PageContext, WidgetConfig } from "../../../src/lib/widget-contract";
import type { OpenArgs } from "../panel/panel"; // type only: no panel code in this bundle
import { brandLogo, safeHex, textOn } from "../core/format";
import { uiState } from "../core/storage";

// message / mode / title come from the "Ask our AI agent" block (askcart-ask-ai.js): the drawer opens with this question sent.
type AskCartApi = { open(a: OpenArgs): void };

const DEFAULT_ACCENT = "#0A0A0A";

const CSS =
  // all:initial also resets the font to the browser default (a serif); take the store's font back.
  ":host{all:initial;font-family:inherit}" +
  ".l,.t{position:fixed;z-index:2147483000;font:inherit;font-size:15px;line-height:20px;box-sizing:border-box}" +
  ".l{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;min-width:48px;padding:0 20px 0 16px;" +
  "border:0;border-radius:24px;background:var(--ac-bg);color:var(--ac-fg);cursor:pointer;" +
  "box-shadow:0 4px 16px rgba(0,0,0,.2),0 1px 3px rgba(0,0,0,.12);font-weight:600;margin:0;text-transform:none;letter-spacing:normal;" +
  "touch-action:manipulation;animation:fo .2s cubic-bezier(0.22,1,0.36,1);transition:transform .15s cubic-bezier(0.22,1,0.36,1),box-shadow .15s}" +
  "@media (hover:hover) and (prefers-reduced-motion:no-preference){.l:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.24),0 1px 3px rgba(0,0,0,.12)}}" +
  "@media (prefers-reduced-motion:no-preference){.l:active{transform:scale(.97)}}" +
  ".l.i{padding:0;width:56px;height:56px;border-radius:28px}" +
  // The logo tab: a small white tab docked to the screen edge at mid-height, with an accent dot.
  ".l.tab{top:50%;bottom:auto;right:0;width:56px;height:64px;min-width:0;padding:0;border-radius:12px 0 0 12px;background:#fff;color:#111;" +
  "box-shadow:-2px 0 12px rgba(0,0,0,.14);transform:translateY(-50%)}" +
  ".l.tab.sl{right:auto;left:0;border-radius:0 12px 12px 0;box-shadow:2px 0 12px rgba(0,0,0,.14)}" +
  ".l.tab:hover,.l.tab:active{transform:translateY(-50%)}" +
  ".l.tab img{display:block;max-width:44px;max-height:44px;object-fit:contain}" +
  ".l.tab::after{content:\"\";position:absolute;top:8px;right:8px;width:8px;height:8px;border-radius:50%;background:var(--ac-bg);box-shadow:0 0 0 2px #fff}" +
  ".l:focus-visible,.t button:focus-visible{outline:3px solid var(--ac-bg);outline-offset:3px}" +
  ".l.tab:focus-visible{outline-color:#2563eb;outline-offset:-3px}" +
  ".t{display:flex;align-items:flex-start;gap:8px;max-width:280px;padding:12px 12px 12px 16px;border-radius:12px;" +
  "background:#fff;color:#111;box-shadow:0 4px 16px rgba(0,0,0,.18);animation:f .2s ease-out}" +
  ".t button{flex:none;width:24px;height:24px;border:0;border-radius:12px;background:transparent;color:#555;" +
  "cursor:pointer;font:inherit;font-size:18px;line-height:24px;padding:0;margin:0}" +
  "@keyframes f{from{opacity:0;transform:translateY(8px)}}@keyframes fo{from{opacity:0}}" + // the button only fades: it appears on every page
  "@media (prefers-reduced-motion:reduce){.l,.t{animation:none;transition:none}}";

function chatIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
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
  // "Ask our AI agent" without theme editing: the embed ships the block in a <template>; put it after the buy form unless
  // the merchant placed the block by hand (any [data-askcart-ask-ai] already in the page), then load its script.
  // Template content is a separate fragment, so the query below only sees blocks that are really in the page.
  const tpl = document.querySelector<HTMLTemplateElement>("template[data-askcart-ask-ai-auto]");
  if (tpl && !document.querySelector("[data-askcart-ask-ai]")) {
    // The real buy form has a submit control; Dawn's price block also renders a hidden "installment" form before it.
    const forms = Array.from(document.querySelectorAll("form[action*='/cart/add']"));
    const isBuy = (f: Element) => !f.matches("[id*='installment'],.installment") && !!f.querySelector("button:not([type=button]):not([type=reset]),[name=add],input[type=submit]");
    const form = forms.find((f) => isBuy(f) && f.closest("main")) ?? forms.find(isBuy) ?? forms.find((f) => f.closest("main")) ?? forms[0]; // not the cart drawer's or a footer's form
    if (form) {
      let anchor: Element = form.closest("product-form") ?? form; // Dawn wraps the form in <product-form>
      // A "Buy it now" button rendered outside that wrapper: land after it, as a child of the wrapper's parent.
      let pay = anchor.parentElement?.querySelector(".shopify-payment-button, shopify-buy-it-now-button") ?? null;
      if (pay && !anchor.contains(pay)) {
        while (pay.parentElement && pay.parentElement !== anchor.parentElement) pay = pay.parentElement;
        anchor = pay;
      }
      // Its own full-width section right after the product section (the user's choice), not inside any theme block:
      // Shopify wraps every section in .shopify-section. `page-width` is Dawn's content-width class; askcart-ask-ai.css
      // gives the same width and padding where a theme doesn't define it. No section wrapper: stay after the buy buttons.
      const section = form.closest(".shopify-section");
      if (section) {
        const wrap = document.createElement("div");
        wrap.className = "askcart-ai-section page-width";
        wrap.append(tpl.content.cloneNode(true));
        section.after(wrap);
      } else anchor.after(tpl.content.cloneNode(true));
      const s = document.createElement("script");
      s.async = true;
      s.src = tpl.dataset.script ?? "";
      if (s.src) document.head.append(s);
    }
  }
  const ui =uiState(page.shop); // the same storage the panel writes (core/storage.ts)
  const left = cfg.launcher.side === "left";
  // The button follows launcher.scope (a config from before it existed means "all"). With no button the launcher still
  // mounts and listens for `askcart:open`, so the product block can open the chat.
  const scope = cfg.launcher.scope ?? "all";
  const showBtn = scope === "all" || (scope === "product" && !!page.productId);
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
  const tab = cfg.launcher.style === "tab";
  if (!tab) {
    btn.style.bottom = offset + "px";
    btn.style[left ? "left" : "right"] = "20px";
  }
  if (tab) {
    // Docked to the edge (offset doesn't apply). The accessible name is the label's translation: the tab shows no text.
    btn.classList.add("tab");
    if (left) btn.classList.add("sl");
    btn.setAttribute("aria-label", d.ariaLabel || "Open the chat assistant");
    const logo = brandLogo(cfg.avatarUrl, page.logo);
    if (logo) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = logo;
      btn.append(img);
    } else btn.append(chatIcon());
  } else if (cfg.launcher.style === "icon") {
    btn.classList.add("i");
    btn.setAttribute("aria-label", d.ariaLabel || "Open the chat assistant");
    btn.append(chatIcon());
  } else {
    // The visible label is the accessible name (WCAG 2.5.3), so no aria-label that would differ from it.
    btn.append(chatIcon(), cfg.launcher.label || d.label || "Ask us anything"); // icon + label pill
  }
  shadow.append(style);
  if (showBtn) shadow.append(btn);
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
    const det = (e as CustomEvent<{ productId?: unknown; message?: unknown; mode?: unknown; title?: { eyebrow?: unknown; heading?: unknown } } | null>).detail;
    const id = det?.productId;
    const args: OpenArgs = { productId: typeof id === "string" || typeof id === "number" ? String(id) : null };
    if (typeof det?.message === "string" && det.message.trim()) args.message = det.message;
    if (det?.mode === "drawer") args.mode = "drawer";
    if (typeof det?.title?.eyebrow === "string" && typeof det.title.heading === "string") args.title = { eyebrow: det.title.eyebrow, heading: det.title.heading };
    openChat(args);
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
  if (showBtn && t && t.enabled && !ui.open.get() && !ui.teaserSeen.get() && !ui.teaserShownThisVisit.get()) {
    const delay = Math.min(120, Math.max(0, Number(t.delaySec) || 0)) * 1000;
    timer = setTimeout(() => {
      ui.teaserShownThisVisit.set(true);
      teaser = document.createElement("div");
      teaser.className = "t";
      teaser.setAttribute("role", "status");
      if (tab) {
        teaser.style.top = "50%";
        teaser.style.transform = "translateY(-50%)";
        teaser.style[left ? "left" : "right"] = "64px";
      } else {
        teaser.style.bottom = offset + 64 + "px";
        teaser.style[left ? "left" : "right"] = "20px";
      }
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
  if (ui.open.get()) openChat({ productId: null, focus: false, ...(ui.drawer.get() && { mode: "drawer" as const }) });

  return () => {
    clearTimeout(timer);
    window.removeEventListener("askcart:open", onOpenEvent);
    host.remove();
  };
}
