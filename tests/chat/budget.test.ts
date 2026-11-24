import { expect, test } from "vitest";
import { applyBudget, productPrice } from "@/lib/chat/budget";
import type { LiveProduct, LiveVariant } from "@/lib/shopify/live-products";
import type { SearchHit } from "@/lib/retrieval";

const v = (price: string, available = true): LiveVariant => ({
  id: price,
  title: price,
  options: [],
  available,
  stock: available ? { kind: "in_stock" } : { kind: "sold_out" },
  price,
  compareAtPrice: null,
});
const product = (id: string, variants: LiveVariant[]): LiveProduct => ({
  id,
  title: `P ${id}`,
  url: `https://shop.example.com/products/${id}`,
  imageUrl: null,
  currency: "INR",
  available: variants.some((x) => x.available),
  action: "add",
  hasOnlyDefaultVariant: variants.length === 1,
  options: [],
  variants,
  moreVariants: false,
});
const hit = (id: string): SearchHit => ({ chunkId: `c${id}`, source: "product", productId: id, content: id, score: 0.9 });
const liveOf = (...ps: LiveProduct[]) => ({ ok: true as const, products: new Map(ps.map((p) => [p.id, p])) });

const a = product("a", [v("1500.00")]);
const b = product("b", [v("400.00")]);
const c = product("c", [v("900.00")]);
const hits = [hit("a"), hit("b"), hit("c")];

test("productPrice: the lowest available variant price, or the lowest of all when none is available", () => {
  expect(productPrice(product("x", [v("30.00"), v("10.00", false), v("20.00")]))).toBe(20);
  expect(productPrice(product("x", [v("30.00", false), v("10.00", false)]))).toBe(10);
  expect(productPrice(product("x", []))).toBeNull();
});

test("no budget and no sort changes nothing and adds no note", () => {
  const live = liveOf(a, b, c);
  expect(applyBudget({ hits, live, budget: null, sort: null, currency: "INR" })).toEqual({ hits, live });
});

test("a budget keeps products inside it (bounds inclusive) and drops the rest", () => {
  const r = applyBudget({ hits, live: liveOf(a, b, c), budget: { min: 400, max: 1000 }, sort: null, currency: "INR" });
  expect(r.live.ok && [...r.live.products.keys()]).toEqual(["b", "c"]);
  expect(r.hits).toBe(hits);
  expect(r.note).toBeUndefined();
});

test("a budget that leaves nothing gives a note with the budget", () => {
  const r = applyBudget({ hits, live: liveOf(a, b, c), budget: { min: 10, max: 100 }, sort: null, currency: "INR" });
  expect(r.live.ok && r.live.products.size).toBe(0);
  expect(r.note).toBe("No products are within the shopper's budget of ₹10–₹100.");
  expect(applyBudget({ hits, live: liveOf(a), budget: { max: 1000 }, sort: null, currency: "INR" }).note).toContain("of at most ₹1,000.");
  expect(applyBudget({ hits, live: liveOf(b), budget: { min: 500 }, sort: null, currency: "EUR" }).note).toContain("of at least €500.");
});

test("cheapest orders the hits by price, keeping every chunk of a product; priciest reverses it", () => {
  const withMore = [hit("a"), hit("b"), { ...hit("a"), chunkId: "ca2" }, hit("c")];
  const cheap = applyBudget({ hits: withMore, live: liveOf(a, b, c), budget: null, sort: "cheapest", currency: "INR" });
  expect(cheap.hits.map((h) => h.chunkId)).toEqual(["cb", "cc", "ca", "ca2"]);
  expect(cheap.note).toMatch(/cheapest to the most expensive/);
  const dear = applyBudget({ hits, live: liveOf(a, b, c), budget: null, sort: "priciest", currency: "INR" });
  expect(dear.hits.map((h) => h.productId)).toEqual(["a", "c", "b"]);
});

test("budget and sort together: filtered, then the survivors ordered", () => {
  const r = applyBudget({ hits, live: liveOf(a, b, c), budget: { max: 1000 }, sort: "cheapest", currency: "INR" });
  expect(r.live.ok && [...r.live.products.keys()]).toEqual(["b", "c"]);
  expect(r.hits.slice(0, 2).map((h) => h.productId)).toEqual(["b", "c"]);
});

test("the C11 fallback (no live prices) filters and sorts nothing, and says prices couldn't be checked", () => {
  const live = { ok: false as const, cards: new Map([["a", { id: "a", title: "A", url: "u", imageUrl: null }]]) };
  const r = applyBudget({ hits, live, budget: { max: 10 }, sort: "cheapest", currency: "INR" });
  expect(r.live).toBe(live);
  expect(r.hits).toBe(hits);
  expect(r.note).toMatch(/could not be checked/);
});
