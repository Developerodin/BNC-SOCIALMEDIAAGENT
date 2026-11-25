import { beforeAll, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { mintToken } from "@/lib/chat/token";
import { customerGid, customerOf, mintSession, SESSION_TTL_MS, verifySession } from "@/lib/chat/customer";

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
