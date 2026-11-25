import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

// Task 33: the size budgets (Global Constraints). Runs the real build, which itself exits 1 when a file is over its
// budget, then re-measures here so a change to the script's own budgets can't loosen the plan's numbers unnoticed.
const root = path.resolve(__dirname, "../..");
const assets = path.join(root, "../shopify/extensions/askcart/assets");
const BUDGETS: Record<string, number> = {
  "askcart-launcher.js": 4 * 1024, // the launcher loads on every storefront page
  "askcart-widget.js": 30 * 1024,
  "askcart-faq.js": 10 * 1024, // Shopify's suggested limit for schema-loaded JS
  "askcart-ask.js": 10 * 1024,
};

describe("widget bundle budgets (Task 33)", () => {
  it("builds, and every file is within its gzip budget", () => {
    execFileSync(process.execPath, ["scripts/build-widget.mjs"], { cwd: root, stdio: "pipe" });
    for (const [file, budget] of Object.entries(BUDGETS)) {
      const gz = gzipSync(readFileSync(path.join(assets, file)), { level: 9 }).length;
      expect(gz, `${file} is ${gz} B gzip`).toBeLessThanOrEqual(budget);
    }
  }, 60_000);

  it("ships no HTML-parsing sink in the built files either", () => {
    for (const file of Object.keys(BUDGETS)) {
      const code = readFileSync(path.join(assets, file), "utf8");
      expect(code, file).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/);
    }
  });
});
