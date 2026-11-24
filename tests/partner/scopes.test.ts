import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import {
  ENDPOINT_SCOPE,
  GRANTABLE,
  PARTNER_SCOPES,
  RESERVED_SCOPES,
  SHOPIFY_SCOPE_FOR,
  parseScopeParam,
} from "@/lib/partner/scopes";

const ALL = ["read:orders", "read:products", "read:shop"];

let logs: MockInstance[];
beforeEach(() => {
  logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  for (const s of logs) {
    expect(s).not.toHaveBeenCalled();
    s.mockRestore();
  }
});

test("the table matches the plan: three grantable read scopes, write and customer scopes reserved", () => {
  expect([...GRANTABLE].sort()).toEqual(ALL);
  expect([...RESERVED_SCOPES].sort()).toEqual(["read:customers", "write:orders", "write:products"]);
  expect(Object.keys(PARTNER_SCOPES).sort()).toEqual([...ALL, "read:customers", "write:orders", "write:products"].sort());
  expect(SHOPIFY_SCOPE_FOR).toEqual({ "read:shop": null, "read:products": "read_products", "read:orders": "read_orders" });
  expect(ENDPOINT_SCOPE).toEqual({ orders: "read:orders", products: "read:products", shop: "read:shop" });
});

test("no grantable scope is a write or customer scope", () => {
  for (const s of GRANTABLE) expect(s).toMatch(/^read:(orders|products|shop)$/);
});

test("an omitted scope defaults to the client's allowed scopes, grantable only, in canonical order", () => {
  expect(parseScopeParam(undefined, ["read:shop", "read:orders", "read:products"])).toEqual(ALL);
  expect(parseScopeParam(null, ["read:shop", "write:orders"])).toEqual(["read:shop"]);
});

test("an omitted scope with nothing grantable allowed is an error", () => {
  expect(parseScopeParam(undefined, ["write:orders"])).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam(undefined, [])).toEqual({ error: "invalid_scope" });
});

test("a requested subset is granted, deduplicated and ordered", () => {
  expect(parseScopeParam("read:shop read:orders read:shop", ALL)).toEqual(["read:orders", "read:shop"]);
});

test("write:orders and the other reserved scopes are refused even when the client lists them", () => {
  const allowed = [...ALL, "write:orders", "write:products", "read:customers"];
  expect(parseScopeParam("write:orders", allowed)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("read:shop write:orders", allowed)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("read:customers", allowed)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("write:*", allowed)).toEqual({ error: "invalid_scope" });
});

test("a scope outside the client's allowed list is refused", () => {
  expect(parseScopeParam("read:orders", ["read:shop"])).toEqual({ error: "invalid_scope" });
});

test("unknown, empty or badly separated scope strings are refused", () => {
  expect(parseScopeParam("", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("read:everything", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("read:shop  read:orders", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam(" read:shop", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("read:shop,read:orders", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("READ:SHOP", ALL)).toEqual({ error: "invalid_scope" });
  expect(parseScopeParam("toString", ALL)).toEqual({ error: "invalid_scope" });
});
