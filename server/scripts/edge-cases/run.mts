// Edge-case evaluation of the chat pipeline against the real model and the dev store's real data.
// Usage: npx tsx --env-file=.env --tsconfig tsconfig.json scripts/edge-cases/run.mts [shopDomain] [caseIdPrefix]
// Runs each case in cases.json through openTurn + runTurn (the code /api/chat uses), a new conversation per case and one
// turn after another inside it. Writes results.json and results.raw.md (answers, cards, tools); grading is added by hand.
// Tools made are read from the OpenAI request bodies (function_call items sent back as input), so product code is untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, forStore, sql } from "@/db/client";
import { products, stores } from "@/db/schema";
import { openTurn, runTurn, type Card, type TurnStore } from "@/lib/chat/turn";

type Case = { id: string; group: string; messages: string[]; viewingProductHandle?: string; locale?: string; expect: string };
type TurnResult = { question: string; answer: string; cards: { title: string; price: string | null; available: boolean | null }[]; tools: string[]; ms: number; error?: string };

const shop = process.argv[2] ?? "ask-cart-hv7ufqqy.myshopify.com";
const only = process.argv[3]?.split(",");
const cases: Case[] = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")).filter((c: Case) => !only || only.includes(c.id));

const [store] = await db
  .select({ id: stores.id, shopDomain: stores.shopDomain, name: stores.name, primaryLocale: stores.primaryLocale, currencyCode: stores.currencyCode, settings: stores.settings, mode: stores.mode, domains: stores.domains })
  .from(stores)
  .where(eq(stores.shopDomain, shop));
if (!store) throw new Error(`no store row for ${shop}`);
const turnStore: TurnStore = store;
const handles = new Map(
  (await forStore(store.id, (tx) => tx.select({ h: products.handle, id: products.shopifyId }).from(products).where(eq(products.storeId, store.id)))).map((p) => [p.h, p.id]),
);

// Observe OpenAI calls: count them and collect tool names from the function_call items in each request's input.
let openaiCalls = 0;
let seenTools: string[] = [];
const seenCallIds = new Set<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.openai.com")) {
    openaiCalls++;
    try {
      const body = JSON.parse(String(init?.body ?? "{}"));
      for (const it of Array.isArray(body.input) ? body.input : []) {
        if (it?.type === "function_call" && !seenCallIds.has(it.call_id)) {
          seenCallIds.add(it.call_id);
          seenTools.push(`${it.name}(${String(it.arguments ?? "").slice(0, 120)})`);
        }
      }
    } catch {
      /* not JSON (an embeddings or multipart call): nothing to read */
    }
  }
  return realFetch(input, init);
};

const out: { case: Case; turns: TurnResult[] }[] = [];
const t00 = performance.now();
for (const c of cases) {
  const turns: TurnResult[] = [];
  let token: string | undefined;
  const productId = c.viewingProductHandle ? handles.get(c.viewingProductHandle) : undefined;
  if (c.viewingProductHandle && !productId) console.warn(`${c.id}: unknown handle ${c.viewingProductHandle}`);
  for (const q of c.messages) {
    seenTools = [];
    const t0 = performance.now();
    let answer = "";
    const cards: Card[] = [];
    let error: string | undefined;
    try {
      const opened = await openTurn(turnStore, { token, message: q, pageUrl: null });
      if (!opened.ok || opened.replay) throw new Error(`openTurn failed: ${JSON.stringify(opened)}`);
      token = opened.token;
      await runTurn({
        store: turnStore,
        conversationId: opened.conversationId,
        token: opened.token,
        history: opened.history,
        message: opened.message,
        productId,
        signal: new AbortController().signal,
        send: (ev, data) => {
          if (ev === "text") answer += (data as { delta: string }).delta;
          else if (ev === "product") cards.push(data as Card);
          else if (ev === "error") error = (data as { message: string }).message;
        },
      });
    } catch (e) {
      error = String(e);
    }
    const ms = Math.round(performance.now() - t0);
    turns.push({ question: q, answer, cards: cards.map((k) => ({ title: k.title, price: k.price ? `${k.price} ${k.currency ?? ""}`.trim() : null, available: k.available })), tools: seenTools, ms, error });
    console.log(`${c.id}: ${ms}ms ${answer.length} chars ${cards.length} cards tools=[${seenTools.map((t) => t.split("(")[0]).join(",")}]${error ? " ERROR " + error.slice(0, 80) : ""}`);
  }
  out.push({ case: c, turns });
}
await sql.end();
const total = Math.round(performance.now() - t00);

writeFileSync(new URL("./results" + (only ? ".partial" : "") + ".json", import.meta.url), JSON.stringify({ shop, runAt: new Date().toISOString(), totalMs: total, openaiCalls, results: out }, null, 2));
const md: string[] = [`# Raw results`, "", `Store ${shop}; ${cases.length} cases; ${total} ms total; ${openaiCalls} OpenAI calls (rewrite, embeddings, answers and tool loops).`, ""];
for (const { case: c, turns } of out) {
  md.push(`## ${c.id} (${c.group})`, "", `Expect: ${c.expect}`, c.viewingProductHandle ? `Viewing: ${c.viewingProductHandle}` : "", "");
  for (const t of turns) {
    md.push(`**Q:** ${t.question.length > 300 ? t.question.slice(0, 300) + "..." : t.question}`, "", `**A:** ${t.answer || "(empty)"}`, "");
    md.push(`- cards: ${t.cards.length ? t.cards.map((k) => `${k.title} (${k.price ?? "no price"}${k.available === false ? ", unavailable" : ""})`).join("; ") : "none"}`);
    md.push(`- tools: ${t.tools.length ? t.tools.join("; ") : "none"}`, `- ms: ${t.ms}`, `- error: ${t.error ?? "none"}`, "");
  }
}
writeFileSync(new URL("./results.raw" + (only ? ".partial" : "") + ".md", import.meta.url), md.join("\n"));
console.log(`done in ${total} ms, ${openaiCalls} OpenAI calls; wrote ${fileURLToPath(new URL("./results" + (only ? ".partial" : "") + ".json", import.meta.url))}`);
