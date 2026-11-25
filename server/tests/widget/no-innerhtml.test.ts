import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Task 33 / Global Constraints "Text only": the widget builds nodes with createElement and textContent. The plan allows
// one exception, a static SVG icon module (panel/icons.ts), but icons.ts uses createElementNS, so no file needs it.
const src = path.resolve(__dirname, "../../widget/src");
const SINK = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser)\b|document\.write(ln)?\b|\beval\s*\(|new\s+Function\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : /\.(ts|js)$/.test(d.name) ? [path.join(dir, d.name)] : [],
  );
}
/** Code only: a comment saying "no innerHTML" is fine. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("widget/src has no HTML-parsing sink (Task 33)", () => {
  const all = files(src);
  it("finds the widget sources", () => expect(all.length).toBeGreaterThan(10));
  it.each(all.map((f) => [path.relative(src, f), f]))("%s", (_rel, f) => {
    const code = stripComments(readFileSync(f, "utf8"));
    expect(code.match(SINK)?.[0] ?? null).toBeNull();
  });
});
