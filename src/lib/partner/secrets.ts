import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Plan (c), (d), (e): every bearer secret of the partner connect flow. Each is random bytes in base64url behind a
// recognisable prefix; only sha256 hex is ever stored. Plain sha256 is enough at 256 bits of entropy (no brute
// force on a stolen hash), and a slow hash would cost every request.

export const ACCESS_PREFIX = "ack_";
export const REFRESH_PREFIX = "ackr_";
export const CLIENT_ID_PREFIX = "pc_";
export const CLIENT_SECRET_PREFIX = "pcs_";

/** An authorization code lives 5 minutes from Allow; a connect request 10 minutes from `/partner/connect`. */
export const CODE_TTL_MS = 300_000;
export const REQUEST_TTL_MS = 600_000;

/**
 * C32 (a): one long-lived access token per grant, valid until the grant is revoked. Switching this to
 * "access_refresh" gives access tokens a one-hour `expires_at` (ACCESS_TTL_MS) and issues an `ackr_` refresh token
 * alongside; the token endpoint (P6) reads the same constant to decide whether `refresh_token` is supported.
 */
export type TokenModel = "long_lived" | "access_refresh";
export const TOKEN_MODEL: TokenModel = "long_lived";
export const ACCESS_TTL_MS = 3_600_000;

/** `expires_at` for a new access token under a model: null (never) for long_lived, now + 1 h for access_refresh. */
export function accessExpiresAt(model: TokenModel = TOKEN_MODEL, now: Date = new Date()): Date | null {
  return model === "access_refresh" ? new Date(now.getTime() + ACCESS_TTL_MS) : null;
}

export type TokenKind = "access" | "refresh";

/** Lowercase hex sha256 of the UTF-8 string: the form every secret is stored and looked up in. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const random43 = () => randomBytes(32).toString("base64url"); // 32 bytes -> 43 chars, no padding

/** A new access (`ack_` + 43) or refresh (`ackr_` + 43) token. `prefix` (first 12 chars) is safe to log and store. */
export function newToken(kind: TokenKind): { token: string; hash: string; prefix: string } {
  const token = (kind === "access" ? ACCESS_PREFIX : REFRESH_PREFIX) + random43();
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 12) };
}

const ACCESS_RE = /^ack_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^ackr_[A-Za-z0-9_-]{43}$/;

/** Which kind of token a Bearer value is by format alone (no DB), or null for anything else (e.g. the legacy secret). */
export function tokenKindOf(s: string): TokenKind | null {
  if (ACCESS_RE.test(s)) return "access";
  if (REFRESH_RE.test(s)) return "refresh";
  return null;
}

/** A new authorization code: 43 base64url chars, no prefix (it travels in a URL). Store only `hash`. */
export function newCode(): { code: string; hash: string } {
  const code = random43();
  return { code, hash: sha256Hex(code) };
}

/** A new public client id: `pc_` + 16 base64url chars (12 random bytes). */
export function newClientId(): string {
  return CLIENT_ID_PREFIX + randomBytes(12).toString("base64url");
}

/** A new client secret: `pcs_` + 43. Printed once by the registration script; store only `hash`. */
export function newClientSecret(): { secret: string; hash: string } {
  const secret = CLIENT_SECRET_PREFIX + random43();
  return { secret, hash: sha256Hex(secret) };
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * Constant-time equality of two hex digests (e.g. a stored sha256 and a fresh one). Malformed or unequal-length
 * input is false, never a throw; the length is not secret (always 64 for sha256).
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !HEX_RE.test(a) || !HEX_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 4.1
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // base64url(sha256) without padding
const STATE_RE = /^[\x20-\x7e]{1,512}$/; // printable ASCII (RFC 6749 VSCHAR)

export const isValidVerifier = (v: string): boolean => VERIFIER_RE.test(v);
export const isValidChallenge = (c: string): boolean => CHALLENGE_RE.test(c);
export const isValidState = (s: string): boolean => STATE_RE.test(s);

/**
 * PKCE S256 only: `base64url(sha256(verifier)) === challenge`, compared in constant time. There is no method
 * argument, so `plain` can't be accepted by mistake. A verifier or challenge of the wrong length or charset is false.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidVerifier(verifier) || !isValidChallenge(challenge)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  // Compare the base64url text (both 43 ASCII chars), not decoded bytes: decoding ignores a last char's spare bits.
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

/** Exact string match against the client's registered list: no prefix, case, slash or query normalisation. */
export function redirectUriMatches(uri: string, registered: readonly string[]): boolean {
  return uri !== "" && registered.includes(uri);
}
