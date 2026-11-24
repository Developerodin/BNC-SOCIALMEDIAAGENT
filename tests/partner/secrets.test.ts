import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import {
  ACCESS_PREFIX,
  ACCESS_TTL_MS,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_TTL_MS,
  REFRESH_PREFIX,
  REQUEST_TTL_MS,
  TOKEN_MODEL,
  accessExpiresAt,
  isValidChallenge,
  isValidState,
  isValidVerifier,
  newClientId,
  newClientSecret,
  newCode,
  newToken,
  redirectUriMatches,
  safeEqualHex,
  sha256Hex,
  tokenKindOf,
  verifyPkceS256,
} from "@/lib/partner/secrets";

// RFC 7636 Appendix B.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

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

test("constants match the plan", () => {
  expect(ACCESS_PREFIX).toBe("ack_");
  expect(REFRESH_PREFIX).toBe("ackr_");
  expect(CLIENT_ID_PREFIX).toBe("pc_");
  expect(CLIENT_SECRET_PREFIX).toBe("pcs_");
  expect(CODE_TTL_MS).toBe(300_000);
  expect(REQUEST_TTL_MS).toBe(600_000);
  expect(ACCESS_TTL_MS).toBe(3_600_000);
  expect(TOKEN_MODEL).toBe("long_lived"); // C32 (a)
});

test("PKCE: the RFC 7636 Appendix B vector verifies", () => {
  expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
});

test("PKCE: a wrong verifier or a changed challenge fails", () => {
  expect(verifyPkceS256(RFC_VERIFIER.replace("d", "e"), RFC_CHALLENGE)).toBe(false);
  expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE.replace("E", "F"))).toBe(false);
});

test("PKCE: plain is impossible by construction (a verifier sent as its own challenge fails)", () => {
  // 43 chars, so it is both a valid verifier and a well-formed challenge; plain would accept it, S256 must not.
  expect(isValidChallenge(RFC_VERIFIER)).toBe(true);
  expect(verifyPkceS256(RFC_VERIFIER, RFC_VERIFIER)).toBe(false);
  expect(verifyPkceS256.length).toBe(2); // no method argument to pass "plain" through
});

test("PKCE: verifiers of 42 and 129 characters are refused, 43 and 128 accepted", () => {
  expect(isValidVerifier("a".repeat(42))).toBe(false);
  expect(isValidVerifier("a".repeat(129))).toBe(false);
  expect(isValidVerifier("a".repeat(43))).toBe(true);
  expect(isValidVerifier("a".repeat(128))).toBe(true);
  expect(isValidVerifier("A-._~z9".repeat(19).slice(0, 128))).toBe(true);
  // A correct hash of a wrong-length verifier still fails.
  const short = "a".repeat(42);
  expect(verifyPkceS256(short, s256(short))).toBe(false);
  const long = "a".repeat(129);
  expect(verifyPkceS256(long, s256(long))).toBe(false);
  const ok = "a".repeat(128);
  expect(verifyPkceS256(ok, s256(ok))).toBe(true);
});

test("PKCE: verifier charset is [A-Za-z0-9-._~] only", () => {
  for (const bad of ["+", "/", "=", " ", "%", "é", "\n"]) {
    const v = "a".repeat(42) + bad;
    expect(isValidVerifier(v)).toBe(false);
    expect(verifyPkceS256(v, s256(v))).toBe(false);
  }
});

test("PKCE: challenge must be exactly 43 base64url characters", () => {
  expect(isValidChallenge(RFC_CHALLENGE)).toBe(true);
  expect(isValidChallenge(RFC_CHALLENGE.slice(1))).toBe(false);
  expect(isValidChallenge(RFC_CHALLENGE + "A")).toBe(false);
  expect(isValidChallenge(RFC_CHALLENGE.slice(1) + "=")).toBe(false);
  expect(isValidChallenge(RFC_CHALLENGE.slice(1) + "+")).toBe(false);
  expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE + "=")).toBe(false);
});

test("access tokens start with ack_, are 47 characters, unique over 1,000 draws, prefix is the first 12", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const { token, hash, prefix } = newToken("access");
    expect(token.startsWith("ack_")).toBe(true);
    expect(token).toHaveLength(47);
    expect(token.slice(4)).toMatch(B64URL43);
    expect(prefix).toBe(token.slice(0, 12));
    expect(hash).toBe(sha256Hex(token));
    seen.add(token);
  }
  expect(seen.size).toBe(1000);
});

test("refresh tokens start with ackr_ and are 48 characters", () => {
  const { token, hash, prefix } = newToken("refresh");
  expect(token.startsWith("ackr_")).toBe(true);
  expect(token).toHaveLength(48);
  expect(token.slice(5)).toMatch(B64URL43);
  expect(prefix).toBe(token.slice(0, 12));
  expect(hash).toBe(sha256Hex(token));
});

test("tokenKindOf tells access, refresh and anything else apart by format", () => {
  expect(tokenKindOf(newToken("access").token)).toBe("access");
  expect(tokenKindOf(newToken("refresh").token)).toBe("refresh");
  expect(tokenKindOf("ack_short")).toBeNull();
  expect(tokenKindOf("ack_" + "a".repeat(44))).toBeNull();
  expect(tokenKindOf("ack_" + "a".repeat(42) + "=")).toBeNull();
  expect(tokenKindOf("some-legacy-shared-secret")).toBeNull();
  expect(tokenKindOf("")).toBeNull();
});

test("codes are 43 base64url characters, hashed with sha256, unique", () => {
  const a = newCode();
  const b = newCode();
  expect(a.code).toMatch(B64URL43);
  expect(a.hash).toBe(sha256Hex(a.code));
  expect(a.code).not.toBe(b.code);
});

test("client ids are pc_ + 16 base64url characters; secrets are pcs_ + 43 with a sha256 hash", () => {
  const id = newClientId();
  expect(id).toMatch(/^pc_[A-Za-z0-9_-]{16}$/);
  expect(newClientId()).not.toBe(id);
  const { secret, hash } = newClientSecret();
  expect(secret).toMatch(/^pcs_[A-Za-z0-9_-]{43}$/);
  expect(hash).toBe(sha256Hex(secret));
  expect(newClientSecret().secret).not.toBe(secret);
});

test("sha256Hex is lowercase hex sha256 of the utf8 string", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("é")).toBe(createHash("sha256").update("é", "utf8").digest("hex"));
});

test("safeEqualHex: equal digests match (any case), anything else does not, and it never throws", () => {
  const h = sha256Hex("x");
  expect(safeEqualHex(h, sha256Hex("x"))).toBe(true);
  expect(safeEqualHex(h, h.toUpperCase())).toBe(true);
  expect(safeEqualHex(h, sha256Hex("y"))).toBe(false);
  expect(safeEqualHex(h, h.slice(0, 62))).toBe(false);
  expect(safeEqualHex(h, h + "00")).toBe(false);
  expect(safeEqualHex(h.slice(0, 63), h.slice(0, 63))).toBe(false); // odd length
  expect(safeEqualHex("zz", "zz")).toBe(false);
  expect(safeEqualHex("", "")).toBe(false);
});

test("state: 1-512 printable ASCII; control characters, non-ASCII, empty or over 512 are refused", () => {
  expect(isValidState("a")).toBe(true);
  expect(isValidState("x".repeat(512))).toBe(true);
  expect(isValidState("abc DEF ~!{}")).toBe(true);
  expect(isValidState("")).toBe(false);
  expect(isValidState("x".repeat(513))).toBe(false);
  expect(isValidState("ab\ncd")).toBe(false);
  expect(isValidState("ab\u0000cd")).toBe(false);
  expect(isValidState("ab\tcd")).toBe(false);
  expect(isValidState("ab\u007fcd")).toBe(false);
  expect(isValidState("café")).toBe(false);
});

test("redirect_uri is an exact string match: no prefix, case, slash or query leeway", () => {
  const list = ["https://portal.example/askcart/callback"];
  expect(redirectUriMatches("https://portal.example/askcart/callback", list)).toBe(true);
  expect(redirectUriMatches("https://portal.example/askcart/callback/", list)).toBe(false);
  expect(redirectUriMatches("https://portal.example/askcart/callback?x=1", list)).toBe(false);
  expect(redirectUriMatches("https://portal.example/askcart/callback#f", list)).toBe(false);
  expect(redirectUriMatches("https://PORTAL.example/askcart/callback", list)).toBe(false);
  expect(redirectUriMatches("https://portal.example/askcart", list)).toBe(false);
  expect(redirectUriMatches("https://portal.example.evil.com/askcart/callback", list)).toBe(false);
  expect(redirectUriMatches("", list)).toBe(false);
  expect(redirectUriMatches("https://portal.example/askcart/callback", [])).toBe(false);
});

test("C32 switch: long_lived access tokens never expire; access_refresh gives one hour", () => {
  const now = new Date("2026-11-24T00:00:00Z");
  expect(accessExpiresAt("long_lived", now)).toBeNull();
  expect(accessExpiresAt("access_refresh", now)).toEqual(new Date(now.getTime() + 3_600_000));
  expect(accessExpiresAt(TOKEN_MODEL, now)).toBeNull();
});
