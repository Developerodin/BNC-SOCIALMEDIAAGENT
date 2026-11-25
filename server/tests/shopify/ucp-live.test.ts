import { expect, test } from "vitest";
import { toPromptStock } from "@/lib/shopify/live-products";
import { moneyOf, toLiveProduct } from "@/lib/shopify/ucp-live";
import { money, pgid, ucpProduct, ucpVariant } from "../helpers/ucp";

// Pure. Fixtures are schema-derived (tests/helpers/ucp.ts): re-record in Phase 0.
const live = (p: unknown, includeGiftCards = false) => toLiveProduct(p, { includeGiftCards });

test("prices are decimals from minor units with the currency's own digits: USD 2, JPY 0, KWD 3", () => {
  expect(moneyOf(money(1999, "USD"))?.text).toBe("19.99");
  expect(moneyOf(money(5, "USD"))?.text).toBe("0.05");
  expect(moneyOf(money(0, "USD"))?.text).toBe("0.00");
  expect(moneyOf(money(1000, "JPY"))?.text).toBe("1000");
  expect(moneyOf(money(12500, "KWD"))?.text).toBe("12.500");
  expect(moneyOf(money(7, "KWD"))?.text).toBe("0.007");
});

test("a bad money object gives null: negative, fractional, unsafe, string amount, unknown or malformed currency", () => {
  for (const m of [money(-1), money(1.5), money(Number.MAX_SAFE_INTEGER + 2), { amount: "100", currency: "USD" }, money(100, "XXXX"), money(100, "usd"), { amount: 1 }, null, "5"]) {
    expect(moneyOf(m)).toBeNull();
  }
});

test("a JPY product shows whole-yen prices and its currency", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(11, { price: money(4800, "JPY"), list: money(6000, "JPY") })] }))!;
  expect(p.currency).toBe("JPY");
  expect(p.variants[0].price).toBe("4800");
  expect(p.variants[0].compareAtPrice).toBe("6000");
});

test("a KWD product keeps three decimals", () => {
  expect(live(ucpProduct(1, { variants: [ucpVariant(11, { price: money(12500, "KWD") })] }))!.variants[0].price).toBe("12.500");
});

test("compare-at only when the list price is higher and in the same currency", () => {
  const v = (list: ReturnType<typeof money>) => live(ucpProduct(1, { variants: [ucpVariant(11, { price: money(2000), list })] }))!.variants[0].compareAtPrice;
  expect(v(money(3000))).toBe("30.00");
  expect(v(money(2000))).toBeNull();
  expect(v(money(1000))).toBeNull();
  expect(v(money(9000, "EUR"))).toBeNull();
});

test("D93: the MCP path's LIVE line carries the same price and currency guard (no was-price) as the installed path", () => {
  const sale = live(ucpProduct(1, { variants: [ucpVariant(11, { price: money(62995, "EUR"), list: money(69995, "EUR") })] }))!;
  expect(toPromptStock(sale, 5)).toBe("€629.95; in stock");
  expect(toPromptStock(sale, 5, "USD")).toBe("in stock");
  const jpy = live(ucpProduct(2, { variants: [ucpVariant(21, { price: money(4800, "JPY") })] }))!;
  expect(toPromptStock(jpy, 5)).toBe("¥4,800; in stock");
  const range = live(ucpProduct(3, { variants: [ucpVariant(31, { title: "S", price: money(1900, "EUR") }), ucpVariant(32, { title: "M", price: money(2900, "EUR") })] }))!;
  expect(toPromptStock(range, 5)).toBe("S: €19.00, in stock; M: €29.00, in stock");
});

test("stock is only in_stock or sold_out, never a count; the product is available when any variant is", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(11, { available: false }), ucpVariant(12, { available: true })] }))!;
  expect(p.variants.map((v) => v.stock)).toEqual([{ kind: "sold_out" }, { kind: "in_stock" }]);
  expect(p.available).toBe(true);
  expect(p.action).toBe("add");
});

test("an all-sold-out product is unavailable with action none (D72: still shown)", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(11, { available: false })] }))!;
  expect(p.available).toBe(false);
  expect(p.action).toBe("none");
});

test("an availability field that is missing or not exactly true counts as sold out", () => {
  const v = ucpVariant(11) as Record<string, unknown>;
  delete v.availability;
  expect(live(ucpProduct(1, { variants: [v as ReturnType<typeof ucpVariant>] }))!.variants[0].available).toBe(false);
});

test("the variant id is the numeric part of a validated ProductVariant GID; a bad GID drops that variant", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(42), { ...ucpVariant(1), id: "gid://shopify/Product/9" }, { ...ucpVariant(1), id: "gid://shopify/ProductVariant/12abc" }, { ...ucpVariant(1), id: "42" }] }))!;
  expect(p.variants.map((v) => v.id)).toEqual(["42"]);
});

test("a product with no valid variant, a bad product GID, no title or no https url gives null", () => {
  expect(live(ucpProduct(1, { variants: [{ ...ucpVariant(1), id: "nope" }] }))).toBeNull();
  expect(live(ucpProduct(1, { variants: [] }))).toBeNull();
  expect(live(ucpProduct("gid://shopify/Product/abc"))).toBeNull();
  expect(live(ucpProduct("gid://shopify/Collection/5"))).toBeNull();
  expect(live(ucpProduct(1, { title: "  " }))).toBeNull();
  expect(live(ucpProduct(1, { url: "http://shop.example.com/p" }))).toBeNull();
  expect(live(ucpProduct(1, { url: "javascript:alert(1)" }))).toBeNull();
  expect(live(null)).toBeNull();
  expect(live("x")).toBeNull();
});

test("an image counts only on cdn.shopify.com over https; others are null, a later cdn image is used", () => {
  expect(live(ucpProduct(1, { image: "https://cdn.shopify.com/a.jpg" }))!.imageUrl).toBe("https://cdn.shopify.com/a.jpg");
  for (const bad of ["https://evil.example.com/a.jpg", "http://cdn.shopify.com/a.jpg", "https://cdn.shopify.com.evil.com/a.jpg", "data:image/png;base64,AAAA", "//cdn.shopify.com/a.jpg"]) {
    expect(live(ucpProduct(1, { image: bad }))!.imageUrl).toBeNull();
  }
  expect(live(ucpProduct(1, { image: null }))!.imageUrl).toBeNull();
  const p = ucpProduct(1, { image: "https://evil.example.com/x.jpg" });
  p.media.push({ type: "image", url: "https://cdn.shopify.com/ok.jpg", alt_text: "" });
  expect(live(p)!.imageUrl).toBe("https://cdn.shopify.com/ok.jpg");
});

test("a gift card is filtered unless includeGiftCards", () => {
  expect(live(ucpProduct(1, { gift: true }))).toBeNull();
  expect(live(ucpProduct(1, { gift: true }), true)!.id).toBe(pgid(1));
});

test("a selling-plan variant makes the product view_options (as the installed app), not add", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(11, { sellingPlan: true })] }))!;
  expect(p.action).toBe("view_options");
  expect(p.available).toBe(true);
});

test("a default-title product has only the default variant; a sized product does not, and options carry through", () => {
  expect(live(ucpProduct(1))!.hasOnlyDefaultVariant).toBe(true);
  const p = ucpProduct(2, { variants: [ucpVariant(21, { options: [["Size", "S"]] }), ucpVariant(22, { options: [["Size", "M"]] })] });
  (p as { options: unknown }).options = [{ name: "Size", values: [{ label: "S" }, { label: "M" }] }];
  const l = live(p)!;
  expect(l.hasOnlyDefaultVariant).toBe(false);
  expect(l.options).toEqual([{ name: "Size", values: ["S", "M"] }]);
  expect(l.variants[1].options).toEqual([{ name: "Size", value: "M" }]);
});

test("variants over the cap are cut and flagged moreVariants", () => {
  const many = Array.from({ length: 60 }, (_, i) => ucpVariant(100 + i));
  const p = live(ucpProduct(1, { variants: many }))!;
  expect(p.variants).toHaveLength(50);
  expect(p.moreVariants).toBe(true);
});

test("variants in a different currency than the first are dropped (one currency per card)", () => {
  const p = live(ucpProduct(1, { variants: [ucpVariant(11), ucpVariant(12, { price: money(900, "EUR") })] }))!;
  expect(p.variants.map((v) => v.id)).toEqual(["11"]);
});

test("currency option: a product in another currency than the store's is refused", () => {
  const gbp = ucpProduct(1, { variants: [ucpVariant(11, { price: money(3000, "GBP") })] });
  expect(toLiveProduct(gbp, { includeGiftCards: false, currency: "USD" })).toBeNull();
  expect(toLiveProduct(gbp, { includeGiftCards: false, currency: "GBP" })!.currency).toBe("GBP");
});

test("url option: off-store hosts are rebuilt from a plain handle, or the product is dropped without one", () => {
  const shop = { domain: "a.myshopify.com", hosts: ["www.brand.com"] };
  const o = { includeGiftCards: false, shop };
  expect(toLiveProduct(ucpProduct(1, { url: "https://www.brand.com/products/x" }), o)!.url).toBe("https://www.brand.com/products/x");
  expect(toLiveProduct(ucpProduct(1, { url: "https://evil.example/p" }), o)!.url).toBe("https://a.myshopify.com/products/h1");
  expect(toLiveProduct({ ...ucpProduct(1, { url: "https://evil.example/p" }), handle: "../x?y" }, o)).toBeNull();
  expect(toLiveProduct({ ...ucpProduct(1, { url: "https://evil.example/p" }), handle: undefined }, o)).toBeNull();
});
