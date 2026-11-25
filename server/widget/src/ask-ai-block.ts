// askcart-ask-ai.js: the "Ask our AI agent" app block. Shopify loads it once per page for every instance.
// The block renders hidden. This script shows it when the AskCart embed is on, fills the pills (the merchant's
// questions, else AI-written ones from GET {apiBase}/api/chat/product-questions) and, on a tap or a send, asks the
// launcher to open the chat as a drawer with that question sent:
//   window.dispatchEvent(new CustomEvent("askcart:open", { detail: { productId, message, mode: "drawer", title } }))
// title is the block's own eyebrow and heading, as shown. All text goes in through textContent; the accent is
// checked by safeHex before it reaches CSS. Any failure of the questions request just means no pills; the input
// never waits for it.
import { safeHex, textOn } from "./core/format";

const SEL = "[data-askcart-ask-ai]";
const MAX = 2000; // the chat input's limit (panel.ts MAX); not imported so the panel code stays out of this bundle
const MAX_PILLS = 3;
const NS = "http://www.w3.org/2000/svg";

function hide(el: HTMLElement) {
  el.hidden = true;
  el.style.display = "none"; // `hidden` alone can lose to theme rules on the wrapper
}

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
    const url = `${api.replace(/\/+$/, "")}/api/chat/product-questions?shop=${encodeURIComponent(shop)}&product=${encodeURIComponent(product)}&locale=${encodeURIComponent(locale || "")}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const qs = ((await res.json()) as { questions?: unknown } | null)?.questions;
    return Array.isArray(qs) ? qs.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, MAX_PILLS) : [];
  } catch {
    return []; // network error or bad JSON
  }
}

function setup(block: HTMLElement) {
  const accent = safeHex(block.dataset.accent);
  if (accent) {
    block.style.setProperty("--askcart-ai-accent", accent);
    block.style.setProperty("--askcart-ai-on", textOn(accent));
  }

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
  else void fetchQuestions(block).then(render);

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
      block.hidden = false;
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
