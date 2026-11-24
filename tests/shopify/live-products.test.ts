import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore, gid } from "../helpers/seed";

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let live: typeof import("@/lib/shopify/live-products");
let tokens: typeof import("@/lib/shopify/tokens");
let client: typeof import("@/db/client");
let gql: ReturnType<typeof vi.fn>;
let storeId: string;
const SHOP = "demo.myshopify.com";
const OPTS = { includeGiftCards: false, currency: "EUR" };

beforeAll(async () => {
  live = await import("@/lib/shopify/live-products");
  tokens = await import("@/lib/shopify/tokens");
  client = await import("@/db/client");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  // Our copy of products 1..12. Product 11 has no link (store domain unknown at sync); 12 is a gift card.
  for (let i = 1; i <= 12; i++) {
    const url = i === 11 ? null : `https://${SHOP}/products/h${i}`;
    await admin`
      insert into products (store_id, shopify_id, handle, title, url, image_url, status, published, is_gift_card, content, content_hash, shopify_updated_at)
      values (${storeId}, ${gid(String(i))}, ${`h${i}`}, ${`Our Tee ${i}`}, ${url}, ${`https://cdn.shopify.com/s/our${i}.jpg`},
              'ACTIVE', true, ${i === 12}, 'c', 'h', now())`;
  }
});

beforeEach(() => {
  gql.mockReset();
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

type V = Partial<{ id: string; title: string; availableForSale: boolean; inventoryQuantity: number | null; inventoryPolicy: string; tracked: boolean; price: string; compareAtPrice: string | null }>;
const variant = (n: number, v: V = {}) => ({
  id: v.id ?? `gid://shopify/ProductVariant/${n}`,
  title: v.title ?? "Default Title",
  availableForSale: v.availableForSale ?? true,
  inventoryQuantity: v.inventoryQuantity === undefined ? 50 : v.inventoryQuantity,
  inventoryPolicy: v.inventoryPolicy ?? "DENY",
  inventoryItem: { tracked: v.tracked ?? true },
  price: v.price ?? "19.99",
  compareAtPrice: v.compareAtPrice ?? null,
  selectedOptions: [{ name: "Title", value: "Default Title" }],
});

/** A live Admin `Product` node: active, published, not a gift card, one available variant, unless told otherwise. */
const liveNode = (
  id: string,
  o: Partial<{
    status: string; publishedAt: string | null; isGiftCard: boolean; requiresSellingPlan: boolean; onlineStoreUrl: string | null;
    image: string | null; publishedInContext: boolean; variants: ReturnType<typeof variant>[]; hasNextPage: boolean;
  }> = {},
) => ({
  id: gid(id),
  status: o.status ?? "ACTIVE",
  publishedAt: o.publishedAt === undefined ? "2026-01-01T00:00:00Z" : o.publishedAt,
  isGiftCard: o.isGiftCard ?? false,
  requiresSellingPlan: o.requiresSellingPlan ?? false,
  tracksInventory: true,
  hasOnlyDefaultVariant: (o.variants?.length ?? 1) === 1,
  onlineStoreUrl: o.onlineStoreUrl === undefined ? `https://shop.example.com/products/h${id}` : o.onlineStoreUrl,
  featuredMedia: o.image === null ? null : { preview: { image: { url: o.image ?? `https://cdn.shopify.com/s/live${id}.jpg` } } },
  options: [{ name: "Title", values: ["Default Title"] }],
  ...(o.publishedInContext === undefined ? {} : { publishedInContext: o.publishedInContext }),
  variants: { pageInfo: { hasNextPage: o.hasNextPage ?? false }, nodes: o.variants ?? [variant(Number(id))] },
});

const respond = (...nodes: (ReturnType<typeof liveNode> | null)[]) => gql.mockResolvedValueOnce({ nodes });

async function check(nodes: (ReturnType<typeof liveNode> | null)[], opts: Partial<Parameters<typeof live.liveCheck>[3]> = {}) {
  respond(...nodes);
  const ids = nodes.map((n, i) => n?.id ?? gid(String(100 + i)));
  const r = await live.liveCheck(storeId, SHOP, ids, { ...OPTS, ...opts });
  if (!r.ok) throw new Error(`liveCheck failed: ${r.reason}`);
  return r.products;
}

describe("dropped products", () => {
  test("DRAFT, ARCHIVED, unpublished and future-published products are dropped even when every variant is for sale", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const m = await check([
      liveNode("1", { status: "DRAFT" }),
      liveNode("2", { status: "ARCHIVED" }),
      liveNode("3", { publishedAt: null }),
      liveNode("4", { publishedAt: tomorrow }),
      liveNode("5"),
    ]);
    expect([...m.keys()]).toEqual([gid("5")]);
  });

  test("publishedInContext false is dropped (D77) and the country is sent", async () => {
    const m = await check([liveNode("1", { publishedInContext: false }), liveNode("2", { publishedInContext: true })], { country: "DE" });
    expect([...m.keys()]).toEqual([gid("2")]);
    const vars = gql.mock.calls[0][3];
    expect(vars).toMatchObject({ withCtx: true, ctx: { country: "DE" } });
  });

  test("with no country the field isn't requested and the check is skipped (C16 a)", async () => {
    const m = await check([liveNode("1")]);
    expect(gql.mock.calls[0][3]).toMatchObject({ withCtx: false });
    expect(m.has(gid("1"))).toBe(true);
  });

  test("gift cards are dropped unless includeGiftCards is set (D74)", async () => {
    expect((await check([liveNode("12", { isGiftCard: true })])).size).toBe(0);
    expect((await check([liveNode("12", { isGiftCard: true })], { includeGiftCards: true })).has(gid("12"))).toBe(true);
  });

  test("deleted products (null nodes), products missing from our table and products without a link are left out", async () => {
    respond(null, liveNode("99"), liveNode("11"), liveNode("1"));
    const r = await live.liveCheck(storeId, SHOP, [gid("98"), gid("99"), gid("11"), gid("1")], OPTS);
    expect(r.ok && [...r.products.keys()]).toEqual([gid("1")]);
  });
});

test("password-protected store (D71): ACTIVE + publishedAt with onlineStoreUrl null is kept, with our handle link and title", async () => {
  const m = await check([liveNode("1", { onlineStoreUrl: null })]);
  const p = m.get(gid("1"))!;
  expect(p.url).toBe(`https://${SHOP}/products/h1`);
  expect(p.title).toBe("Our Tee 1");
  expect(p.currency).toBe("EUR");
});

describe("stock", () => {
  const stockOf = async (v: V) => (await check([liveNode("1", { variants: [variant(1, v)] })])).get(gid("1"))!.variants[0].stock;

  test("tracked + DENY + 3 → count 3", async () => {
    expect(await stockOf({ tracked: true, inventoryPolicy: "DENY", inventoryQuantity: 3 })).toEqual({ kind: "count", n: 3 });
  });
  test("tracked + CONTINUE + 0 → in_stock", async () => {
    expect(await stockOf({ tracked: true, inventoryPolicy: "CONTINUE", inventoryQuantity: 0 })).toEqual({ kind: "in_stock" });
  });
  test("untracked + 0 + available → in_stock", async () => {
    expect(await stockOf({ tracked: false, inventoryQuantity: 0, availableForSale: true })).toEqual({ kind: "in_stock" });
  });
  test("availableForSale false → sold_out", async () => {
    expect(await stockOf({ availableForSale: false, inventoryQuantity: 0 })).toEqual({ kind: "sold_out" });
  });
});

describe("sold out (D72)", () => {
  test("every variant sold out: kept, available false, action none", async () => {
    const p = (await check([liveNode("1", { variants: [variant(1, { availableForSale: false }), variant(2, { availableForSale: false })] })])).get(gid("1"))!;
    expect(p.available).toBe(false);
    expect(p.action).toBe("none");
  });
  test("one variant sold out: that variant is unavailable, the product keeps add", async () => {
    const p = (await check([liveNode("1", { variants: [variant(1, { availableForSale: false }), variant(2)] })])).get(gid("1"))!;
    expect(p.variants.map((v) => v.available)).toEqual([false, true]);
    expect(p.available).toBe(true);
    expect(p.action).toBe("add");
  });
});

describe("other card rules", () => {
  test("requiresSellingPlan → view_options (D75)", async () => {
    expect((await check([liveNode("1", { requiresSellingPlan: true })])).get(gid("1"))!.action).toBe("view_options");
  });
  test("an image on evil.com → imageUrl null; cdn.shopify.com is kept", async () => {
    const m = await check([liveNode("1", { image: "https://evil.com/x.jpg" }), liveNode("2")]);
    expect(m.get(gid("1"))!.imageUrl).toBeNull();
    expect(m.get(gid("2"))!.imageUrl).toBe("https://cdn.shopify.com/s/live2.jpg");
  });
  test("variant ids come out numeric (D30), with price and compareAtPrice passed through", async () => {
    const v = (await check([liveNode("1", { variants: [variant(1, { id: "gid://shopify/ProductVariant/123", compareAtPrice: "29.99" })] })])).get(gid("1"))!.variants[0];
    expect(v).toMatchObject({ id: "123", price: "19.99", compareAtPrice: "29.99", options: [{ name: "Title", value: "Default Title" }] });
  });
  test("moreVariants follows variants.pageInfo.hasNextPage (C12)", async () => {
    expect((await check([liveNode("1", { hasNextPage: true })])).get(gid("1"))!.moreVariants).toBe(true);
    expect((await check([liveNode("1")])).get(gid("1"))!.moreVariants).toBe(false);
  });
});

test("one call: 9 ids make a single nodes request with VARIANT_CAP 50", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => String(i + 1));
  const m = await check(ids.map((i) => liveNode(i)));
  expect(gql).toHaveBeenCalledTimes(1);
  const [sid, shop, query, vars] = gql.mock.calls[0];
  expect([sid, shop]).toEqual([storeId, SHOP]);
  expect(query).toContain("nodes(ids: $ids)");
  expect(query).toContain("variants(first: 50)");
  expect(vars.ids).toEqual(ids.map(gid));
  expect(m.size).toBe(9);
  expect(live.VARIANT_CAP).toBe(50);
});

describe("failures never throw", () => {
  test("GraphQL THROTTLED → throttled", async () => {
    const { GraphqlQueryError } = await import("@shopify/shopify-api");
    gql.mockRejectedValueOnce(
      new GraphqlQueryError({
        message: "Throttled",
        response: {} as Record<string, unknown>,
        body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
      }),
    );
    expect(await live.liveCheck(storeId, SHOP, [gid("1")], OPTS)).toEqual({ ok: false, reason: "throttled" });
  });

  test("HTTP 429 → throttled", async () => {
    const { HttpThrottlingError } = await import("@shopify/shopify-api");
    gql.mockRejectedValueOnce(new HttpThrottlingError({ message: "429", code: 429, statusText: "Too Many Requests" }));
    expect(await live.liveCheck(storeId, SHOP, [gid("1")], OPTS)).toEqual({ ok: false, reason: "throttled" });
  });

  test("ReconnectNeededError → reconnect", async () => {
    gql.mockRejectedValueOnce(new tokens.ReconnectNeededError(storeId));
    expect(await live.liveCheck(storeId, SHOP, [gid("1")], OPTS)).toEqual({ ok: false, reason: "reconnect" });
  });

  test("other errors → error", async () => {
    gql.mockRejectedValueOnce(new Error("boom"));
    expect(await live.liveCheck(storeId, SHOP, [gid("1")], OPTS)).toEqual({ ok: false, reason: "error" });
  });

  test("no answer within 3 s → timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      gql.mockReturnValueOnce(new Promise(() => {}));
      const p = live.liveCheck(storeId, SHOP, [gid("1")], OPTS);
      // Wait (on real setImmediate, not the faked timers) for the DB read to finish and Shopify to be called.
      while (gql.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(2999);
      expect(await Promise.race([p, Promise.resolve("pending")])).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("the request's own signal aborting → timeout, without calling Shopify when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await live.liveCheck(storeId, SHOP, [gid("1")], { ...OPTS, signal: ac.signal })).toEqual({ ok: false, reason: "timeout" });
    expect(gql).not.toHaveBeenCalled();
  });
});

describe("toPromptStock (C14 a)", () => {
  const product = async (variants: ReturnType<typeof variant>[], extra = {}) =>
    (await check([liveNode("1", { variants, ...extra })])).get(gid("1"))!;

  test("a count is shown only below the threshold, otherwise in stock", async () => {
    expect(live.toPromptStock(await product([variant(1, { inventoryQuantity: 3 })]), 5)).toBe("only 3 left");
    expect(live.toPromptStock(await product([variant(1, { inventoryQuantity: 5 })]), 5)).toBe("in stock");
    expect(live.toPromptStock(await product([variant(1, { inventoryQuantity: 800 })]), 5)).toBe("in stock");
  });

  test("sold out, and view options", async () => {
    expect(live.toPromptStock(await product([variant(1, { availableForSale: false })]), 5)).toBe("sold out");
    expect(live.toPromptStock(await product([variant(1)], { requiresSellingPlan: true }), 5)).toBe("in stock; view options (subscription)");
  });

  test("several variants are listed by title, and never with a large count", async () => {
    const line = live.toPromptStock(
      await product([
        variant(1, { title: "S", inventoryQuantity: 2 }),
        variant(2, { title: "M", inventoryQuantity: 40 }),
        variant(3, { title: "L", availableForSale: false }),
      ], { hasNextPage: true }),
      5,
    );
    expect(line).toBe("S: only 2 left; M: in stock; L: sold out; more variants on the product page");
    expect(line).not.toContain("40");
  });
});

describe("fallbackCards (C11 b)", () => {
  test("title, url and image from our table only; no price, stock or action; gift cards only when asked", async () => {
    await admin`update products set image_url = 'https://evil.com/x.jpg' where store_id = ${storeId} and shopify_id = ${gid("2")}`;
    const ids = [gid("1"), gid("2"), gid("11"), gid("12"), gid("98")];
    const cards = await live.fallbackCards(storeId, ids, { includeGiftCards: false });
    expect([...cards.values()]).toEqual([
      { id: gid("1"), title: "Our Tee 1", url: `https://${SHOP}/products/h1`, imageUrl: "https://cdn.shopify.com/s/our1.jpg" },
      { id: gid("2"), title: "Our Tee 2", url: `https://${SHOP}/products/h2`, imageUrl: null },
    ]);
    expect((await live.fallbackCards(storeId, ids, { includeGiftCards: true })).has(gid("12"))).toBe(true);
    expect(gql).not.toHaveBeenCalled();
  });

  test("draft or unpublished rows are left out", async () => {
    await admin`update products set status = 'DRAFT' where store_id = ${storeId} and shopify_id = ${gid("3")}`;
    await admin`update products set published = false where store_id = ${storeId} and shopify_id = ${gid("4")}`;
    expect((await live.fallbackCards(storeId, [gid("3"), gid("4"), gid("5")], { includeGiftCards: false })).size).toBe(1);
  });
});
