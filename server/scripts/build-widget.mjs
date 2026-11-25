// Bundles the storefront widget (widget/src) into the theme app extension's assets (C20: Shopify serves them).
// The output is gitignored, so run this before `shopify app dev` / `shopify app deploy` (`npm run dev` does it).
//   node scripts/build-widget.mjs           one build, fails when a file is over its gzip budget
//   node scripts/build-widget.mjs --watch   rebuilds on change, budgets only warn
import * as esbuild from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const assets = path.join(root, "../shopify/extensions/askcart/assets");
const publicDir = path.join(root, "public"); // served by our own app: the embed and the hosted chat page (docs/embed.md)
const watch = process.argv.includes("--watch");

// Gzip budgets in bytes. Launcher and chat come from the M5 plan's Global Constraints; the block scripts use
// Shopify's suggested 10 KB compressed limit for schema-loaded JS.
const entries = [
  { in: "widget/src/launcher.ts", out: "askcart-launcher", budget: 4 * 1024 },
  { in: "widget/src/widget.ts", out: "askcart-widget", budget: 30 * 1024 },
  { in: "widget/src/faq-block.ts", out: "askcart-faq", budget: 10 * 1024 },
  { in: "widget/src/ask-block.ts", out: "askcart-ask", budget: 10 * 1024 },
  { in: "widget/src/ask-ai-block.ts", out: "askcart-ask-ai", budget: 10 * 1024 },
  { in: "widget/src/embed.ts", out: "embed", dir: publicDir, budget: 4 * 1024 },
  { in: "widget/src/hosted.ts", out: "askcart-hosted", dir: publicDir, budget: 30 * 1024 },
];

function report() {
  let over = false;
  for (const e of entries) {
    const file = path.join(e.dir ?? assets, `${e.out}.js`);
    if (!existsSync(file)) continue; // --watch: the other output directory's first build hasn't finished yet
    const buf = readFileSync(file);
    const gz = gzipSync(buf, { level: 9 }).length;
    const bad = gz > e.budget;
    over ||= bad;
    console.log(`${bad ? "OVER" : "ok  "} ${e.out}.js  ${buf.length} B raw, ${gz} B gzip (budget ${e.budget} B)`);
  }
  return over;
}

// One esbuild config per output directory (esbuild won't write outside its outdir).
const dirs = [...new Set(entries.map((e) => e.dir ?? assets))];
const optionsFor = (dir) => ({
  absWorkingDir: root,
  entryPoints: entries.filter((e) => (e.dir ?? assets) === dir).map((e) => ({ in: e.in, out: e.out })),
  outdir: dir,
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  legalComments: "none",
  logLevel: "warning",
});

if (watch) {
  for (const dir of dirs) {
    const ctx = await esbuild.context({
      ...optionsFor(dir),
      plugins: [{ name: "size", setup: (b) => b.onEnd((r) => { if (r.errors.length === 0) report(); }) }],
    });
    await ctx.watch();
  }
  console.log("Watching widget/src ...");
} else {
  for (const dir of dirs) await esbuild.build(optionsFor(dir));
  if (report()) {
    console.error("A widget file is over its gzip budget.");
    process.exit(1);
  }
}
