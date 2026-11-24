import { and, eq, inArray } from "drizzle-orm";
import { forStore } from "@/db/client";
import { products } from "@/db/schema";
import { chunkText } from "@/lib/chunking";
import type { SearchHit } from "@/lib/retrieval";

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
  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    id: 1,
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile } },
        catalog: { query, filters: { available }, pagination: { limit: k } },
      },
    },
  };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`https://${shopDomain}/api/ucp/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (res.status !== 200) {
    const loc = res.headers.get("location");
    throw new Error(`HTTP ${res.status}${loc ? ` -> ${loc}` : ""}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (json.error) throw new Error(`JSON-RPC error: ${JSON.stringify(json.error).slice(0, 300)}`);
  const r = json.result;
  const sc = r?.structuredContent ?? (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : undefined);
  if (r?.isError || !Array.isArray(sc?.products)) throw new Error(`tool error: ${JSON.stringify(r).slice(0, 300)}`);
  const ids = (sc.products as McpProduct[])
    .map((p) => p.id)
    .filter((id): id is string => typeof id === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(id));
  return [...new Set(ids)];
}
