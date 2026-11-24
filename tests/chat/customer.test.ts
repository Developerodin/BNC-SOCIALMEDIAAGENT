import { beforeAll, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { mintToken } from "@/lib/chat/token";
import { customerGid, customerOf, mintSession, SESSION_TTL_MS, verifySession } from "@/lib/chat/customer";
import { proxySignature, verifyProxy } from "@/lib/shopify/app-proxy";

beforeAll(() => {
  // Test-only dummy secret; never a real one.
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE=";
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ALICE = "gid://shopify/Customer/1001";

test("a session verifies for its store and returns the customer GID", () => {
  const { token, expiresAt } = mintSession(A, ALICE, 1_000);
  expect(expiresAt).toBe(1_000 + SESSION_TTL_MS);
  expect(verifySession(A, token, 2_000)).toBe(ALICE);
});

test("a session is refused for another store, after expiry, and when any part is changed", () => {
  const { token } = mintSession(A, ALICE, 1_000);
  expect(verifySession(B, token, 2_000)).toBeNull();
  expect(verifySession(A, token, 1_000 + SESSION_TTL_MS)).toBeNull();
  const [exp, id, mac] = token.split(".");
  expect(verifySession(A, `${exp}.1002.${mac}`, 2_000)).toBeNull();
  expect(verifySession(A, `${Number(exp) + 99999999}.${id}.${mac}`, 2_000)).toBeNull();
  expect(verifySession(A, `${exp}.${id}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`, 2_000)).toBeNull();
  expect(verifySession(A, "garbage", 2_000)).toBeNull();
});

test("a conversation token is not a session and a session is not a conversation token", () => {
  const { token: convToken } = mintToken(A);
  expect(verifySession(A, convToken)).toBeNull();
  // Same MAC input shape signed with the conversation-token prefix must not pass either.
  const exp = String(Date.now() + 60_000);
  const forged = createHmac("sha256", Buffer.from(process.env.CHAT_TOKEN_SECRET!, "base64")).update(`v1|${A}|${exp}|1001`).digest("base64url");
  expect(verifySession(A, `${exp}.1001.${forged}`)).toBeNull();
});

test("only a canonical customer id can be signed", () => {
  expect(() => mintSession(A, "gid://shopify/Product/1")).toThrow();
  expect(customerGid("42")).toBe("gid://shopify/Customer/42");
  expect(customerGid("")).toBeNull();
  expect(customerGid("4 2")).toBeNull();
});

test("customerOf: no header is a guest, a good header the customer, a bad one a refusal", () => {
  const req = (h?: string) => new Request("http://x", { headers: h ? { "x-askcart-customer": h } : {} });
  expect(customerOf(req(), A)).toEqual({ ok: true });
  expect(customerOf(req(mintSession(A, ALICE).token), A)).toEqual({ ok: true, customer: ALICE });
  expect(customerOf(req("nope"), A)).toEqual({ ok: false });
  expect(customerOf(req(mintSession(B, ALICE).token), A)).toEqual({ ok: false });
});

// App Proxy signature (Shopify's documented algorithm).
const SECRET = "hush";
function signed(extra: Record<string, string>, ts = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ shop: "a.myshopify.com", path_prefix: "/apps/askcart", timestamp: String(ts), ...extra });
  p.set("signature", proxySignature(p, SECRET));
  return p;
}

test("proxy signature: matches Shopify's documented construction", () => {
  const p = new URLSearchParams("extra=1&extra=2&shop=a.myshopify.com&timestamp=5");
  const expected = createHmac("sha256", SECRET).update("extra=1,2shop=a.myshopify.comtimestamp=5").digest("hex");
  expect(proxySignature(p, SECRET)).toBe(expected);
});

test("proxy signature: valid passes; tampered param, wrong secret, missing or stale timestamp fail", () => {
  const now = Date.now();
  expect(verifyProxy(signed({ logged_in_customer_id: "7" }), SECRET, now)).toBe(true);
  const tampered = signed({ logged_in_customer_id: "7" });
  tampered.set("logged_in_customer_id", "8");
  expect(verifyProxy(tampered, SECRET, now)).toBe(false);
  expect(verifyProxy(signed({}), "other", now)).toBe(false);
  const unsigned = signed({});
  unsigned.delete("signature");
  expect(verifyProxy(unsigned, SECRET, now)).toBe(false);
  const old = signed({}, Math.floor(now / 1000) - 600);
  expect(verifyProxy(old, SECRET, now)).toBe(false);
  const future = signed({}, Math.floor(now / 1000) + 600);
  expect(verifyProxy(future, SECRET, now)).toBe(false);
  const noTs = new URLSearchParams({ shop: "a.myshopify.com" });
  noTs.set("signature", proxySignature(noTs, SECRET));
  expect(verifyProxy(noTs, SECRET, now)).toBe(false);
});
