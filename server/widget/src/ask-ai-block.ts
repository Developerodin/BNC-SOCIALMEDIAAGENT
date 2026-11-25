// askcart-ask-ai.js: the "Ask our AI agent" app block. Shopify loads it once per page for every instance.
// The block renders visible (so the page doesn't jump when this script loads); this script hides it when the AskCart
// embed is off, fills the pills (the merchant's questions, else AI-written ones from
// GET {apiBase}/api/chat/product-questions, fetched when the block nears the viewport) and, on a tap or a send, asks the
// launcher to open the chat as a drawer with that question sent:
//   window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId, message, mode: "drawer", title } }))
// title is the block's own eyebrow and heading, as shown. All text goes in through textContent; the accent is
// checked by safeHex before it reaches CSS. Any failure of the questions request just means no pills; the input
// never waits for it.
import { MAX_INPUT_CHARS as MAX } from "../../src/lib/chat/limits"; // the chat's message limit; the file has no imports, so no panel code comes along
import { safeHex, textOn } from "./core/format";

const SEL = "[data-askcart-ask-ai]";
const MAX_PILLS = 3;
const NS = "http://www.w3.org/2000/svg";

function hide(el: HTMLElement) {
  el.hidden = true;
  el.style.display = "none"; // `hidden` alone can lose to theme rules on the wrapper
}

/** "#112233" → "17, 34, 51": the form Dawn-family themes use for colours, so the CSS can mix theme and accent in one rgb(). */
const triplet = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");

function sparkle(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z");
  svg.append(path);
  return svg;
}

async function fetchQuestions(block: HTMLElement): Promise<string[]> {
  const { api, shop, product, locale } = block.dataset;
  if (!api || !api.startsWith("https://") || !shop || !product) return [];
  try {
    const url = `${api.replace(/\/+$/, "")}/api/chat/product-questions?shop=${encodeURIComponent(shop)}&product=${encodeURIComponent(product)}${locale ? `&locale=${encodeURIComponent(locale)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const qs = ((await res.json()) as { questions?: unknown } | null)?.questions;
    return Array.isArray(qs) ? qs.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, MAX_PILLS) : [];
  } catch {
    return []; // network error or bad JSON
  }
}

/** Runs `fn` once the block is within a screen or so of the viewport (right away where IntersectionObserver is missing). */
function whenNear(block: HTMLElement, fn: () => void) {
  if (typeof IntersectionObserver === "undefined") return fn();
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      fn();
    },
    { rootMargin: "800px 0px" },
  );
  io.observe(block);
}

function setup(block: HTMLElement) {
  const accent = safeHex(block.dataset.accent);
  if (accent) {
    block.style.setProperty("--askcart-ai-accent", accent);
    block.style.setProperty("--askcart-ai-on", textOn(accent));
  }
  // The theme's own colours, only when written as Dawn's "R, G, B" triplets: other themes use the same names for hex or
  // other formats, and rgb(var(...)) of those is invalid, which would leave the send button transparent. The button
  // pair is used together or not at all, so the arrow always contrasts with its background; otherwise the AskCart accent.
  const css = getComputedStyle(block);
  const themeRgb = (name: string) => {
    // "18, 18, 18" or Liquid's `.rgb` form "18 18 18"; returned with commas, since the CSS uses rgba(var(...), alpha).
    const m = /^(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})$/.exec(css.getPropertyValue(name).trim());
    return m ? `${m[1]}, ${m[2]}, ${m[3]}` : null;
  };
  const btn = themeRgb("--color-button");
  const btnText = themeRgb("--color-button-text");
  const pair = btn && btnText ? [btn, btnText] : accent ? [triplet(accent), triplet(textOn(accent))] : null;
  if (pair) {
    block.style.setProperty("--askcart-btn-rgb", pair[0]);
    block.style.setProperty("--askcart-btn-text-rgb", pair[1]);
  }
  const fg = themeRgb("--color-foreground");
  if (fg) block.style.setProperty("--askcart-fg-rgb", fg);

  const ask = (message: string) => {
    const eyebrow = block.querySelector("[data-askcart-eyebrow]")?.textContent ?? "";
    const heading = block.querySelector("[data-askcart-heading]")?.textContent ?? "";
    window.dispatchEvent(
      new CustomEvent("askcart:open", {
        detail: { productId: block.dataset.product || null, message, mode: "drawer", title: { eyebrow, heading } },
      }),
    );
  };

  const pills = block.querySelector<HTMLElement>("[data-askcart-pills]");
  const render = (qs: string[]) => {
    if (!pills) return;
    pills.removeAttribute("data-askcart-loading"); // Liquid reserved the pills' space until now
    pills.replaceChildren(
      ...qs.map((q) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "askcart-ai__pill";
        const label = document.createElement("span");
        label.textContent = q;
        b.append(sparkle(), label);
        b.addEventListener("click", () => ask(q.trim().slice(0, MAX)));
        return b;
      }),
    );
  };
  const own = [block.dataset.q1, block.dataset.q2, block.dataset.q3].map((q) => (q ?? "").trim()).filter(Boolean);
  if (own.length) render(own.slice(0, MAX_PILLS));
  else whenNear(block, () => void fetchQuestions(block).then(render));

  const form = block.querySelector<HTMLFormElement>("[data-askcart-form]");
  const input = form?.querySelector<HTMLInputElement>("input");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = (input?.value ?? "").trim().slice(0, MAX);
    if (!message) return;
    ask(message);
    if (input) input.value = "";
  });
}

export function initAskAiBlocks(doc: Document = document): void {
  const run = () => {
    const hasRoot = doc.getElementById("askcart-root") !== null;
    doc.querySelectorAll<HTMLElement>(SEL).forEach((block) => {
      if (!hasRoot) return hide(block); // embed off: nobody listens for askcart:open
      if (block.dataset.askcartBound) return; // re-runs (theme editor section reloads) must not bind or fetch twice
      block.dataset.askcartBound = "1";
      block.hidden = false; // a re-run after the embed was off must show it again
      block.style.display = "";
      setup(block);
    });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
  // The theme editor re-renders a section in place when the merchant adds or moves the block.
  doc.addEventListener("shopify:section:load", run);
}

initAskAiBlocks(document);
