// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { brandLogo, contrastRatio, formatPrice, resolveHttpsUrl, safeHex, safeHttpsUrl, safeImageUrl, stockLabel, textOn } from "../../../widget/src/core/format";
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

  it("accepts Liquid's protocol-relative and same-store /cdn/shop/ image URLs, resolved against the page", () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("https://shop.example/products/tee");
    expect(safeImageUrl("//shop.example/cdn/shop/files/a.jpg?width=160")).toBe("https://shop.example/cdn/shop/files/a.jpg?width=160");
    expect(safeImageUrl("/cdn/shop/files/a.jpg")).toBe("https://shop.example/cdn/shop/files/a.jpg");
    expect(safeImageUrl("//cdn.shopify.com/s/files/a.png")).toBe("https://cdn.shopify.com/s/files/a.png");
    // other hosts, other paths on the store, and look-alikes stay out
    expect(safeImageUrl("//evil.example/cdn/shop/files/a.jpg")).toBeNull();
    expect(safeImageUrl("//shop.example/evil/a.jpg")).toBeNull();
    expect(safeImageUrl("/a.png")).toBeNull();
    expect(safeImageUrl("//shop.example.evil.com/cdn/shop/a.jpg")).toBeNull();
    expect(safeImageUrl("http://shop.example/cdn/shop/a.jpg")).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
  });

  it("the chat's logo is the avatar, else the shop's brand logo, else nothing", () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("https://shop.example/");
    const av = "https://cdn.shopify.com/s/files/av.png";
    expect(brandLogo(av, "//shop.example/cdn/shop/files/logo.png")).toBe(av);
    expect(brandLogo(null, "//shop.example/cdn/shop/files/logo.png")).toBe("https://shop.example/cdn/shop/files/logo.png");
    expect(brandLogo("https://evil.com/a.png", "https://cdn.shopify.com/l.png")).toBe("https://cdn.shopify.com/l.png");
    expect(brandLogo(null, "https://evil.com/l.png")).toBeNull();
    expect(brandLogo(null, null)).toBeNull();
  });

  it("picks black or white text for contrast on the accent (UD17), and checks hex colours", () => {
    expect(textOn("#0A0A0A")).toBe("#ffffff");
    expect(textOn("#FFE600")).toBe("#000000");
    expect(safeHex("#12abEF")).toBe("#12abEF");
    expect(safeHex("red;background:url(x)")).toBeNull();
  });

  it("resolves a storefront-relative path against the page, then requires https", () => {
    expect(resolveHttpsUrl("/cart", "https://a.example/products/x")).toBe("https://a.example/cart");
    expect(resolveHttpsUrl("https://b.example/p", "https://a.example/")).toBe("https://b.example/p");
    expect(resolveHttpsUrl("javascript:alert(1)", "https://a.example/")).toBeNull();
    expect(resolveHttpsUrl("/cart", "http://a.example/")).toBeNull();
    expect(resolveHttpsUrl(null, "https://a.example/")).toBeNull();
    expect(resolveHttpsUrl("", "https://a.example/")).toBeNull();
  });
});

describe("accent contrast", () => {
  it("contrastRatio matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("textOn keeps WCAG AA (4.5:1) on every accent, including the worst mid-tones", () => {
    for (let r = 0; r < 256; r += 51) {
      for (let g = 0; g < 256; g += 51) {
        for (let b = 0; b < 256; b += 51) {
          const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
          expect(contrastRatio(hex, textOn(hex))).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(textOn("#ffe600")).toBe("#000000");
    expect(textOn("#0a0a0a")).toBe("#ffffff");
  });
});
