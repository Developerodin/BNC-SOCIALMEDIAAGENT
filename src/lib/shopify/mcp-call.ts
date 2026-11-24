// The one JSON-RPC `tools/call` caller for Shopify's MCP endpoints (the Catalog MCP at /api/ucp/mcp, the Storefront MCP
// at /api/mcp). The arguments carry the shopper's words, and Shopify's error bodies and messages can echo them, so every
// error thrown here names only a kind or a status: never log or rethrow anything from the response (§7.10).

export type McpResult = { structuredContent?: unknown; content?: { text?: unknown }[] };

/** The `result` of one tools/call. Throws on HTTP, JSON-RPC, tool or network errors and on timeout/abort. */
export async function callMcpTool(
  url: string,
  name: string,
  args: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal; redirect?: "manual" | "follow" },
): Promise<McpResult | undefined> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1, params: { name, arguments: args } }),
    ...(opts.redirect ? { redirect: opts.redirect } : {}),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const loc = res.headers.get("location");
    throw new Error(`HTTP ${res.status}${loc ? ` -> ${loc}` : ""}`);
  }
  // A JSON.parse error message quotes the start of the text, so it is replaced by a fixed one.
  const json = await res.json().catch(() => {
    throw new Error("invalid JSON");
  });
  if (json.error) throw new Error("JSON-RPC error");
  if (json.result?.isError) throw new Error("tool error");
  return json.result;
}

/** A result's JSON payload: `structuredContent`, else the first text content parsed. Throws a fixed message if that text isn't JSON. */
export function mcpPayload(r: McpResult | undefined): unknown {
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = r?.content?.[0]?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(String(text));
  } catch {
    throw new Error("invalid JSON");
  }
}
