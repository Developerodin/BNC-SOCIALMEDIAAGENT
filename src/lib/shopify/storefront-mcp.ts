// Shopify's Storefront MCP (https://{shop}/api/mcp): search_shop_policies_and_faqs, the store's own policies and FAQ
// answers (returns, shipping, contact, hours). Public, no token and no UCP agent profile needed. The chat agent calls it
// through its store_policies tool (src/lib/chat/tools.ts).

const TIMEOUT_MS = 5000;
/** Policy texts can be long (full terms of service); the model gets at most this many characters. */
const MAX_POLICY_CHARS = 6000;

export const POLICY_TYPES = ["refund", "shipping", "privacy", "terms_of_service", "terms_of_sale", "subscription", "legal_notice", "contact"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/**
 * Asks the store's policy and FAQ tool. Returns the tool's text (JSON as Shopify sends it, cut to MAX_POLICY_CHARS), or
 * null on any failure (HTTP, JSON-RPC or tool error, timeout, `signal`), which is logged. Never throws.
 * The query must already be masked (D41): it goes to Shopify as is.
 */
export async function askPolicies(
  shopDomain: string,
  query: string,
  policyTypes: PolicyType[],
  opts: { storeId: string; signal?: AbortSignal },
): Promise<string | null> {
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(`https://${shopDomain}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_shop_policies_and_faqs",
          arguments: { query, ...(policyTypes.length ? { policy_types: policyTypes } : {}) },
        },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { error?: { message?: string }; result?: { isError?: boolean; content?: { text?: unknown }[] } };
    // Not Shopify's message: it may repeat the shopper's query, and message text is never logged (§7.10).
    if (body.error) throw new Error("JSON-RPC error");
    if (body.result?.isError) throw new Error("tool error");
    const text = (body.result?.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n").trim();
    return text.slice(0, MAX_POLICY_CHARS);
  } catch (err) {
    console.warn("storefront mcp policies failed", { storeId: opts.storeId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
