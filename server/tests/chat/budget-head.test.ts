import { expect, test } from "vitest";
import { applyBudget } from "@/lib/chat/budget";
import { plainText, stripProductRefs } from "@/lib/chat/prompt";
import type { LiveProduct } from "@/lib/shopify/live-products";
import type { SearchHit } from "@/lib/retrieval";

const product = (id: string, price: string): LiveProduct => ({
  id,
  title: id,
  url: `https://shop.example.com/products/${id}`,
  imageUrl: null,
  currency: "EUR",
  available: true,
  action: "add",
  hasOnlyDefaultVariant: true,
  options: [],
  variants: [{ id, title: "Default Title", options: [], available: true, stock: { kind: "in_stock" }, price, compareAtPrice: null }],
  moreVariants: false,
});
const hit = (id: string, score: number): SearchHit => ({ chunkId: `c${id}`, source: "product", productId: id, content: id, score });
const liveOf = (...ps: LiveProduct[]) => ({ ok: true as const, products: new Map(ps.map((p) => [p.id, p])) });
const ids = (hits: SearchHit[]) => hits.map((h) => h.productId);

const sofaA = product("sofaA", "900.00");
const sofaB = product("sofaB", "600.00");
const cushion = product("cushion", "39.00");
const hits = [hit("sofaA", 0.62), hit("sofaB", 0.6), hit("cushion", 0.41)];

test("cheapest sorts only the products that match the search: the cushion does not beat the sofas", () => {
  const r = applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: null, sort: "cheapest", currency: "EUR" });
  expect(ids(r.hits)).toEqual(["sofaB", "sofaA"]);
  expect(r.note).toContain("cheapest to the most expensive");
});

test("priciest uses the same head, and a wider margin keeps more products in it", () => {
  expect(ids(applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: null, sort: "priciest", currency: "EUR" }).hits)).toEqual(["sofaA", "sofaB"]);
  expect(ids(applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: null, sort: "cheapest", currency: "EUR", margin: 0.3 }).hits)).toEqual(["cushion", "sofaB", "sofaA"]);
});

test("when the budget leaves none of the head, what is left is sorted rather than nothing", () => {
  const r = applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: { max: 100 }, sort: "cheapest", currency: "EUR" });
  expect(ids(r.hits)).toEqual(["cushion"]);
});

test("a budget with a sort keeps the head products that fit", () => {
  const r = applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: { max: 700 }, sort: "cheapest", currency: "EUR" });
  expect(ids(r.hits)).toEqual(["sofaB"]);
});

test("a budget alone still keeps every hit in search order (the model sees what fits)", () => {
  const r = applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: { max: 700 }, sort: null, currency: "EUR" });
  expect(r.hits).toBe(hits);
});

test("notes write prices with two decimals and a dot", () => {
  const r = applyBudget({ hits, live: liveOf(sofaA, sofaB, cushion), budget: { max: 45 }, sort: null, currency: "EUR" });
  expect(r.note).toContain("at €600.00");
});

test("plainText removes HTML tags, Markdown links and emphasis, and leaves ordinary text alone", () => {
  expect(plainText("<b>Oak</b> <br/>table <img src='a.png'> [Shop](https://x.test/a_(b)) **solid** __wood__ *rustic* ~~old~~")).toBe("Oak table [Shop] solid wood rustic old".replace("[Shop]", "Shop"));
  expect(plainText("Size <5 cm, 5 * 3 mm, a_b_c, rated 4*, [[x]]")).toBe("Size <5 cm, 5 * 3 mm, a_b_c, rated 4*, [[x]]");
});

test("stripProductRefs removes marker lookalikes from a shopper's message and never empties it", () => {
  expect(stripProductRefs("show [[product:2]] and product:3 and [[ Product : 4 ]]")).toBe("show and and");
  expect(stripProductRefs("product: 5 chairs")).toBe("product: 5 chairs");
  expect(stripProductRefs("[[product:1]]")).toBe("[[product:1]]");
});
