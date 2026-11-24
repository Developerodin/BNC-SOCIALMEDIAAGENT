import type { FunctionTool } from "openai/resources/responses/responses";
import type { SearchHit } from "@/lib/retrieval";
import { searchProducts } from "@/lib/search-provider";
import { getProduct } from "@/lib/shopify/catalog-mcp";
import { askPolicies, POLICY_TYPES, type PolicyType } from "@/lib/shopify/storefront-mcp";
import { productBlock, sanitizeData, type PromptProducts } from "./prompt";

// The chat agent's tools (Responses API function tools), run by answer()'s tool loop:
// - store_policies: Shopify Storefront MCP search_shop_policies_and_faqs (returns, shipping, contact, FAQs).
// - search_products: another product search through the store's provider (ours, or Shopify's Catalog MCP, D89), when the
//   turn's first search didn't fit. New products are live-checked and numbered after this turn's, so [[product:<n>]]
//   cards work for them.
// Results are wrapped in <store_data> and sanitized like the rest of the store data (prompt rules 1 and 8).

/** At most this many new products per search_products call, so one call can't flood the prompt. */
const TOOL_PRODUCTS = 5;
const TOOL_SEARCH_K = 8;

export const TOOL_DEFS: FunctionTool[] = [
  {
    type: "function",
    name: "store_policies",
    description:
      "Look up the store's own policies and FAQ answers: returns, refunds, exchanges, shipping, delivery times, payment, privacy, contact details, opening hours. Call it for any question about the store itself rather than its products.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The shopper's question in plain language." },
        policy_types: {
          type: "array",
          items: { type: "string", enum: [...POLICY_TYPES] },
          description: 'Written policies the question touches, e.g. ["refund"] for returns, ["contact"] for phone or hours. Empty for FAQ answers only.',
        },
      },
      required: ["query", "policy_types"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_products",
    description:
      "Search the store's catalog again, only when <store_data> has no product related to the shopper's request at all. Not for sold-out products: those are answered from <store_data>, with the alternatives there.",
    strict: true,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Product search words, e.g. 'waterproof snowboard boots'." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

// product_details: Shopify's UCP get_product for one product of this turn. Only offered with UCP_AGENT_PROFILE_URL (the
// request needs the agent profile). When to call it is only in this description: a fuller rule in the system prompt made
// the live sold-out test worse (see TOOLS_RULE in prompt.ts).
const PRODUCT_DETAILS_DEF: FunctionTool = {
  type: "function",
  name: "product_details",
  description:
    "Get the full details of ONE product from <store_data>: its description and specifications, and all its options and variants (sizes, colours, materials). Call it when the shopper asks about a specific product's details that <store_data> doesn't cover, such as whether a size or colour exists or what it is made of. Not for price or stock: those are only in the LIVE lines.",
  strict: true,
  parameters: {
    type: "object",
    properties: { product: { type: "string", description: "The product's number from <store_data>, for example '2' for #2." } },
    required: ["product"],
    additionalProperties: false,
  },
};

/** The tools to offer: TOOL_DEFS, plus product_details when the UCP agent profile is configured. */
export const toolDefs = (): FunctionTool[] => (process.env.UCP_AGENT_PROFILE_URL ? [...TOOL_DEFS, PRODUCT_DETAILS_DEF] : TOOL_DEFS);

export type ToolContext = {
  store: { id: string; shopDomain: string; settings: unknown };
  /** This turn's live-check outcome; new products are added to it. */
  live: PromptProducts;
  /** n → GID, shared with the marker parser; new products are added to it. */
  allowed: Map<string, string>;
  threshold: number;
  includeGiftCards: boolean;
  signal: AbortSignal;
  /** The turn's live check (turn.ts checkProducts). */
  check: (ids: string[]) => Promise<PromptProducts>;
};

const data = (body: string) => `<store_data>\n${body}\n</store_data>`;

/** Runs one tool call. Always returns text for the model (an error is a sentence, not a throw). */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return "Invalid arguments.";
  }
  if (name === "product_details") return data(await productDetails(args.product, ctx));
  const query = typeof args.query === "string" ? args.query.slice(0, 500) : "";
  if (!query.trim()) return "Invalid arguments: query is empty.";

  if (name === "store_policies") {
    const types = (Array.isArray(args.policy_types) ? args.policy_types : []).filter((t): t is PolicyType =>
      (POLICY_TYPES as readonly unknown[]).includes(t),
    );
    const text = await askPolicies(ctx.store.shopDomain, query, types, { storeId: ctx.store.id, signal: ctx.signal });
    if (text === null) return data("Store policies are unavailable right now. Suggest the shopper checks the store's policy pages or contacts the store.");
    // Policy answers can mention prices or stock; D37: never quote prices, stock only from LIVE lines.
    return data(text ? `${sanitizeData(text)}\n(Any price or stock in this answer is not authoritative.)` : "The store has no policy or FAQ answer for this.");
  }

  if (name === "search_products") return data(await searchMore(query, ctx));

  return `Unknown tool: ${name}.`;
}

/** The product_details text is cut to this many characters (descriptions can be long). */
const MAX_DETAILS_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_VARIANTS = 40;

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const htmlToText = (html: unknown) =>
  text(typeof html === "string" ? html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&") : "");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/**
 * product_details: get_product for the product with this number in `allowed` (the model never passes a GID, so it can't
 * fetch a product outside this turn's <store_data>).
 * Prices, stock and availability from get_product are deliberately left out: the prompt says prices are never written
 * and stock comes only from the LIVE lines, and a second source of availability here (real-time, but per variant and
 * possibly out of step with the turn's live check) would invite the model to quote it. The model gets what the LIVE line
 * doesn't have: description, options and variant names. Links, images and selling-plan prices are left out too.
 */
async function productDetails(arg: unknown, ctx: ToolContext): Promise<string> {
  const n = typeof arg === "number" ? String(arg) : typeof arg === "string" ? arg.trim().replace(/^#/, "") : "";
  const id = ctx.allowed.get(n);
  if (!id) return "Unknown product number: use a number from <store_data>.";
  const p = await getProduct(ctx.store.shopDomain, id, { storeId: ctx.store.id, signal: ctx.signal });
  if (!p) return "Product details are unavailable right now. Answer from <store_data> only.";

  const lines = [`#${n} ${text(p.title)}`];
  const description = htmlToText((p.description as { html?: unknown } | undefined)?.html).slice(0, MAX_DESCRIPTION_CHARS);
  if (description) lines.push(`Description: ${description}`);
  for (const o of list(p.options)) {
    const values = list(o.values).map((v) => text(v.label)).filter(Boolean);
    if (values.length) lines.push(`Option ${text(o.name)}: ${values.join(", ")}`);
  }
  const variants = list(p.variants);
  for (const v of variants.slice(0, MAX_VARIANTS)) {
    const opts = list(v.options).map((o) => `${text(o.name)}: ${text(o.label)}`).join(", ");
    lines.push(`Variant: ${text(v.title)}${opts ? ` (${opts})` : ""}`);
  }
  if (variants.length > MAX_VARIANTS) lines.push(`(${variants.length - MAX_VARIANTS} more variants not listed)`);
  const tags = (Array.isArray(p.tags) ? p.tags : []).map(text).filter(Boolean);
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push("Price and stock are not given here: they come only from the LIVE lines.");
  // Sanitize first (it only removes text), then cut.
  return sanitizeData(lines.join("\n")).slice(0, MAX_DETAILS_CHARS);
}

/**
 * search_products: products already numbered this turn are referred to by their number; new ones (up to TOOL_PRODUCTS)
 * are live-checked, added to `live` and `allowed`, and described like buildInput does.
 * `// ponytail:` when this call's live check and the turn's disagree (one live, one fallback), the new products can't
 * join `live` in its shape, so they are left out and the model is told search is unavailable. Rare: both checks hit the
 * same Shopify API seconds apart.
 */
async function searchMore(query: string, ctx: ToolContext): Promise<string> {
  const hits = await searchProducts(ctx.store, query, TOOL_SEARCH_K, { includeGiftCards: ctx.includeGiftCards, signal: ctx.signal });
  const numberOf = new Map([...ctx.allowed].map(([n, id]) => [id, n]));
  const texts = new Map<string, string[]>();
  for (const h of hits as SearchHit[]) {
    if (!numberOf.has(h.productId) && !texts.has(h.productId) && texts.size >= TOOL_PRODUCTS) continue;
    texts.set(h.productId, [...(texts.get(h.productId) ?? []), h.content]);
  }
  if (texts.size === 0) return "No products match this search.";

  const fresh = [...texts.keys()].filter((id) => !numberOf.has(id));
  if (fresh.length) {
    const r = await ctx.check(fresh);
    if (r.ok !== ctx.live.ok) return "Product search is unavailable right now.";
    for (const id of fresh) {
      const got = r.ok ? r.products.get(id) : r.cards.get(id);
      if (!got) continue; // dropped by the live check (unpublished, gift card, gone)
      if (ctx.live.ok && r.ok) ctx.live.products.set(id, r.products.get(id)!);
      else if (!ctx.live.ok && !r.ok) ctx.live.cards.set(id, r.cards.get(id)!);
      const n = String(ctx.allowed.size + 1);
      ctx.allowed.set(n, id);
      numberOf.set(id, n);
    }
  }

  const blocks = [...texts]
    .filter(([id]) => numberOf.has(id))
    .map(([id, t]) => productBlock({ n: numberOf.get(id)!, id, texts: t, live: ctx.live, threshold: ctx.threshold }));
  return blocks.length ? blocks.join("\n\n") : "No products match this search.";
}
