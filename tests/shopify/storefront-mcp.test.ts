import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { askPolicies } from "@/lib/shopify/storefront-mcp";

// Offline: fetch is stubbed.
const fetchMock = vi.fn();
const PROFILE = "https://example.com/profile.json";
const SECRET_QUERY = "where is my order 4412 for jane@example.com";
const opts = { storeId: "store-1" };

const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
const answer = (plain: string) => rpc({ structuredContent: { ucp: {}, answer: { plain } } });
const oldTool = (text: string) => rpc({ content: [{ type: "text", text }] });
const urls = () => fetchMock.mock.calls.map(([u]) => u);
const body = (i: number) => JSON.parse(String(fetchMock.mock.calls[i][1].body)).params;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("without UCP_AGENT_PROFILE_URL it uses only the old policies tool, with policy_types", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", "");
  fetchMock.mockResolvedValue(oldTool("old answer"));
  expect(await askPolicies("x.myshopify.com", "returns?", ["refund"], opts)).toBe("old answer");
  expect(urls()).toEqual(["https://x.myshopify.com/api/mcp"]);
  expect(body(0)).toEqual({ name: "search_shop_policies_and_faqs", arguments: { query: "returns?", policy_types: ["refund"] } });
});

test("with the profile it calls ask_business on /api/ucp/mcp with the profile and the query, and returns answer.plain", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockResolvedValue(answer("  30 day returns.  "));
  expect(await askPolicies("x.myshopify.com", "returns?", ["refund"], opts)).toBe("30 day returns.");
  expect(urls()).toEqual(["https://x.myshopify.com/api/ucp/mcp"]);
  expect(body(0)).toEqual({ name: "ask_business", arguments: { meta: { "ucp-agent": { profile: PROFILE } }, ask: { query: "returns?" } } });
});

test("a long answer is cut", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockResolvedValue(answer("a".repeat(20000)));
  expect((await askPolicies("x.myshopify.com", "q", [], opts))?.length).toBe(6000);
});

test("an ask_business error falls back to the old tool", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 })).mockResolvedValueOnce(oldTool("old answer"));
  expect(await askPolicies("x.myshopify.com", "q", ["contact"], opts)).toBe("old answer");
  expect(urls()).toEqual(["https://x.myshopify.com/api/ucp/mcp", "https://x.myshopify.com/api/mcp"]);
  expect(body(1).arguments.policy_types).toEqual(["contact"]);
});

test("an empty ask_business answer is the answer: no fallback", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockResolvedValue(answer(""));
  expect(await askPolicies("x.myshopify.com", "q", [], opts)).toBe("");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a timeout on ask_business falls back; both failing returns null", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
  expect(await askPolicies("x.myshopify.com", "q", [], opts)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an aborted turn does not start the fallback", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  const ctl = new AbortController();
  ctl.abort();
  fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
  expect(await askPolicies("x.myshopify.com", "q", [], { ...opts, signal: ctl.signal })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("logs never contain the query", async () => {
  vi.stubEnv("UCP_AGENT_PROFILE_URL", PROFILE);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: SECRET_QUERY } }), { status: 200 }));
  await askPolicies("x.myshopify.com", SECRET_QUERY, [], opts);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/4412|jane/);
});
