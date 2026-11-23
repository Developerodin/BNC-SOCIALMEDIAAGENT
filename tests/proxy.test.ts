import { expect, test } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const run = (path: string) => proxy(new NextRequest(`http://localhost${path}`));

test("root with shop/host redirects to /app keeping the query", () => {
  const res = run("/?shop=a.myshopify.com&host=x");
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://localhost/app?shop=a.myshopify.com&host=x");
});

test("/app with a valid shop may be framed by that shop and the admin", () => {
  const csp = run("/app?shop=a.myshopify.com").headers.get("content-security-policy");
  expect(csp).toContain("frame-ancestors https://a.myshopify.com https://admin.shopify.com");
});

test.each(["/app?shop=evil.com", "/dash", "/"])("%s cannot be framed", (path) => {
  expect(run(path).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
});
