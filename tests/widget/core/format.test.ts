// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { formatPrice, safeHex, safeHttpsUrl, safeImageUrl, stockLabel, textOn } from "../../../widget/src/core/format";
import { translator } from "../../../widget/src/core/i18n";

const t = translator("en");
const spaces = (s: string | null) => s?.replace(/\s/g, " ");

describe("format", () => {
  it("formats a price in the shopper's locale", () => {
    expect(spaces(formatPrice("19.9", "EUR", "fr"))).toBe("19,90 €");
    expect(formatPrice("19.9", "USD", "en")).toBe("$19.90");
    expect(formatPrice("abc", "USD", "en")).toBeNull();
    expect(formatPrice("1", "not a currency", "en")).toBeNull();
  });

  it("labels stock against the threshold (UD10)", () => {
    expect(stockLabel({ kind: "count", n: 3 }, 5, t)).toBe("Only 3 left");
    expect(stockLabel({ kind: "count", n: 12 }, 5, t)).toBe("In stock");
    expect(stockLabel({ kind: "count", n: 0 }, 5, t)).toBe("Sold out");
    expect(stockLabel({ kind: "in_stock" }, 5, t)).toBe("In stock");
    expect(stockLabel({ kind: "sold_out" }, 5, t)).toBe("Sold out");
    expect(stockLabel(null, 5, t)).toBeNull();
  });

  it("allows https links only", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://x")).toBeNull();
    expect(safeHttpsUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpsUrl("https://user:pw@shop.example/p")).toBeNull();
    expect(safeHttpsUrl(42)).toBeNull();
    expect(safeHttpsUrl("https://shop.example/products/a")).toBe("https://shop.example/products/a");
  });

  it("allows images on cdn.shopify.com only", () => {
    expect(safeImageUrl("https://evil.com/a.png")).toBeNull();
    expect(safeImageUrl("https://cdn.shopify.com.evil.com/a.png")).toBeNull();
    expect(safeImageUrl("http://cdn.shopify.com/a.png")).toBeNull();
    expect(safeImageUrl("https://cdn.shopify.com/s/files/a.png")).toBe("https://cdn.shopify.com/s/files/a.png");
  });

  it("picks black or white text for contrast on the accent (UD17), and checks hex colours", () => {
    expect(textOn("#0A0A0A")).toBe("#ffffff");
    expect(textOn("#FFE600")).toBe("#000000");
    expect(safeHex("#12abEF")).toBe("#12abEF");
    expect(safeHex("red;background:url(x)")).toBeNull();
  });
});
