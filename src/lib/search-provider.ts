import { search, type SearchHit } from "@/lib/retrieval";
import { productGid } from "@/lib/ids";
import { mcpSearch } from "@/lib/shopify/catalog-mcp";

// D89: the per-store product search provider, stores.settings.searchProvider.
export type SearchProvider = "ours" | "mcp" | "hybrid";
const PROVIDERS: readonly SearchProvider[] = ["ours", "mcp", "hybrid"];

/** settings.searchProvider when it is one of "ours", "mcp", "hybrid"; anything else (missing, invalid) is "ours". */
export function searchProvider(settings: unknown): SearchProvider {
  const p = (settings as { searchProvider?: unknown } | null)?.searchProvider;
  return PROVIDERS.includes(p as SearchProvider) ? (p as SearchProvider) : "ours";
}

/**
 * The turn's product search (D89), picked by the store's settings.searchProvider:
 * - "ours" (default): search() exactly as before.
 * - "mcp": Shopify's Storefront Catalog MCP (mcpSearch), plus the current product's chunks the way search() adds them.
 * - "hybrid": search() first; if it found nothing but the current product's own chunks, MCP's hits are put first.
 * MCP needs UCP_AGENT_PROFILE_URL; without it "mcp" and "hybrid" run as "ours" and log a line.
 * Gift cards are left out unless opts.includeGiftCards (D74), on both providers.
 */
export async function searchProducts(
  store: { id: string; shopDomain: string; settings: unknown },
  query: string,
  k: number,
  opts: { productId?: string; includeGiftCards?: boolean; signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  let provider = searchProvider(store.settings);
  if (provider !== "ours" && !process.env.UCP_AGENT_PROFILE_URL) {
    console.warn("search provider falls back to ours", { storeId: store.id, provider, reason: "UCP_AGENT_PROFILE_URL is not set" });
    provider = "ours";
  }
  const ourOpts = { productId: opts.productId, includeGiftCards: opts.includeGiftCards, signal: opts.signal };
  const mcp = () => mcpSearch(store.shopDomain, query, k, { storeId: store.id, includeGiftCards: opts.includeGiftCards, signal: opts.signal });

  if (provider === "ours") return search(store.id, query, k, ourOpts);

  if (provider === "hybrid") {
    const ours = await search(store.id, query, k, ourOpts);
    const current = productGid(opts.productId);
    // ponytail: on a product page search() always appends the current product's chunks, so "nothing" means nothing but
    // those. When the query matched only the current product itself, MCP is asked too and its other products are added.
    if (ours.some((h) => h.productId !== current)) return ours;
    const fromMcp = await mcp();
    return [...fromMcp, ...ours.filter((h) => !fromMcp.some((m) => m.productId === h.productId))];
  }

  // "mcp". The current product's chunks come from search() with k = 0: no top hits, only its 2 nearest chunks, fetched
  // in parallel with MCP (one embedding call). They are skipped when MCP already returned that product.
  const [fromMcp, extra] = await Promise.all([mcp(), opts.productId ? search(store.id, query, 0, ourOpts) : Promise.resolve([])]);
  return [...fromMcp, ...extra.filter((h) => !fromMcp.some((m) => m.productId === h.productId))];
}
