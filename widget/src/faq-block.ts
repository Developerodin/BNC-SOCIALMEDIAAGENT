// askcart-faq.js: the product FAQ app block (Task 28, D32, D7). Shopify loads it once per page for every instance.
// Each block starts hidden. The script fetches GET {apiBase}/api/faq?shop=…&product=…, renders a <details>/<summary>
// list (keyboard-accessible with no JS of ours) with textContent only, injects one FAQPage JSON-LD, then shows the
// block. Any failure (server down, non-2xx, bad payload, no items) leaves it hidden (D32 trade-off).
// `hidden` alone can lose to theme rules on the wrapper, so the inline display is set too.

const SEL = "[data-askcart-faq]";
const MAX = 20; // the endpoint's cap, checked again here

type Item = { question: string; answer: string };

function hide(el: HTMLElement) {
  el.hidden = true;
  el.style.display = "none";
}

function itemsOf(body: unknown): Item[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((i): i is Item => typeof i?.question === "string" && typeof i?.answer === "string" && i.question !== "")
    .slice(0, MAX);
}

/** FAQPage structured data. JSON.stringify, then every `<` escaped, so no string can close the script element. */
export function faqJsonLd(items: Item[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.question, acceptedAnswer: { "@type": "Answer", text: i.answer } })),
  }).replace(/</g, "\\u003c");
}

async function load(block: HTMLElement, doc: Document) {
  const { api, shop, product } = block.dataset;
  if (!api || !api.startsWith("https://") || !shop || !product) return hide(block);
  let items: Item[] = [];
  try {
    const url = `${api.replace(/\/+$/, "")}/api/faq?shop=${encodeURIComponent(shop)}&product=${encodeURIComponent(product)}`;
    const res = await fetch(url);
    if (res.ok) items = itemsOf(await res.json());
  } catch {
    // network error or bad JSON: stays empty, so the block hides
  }
  if (items.length === 0) return hide(block);

  const list = block.querySelector<HTMLElement>("[data-askcart-faq-list]") ?? block;
  for (const i of items) {
    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = i.question;
    const answer = doc.createElement("div");
    answer.className = "askcart-faq__answer";
    answer.textContent = i.answer;
    details.append(summary, answer);
    list.append(details);
  }
  const ld = doc.createElement("script");
  ld.type = "application/ld+json";
  ld.textContent = faqJsonLd(items);
  block.append(ld);
  block.hidden = false;
  block.style.display = "";
}

export function initFaqBlocks(doc: Document = document): void {
  const run = () => {
    doc.querySelectorAll<HTMLElement>(SEL).forEach((block) => {
      if (block.dataset.askcartBound) return; // re-runs (theme editor section reloads) must not fetch twice
      block.dataset.askcartBound = "1";
      void load(block, doc);
    });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
  // The theme editor re-renders a section in place when the merchant adds or moves the block.
  doc.addEventListener("shopify:section:load", run);
}

initFaqBlocks(document);
