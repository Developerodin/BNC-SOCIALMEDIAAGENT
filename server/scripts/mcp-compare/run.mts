// Side-by-side: our search() vs Shopify's Storefront Catalog MCP search_catalog, on the same shopper queries.
// Usage: npx tsx --env-file=.env --tsconfig tsconfig.json scripts/mcp-compare/run.mts <profileUrl> [shopDomain]
// Reads the dev DB only (one embedding call per query). Writes scripts/mcp-compare/results.md.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { db, forStore, sql } from "@/db/client";
import { products, stores } from "@/db/schema";
import { search } from "@/lib/retrieval";

type Query = { id: string; kind: string; query: string; includeGiftCards?: boolean; expect?: string[]; expectNone?: boolean };
type Hit = { title: string; note: string };
type Side = { hits: Hit[]; ms: number; error?: string };

const TOP = 5;
const MCP_TIMEOUT_MS = 20_000;

const profileUrl = process.argv[2];
const shop = process.argv[3] ?? "ask-cart-hv7ufqqy.myshopify.com";
if (!profileUrl) {
  console.error("usage: run.mts <publicProfileUrl> [shopDomain]");
  process.exit(1);
}
const queries: Query[] = JSON.parse(readFileSync(new URL("./queries.json", import.meta.url), "utf8"));

const [store] = await db.select({ id: stores.id }).from(stores).where(eq(stores.shopDomain, shop));
if (!store) throw new Error(`no store row for ${shop}`);

async function ours(q: Query): Promise<Side> {
  const t0 = performance.now();
  try {
    // k is larger than TOP so the top TOP distinct products survive the per-product cap.
    const hits = await search(store.id, q.query, TOP * 2, { includeGiftCards: q.includeGiftCards });
    const ms = performance.now() - t0;
    const best = new Map<string, number>();
    for (const h of hits) if (!best.has(h.productId)) best.set(h.productId, h.score);
    const ids = [...best.keys()].slice(0, TOP);
    const rows = ids.length
      ? await forStore(store.id, (tx) =>
          tx
            .select({ id: products.shopifyId, title: products.title })
            .from(products)
            .where(and(eq(products.storeId, store.id), inArray(products.shopifyId, ids))),
        )
      : [];
    const title = new Map(rows.map((r) => [r.id, r.title]));
    return { ms, hits: ids.map((id) => ({ title: title.get(id) ?? id, note: `score ${best.get(id)!.toFixed(3)}` })) };
  } catch (e) {
    return { ms: performance.now() - t0, hits: [], error: String(e) };
  }
}

async function mcp(q: Query): Promise<Side> {
  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    id: 1,
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile: profileUrl } },
        catalog: { query: q.query, pagination: { limit: TOP } },
      },
    },
  };
  const t0 = performance.now();
  try {
    const res = await fetch(`https://${shop}/api/ucp/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (res.status !== 200) {
      const loc = res.headers.get("location");
      return { ms, hits: [], error: `HTTP ${res.status}${loc ? ` -> ${loc}` : ""}: ${text.slice(0, 300)}` };
    }
    const json = JSON.parse(text);
    if (json.error) return { ms, hits: [], error: `JSON-RPC error: ${JSON.stringify(json.error)}` };
    const r = json.result;
    const sc = r?.structuredContent ?? (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : undefined);
    if (r?.isError || !sc?.products) {
      return { ms, hits: [], error: `tool error: ${JSON.stringify(r).slice(0, 500)}` };
    }
    type McpProduct = { title: string; gift_card?: boolean; price_range?: { min?: { currency: string; amount: number } }; variants?: { availability?: { available?: boolean } }[] };
    const hits = (sc.products as McpProduct[]).slice(0, TOP).map((p) => {
      const min = p.price_range?.min;
      const price = min ? `${min.currency} ${(min.amount / 100).toFixed(2)}` : "no price";
      const avail = (p.variants ?? []).some((v) => v.availability?.available) ? "available" : "not available";
      return { title: p.title as string, note: `${price}, ${avail}${p.gift_card ? ", gift card" : ""}` };
    });
    return { ms, hits };
  } catch (e) {
    return { ms: performance.now() - t0, hits: [], error: String(e) };
  }
}

// Untimed warm-up so the first row doesn't carry DB/TLS connection setup.
await ours({ id: "warm", kind: "", query: "snowboard" });
await mcp({ id: "warm", kind: "", query: "snowboard" });

const rows: { q: Query; a: Side; b: Side }[] = [];
for (const q of queries) {
  const [a, b] = await Promise.all([ours(q), mcp(q)]);
  rows.push({ q, a, b });
  console.log(`${q.id}: ours ${a.hits.length} hits ${a.ms.toFixed(0)}ms${a.error ? " ERROR" : ""} | mcp ${b.hits.length} hits ${b.ms.toFixed(0)}ms${b.error ? ` ERROR ${b.error.slice(0, 120)}` : ""}`);
}
await sql.end();

// Grading: a hit when a top title contains any expected substring; expectNone queries pass only on zero results.
type Grade = "hit@1" | "hit@5" | "miss" | "pass" | "fail" | "n/a" | "error";
function grade(q: Query, s: Side): Grade {
  if (s.error) return "error";
  if (q.expectNone) return s.hits.length === 0 ? "pass" : "fail";
  if (!q.expect?.length) return "n/a";
  const ok = (t: string) => q.expect!.some((e) => t.toLowerCase().includes(e.toLowerCase()));
  if (s.hits[0] && ok(s.hits[0].title)) return "hit@1";
  return s.hits.some((h) => ok(h.title)) ? "hit@5" : "miss";
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const lat = (side: "a" | "b") => {
  const xs = rows.filter((r) => !r[side].error).map((r) => r[side].ms);
  const mean = xs.reduce((x, y) => x + y, 0) / (xs.length || 1);
  return `${xs.length} ok calls; mean ${mean.toFixed(0)} ms, p50 ${pct(xs, 50)?.toFixed(0)} ms, p95 ${pct(xs, 95)?.toFixed(0)} ms`;
};
const tally = (side: "a" | "b") => {
  const c: Record<string, number> = {};
  for (const r of rows) {
    const g = grade(r.q, r[side]);
    c[g] = (c[g] ?? 0) + 1;
  }
  return Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(", ");
};

const out: string[] = [];
out.push(`# Our search vs Storefront Catalog MCP`, "");
out.push(`- Store: ${shop}`, `- Run at: ${new Date().toISOString()}`, `- Agent profile: ${profileUrl}`);
out.push(`- Ours: \`search(storeId, query, ${TOP * 2}, { includeGiftCards })\`, top ${TOP} distinct products. Latency includes the OpenAI embedding call.`);
out.push(`- MCP: \`search_catalog\` with \`pagination.limit = ${TOP}\`, no context or filters (so the default \`filters.available = true\` applies). Latency is the full HTTP round trip.`);
out.push(`- Grading: hit@1 / hit@5 when a top title contains an expected string; queries expecting nothing pass only on zero results; n/a = no expected answer.`, "");
out.push(`## Summary`, "");
out.push(`| | Ours | MCP |`, `|---|---|---|`);
out.push(`| Latency | ${lat("a")} | ${lat("b")} |`);
out.push(`| Grades | ${tally("a")} | ${tally("b")} |`);
out.push(`| Queries with zero results | ${rows.filter((r) => !r.a.error && !r.a.hits.length).length} | ${rows.filter((r) => !r.b.error && !r.b.hits.length).length} |`);
out.push(`| Errors | ${rows.filter((r) => r.a.error).length} | ${rows.filter((r) => r.b.error).length} |`);
const both = rows.filter((r) => !r.a.error && !r.b.error && r.a.hits.length && r.b.hits.length);
out.push(`| Same top-1 product (both answered) | ${both.filter((r) => r.a.hits[0].title === r.b.hits[0].title).length} / ${both.length} | |`);
out.push("");

for (const { q, a, b } of rows) {
  out.push(`## ${q.id}: "${cell(q.query)}"`, "");
  out.push(`${q.kind}${q.includeGiftCards ? " (includeGiftCards)" : ""}. Expected: ${q.expectNone ? "nothing" : q.expect?.length ? q.expect.join(" / ") : "no fixed answer"}.`, "");
  out.push(`| # | Ours (${a.ms.toFixed(0)} ms, ${grade(q, a)}) | MCP (${b.ms.toFixed(0)} ms, ${grade(q, b)}) |`, `|---|---|---|`);
  if (a.error || b.error) out.push(`| err | ${cell(a.error ?? "")} | ${cell(b.error ?? "")} |`);
  const n = Math.max(a.hits.length, b.hits.length);
  if (!n && !a.error && !b.error) out.push(`| - | (no results) | (no results) |`);
  for (let i = 0; i < n; i++) {
    const f = (h?: Hit) => (h ? `${cell(h.title)} (${h.note})` : "");
    out.push(`| ${i + 1} | ${f(a.hits[i])} | ${f(b.hits[i])} |`);
  }
  out.push("");
}

const file = new URL("./results.md", import.meta.url);
writeFileSync(file, out.join("\n"));
console.log(`wrote ${fileURLToPath(file)}`);
