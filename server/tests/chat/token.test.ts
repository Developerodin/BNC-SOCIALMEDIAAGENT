import { beforeAll, expect, test } from "vitest";
import { mintToken, tokenHash, verifyToken } from "@/lib/chat/token";

beforeAll(() => {
  // Test-only dummy secret; never a real one.
  process.env.CHAT_TOKEN_SECRET = "dGVzdC1jaGF0LXRva2VuLXNlY3JldC0zMi1ieXRlcyE=";
});

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";

test("a minted token verifies for its store and returns its id", () => {
  const { conversationId, token } = mintToken(STORE_A);
  expect(token.startsWith(`${conversationId}.`)).toBe(true);
  expect(verifyToken(STORE_A, token)).toBe(conversationId);
});

test("the same token with another storeId returns null", () => {
  const { token } = mintToken(STORE_A);
  expect(verifyToken(STORE_B, token)).toBeNull();
});

test("flipping one character returns null", () => {
  const { token } = mintToken(STORE_A);
  const i = token.length - 3;
  const flipped = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
  expect(verifyToken(STORE_A, flipped)).toBeNull();
  // A flip in the id half is rejected too.
  const idFlip = (token[0] === "a" ? "b" : "a") + token.slice(1);
  expect(verifyToken(STORE_A, idFlip)).toBeNull();
});

test('"garbage" returns null', () => {
  expect(verifyToken(STORE_A, "garbage")).toBeNull();
  expect(verifyToken(STORE_A, "")).toBeNull();
  expect(verifyToken(STORE_A, "a.b.c")).toBeNull();
});

test("tokenHash is the sha256 hex and differs from the token", () => {
  const { token } = mintToken(STORE_A);
  const h = tokenHash(token);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(h).toBe(tokenHash(token));
  expect(h).not.toContain(token);
});

test("mintToken throws without CHAT_TOKEN_SECRET", () => {
  const saved = process.env.CHAT_TOKEN_SECRET;
  delete process.env.CHAT_TOKEN_SECRET;
  try {
    expect(() => mintToken(STORE_A)).toThrow(/CHAT_TOKEN_SECRET/);
  } finally {
    process.env.CHAT_TOKEN_SECRET = saved;
  }
});
