// The cards' "similar products" icon through POST /api/chat (similarTo). Same mocks as chat-route.test.ts, in its own file
// because the route's per-IP rate limit (60 a minute, per process) is already nearly used up there.
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { fakeStream } from "../helpers/fake-openai";
import { gid, newStore } from "../helpers/seed";
import type { LiveProduct } from "@/lib/shopify/live-products";

// Nothing here calls OpenAI or Shopify: the client, search, rewrite and liveCheck are all mocked.
const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));
const search = vi.fn();
vi.mock("@/lib/retrieval", () => ({ search: (...a: unknown[]) => search(...a) }));
const rewriteQuery = vi.fn();
const askPolicies = vi.fn();
vi.mock("@/lib/shopify/storefront-mcp", async (orig) => ({ ...(await orig<object>()), askPolicies: (...a: unknown[]) => askPolicies(...a) }));
vi.mock("@/lib/chat/rewrite", () => ({ rewriteQuery: (...a: unknown[]) => rewriteQuery(...a) }));
const liveCheck = vi.fn();
vi.mock("@/lib/shopify/live-products", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/live-products")>()),
  liveCheck: (...a: unknown[]) => liveCheck(...a),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/chat/route");
let client: typeof import("@/db/client");
let token: typeof import("@/lib/chat/token");
let storeA: string;
let storeB: string;
let shopA: string;
let shopB: string;
let inactiveShop: string;
const ORIGIN = "https://shop-a.example.com";

const live = (id: string): LiveProduct => ({
  id: gid(id),
  title: `Tee ${id}`,
  url: `https://shop.example.com/products/h${id}`,
  imageUrl: null,
  currency: "EUR",
  available: true,
  action: "add",
  hasOnlyDefaultVariant: true,
  options: [],
  variants: [{ id: `${id}1`, title: "Default Title", options: [], available: true, stock: { kind: "in_stock" }, price: "10.00", compareAtPrice: null }],
  moreVariants: false,
});

function post(body: unknown, origin: string | null = ORIGIN) {
  return route.POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

type Ev = { event: string; data: Record<string, unknown> };
/** Strict SSE parse: every block is "event: <name>\ndata: <JSON>" or a ":" comment, separated by a blank line. */
function parseSse(raw: string): Ev[] {
  expect(raw.endsWith("\n\n")).toBe(true);
  const out: Ev[] = [];
  for (const block of raw.slice(0, -2).split("\n\n")) {
    if (block.startsWith(":")) continue;
    const m = /^event: (\w+)\ndata: (.*)$/.exec(block);
    expect(m, `bad SSE block: ${block}`).not.toBeNull();
    out.push({ event: m![1], data: JSON.parse(m![2]) });
  }
  return out;
}
/** The events without `status` (a live hint the other tests don't assert); readWithStatus keeps them. */
const readWithStatus = async (res: Response) => parseSse(await res.text());
const readAll = async (res: Response) => (await readWithStatus(res)).filter((e) => e.event !== "status");
/** Task 22: the id of the conversation's latest assistant row, which `done` carries as messageId. */
async function lastAssistantId(conversationId: string | null) {
  const [row] = await admin`select id from messages where conversation_id = ${conversationId} and role = 'assistant' order by created_at desc limit 1`;
  return row.id as string;
}

beforeAll(async () => {
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE="; // test-only dummy
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  route = await import("@/app/api/chat/route");
  client = await import("@/db/client");
  token = await import("@/lib/chat/token");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeA = await newStore(admin);
  storeB = await newStore(admin);
  const inactive = await newStore(admin, false);
  const shop = async (id: string, domains: string[]) => {
    const [s] = await admin`update stores set currency_code = 'EUR', name = 'Shop', domains = ${domains} where id = ${id} returning shop_domain`;
    return s.shop_domain as string;
  };
  shopA = await shop(storeA, ["shop-a.example.com"]);
  shopB = await shop(storeB, ["shop-b.example.com"]);
  inactiveShop = await shop(inactive, ["shop-a.example.com"]);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});
beforeEach(() => {
  create.mockReset();
  search.mockReset();
  rewriteQuery.mockReset();
  liveCheck.mockReset();
  askPolicies.mockReset();
  rewriteQuery.mockImplementation(async (o: { message: string }) => ({ query: o.message, includeGiftCards: false, tokens: { input: 1, output: 1 } }));
  search.mockResolvedValue([]);
  liveCheck.mockResolvedValue({ ok: true, products: new Map() });
  create.mockImplementation(fakeStream(["Hello ", "there"]));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const noCalls = () => {
  expect(create).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  expect(rewriteQuery).not.toHaveBeenCalled();
  expect(liveCheck).not.toHaveBeenCalled();
};

// --- CORS (Review Focus 3) ---

// --- the cards' "similar products" icon (similarTo) ---

test("similarTo: another store's product, a malformed id or a non-string → 400 invalid_similar_to with CORS headers, nothing saved or called", async () => {
  const { upsert, node } = await import("../helpers/seed");
  await upsert(storeB, node("90"));
  const [{ n: before }] = await admin`select count(*)::int as n from messages where store_id = ${storeA}`;
  for (const similarTo of [gid("90"), gid("404"), "not-a-product", 42, { id: 1 }, ""]) {
    const res = await post({ shop: shopA, message: "Show me products similar to X", similarTo });
    expect(res.status, JSON.stringify(similarTo)).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_similar_to" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  }
  noCalls();
  const [{ n: after }] = await admin`select count(*)::int as n from messages where store_id = ${storeA}`;
  expect(after).toBe(before);
});

test("similarTo: a product of this store skips the rewrite, seeds the search with it, leaves out what is in the cart, and shows at most three cards", async () => {
  const { upsert, node } = await import("../helpers/seed");
  await upsert(storeA, node("71", { title: "Seed boots" }), node("72", { title: "In my cart" }));
  const hit = (id: string) => ({ chunkId: `c${id}`, source: "product", productId: gid(id), content: `Tee ${id}`, score: 0.9 });
  search.mockResolvedValueOnce(["81", "82", "83", "84", "85"].map(hit));
  liveCheck.mockResolvedValueOnce({ ok: true, products: new Map(["81", "82", "83", "84", "85"].map((id) => [gid(id), live(id)])) });
  create.mockImplementation(fakeStream(["Try these ", "[[product:1]][[product:2]][[product:3]][[product:4]][[product:5]]"]));

  const res = await post({
    shop: shopA,
    message: "Show me products similar to Seed boots",
    similarTo: gid("71"),
    productId: "999", // the page's own product must not become the "viewing" product
    cart: { items: [{ title: "In my cart", quantity: 1, price: "€5.00" }], total: "€5.00" },
  });
  expect(res.status).toBe(200);
  const events = await readAll(res);

  expect(rewriteQuery).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0][1]).toBe("");
  expect(search.mock.calls[0][3]).toMatchObject({ similarTo: gid("71"), exclude: [gid("72")] });
  expect(events.filter((e) => e.event === "product").map((e) => e.data.id)).toEqual([gid("81"), gid("82"), gid("83")]);
  const prompt = JSON.stringify(create.mock.calls[0][0].input);
  expect(prompt).toContain('similar to \\"Seed boots\\"');
  expect(prompt).not.toContain("the one the shopper is viewing");
});

test("similarTo: sold-out products are skipped for the next nearest", async () => {
  const { upsert, node } = await import("../helpers/seed");
  await upsert(storeA, node("73"));
  const hit = (id: string) => ({ chunkId: `c${id}`, source: "product", productId: gid(id), content: `Tee ${id}`, score: 0.9 });
  search.mockResolvedValueOnce(["81", "82", "83", "84"].map(hit));
  const soldOut = { ...live("81"), available: false };
  liveCheck.mockResolvedValueOnce({ ok: true, products: new Map([[gid("81"), soldOut], ...["82", "83", "84"].map((id) => [gid(id), live(id)] as const)]) });
  create.mockImplementation(fakeStream(["Try ", "[[product:1]][[product:2]][[product:3]][[product:4]]"]));

  const events = await readAll(await post({ shop: shopA, message: "Show me products similar to Tee 73", similarTo: gid("73") }));

  expect(events.filter((e) => e.event === "product").map((e) => e.data.id)).toEqual([gid("82"), gid("83"), gid("84")]);
});

test("similarTo: an ordinary message without it still goes through the rewrite", async () => {
  await readAll(await post({ shop: shopA, message: "tee?" }));
  expect(rewriteQuery).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0][3]).not.toHaveProperty("similarTo");
});
