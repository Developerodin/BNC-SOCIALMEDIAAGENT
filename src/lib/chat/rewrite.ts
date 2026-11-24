import { chatModel, chatReasoning, deadline, errorStatus, openai } from "./openai";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type Rewrite = { query: string; includeGiftCards: boolean; tokens: { input: number; output: number } };

const REWRITE_TIMEOUT_MS = 5000;
const REWRITE_HISTORY = 6;

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    includeGiftCards: { type: "boolean" },
  },
  required: ["query", "includeGiftCards"],
  additionalProperties: false,
} as const;

// D49 draft wording, to be approved with the other prompt text before the beta.
function instructions(storeLocale: string | null): string {
  const lines = [
    "You turn a shopper's latest chat message into one standalone product-search query for an online store's catalog.",
    "Use the earlier messages only to resolve what the latest message refers to (for example \"the red one\" or \"does it come in XL?\").",
    "Keep it short: the product type, plus any attributes, use or audience the shopper mentioned. Do not answer the shopper.",
    "Set includeGiftCards to true only when the shopper is asking for a gift card or voucher, in any language. Otherwise set it to false.",
  ];
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

function parse(text: string): { query: string; includeGiftCards: boolean } | null {
  try {
    const v = JSON.parse(text) as { query?: unknown; includeGiftCards?: unknown };
    if (typeof v.query !== "string" || !v.query.trim() || typeof v.includeGiftCards !== "boolean") return null;
    return { query: v.query.trim(), includeGiftCards: v.includeGiftCards };
  } catch {
    return null;
  }
}

// One small-model call (C18: on every message). `message` and `history` must already be masked (D41).
// Never throws: on any failure (timeout, 429, 5xx, bad JSON) it falls back to the raw message, without
// gift cards, so search still runs. Logs only the failure kind, never the text (§7.10).
export async function rewriteQuery(opts: {
  message: string;
  history: ChatTurn[];
  storeLocale: string | null;
  signal: AbortSignal;
}): Promise<Rewrite> {
  const fallback = (tokens = { input: 0, output: 0 }): Rewrite => ({
    query: opts.message,
    includeGiftCards: false,
    tokens,
  });
  const d = deadline(REWRITE_TIMEOUT_MS, opts.signal);
  try {
    const res = await openai().responses.create(
      {
        model: chatModel("small"),
        reasoning: chatReasoning("small"),
        store: false,
        instructions: instructions(opts.storeLocale),
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
