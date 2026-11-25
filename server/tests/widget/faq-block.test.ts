// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initFaqBlocks } from "../../widget/src/faq-block";

const API = "https://app.example.com";

function page(api = API) {
  document.body.innerHTML =
    `<div class="askcart-faq" data-askcart-faq data-shop="s.myshopify.com" data-product="8123" data-api="${api}" hidden>` +
    `<h2>FAQ</h2><div data-askcart-faq-list></div></div>`;
  return document.querySelector<HTMLElement>("[data-askcart-faq]")!;
}

function mockFetch(res: Response | Promise<Response>) {
  const f = vi.fn(async () => res);
  vi.stubGlobal("fetch", f);
  return f;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("FAQ block (Task 28, D32, D7)", () => {
  it("fetches this product's FAQ and renders a details/summary list, visible", async () => {
    const f = mockFetch(json({ items: [{ question: "Waterproof?", answer: "Yes, to 10 m." }, { question: "Size?", answer: "Fits true." }] }));
    const block = page();
    initFaqBlocks(document);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`${API}/api/faq?shop=s.myshopify.com&product=8123`);
    const details = block.querySelectorAll("details");
    expect(details).toHaveLength(2);
    expect(details[0].querySelector("summary")!.textContent).toBe("Waterproof?");
    expect(details[0].textContent).toContain("Yes, to 10 m.");
    expect(block.hidden).toBe(false);
  });

  it("renders an answer with <img onerror> as text", async () => {
    const evil = `<img src=x onerror="window.__pwned=1">`;
    mockFetch(json({ items: [{ question: evil, answer: evil }] }));
    const block = page();
    initFaqBlocks(document);
    await settle();
    expect(block.querySelector("img")).toBeNull();
    expect(block.querySelector("summary")!.textContent).toBe(evil);
    expect(block.querySelector("details")!.textContent).toContain(evil);
  });

  it("injects one FAQPage JSON-LD that parses and has no raw </script>", async () => {
    const a = `</script><script>alert(1)</script>`;
    mockFetch(json({ items: [{ question: "Q1", answer: a }] }));
    const block = page();
    initFaqBlocks(document);
    await settle();
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const raw = scripts[0].textContent!;
    expect(raw).not.toContain("<");
    const data = JSON.parse(raw);
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [{ "@type": "Question", name: "Q1", acceptedAnswer: { "@type": "Answer", text: a } }],
    });
    expect(block.contains(scripts[0])).toBe(true);
  });

  it("a second init (theme editor reload) doesn't fetch or inject twice", async () => {
    const f = mockFetch(json({ items: [{ question: "Q", answer: "A" }] }));
    page();
    initFaqBlocks(document);
    initFaqBlocks(document);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
    expect(document.querySelectorAll("details")).toHaveLength(1);
  });

  it("a 500 hides the block", async () => {
    mockFetch(json({ error: "boom" }, 500));
    const block = page();
    initFaqBlocks(document);
    await settle();
    expect(block.hidden).toBe(true);
    expect(block.style.display).toBe("none");
    expect(block.querySelector("details")).toBeNull();
  });

  it("a network error, no items or a bad payload hides the block", async () => {
    for (const res of [Promise.reject(new Error("offline")), json({ items: [] }), json({ items: "nope" }), json({ items: [{ question: 1, answer: null }] })]) {
      mockFetch(res);
      const block = page();
      initFaqBlocks(document);
      await settle();
      expect(block.hidden).toBe(true);
      expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
    }
  });

  it("a non-https api base never fetches and hides the block", async () => {
    const f = mockFetch(json({ items: [{ question: "Q", answer: "A" }] }));
    const block = page("http://app.example.com");
    initFaqBlocks(document);
    await settle();
    expect(f).not.toHaveBeenCalled();
    expect(block.hidden).toBe(true);
  });
});

describe("askcart-faq.liquid", () => {
  const liquid = readFileSync(path.resolve(__dirname, "../../../shopify/extensions/askcart/blocks/askcart-faq.liquid"), "utf8");

  it("is a product-template block that loads askcart-faq.js, starts hidden and escapes its data attributes", () => {
    expect(liquid).toContain('"javascript": "askcart-faq.js"');
    expect(liquid).toMatch(/"templates":\s*\["product"\]/);
    expect(liquid).toMatch(/\sdata-askcart-faq\s/);
    expect(liquid).toContain("'faq.heading' | t");
    for (const attr of ["data-shop", "data-product", "data-api"]) expect(liquid).toMatch(new RegExp(`${attr}="\\{\\{[^}]*\\| escape \\}\\}"`));
    expect(liquid).toMatch(/\bhidden\b/);
  });
});
