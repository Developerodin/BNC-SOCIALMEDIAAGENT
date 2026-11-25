// The store's own policies and FAQ answers (returns, shipping, contact, hours), asked through the chat agent's
// store_policies tool (src/lib/chat/tools.ts). Preferred: UCP ask_business (https://{shop}/api/ucp/mcp), needs
// UCP_AGENT_PROFILE_URL. Fallback: the Storefront MCP search_shop_policies_and_faqs (https://{shop}/api/mcp, public, no
// profile), deprecated by Shopify and maintained until 2027-01-15; remove the fallback after that date.
// The JSON-RPC call itself is mcp-call.ts, shared with catalog-mcp.ts.
import { callMcpTool, mcpPayload } from "./mcp-call";

const TIMEOUT_MS = 5000;
/** ask_business writes its answer with a model, so it is slower than the old lookup. Not retried on a timeout, so a call stays under ~11 s (6 + the old tool's 5 after a fast error). */
const ASK_TIMEOUT_MS = 6000;
/** Policy texts can be long (full terms of service); the model gets at most this many characters. */
const MAX_POLICY_CHARS = 6000;

export const POLICY_TYPES = ["refund", "shipping", "privacy", "terms_of_service", "terms_of_sale", "subscription", "legal_notice", "contact"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** ask_business: the answer's plain text (maybe empty). Throws on any error; the caller turns that into the fallback. */
async function askBusiness(shopDomain: string, query: string, profile: string, signal?: AbortSignal): Promise<string> {
  const r = await callMcpTool(
    `https://${shopDomain}/api/ucp/mcp`,
    "ask_business",
    { meta: { "ucp-agent": { profile } }, ask: { query } },
    { timeoutMs: ASK_TIMEOUT_MS, signal, redirect: "manual" },
  );
  const p = mcpPayload(r) as { ucp?: { status?: unknown }; messages?: { type?: unknown }[]; answer?: { plain?: unknown } } | undefined;
  // No answer object, or Shopify reporting an error, is a failure (so the fallback runs); only an empty plain is "no answer".
  const errorOnly = Array.isArray(p?.messages) && p.messages.length > 0 && p.messages.every((m) => m?.type === "error");
  if (typeof p?.answer?.plain !== "string" || p.ucp?.status === "error" || (errorOnly && !p.answer.plain.trim())) throw new Error("no answer");
  return p.answer.plain.trim().slice(0, MAX_POLICY_CHARS);
}

/**
 * Asks the store's policy and FAQ answer. With UCP_AGENT_PROFILE_URL it uses ask_business and falls back to the old
 * policies tool on a fast error (not on a timeout, nor on an empty answer: that is the store's answer). Returns the text (cut to
 * MAX_POLICY_CHARS; the old tool's is JSON as Shopify sends it), or null on any failure (HTTP, JSON-RPC or tool error,
 * timeout, `signal`), which is logged. Never throws. policyTypes only apply to the old tool.
 * The query must already be masked (D41): it goes to Shopify as is. Logs only a kind, never the query.
 */
export async function askPolicies(
  shopDomain: string,
  query: string,
  policyTypes: PolicyType[],
  opts: { storeId: string; signal?: AbortSignal },
): Promise<string | null> {
  const profile = process.env.UCP_AGENT_PROFILE_URL;
  if (profile) {
    try {
      return await askBusiness(shopDomain, query, profile, opts.signal);
    } catch (err) {
      console.warn("ask_business failed, using the policies tool", { storeId: opts.storeId, error: err instanceof Error ? err.message : String(err) });
      // A timeout means Shopify is slow (don't spend 5 more seconds); an aborted turn is over.
      if (opts.signal?.aborted || (err instanceof Error && err.name === "TimeoutError")) return null;
    }
  }
  try {
    const r = await callMcpTool(
      `https://${shopDomain}/api/mcp`,
      "search_shop_policies_and_faqs",
      { query, ...(policyTypes.length ? { policy_types: policyTypes } : {}) },
      { timeoutMs: TIMEOUT_MS, signal: opts.signal },
    );
    const text = (r?.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n").trim();
    return text.slice(0, MAX_POLICY_CHARS);
  } catch (err) {
    console.warn("storefront mcp policies failed", { storeId: opts.storeId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
