import { expect, test } from "vitest";
import { parseRating } from "@/lib/ratings";
import { featuredCollection } from "@/lib/chat/featured-collection";

const m = (namespace: string, key: string, value: string) => ({ namespace, key, value });

test("Shopify's standard reviews.rating is normalized to a 0-5 scale, whatever scale the app used", () => {
  expect(parseRating([m("reviews", "rating", '{"scale_min":"1.0","scale_max":"5.0","value":"4.5"}'), m("reviews", "rating_count", "12")])).toEqual({ rating: 4.5, count: 12 });
  expect(parseRating([m("reviews", "rating", '{"scale_min":"1","scale_max":"10","value":"9"}'), m("reviews", "rating_count", "4")])).toEqual({ rating: 4.5, count: 4 });
  expect(parseRating([m("reviews", "rating", "4.2"), m("reviews", "rating_count", "7")])).toEqual({ rating: 4.2, count: 7 });
});

test("review apps' own namespaces are read: Judge.me badge, Okendo, Yotpo, Stamped, Loox", () => {
  expect(parseRating([m("judgeme", "badge", `<div class='jdgm-prev-badge' data-average-rating='4.80' data-number-of-reviews='25'></div>`)])).toEqual({ rating: 4.8, count: 25 });
  expect(parseRating([m("okendo", "summaryData", '{"reviewCount":9,"averageRating":4.33,"recommendationRating":1}')])).toEqual({ rating: 4.33, count: 9 });
  expect(parseRating([m("yotpo", "reviews_average", "4.1"), m("yotpo", "reviews_count", "30")])).toEqual({ rating: 4.1, count: 30 });
  expect(parseRating([m("stamped", "reviews_average", "3.9"), m("stamped", "reviews_count", "5")])).toEqual({ rating: 3.9, count: 5 });
  expect(parseRating([m("stamped", "badge", `<span class="stamped-badge" data-rating="4.6" data-count="11"></span>`)])).toEqual({ rating: 4.6, count: 11 });
  expect(parseRating([m("loox", "avg_rating", "4.9"), m("loox", "num_reviews", "40")])).toEqual({ rating: 4.9, count: 40 });
});

test("no rating, no reviews, or unusable values give null", () => {
  expect(parseRating([])).toBeNull();
  expect(parseRating([m("custom", "material", "oak")])).toBeNull();
  expect(parseRating([m("reviews", "rating", "4.5")])).toBeNull(); // no count
  expect(parseRating([m("reviews", "rating", "4.5"), m("reviews", "rating_count", "0")])).toBeNull();
  expect(parseRating([m("reviews", "rating", "7.5"), m("reviews", "rating_count", "3")])).toBeNull(); // above the scale
  expect(parseRating([m("reviews", "rating", "not json"), m("reviews", "rating_count", "3")])).toBeNull();
  expect(parseRating([m("okendo", "summaryData", "{broken")])).toBeNull();
});

test("a broken first source falls through to the next one", () => {
  expect(parseRating([m("reviews", "rating", "x"), m("yotpo", "reviews_average", "4"), m("yotpo", "reviews_count", "3")])).toEqual({ rating: 4, count: 3 });
});

const col = (title: string, handle = "") => ({ title, handle });

test("featured_collection finds the best-sellers collection by title or handle in the six languages", () => {
  for (const t of ["Best Sellers", "Meilleures ventes", "Les plus vendus", "Bestseller", "Más vendidos", "I più venduti", "Meest verkocht", "Top ventes"]) {
    expect(featuredCollection("best_sellers", [col("Chaises"), col(t), col("Tables")])?.title).toBe(t);
  }
  expect(featuredCollection("best_sellers", [col("Chaises"), col("Coups de coeur", "meilleures-ventes")])?.title).toBe("Coups de coeur");
  expect(featuredCollection("best_sellers", [col("Chaises"), col("Tables")])).toBeUndefined();
});

test("featured_collection finds the sale collection: soldes, promotions, offres, Black Friday and the other languages", () => {
  for (const t of ["Sale", "Soldes d'hiver", "Promotions", "Promo", "Offres spéciales", "Black Friday", "Rebajas", "Angebote", "Saldi", "Uitverkoop", "Ofertas"]) {
    expect(featuredCollection("sale", [col("Canapés"), col(t)])?.title).toBe(t);
  }
  expect(featuredCollection("sale", [col("Wholesale"), col("Consoles")])).toBeUndefined(); // whole words only
  expect(featuredCollection("sale", [col("Canapés"), col("Fauteuils")])).toBeUndefined();
});

test("a best-sellers collection is not taken for a sale one, and a tie goes to the shorter title", () => {
  expect(featuredCollection("sale", [col("Best Sellers")])).toBeUndefined();
  expect(featuredCollection("best_sellers", [col("Soldes")])).toBeUndefined();
  expect(featuredCollection("best_sellers", [col("Best Sellers Chaises"), col("Best Sellers")])?.title).toBe("Best Sellers");
});
