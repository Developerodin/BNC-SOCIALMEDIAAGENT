import { and, eq, inArray } from "drizzle-orm";
import { forStore } from "@/db/client";
import { products } from "@/db/schema";
import { chunkText } from "@/lib/chunking";
import type { SearchHit } from "@/lib/retrieval";
import { callMcpTool } from "./mcp-call";

// D89: Shopify's Storefront Catalog MCP (search_catalog over JSON-RPC at https://{shop}/api/ucp/mcp) as an alternative
// product search. Request and response handling follow scripts/mcp-compare/run.mts.
const TIMEOUT_MS = 3000;

type McpProduct = { id?: unknown };

/**
 * search_catalog for `query`, mapped to SearchHit[] built from OUR rows: a result is kept only when its product GID is in
 * our products table for this store, ACTIVE and published (the cards, the D71 URL and the live check need our row), and,
 * unless opts.includeGiftCards, not a gift card (D74).
 * filters.available is a boolean (default true) and is not "include sold-out": live on the dev store, true returns only
 * sale-ready products and false returns ONLY unavailable ones (null is rejected). So two calls run in parallel, k each,
 * and the sale-ready results come first, then the sold-out ones (so D72 can say "sold out"), cut to k after our filter.
 * The live check still decides what is buyable.
 * content = the first chunk of our products.content (chunkText), so the prompt gets the same text, at most one chunk's size.
 * score = 1 - i/k, where i is the hit's position in the returned list: a rank, not a similarity, so D86's MIN_SCORE does
 * not apply to it. chunkId = "mcp:" + GID (there is no chunk).
 * Needs UCP_AGENT_PROFILE_URL (a public agent profile URL). When one of the two calls fails (an HTTP, JSON-RPC or tool
 * error, or a timeout of ~3 s, or opts.signal), the other's results are used and the failure is logged; when both fail,
 * or the URL is missing, returns [] and logs the error. It never throws.
 * The query must already be masked (D41); this sends it to Shopify as is.
 * `// ponytail:` a sold-out product shows only when fewer than k sale-ready products match (after our filter), so an exact
 * name query for a sold-out product can lose it to k in-stock ones. MCP's ranking is keyword-like (D89). Upgrade path:
 * reserve a slot or two for the best sold-out match.
 */
export async function mcpSearch(
  shopDomain: string,
  query: string,
  k: number,
  opts: { storeId: string; includeGiftCards?: boolean; signal?: AbortSignal },
): Promise<SearchHit[]> {
  if (!query.trim() || k < 1) return [];
  const profile = process.env.UCP_AGENT_PROFILE_URL;
  if (!profile) {
    console.warn("catalog mcp unavailable", { storeId: opts.storeId, error: "UCP_AGENT_PROFILE_URL is not set" });
    return [];
  }
  // One failed call keeps the other's results (sale-ready only, or sold-out only); only both failing gives [].
  const [ready, soldOut] = await Promise.allSettled([
    callSearchCatalog(shopDomain, query, k, true, profile, opts.signal),
    callSearchCatalog(shopDomain, query, k, false, profile, opts.signal),
  ]);
  const failed = [ready, soldOut].filter((r) => r.status === "rejected").map((r) => errorText(r.reason));
  if (failed.length === 2) {
    console.warn("catalog mcp search failed", { storeId: opts.storeId, error: failed.join("; ") });
    return [];
  }
  if (failed.length) {
    const available = ready.status === "rejected";
    console.warn("catalog mcp search partly failed", { storeId: opts.storeId, available, error: failed[0] });
  }
  const ids = [...new Set([...(ready.status === "fulfilled" ? ready.value : []), ...(soldOut.status === "fulfilled" ? soldOut.value : [])])];
  if (!ids.length) return [];

  const rows = await forStore(opts.storeId, (tx) =>
    tx
      .select({ id: products.shopifyId, title: products.title, content: products.content, isGiftCard: products.isGiftCard })
      .from(products)
      .where(
        and(
          eq(products.storeId, opts.storeId),
          inArray(products.shopifyId, ids),
          eq(products.status, "ACTIVE"),
          eq(products.published, true),
          opts.includeGiftCards ? undefined : eq(products.isGiftCard, false),
        ),
      ),
  );
  const ours = new Map(rows.map((r) => [r.id, r]));
  return ids
    .filter((id) => ours.has(id))
    .slice(0, k)
    .map((id, i) => {
      const r = ours.get(id)!;
      return { chunkId: `mcp:${id}`, source: "product" as const, productId: id, content: chunkText(r.title, r.content)[0], score: 1 - i / k };
    });
}

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** The product GIDs search_catalog returns, in its order, de-duplicated. Throws on any failure. */
async function callSearchCatalog(
  shopDomain: string,
  query: string,
  k: number,
  available: boolean,
  profile: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const args = { meta: { "ucp-agent": { profile } }, catalog: { query, filters: { available }, pagination: { limit: k } } };
  const { sc } = await callUcpTool(shopDomain, "search_catalog", args, signal);
  if (!Array.isArray(sc?.products)) throw new Error("tool error: no products");
  const ids = (sc.products as McpProduct[])
    .map((p) => p.id)
    .filter((id): id is string => typeof id === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(id));
  return [...new Set(ids)];
}

/**
 * get_product for one product GID: Shopify's full product detail (the `product` of the reply), or null on any failure
 * (HTTP, JSON-RPC or tool error, no product in the reply, a timeout of ~3 s, or opts.signal), which is logged. Needs
 * UCP_AGENT_PROFILE_URL. Never throws. The GID is ours (the chat tool maps a number to it), never shopper text.
 */
export async function getProduct(shopDomain: string, productGid: string, opts: { storeId: string; signal?: AbortSignal }): Promise<Record<string, unknown> | null> {
  const profile = process.env.UCP_AGENT_PROFILE_URL;
  if (!profile) {
    console.warn("catalog mcp get_product failed", { storeId: opts.storeId, error: "UCP_AGENT_PROFILE_URL is not set" });
    return null;
  }
  // filters.available defaults to true (sale-ready only), so like mcpSearch two calls run in parallel, true and false, and
  // are merged: otherwise a sold-out size would look like it doesn't exist. One failing call keeps the other's result.
  const [ready, soldOut] = await Promise.allSettled([
    callGetProduct(shopDomain, productGid, profile, true, opts.signal),
    callGetProduct(shopDomain, productGid, profile, false, opts.signal),
  ]);
  const failed = [ready, soldOut].filter((r) => r.status === "rejected").map((r) => errorText(r.reason));
  if (failed.length) console.warn(failed.length === 2 ? "catalog mcp get_product failed" : "catalog mcp get_product partly failed", { storeId: opts.storeId, error: failed.join("; ") });
  const parts = [ready, soldOut].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return parts.length ? mergeProducts(parts) : null;
}

async function callGetProduct(shopDomain: string, productGid: string, profile: string, available: boolean, signal?: AbortSignal) {
  const args = { meta: { "ucp-agent": { profile } }, catalog: { id: productGid, filters: { available } } };
  const { sc } = await callUcpTool(shopDomain, "get_product", args, signal);
  if (!sc?.product || typeof sc.product !== "object") throw new Error("tool error: no product");
  return sc.product as Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === "object") : []);

/**
 * The product fields of the first part, with variants and option values unioned over all parts (by variant id or title,
 * option name and value label). The order must not show which call a variant came from (sold-out ones come from the
 * second), so variants are sorted by their numeric id (Shopify's creation order, usually the merchant's) and each
 * option's values by first appearance in that order.
 */
function mergeProducts(parts: Obj[]): Obj {
  const variants = new Map<string, Obj>();
  for (const v of parts.flatMap((p) => objs(p.variants))) variants.set(String(v.id ?? v.title), variants.get(String(v.id ?? v.title)) ?? v);
  const num = (v: Obj) => Number(String(v.id ?? "").match(/\d+$/)?.[0] ?? NaN);
  const sorted = [...variants.values()].sort((a, b) => (num(a) - num(b) || 0));
  const seen = (name: unknown, label: unknown) =>
    sorted.findIndex((v) => objs(v.options).some((o) => o.name === name && o.label === label)) + 1 || 1e9;
  const options = new Map<string, Obj>();
  for (const o of parts.flatMap((p) => objs(p.options))) {
    const have = options.get(String(o.name));
    const values = new Map(objs(have?.values ?? []).map((x) => [String(x.label), x]));
    for (const x of objs(o.values)) if (!values.has(String(x.label))) values.set(String(x.label), x);
    options.set(String(o.name), { ...(have ?? o), values: [...values.values()].sort((a, b) => seen(o.name, a.label) - seen(o.name, b.label)) });
  }
  return { ...parts[0], variants: sorted, options: [...options.values()] };
}

/** One tools/call on the store's UCP MCP: its structured payload. Throws on an HTTP, JSON-RPC, tool or network error, or a timeout of ~3 s. */
async function callUcpTool(shopDomain: string, name: string, args: unknown, signal?: AbortSignal) {
  const r = await callMcpTool(`https://${shopDomain}/api/ucp/mcp`, name, args, { timeoutMs: TIMEOUT_MS, signal, redirect: "manual" });
  const text = r?.content?.[0]?.text;
  // A payload that isn't JSON throws a fixed message, not the parser's (which quotes the text).
  const sc = (r?.structuredContent ?? (text ? parseJson(text) : undefined)) as Record<string, unknown> | undefined;
  return { sc };
}

function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    throw new Error("invalid JSON");
  }
}
