import { chunkText } from "@/lib/chunking";
import type { SearchHit } from "@/lib/retrieval";
import { callUcpTool, mergeProducts } from "./catalog-mcp";
import type { LiveProduct } from "./live-products";
import { McpHttpError } from "./mcp-call";
import { breakerOpen, MCP_BUDGET_MS, recordUcp } from "./ucp-guard";
import { toLiveProduct } from "./ucp-live";

// MCP-only stores (stores.mode = 'mcp'): there is no products table, the catalog IS Shopify's UCP payload, kept in memory
// for one chat turn. Search and live check for these stores live here; installed stores never touch this file.

type Obj = Record<string, unknown>;
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === "object") : []);

const CALL_TIMEOUT_MS = 3000; // one call; the turn's whole budget is MCP_BUDGET_MS
const LOOKUP_IDS = 10; // lookup_catalog's maxItems for `ids` (tools/list)
const MIN_CALL_MS = 300; // below this much budget a call can't finish; skip it

/** The store-data note when Shopify's catalog gave no answer at all (turn.ts, and the search_products tool). */
export const CATALOG_DEGRADED =
  "The product catalog is temporarily unavailable, so no products could be looked up. Tell the shopper to try again in a moment; never say the store doesn't carry something.";

/**
 * State of one chat turn's catalog access. Created per turn (never module-level: a payload must not outlive its turn,
 * and one store's products must never reach another's) and passed down the search and check paths.
 * `products` = the UCP payload by product GID; `spentMs` = time already waited (MCP_BUDGET_MS caps it);
 * `degraded` = the latest search got no answer from Shopify at all (breaker open, budget spent, errors).
 */
export type TurnCatalog = {
  store: { id: string; shopDomain: string; currencyCode: string | null; domains?: string[] };
  country?: string;
  products: Map<string, Obj>;
  spentMs: number;
  degraded: boolean;
};

export function newTurnCatalog(store: TurnCatalog["store"], country?: string): TurnCatalog {
  return { store, country, products: new Map(), spentMs: 0, degraded: false };
}

/** Runs `fn` and charges its wall time (a parallel pair counts once) to the turn's catalog budget. */
async function timed<T>(cat: TurnCatalog, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    cat.spentMs += Date.now() - start;
  }
}

/** How toLiveProduct is told to treat this store: its currency (a product in another one is never shown) and its hosts (card links). */
const liveOpts = (cat: TurnCatalog, includeGiftCards: boolean) => ({
  includeGiftCards,
  currency: cat.store.currencyCode ?? undefined,
  shop: { domain: cat.store.shopDomain, hosts: cat.store.domains ?? [] },
});

/**
 * One UCP catalog tool call: the reply's `key` (`products` for search and lookup, `product` for get_product), or null
 * (never throws) when the breaker is open, the budget is spent, or the call failed. Always sends context.currency (and the country when known) so prices come in the store's currency.
 * Logs tool, status kind, ms and retryAfter; never the query, the ids or anything from the reply.
 */
async function catalogCall(cat: TurnCatalog, tool: string, args: Obj, signal?: AbortSignal, key: "products" | "product" = "products"): Promise<unknown> {
  const log = (status: string, ms: number, retryAfter?: number) =>
    console.info("ucp call", { storeId: cat.store.id, tool, status, ms, ...(retryAfter ? { retryAfter } : {}) });
  const profile = process.env.UCP_AGENT_PROFILE_URL;
  if (!profile) {
    log("no_profile", 0);
    return null;
  }
  const shop = cat.store.shopDomain;
  if (breakerOpen(shop)) {
    log("breaker", 0);
    return null;
  }
  const left = MCP_BUDGET_MS - cat.spentMs;
  if (left < MIN_CALL_MS) {
    log("budget", 0);
    return null;
  }
  const context = { ...(cat.store.currencyCode ? { currency: cat.store.currencyCode } : {}), ...(cat.country ? { address_country: cat.country } : {}) };
  const start = Date.now();
  const timeoutMs = Math.min(CALL_TIMEOUT_MS, left);
  try {
    const { sc } = await callUcpTool(shop, tool, { meta: { "ucp-agent": { profile } }, catalog: { ...args, context } }, signal, timeoutMs);
    const got = sc?.[key];
    if (key === "products" ? !Array.isArray(got) : !got || typeof got !== "object") throw new Error(`tool error: no ${key}`);
    recordUcp(shop, { kind: "ok" });
    log("ok", Date.now() - start);
    return key === "products" ? objs(got) : got;
  } catch (err) {
    const ms = Date.now() - start;
    const timedOut = err instanceof Error && /Timeout|Abort/.test(err.name);
    if (signal?.aborted) {
      log("aborted", ms); // the shopper left: says nothing about Shopify's health
    } else if (timedOut && timeoutMs < CALL_TIMEOUT_MS) {
      log("budget_timeout", ms); // our turn's budget cut this call short, not a slow Shopify: no breaker failure
    } else if (err instanceof McpHttpError && err.status === 429) {
      recordUcp(shop, { kind: "rate_limited", retryAfter: err.retryAfter });
      log("rate_limited", ms, err.retryAfter);
    } else {
      recordUcp(shop, { kind: "failure" });
      log(err instanceof McpHttpError ? "http" : timedOut ? "timeout" : "error", ms);
    }
    return null;
  }
}

/** Keeps payloads in the turn's map, merged with what an earlier call this turn returned (sold-out variants come from the other call). */
function remember(cat: TurnCatalog, products: Obj[]): void {
  for (const p of products) {
    if (typeof p.id !== "string" || !/^gid:\/\/shopify\/Product\/\d+$/.test(p.id)) continue;
    const have = cat.products.get(p.id);
    cat.products.set(p.id, have ? mergeProducts([have, p]) : p);
  }
}

const plain = (html: unknown) =>
  typeof html === "string"
    ? html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
    : "";

/**
 * search_catalog for an mcp store: the same two calls as mcpSearch (sale-ready, then sold-out), but the payload is kept in
 * `cat.products` instead of being matched against our table. Hits are ordered like mcpSearch's (sale-ready first), cut to k
 * after dropping what toLiveProduct would refuse (gift cards unless asked, no https url, no valid variant); score = rank,
 * chunkId = "mcp:" + GID, content = the description's first chunk (the title when there is none).
 * status "degraded" = neither call answered (breaker, budget, errors): the caller must say the catalog is unavailable, never
 * that nothing matches. One call failing still gives "ok" with the other's results. Never throws.
 * The query must already be masked (D41); this sends it to Shopify as is.
 */
export async function catalogSearch(
  cat: TurnCatalog,
  query: string,
  k: number,
  opts: { includeGiftCards?: boolean; signal?: AbortSignal },
): Promise<{ hits: SearchHit[]; status: "ok" | "degraded" }> {
  if (!query.trim() || k < 1) return { hits: [], status: "ok" };
  const call = (available: boolean) => catalogCall(cat, "search_catalog", { query, filters: { available }, pagination: { limit: k } }, opts.signal);
  const [ready, soldOut] = (await timed(cat, () => Promise.all([call(true), call(false)]))) as (Obj[] | null)[];
  cat.degraded = ready === null && soldOut === null;
  if (cat.degraded) return { hits: [], status: "degraded" };
  const found = [...(ready ?? []), ...(soldOut ?? [])];
  remember(cat, found);
  const ids = [...new Set(found.map((p) => p.id).filter((id): id is string => typeof id === "string" && cat.products.has(id)))].filter((id) =>
    toLiveProduct(cat.products.get(id), liveOpts(cat, !!opts.includeGiftCards)),
  );
  const hits = ids.slice(0, k).map((id, i) => {
    const p = cat.products.get(id)!;
    const title = typeof p.title === "string" ? p.title : "";
    const body = plain((p.description as { html?: unknown } | undefined)?.html) || title;
    return { chunkId: `mcp:${id}`, source: "product" as const, productId: id, content: chunkText(title, body)[0], score: 1 - i / k };
  });
  return { hits, status: "ok" };
}

/**
 * The live products for these GIDs in an mcp store: from the turn's payload map, plus lookup_catalog (10 ids per call,
 * sale-ready and sold-out like the search) for the ones it doesn't hold (the current product, a tool's hits). An id that
 * couldn't be fetched, or that toLiveProduct refuses, is simply absent, as with a product the live check dropped.
 */
export async function catalogLive(cat: TurnCatalog, ids: string[], opts: { includeGiftCards: boolean; signal?: AbortSignal }): Promise<Map<string, LiveProduct>> {
  const missing = [...new Set(ids)].filter((id) => !cat.products.has(id));
  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < missing.length; i += LOOKUP_IDS) {
    const batch = missing.slice(i, i + LOOKUP_IDS);
    for (const available of [true, false]) calls.push(catalogCall(cat, "lookup_catalog", { ids: batch, filters: { available } }, opts.signal));
  }
  if (calls.length) for (const r of await timed(cat, () => Promise.all(calls))) if (r) remember(cat, r as Obj[]);
  const out = new Map<string, LiveProduct>();
  for (const id of ids) {
    const live = cat.products.has(id) ? toLiveProduct(cat.products.get(id), liveOpts(cat, opts.includeGiftCards)) : null;
    if (live) out.set(id, live);
  }
  return out;
}

/**
 * get_product for the product_details tool in an mcp store, through the same breaker, time budget and logging as the
 * search: the full product (sale-ready and sold-out variants merged, like getProduct), or null on any failure.
 * The GID is ours (the tool maps a number from this turn's <store_data>), never shopper text.
 */
export async function catalogProduct(cat: TurnCatalog, productGid: string, signal?: AbortSignal): Promise<Obj | null> {
  const call = (available: boolean) => catalogCall(cat, "get_product", { id: productGid, filters: { available } }, signal, "product");
  const parts = (await timed(cat, () => Promise.all([call(true), call(false)]))).filter((p): p is Obj => !!p);
  return parts.length ? mergeProducts(parts) : null;
}
