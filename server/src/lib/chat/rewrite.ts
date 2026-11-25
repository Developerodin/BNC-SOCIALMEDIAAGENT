import type { Budget, PriceSort } from "./budget";
import { chatModel, chatReasoning, deadline, errorStatus, openai } from "./openai";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type Rewrite = {
  query: string;
  includeGiftCards: boolean;
  /** D87: the shopper's budget in the store currency's major units, or null when they gave none. */
  budget: Budget | null;
  sort: PriceSort | null;
  tokens: { input: number; output: number };
};

// 8 s: the small model took 4.1–5.0 s on 2026-11-24, so 5 s often fell back to the untranslated message (D76).
export const REWRITE_TIMEOUT_MS = 8000;
const REWRITE_HISTORY = 6;

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    includeGiftCards: { type: "boolean" },
    // D87. Strict mode requires every property, so "no budget" is null rather than a missing key.
    budget: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { min: { type: ["number", "null"] }, max: { type: ["number", "null"] } },
          required: ["min", "max"],
          additionalProperties: false,
        },
      ],
    },
    sort: { anyOf: [{ type: "null" }, { type: "string", enum: ["cheapest", "priciest"] }] },
  },
  required: ["query", "includeGiftCards", "budget", "sort"],
  additionalProperties: false,
} as const;

// D49 draft wording, to be approved with the other prompt text before the beta.
function instructions(storeLocale: string | null, storeCurrency: string | null): string {
  const lines = [
    "You turn a shopper's latest chat message into one standalone product-search query for an online store's catalog.",
    "Use the earlier messages only to resolve what the latest message refers to (for example \"the red one\" or \"does it come in XL?\").",
    "Keep it short: the product type, plus any attributes, use or audience the shopper mentioned. Do not answer the shopper.",
    "If the shopper asks for a room, space or broad category rather than a product (for example 'bedroom', 'living room', 'for my office', 'outdoor'), write a query that lists the main product types sold for it (for example for a bedroom: bed, bedside table, wardrobe, chest of drawers, bench), in the store's language. Put the most typical product first.",
    "Set includeGiftCards to true only when the shopper is asking for a gift card or voucher, in any language. Otherwise set it to false.",
    "Leave prices and budgets out of the query.",
    "Set budget only when the shopper states a price limit or range, in any language (for example \"under 50\", \"between 20 and 40\", \"at least 100\"): max for an upper limit, min for a lower one, null for a side they didn't give. Use plain numbers in the currency's major units (1000, not \"1,000\" or cents). If the shopper gives no budget, set budget to null. Never guess one.",
    "Set sort to \"cheapest\" when the shopper asks for the cheapest or least expensive option, \"priciest\" for the most expensive one, otherwise null.",
  ];
  // D87. `// ponytail:` no currency conversion: a budget in another currency keeps its number as if it were in the store's
  // currency. Converting would need exchange rates; Shopify Markets prices per country are not used here either.
  if (storeCurrency) {
    lines.push(
      `The store's prices are in ${storeCurrency}. Give the budget in ${storeCurrency}. If the shopper names a different currency, keep their number unchanged; do not convert it.`,
    );
  }
  // D76: no store language known -> no translation instruction at all (the query keeps the shopper's words).
  if (storeLocale) {
    lines.push(
      `The store's catalog is written in the language with code "${storeLocale}". If the shopper writes in a different language, write the query in that store language. Otherwise keep the shopper's own words.`,
    );
  } else {
    lines.push("Keep the shopper's own words.");
  }
  return lines.join("\n");
}

/** A finite, non-negative number, or undefined (null, missing, negative or not a number). */
function bound(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** D87: null unless at least one bound is usable. Swapped bounds (min above max) are put back in order. */
function parseBudget(v: unknown): Budget | null {
  if (!v || typeof v !== "object") return null;
  const { min, max } = v as { min?: unknown; max?: unknown };
  let lo = bound(min);
  let hi = bound(max);
  if (lo === undefined && hi === undefined) return null;
  if (lo !== undefined && hi !== undefined && lo > hi) [lo, hi] = [hi, lo];
  return { ...(lo !== undefined ? { min: lo } : {}), ...(hi !== undefined ? { max: hi } : {}) };
}

function parse(text: string): Omit<Rewrite, "tokens"> | null {
  try {
    const v = JSON.parse(text) as { query?: unknown; includeGiftCards?: unknown; budget?: unknown; sort?: unknown };
    if (typeof v.query !== "string" || !v.query.trim() || typeof v.includeGiftCards !== "boolean") return null;
    const sort = v.sort === "cheapest" || v.sort === "priciest" ? v.sort : null;
    return { query: v.query.trim(), includeGiftCards: v.includeGiftCards, budget: parseBudget(v.budget), sort };
  } catch {
    return null;
  }
}

// One small-model call (C18: on every message). `message` and `history` must already be masked (D41).
// Never throws: on any failure (timeout, 429, 5xx, bad JSON) it falls back to the raw message, without
// gift cards, budget or sort, so search still runs. Logs only the failure kind, never the text (§7.10).
export async function rewriteQuery(opts: {
  message: string;
  history: ChatTurn[];
  storeLocale: string | null;
  /** stores.currency_code, so a budget is read in the store's currency (D87). Optional: absent means unknown. */
  storeCurrency?: string | null;
  signal: AbortSignal;
}): Promise<Rewrite> {
  const fallback = (tokens = { input: 0, output: 0 }): Rewrite => ({
    query: opts.message,
    includeGiftCards: false,
    budget: null,
    sort: null,
    tokens,
  });
  const d = deadline(REWRITE_TIMEOUT_MS, opts.signal);
  try {
    const res = await openai().responses.create(
      {
        model: chatModel("small"),
        reasoning: chatReasoning("small"),
        store: false,
        instructions: instructions(opts.storeLocale, opts.storeCurrency ?? null),
        input: [
          ...opts.history.slice(-REWRITE_HISTORY).map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: opts.message },
        ],
        text: { format: { type: "json_schema", name: "search_query", strict: true, schema: SCHEMA } },
      },
      { signal: d.signal },
    );
    const tokens = { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 };
    const parsed = parse(res.output_text);
    if (!parsed) {
      console.warn("chat rewrite failed", { reason: "bad_output" });
      return fallback(tokens);
    }
    return { ...parsed, tokens };
  } catch (err) {
    const reason = d.expired() ? "timeout" : opts.signal.aborted ? "aborted" : (errorStatus(err) ?? "error");
    console.warn("chat rewrite failed", { reason });
    return fallback();
  } finally {
    d.clear();
  }
}
