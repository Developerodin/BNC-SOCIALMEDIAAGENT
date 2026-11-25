// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initAskAiBlocks } from "../../widget/src/ask-ai-block";

const API = "https://app.example.com";

function page(opts: { root?: boolean; q?: string[]; accent?: string; eyebrow?: string; heading?: string } = {}) {
  const { root = true, q = [], accent = "#112233", eyebrow = "More questions?", heading = "Ask our AI agent" } = opts;
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  document.body.innerHTML =
    `<div class="askcart-ai" data-askcart-ask-ai data-shop="s.myshopify.com" data-product="8123" data-locale="fr" data-api="${API}" data-accent="${attr(accent)}"` +
    ` data-q1="${attr(q[0] ?? "")}" data-q2="${attr(q[1] ?? "")}" data-q3="${attr(q[2] ?? "")}" hidden>` +
    `<p data-askcart-eyebrow></p><h2 data-askcart-heading></h2><div data-askcart-pills></div>` +
    `<form data-askcart-form><input type="text" name="question" maxlength="2000"><button type="submit">Send</button></form></div>` +
    (root ? `<div id="askcart-root" hidden></div>` : "");
  document.querySelector("[data-askcart-eyebrow]")!.textContent = eyebrow;
  document.querySelector("[data-askcart-heading]")!.textContent = heading;
  return document.querySelector<HTMLElement>("[data-askcart-ask-ai]")!;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (res: Response | Promise<Response>) => {
  const f = vi.fn(async () => res);
  vi.stubGlobal("fetch", f);
  return f;
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const pills = (b: HTMLElement) => Array.from(b.querySelectorAll<HTMLButtonElement>(".askcart-ai__pill"));

function listen() {
  const seen = vi.fn();
  window.addEventListener("askcart:open", seen);
  return { seen, stop: () => window.removeEventListener("askcart:open", seen), detail: (i = 0) => (seen.mock.calls[i][0] as CustomEvent).detail };
}

function submit(b: HTMLElement, text: string) {
  const input = b.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  b.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  return input;
}

// The block waits for its scroll position before fetching; most tests want it right away.
class ImmediateIO {
  constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
  observe() {
    queueMicrotask(() => this.cb([{ isIntersecting: true }]));
  }
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", ImmediateIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Ask our AI agent block", () => {
  it("shows the block and renders the merchant's non-empty questions as pills, with no request", async () => {
    const f = mockFetch(json({ questions: ["never used"] }));
    const b = page({ q: ["What are the dimensions?", "", "  Which wood?  "] });
    initAskAiBlocks(document);
    await settle();
    expect(b.hidden).toBe(false);
    expect(pills(b).map((p) => p.textContent)).toEqual(["What are the dimensions?", "Which wood?"]);
    expect(pills(b)[0].querySelector("svg")).not.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("with no merchant questions it fetches the AI ones for this product and renders them when they arrive", async () => {
    const f = mockFetch(json({ questions: ["Is it waterproof?", "", 5, "What size?", "Extra?", "Fourth?"] }));
    const b = page();
    initAskAiBlocks(document);
    expect(pills(b)).toHaveLength(0);
    await settle();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`${API}/api/chat/product-questions?shop=s.myshopify.com&product=8123&locale=fr`);
    expect(pills(b).map((p) => p.textContent)).toEqual(["Is it waterproof?", "What size?", "Extra?"]);
  });

  it.each([
    ["an empty list", () => mockFetch(json({ questions: [] }))],
    ["a server error", () => mockFetch(json({ error: "x" }, 500))],
    ["a network error", () => mockFetch(Promise.reject(new Error("offline")))],
    ["a bad payload", () => mockFetch(json({ questions: "nope" }))],
  ])("%s: no pills, and the input still works", async (_n, arrange) => {
    arrange();
    const b = page();
    initAskAiBlocks(document);
    await settle();
    expect(pills(b)).toHaveLength(0);
    expect(b.hidden).toBe(false);
    const ev = listen();
    submit(b, "Still works?");
    ev.stop();
    expect(ev.seen).toHaveBeenCalledTimes(1);
  });

  it("the input works while the questions request is still pending", () => {
    mockFetch(new Promise<Response>(() => {}));
    const b = page();
    initAskAiBlocks(document);
    const ev = listen();
    submit(b, "Quick one");
    ev.stop();
    expect(ev.detail().message).toBe("Quick one");
  });

  it("a pill opens the drawer with that question, this product and the block's own heading", () => {
    const b = page({ q: ["Which wood?"], eyebrow: "Plus de questions ?", heading: "Demandez à l’IA" });
    initAskAiBlocks(document);
    const ev = listen();
    pills(b)[0].click();
    ev.stop();
    expect(ev.detail()).toEqual({
      productId: "8123",
      message: "Which wood?",
      mode: "drawer",
      title: { eyebrow: "Plus de questions ?", heading: "Demandez à l’IA" },
    });
  });

  it("sending the input trims, ignores empty, clears the field and caps the length", () => {
    const b = page();
    mockFetch(json({ questions: [] }));
    initAskAiBlocks(document);
    const ev = listen();
    submit(b, "   ");
    expect(ev.seen).not.toHaveBeenCalled();
    const input = submit(b, "  How heavy?  ");
    expect(ev.detail().message).toBe("How heavy?");
    expect(input.value).toBe("");
    submit(b, "x".repeat(2500));
    ev.stop();
    expect(ev.detail(1).message).toHaveLength(2000);
  });

  it("hides the whole block when the embed is off (no #askcart-root) and requests nothing", () => {
    const f = mockFetch(json({ questions: ["x"] }));
    const b = page({ root: false });
    initAskAiBlocks(document);
    expect(b.hidden).toBe(true);
    expect(b.style.display).toBe("none");
    expect(f).not.toHaveBeenCalled();
  });

  it("a re-run (theme editor section reload) binds and fetches once", async () => {
    const f = mockFetch(json({ questions: ["A?"] }));
    const b = page();
    initAskAiBlocks(document);
    initAskAiBlocks(document);
    document.dispatchEvent(new Event("shopify:section:load"));
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(pills(b)).toHaveLength(1);
    const ev = listen();
    submit(b, "once");
    ev.stop();
    expect(ev.seen).toHaveBeenCalledTimes(1);
  });

  it("merchant, model and server text never becomes markup", async () => {
    mockFetch(json({ questions: ['<img src=x onerror="window.__pwn=1">AI'] }));
    const b = page();
    initAskAiBlocks(document);
    await settle();
    expect(b.querySelector("img")).toBeNull();
    expect(pills(b)[0].textContent).toBe('<img src=x onerror="window.__pwn=1">AI');
    document.body.innerHTML = "";
    const own = page({ q: ["<b>bold</b>"] });
    initAskAiBlocks(document);
    expect(own.querySelector("b")).toBeNull();
    expect(pills(own)[0].textContent).toBe("<b>bold</b>");
  });

  it("the accent reaches CSS only when it is a real colour", () => {
    const ok = page({ accent: "#FFE600" });
    initAskAiBlocks(document);
    expect(ok.style.getPropertyValue("--askcart-ai-accent")).toBe("#FFE600");
    expect(ok.style.getPropertyValue("--askcart-ai-on")).toBe("#000000");
    document.body.innerHTML = "";
    const bad = page({ accent: "red;}body{display:none" });
    initAskAiBlocks(document);
    expect(bad.style.getPropertyValue("--askcart-ai-accent")).toBe("");
  });
});

const ext = path.resolve(__dirname, "../../../shopify/extensions/askcart");
const blockSrc = readFileSync(path.join(ext, "blocks/askcart-ask-ai.liquid"), "utf8");
const snippetSrc = readFileSync(path.join(ext, "snippets/askcart-ask-ai.liquid"), "utf8"); // the markup, shared with the app embed

describe("askcart-ask-ai.liquid", () => {
  const liquid = blockSrc + snippetSrc;
  const schema = JSON.parse(blockSrc.split("{% schema %}")[1].split("{% endschema %}")[0]);

  it("is a product-page section block that loads askcart-ask-ai.js", () => {
    expect(schema.target).toBe("section");
    expect(schema.enabled_on).toEqual({ templates: ["product"] });
    expect(schema.javascript).toBe("askcart-ask-ai.js");
  });

  it("has the merchant settings", () => {
    const ids = schema.settings.filter((s: { id?: string }) => s.id).map((s: { id: string }) => s.id);
    expect(ids).toEqual(["eyebrow", "heading", "question_1", "question_2", "question_3"]);
  });

  it("always shows the AI note: no setting can switch it off, and it is escaped", () => {
    expect(liquid).not.toContain("show_note");
    expect(liquid).toMatch(/<p class="askcart-ai__note">\{\{ 'ask_ai\.note' \| t \| escape \}\}<\/p>/);
    expect(liquid.slice(0, liquid.indexOf("{% schema %}"))).not.toMatch(/\{%-?\s*if[^%]*%\}\s*<p class="askcart-ai__note"/);
  });

  it("falls back to the storefront locale strings and renders visible (the script hides it when the embed is off)", () => {
    for (const k of ["ask_ai.eyebrow", "ask_ai.heading", "ask_ai.placeholder", "ask_ai.send", "ask_ai.note"]) expect(liquid).toContain(`'${k}' | t`);
    expect(liquid).not.toMatch(/\r?\n\s+hidden\r?\n/); // no `hidden` attribute: it would shift the page when the script reveals it (CRLF-tolerant)
    expect(liquid).toContain("data-askcart-loading"); // the pills' space is reserved until they arrive
    expect(liquid).toContain("{%- if product and cfg.enabled and cfg.apiBase != blank -%}");
  });
});

describe("lazy questions fetch", () => {
  class FakeIO {
    static last: FakeIO | null = null;
    disconnected = false;
    constructor(public cb: (e: { isIntersecting: boolean }[]) => void, public opts?: IntersectionObserverInit) {
      FakeIO.last = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    fire(isIntersecting: boolean) {
      this.cb([{ isIntersecting }]);
    }
  }

  it("waits until the block nears the viewport, then fetches once", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    const f = mockFetch(json({ questions: ["Is it waterproof?"] }));
    const b = page();
    initAskAiBlocks(document);
    await settle();
    expect(f).not.toHaveBeenCalled();
    expect(FakeIO.last!.opts?.rootMargin).toMatch(/^\d+px/);
    FakeIO.last!.fire(false);
    expect(f).not.toHaveBeenCalled();
    FakeIO.last!.fire(true);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(FakeIO.last!.disconnected).toBe(true);
    expect(pills(b)).toHaveLength(1);
  });

  it("omits locale when the dataset is empty", async () => {
    const f = mockFetch(json({ questions: [] }));
    const b = page();
    b.dataset.locale = "";
    initAskAiBlocks(document);
    await settle();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`${API}/api/chat/product-questions?shop=s.myshopify.com&product=8123`);
  });

  it("the reserved pill space is released when the questions arrive", async () => {
    mockFetch(json({ questions: ["A?"] }));
    const b = page();
    b.querySelector("[data-askcart-pills]")!.setAttribute("data-askcart-loading", "");
    initAskAiBlocks(document);
    await settle();
    expect(b.querySelector("[data-askcart-pills]")!.hasAttribute("data-askcart-loading")).toBe(false);
  });
});

describe("askcart-ask-ai.liquid theme matching", () => {
  const liquid = blockSrc + snippetSrc;
  // App blocks can't hold {% stylesheet %} (Shopify's AppBlockValidTags check): the CSS is an asset named in the schema.
  const css = readFileSync(path.resolve(__dirname, "../../../shopify/extensions/askcart/assets/askcart-ask-ai.css"), "utf8");

  it("loads its CSS as an asset, never a {% stylesheet %} tag", () => {
    expect(liquid).not.toContain("{% stylesheet %}");
    expect(liquid).toContain('"stylesheet": "askcart-ask-ai.css"');
  });

  it("takes font and colour from the theme", () => {
    expect(css).toMatch(/\.askcart-ai \{[^}]*font-family: inherit;[^}]*color: inherit;/);
    expect(css).not.toMatch(/font-family: (?!inherit|var\()/);
    expect(css).toContain("var(--font-heading-family, inherit)");
    expect(css).toContain("var(--font-heading-weight, 700)");
  });

  it("uses Dawn-family variables, each with a fallback", () => {
    for (const v of ["--inputs-radius", "--buttons-radius", "--askcart-fg-rgb", "--askcart-btn-rgb", "--askcart-btn-text-rgb"]) {
      expect(css).toMatch(new RegExp(`var\\(${v},\\s*\\S`));
    }
    // Theme colours never go into rgb() unchecked: a hex --color-button would make the send button transparent.
    expect(css).not.toMatch(/var\(--color-(button|foreground)/);
  });

  it("text is in em (scales with the theme), touch targets are at least 44px, and nothing renders hidden", () => {
    expect(css).not.toMatch(/font-size: \d+px/);
    expect(css).toMatch(/--askcart-h: 48px/);
    expect(css).toMatch(/\.askcart-ai__send \{[^}]*width: 44px; height: 44px/);
    expect(liquid).toContain("{{ 'ask_ai.note' | t | escape }}");
  });
});

describe("theme colours", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const vars = (b: HTMLElement) => ["--askcart-btn-rgb", "--askcart-btn-text-rgb", "--askcart-fg-rgb"].map((n) => b.style.getPropertyValue(n));

  it("uses the theme's button and text colours when they are R, G, B triplets", () => {
    mockFetch(json({ questions: [] }));
    const b = page();
    // Set on the block: happy-dom doesn't inherit custom properties from <html> the way browsers do.
    b.style.setProperty("--color-button", "200, 100, 50");
    b.style.setProperty("--color-button-text", "255, 255, 255");
    b.style.setProperty("--color-foreground", "18, 18, 18");
    initAskAiBlocks(document);
    expect(vars(b)).toEqual(["200, 100, 50", "255, 255, 255", "18, 18, 18"]);
  });

  it("falls back to the AskCart accent when the theme writes those colours another way (hex)", () => {
    mockFetch(json({ questions: [] }));
    const b = page({ accent: "#112233" });
    b.style.setProperty("--color-button", "#c86432");
    b.style.setProperty("--color-button-text", "#ffffff");
    b.style.setProperty("--color-foreground", "#121212");
    initAskAiBlocks(document);
    expect(vars(b)).toEqual(["17, 34, 51", "255, 255, 255", ""]);
  });
});

describe("theme colours, space-separated", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts Liquid's `.rgb` form (\"18 18 18\") and passes it on with commas", () => {
    mockFetch(json({ questions: [] }));
    const b = page();
    b.style.setProperty("--color-button", "200 100 50");
    b.style.setProperty("--color-button-text", "255 255 255");
    b.style.setProperty("--color-foreground", "18 18 18");
    initAskAiBlocks(document);
    expect(["--askcart-btn-rgb", "--askcart-btn-text-rgb", "--askcart-fg-rgb"].map((n) => b.style.getPropertyValue(n))).toEqual([
      "200, 100, 50",
      "255, 255, 255",
      "18, 18, 18",
    ]);
  });
});

describe("the app embed's automatic copy of the block", () => {
  const embed = readFileSync(path.join(ext, "blocks/askcart-embed.liquid"), "utf8");
  const schema = JSON.parse(embed.split("{% schema %}")[1].split("{% endschema %}")[0]);
  const tpl = embed.match(/<template data-askcart-ask-ai-auto[\s\S]*?<\/template>/)![0];

  it("has an on-by-default checkbox with the agreed wording", () => {
    expect(schema.settings).toEqual([
      {
        type: "checkbox",
        id: "auto_ask_ai",
        label: 'Show "Ask our AI agent" below Add to cart on product pages',
        info: "If you place the block yourself in the theme editor, yours is used instead.",
        default: true,
      },
    ]);
  });

  it("renders the template only on product pages with the setting on, inside the enabled branch", () => {
    expect(embed).toContain("{%- if block.settings.auto_ask_ai and request.page_type == 'product' and product and cfg.apiBase != blank -%}");
    expect(embed.indexOf("data-askcart-ask-ai-auto")).toBeGreaterThan(embed.indexOf('id="askcart-root"'));
  });

  it("uses the block's own snippet with AI-written questions (none set) and no editor attributes", () => {
    expect(tpl).toMatch(/\{%-? render 'askcart-ask-ai', cfg: cfg, product: product, eyebrow: ask_eyebrow, heading: ask_heading, pill_count: 3 -%\}/);
    expect(tpl).not.toContain("question_");
    expect(tpl).not.toContain("shopify_attributes");
    expect(blockSrc).toContain("{%- render 'askcart-ask-ai',");
    expect(tpl).toContain('<link rel="stylesheet"');
  });

  it("escapes the script and stylesheet URLs", () => {
    expect(tpl).toContain("data-script=\"{{ 'askcart-ask-ai.js' | asset_url | escape }}\"");
    expect(tpl).toContain("href=\"{{ 'askcart-ask-ai.css' | asset_url | escape }}\"");
  });

  it("every output in the snippet is escaped, except the editor attributes the block passes through", () => {
    const body = snippetSrc.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/, "");
    const outs = [...body.matchAll(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g)].map((m) => m[1]);
    expect(outs.length).toBeGreaterThan(8);
    expect(outs.filter((e) => !/\|\s*escape$/.test(e))).toEqual(["shopify_attributes"]);
  });
});
