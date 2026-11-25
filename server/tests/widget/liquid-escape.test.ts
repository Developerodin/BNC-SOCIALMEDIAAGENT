import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Task 33 / Review Focus 2: every Liquid output in the theme app extension is escaped. Allowed without `| escape`:
//   - `block.shopify_attributes` (Shopify's own editor attributes, must stay raw),
//   - `'key' | t` (Shopify escapes translations unless the key ends in `_html`; none of ours does),
//   - inside a `{% capture %}` that is itself output through `| escape`: values ending in `| json`, or another capture.
const blocks = path.resolve(__dirname, "../../../shopify/extensions/askcart/blocks");
const snippets = path.resolve(__dirname, "../../../shopify/extensions/askcart/snippets");
const files = [
  ...readdirSync(blocks).filter((f) => f.endsWith(".liquid")).map((f) => path.join(blocks, f)),
  ...readdirSync(snippets).filter((f) => f.endsWith(".liquid")).map((f) => path.join(snippets, f)),
];

function outputs(src: string) {
  const out: { expr: string; capture: string | null }[] = [];
  const re = /\{%-?\s*(capture|endcapture)\s*(\w*)\s*-?%\}|\{\{-?\s*([\s\S]*?)\s*-?\}\}/g;
  let capture: string | null = null;
  for (const m of src.matchAll(re)) {
    if (m[1] === "capture") capture = m[2];
    else if (m[1] === "endcapture") capture = null;
    else out.push({ expr: m[3], capture });
  }
  return out;
}

describe("Liquid outputs are escaped (Task 33)", () => {
  it.each(files.map((f) => [path.basename(f), f]))("%s", (_name, file) => {
    const src = readFileSync(file, "utf8").replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/, "");
    const captures = new Set([...src.matchAll(/\{%-?\s*capture\s+(\w+)/g)].map((m) => m[1]));
    const bad: string[] = [];
    for (const { expr, capture } of outputs(src)) {
      const filters = expr.split("|").map((s) => s.trim());
      const last = filters[filters.length - 1];
      if (last === "escape" || last === "escape_once") continue; // escape_once: text that may already be a (HTML-escaped) translation
      if (expr === "block.shopify_attributes" || expr === "shopify_attributes") continue; // the latter is the block's pass-through to the snippet
      if (last === "t" && !/_html['"]/.test(filters[0])) continue;
      if (capture && (last === "json" || captures.has(expr))) continue;
      bad.push(expr);
    }
    expect(bad).toEqual([]);
  });

  it("the embed's viewing field (product title, image, price) is JSON-escaped and only leaves through the escaped data-page", () => {
    const src = readFileSync(path.join(blocks, "askcart-embed.liquid"), "utf8");
    const viewing = src.match(/\{%-?\s*capture viewing\s*-?%\}([\s\S]*?)\{%-?\s*endcapture/)![1];
    for (const expr of ["product.title", "product.featured_image | image_url: width: 160", "product.price"]) {
      expect(viewing).toContain(`{{ ${expr} | json }}`);
    }
    expect(src).toContain('"viewing":{{ viewing }}');
    expect(src).toContain('data-page="{{ ctx | strip | escape }}"');
  });

  it("the embed's logo (the shop's brand logo URL) is JSON-escaped like the rest of the page context", () => {
    const src = readFileSync(path.join(blocks, "askcart-embed.liquid"), "utf8");
    const logo = src.match(/\{%-?\s*capture logo\s*-?%\}([\s\S]*?)\{%-?\s*endcapture/)![1];
    for (const expr of ["shop.brand.logo | image_url: width: 256", "shop.brand.square_logo | image_url: width: 256"]) expect(logo).toContain(`{{ ${expr} | json }}`);
    expect(src).toContain('"logo":{{ logo }}');
  });

  it("translations are not escaped a second time (Shopify's t already escapes them: a second pass shows &#39;)", () => {
    for (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/\|\s*t\s*\|\s*escape\b/);
  });

  it("every capture is output only through escape", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const captures = [...src.matchAll(/\{%-?\s*capture\s+(\w+)/g)].map((m) => m[1]);
      for (const c of captures) {
        for (const { expr, capture } of outputs(src)) {
          if (expr.split("|")[0].trim() !== c || capture) continue;
          expect(expr.trim().endsWith("escape"), `${file}: {{ ${expr} }}`).toBe(true);
        }
      }
    }
  });
});
