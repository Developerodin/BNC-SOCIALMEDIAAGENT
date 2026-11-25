import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// UD18: the Liquid-side strings live in the extension's locale files. Shopify caps each at 15 KB.
const dir = path.resolve(__dirname, "../../../shopify/extensions/askcart/locales");
const LANGS = ["en.default", "fr", "de", "es", "it", "nl"];

function keys(obj: unknown, prefix = ""): string[] {
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}
const load = (lang: string) => JSON.parse(readFileSync(path.join(dir, `${lang}.json`), "utf8"));

describe("extension locales", () => {
  it("has exactly the six languages", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json"));
    expect(files.sort()).toEqual(LANGS.map((l) => `${l}.json`).sort());
  });

  it("English has every Liquid string M5 needs", () => {
    const en = keys(load("en.default"));
    for (const k of ["launcher.label", "launcher.aria_label", "ask_block.button", "faq.heading", "faq.show_answer", "ask_ai.eyebrow", "ask_ai.heading", "ask_ai.placeholder", "ask_ai.send", "ask_ai.note"]) {
      expect(en).toContain(k);
    }
    expect(load("en.default").launcher.label).toBe("Ask us anything");
  });

  it.each(LANGS)("%s: the block's default eyebrow names the store and the heading is a sentence-case question", (lang) => {
    const l = load(lang);
    expect(l.ask_ai.eyebrow).toContain("{{ store }}");
    expect(l.ask_ai.heading).toMatch(/\?$/);
    expect(l.ask_ai.heading).not.toBe(l.ask_ai.heading.toUpperCase());
  });
  it("English defaults", () => {
    const en = load("en.default");
    expect(en.ask_ai.eyebrow).toBe("Your {{ store }} expert");
    expect(en.ask_ai.heading).toBe("A question about this product?");
  });

  it.each(LANGS)("%s: the block note and the default teaser say it is an AI", (lang) => {
    const l = load(lang);
    const ai = /\b(AI|IA|KI)\b|AI-/;
    expect(l.ask_ai.note).toMatch(ai);
    expect(l.launcher.teaser).toMatch(ai);
  });
  it("English note and teaser wording", () => {
    const en = load("en.default");
    expect(en.ask_ai.note).toBe("Answers are written by an AI assistant from this product's data (description, dimensions, price, stock, options).");
    expect(en.launcher.teaser).toBe("Questions? Our AI assistant can help.");
  });

  it.each(LANGS.slice(1))("%s has the same keys as English, all non-empty strings", (lang) => {
    const en = keys(load("en.default")).sort();
    const other = load(lang);
    expect(keys(other).sort()).toEqual(en);
    for (const k of en) {
      const v = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], other);
      expect(typeof v === "string" && v.trim().length > 0).toBe(true);
    }
  });

  it.each(LANGS)("%s is under 15 KB", (lang) => {
    expect(statSync(path.join(dir, `${lang}.json`)).size).toBeLessThan(15 * 1024);
  });
});
