import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { askPolicies } from "@/lib/shopify/storefront-mcp";
import { getProduct } from "@/lib/shopify/catalog-mcp";

// §7.10: shopper text never reaches the logs. Shopify's error bodies and JSON-RPC messages can echo the query, so a
// failed MCP call logs a kind or a status only. Offline: fetch is stubbed.

const SECRET = "my-card-4111-1111-1111-1111";
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "https://example.com/profile.json");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const logged = () => JSON.stringify(vi.mocked(console.warn).mock.calls);
const rpc = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// The payload case is for get_product only: the policies tool returns its text as is.
const failures: [string, () => Response][] = [
  ["HTTP error body", () => rpc(`bad request: ${SECRET}`, 400)],
  ["JSON-RPC error message", () => rpc({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `no match for ${SECRET}` } })],
  ["tool error content", () => rpc({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ text: `cannot find ${SECRET}` }] } })],
  ["non-JSON reply", () => rpc(`oops ${SECRET}`)],
  ["non-JSON payload", () => rpc({ jsonrpc: "2.0", id: 1, result: { content: [{ text: `{${SECRET}` }] } })],
];

for (const [name, res] of failures) {
  if (name !== "non-JSON payload") test(`policies: ${name} logs a kind, not the response`, async () => {
    fetchMock.mockImplementation(async () => res());
    expect(await askPolicies("s.myshopify.com", SECRET, [], { storeId: "st" })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("storefront mcp policies failed", { storeId: "st", error: expect.any(String) });
    expect(logged()).not.toContain(SECRET);
  });

  test(`get_product: ${name} logs a kind, not the response`, async () => {
    fetchMock.mockImplementation(async () => res());
    expect(await getProduct("s.myshopify.com", "gid://shopify/Product/1", { storeId: "st" })).toBeNull();
    expect(logged()).not.toContain(SECRET);
  });
}

test("policies: a good reply is the tool's text, cut to 6000 characters", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", ""); // the old tool; with a profile ask_business is asked first
  fetchMock.mockImplementation(async () => rpc({ jsonrpc: "2.0", id: 1, result: { content: [{ text: "x".repeat(7000) }] } }));
  expect(await askPolicies("s.myshopify.com", "returns?", ["refund"], { storeId: "st" })).toHaveLength(6000);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.params).toEqual({ name: "search_shop_policies_and_faqs", arguments: { query: "returns?", policy_types: ["refund"] } });
});
