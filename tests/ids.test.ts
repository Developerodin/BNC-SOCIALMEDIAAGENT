import { expect, test } from "vitest";
import { productGid } from "@/lib/ids";

test("productGid: a numeric id or a Product GID becomes a GID; anything else is undefined", () => {
  expect(productGid("123")).toBe("gid://shopify/Product/123");
  expect(productGid("gid://shopify/Product/123")).toBe("gid://shopify/Product/123");
  for (const raw of [undefined, null, "", "abc", "gid://shopify/ProductVariant/1", "12a", "gid://shopify/Product/"]) {
    expect(productGid(raw)).toBeUndefined();
  }
});
