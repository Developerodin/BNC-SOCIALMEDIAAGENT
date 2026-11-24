// Raw scores of our search() per comparison query, with no cut-off, to tune MIN_SCORE in src/lib/retrieval.ts (D86),
// then what search() returns with the cut-off (k = 10, top 5 distinct products, graded as in run.mts).
// Usage: npx tsx --env-file=.env --tsconfig tsconfig.json scripts/mcp-compare/scores.mts [shopDomain]
// Reads the dev DB only (two embedding calls per query).
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, forStore, sql } from "@/db/client";
import { products, stores } from "@/db/schema";
import { MIN_SCORE, search } from "@/lib/retrieval";

type Query = { id: string; query: string; includeGiftCards?: boolean; expect?: string[]; expectNone?: boolean };

const shop = process.argv[2] ?? "ask-cart-hv7ufqqy.myshopify.com";
const queries: Query[] = JSON.parse(readFileSync(new URL("./queries.json", import.meta.url), "utf8"));
const [store] = await db.select({ id: stores.id }).from(stores).where(eq(stores.shopDomain, shop));
if (!store) throw new Error(`no store row for ${shop}`);

console.log(`MIN_SCORE = ${MIN_SCORE}`);
console.log(`| Query | Expected | Top score (title) | Best expected hit | 5th distinct product | With cut-off: products kept, grade |`);
console.log(`|---|---|---|---|---|---|`);
for (const q of queries) {
  const hits = await search(store.id, q.query, 40, { includeGiftCards: q.includeGiftCards, minScore: -1 });
  const best = new Map<string, number>();
  for (const h of hits) if (!best.has(h.productId)) best.set(h.productId, h.score);
  const ids = [...best.keys()];
  const rows = ids.length
    ? await forStore(store.id, (tx) =>
        tx.select({ id: products.shopifyId, title: products.title }).from(products).where(and(eq(products.storeId, store.id), inArray(products.shopifyId, ids))),
      )
    : [];
  const title = new Map(rows.map((r) => [r.id, r.title]));
  const ranked = ids.map((id) => ({ title: title.get(id) ?? id, score: best.get(id)! }));
  const ok = (t: string) => q.expect?.some((e) => t.toLowerCase().includes(e.toLowerCase()));
  const exp = q.expectNone ? "nothing" : q.expect?.length ? q.expect.join(" / ") : "n/a";
  const hit = q.expectNone || !q.expect?.length ? "-" : (() => {
    const i = ranked.findIndex((r) => ok(r.title));
    return i < 0 ? "none" : `${ranked[i].score.toFixed(3)} (#${i + 1} ${ranked[i].title})`;
  })();
  const top = ranked[0] ? `${ranked[0].score.toFixed(3)} (${ranked[0].title})` : "-";
  // The real call, with the default MIN_SCORE.
  const cut = await search(store.id, q.query, 10, { includeGiftCards: q.includeGiftCards });
  const kept = [...new Set(cut.map((h) => h.productId))].slice(0, 5).map((id) => title.get(id) ?? id);
  const grade = q.expectNone
    ? kept.length ? "fail" : "pass"
    : !q.expect?.length ? "n/a" : kept[0] && ok(kept[0]) ? "hit@1" : kept.some((t) => ok(t)) ? "hit@5" : "miss";
  console.log(`| ${q.id} | ${exp} | ${top} | ${hit} | ${ranked[4]?.score.toFixed(3) ?? "-"} | ${kept.length}, ${grade} |`);
}
await sql.end();
