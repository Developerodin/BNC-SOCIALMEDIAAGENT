import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Task 33 / Review Focus 2: every Liquid output in the theme app extension is escaped. Allowed without `| escape`:
//   - `block.shopify_attributes` (Shopify's own editor attributes, must stay raw),
//   - `'key' | t` (Shopify escapes translations unless the key ends in `_html`; none of ours does),
//   - inside a `{% capture %}` that is itself output through `| escape`: values ending in `| json`, or another capture.
const blocks = path.resolve(__dirname, "../../../shopify/extensions/askcart/blocks");
const files = readdirSync(blocks).filter((f) => f.endsWith(".liquid"));

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
  it.each(files)("%s", (file) => {
    const src = readFileSync(path.join(blocks, file), "utf8").replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/, "");
    const captures = new Set([...src.matchAll(/\{%-?\s*capture\s+(\w+)/g)].map((m) => m[1]));
    const bad: string[] = [];
    for (const { expr, capture } of outputs(src)) {
      const filters = expr.split("|").map((s) => s.trim());
      const last = filters[filters.length - 1];
      if (last === "escape") continue;
      if (expr === "block.shopify_attributes") continue;
      if (last === "t" && !/_html['"]/.test(filters[0])) continue;
      if (capture && (last === "json" || captures.has(expr))) continue;
      bad.push(expr);
    }
    expect(bad).toEqual([]);
  });

  it("every capture is output only through escape", () => {
    for (const file of files) {
      const src = readFileSync(path.join(blocks, file), "utf8");
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
