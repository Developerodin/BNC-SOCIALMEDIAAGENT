import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Conversation token: "<conversationId>.<base64url HMAC-SHA256(secret, "v1|storeId|conversationId")>".
// Binding storeId into the MAC means a token minted for store B never verifies under store A.
// Rotating CHAT_TOKEN_SECRET invalidates every open conversation (shoppers start a new chat).

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function secret(): Buffer {
  const k = Buffer.from(process.env.CHAT_TOKEN_SECRET ?? "", "base64");
  if (k.length !== 32) throw new Error("CHAT_TOKEN_SECRET must be 32 bytes, base64-encoded");
  return k;
}

function mac(storeId: string, conversationId: string): string {
  return createHmac("sha256", secret()).update(`v1|${storeId}|${conversationId}`).digest("base64url");
}

export function mintToken(storeId: string): { conversationId: string; token: string } {
  const conversationId = randomUUID();
  return { conversationId, token: `${conversationId}.${mac(storeId, conversationId)}` };
}

/** The token of an existing conversation. It is a MAC of (store, id), so it can be re-derived: a signed-in customer's list hands these out. */
export function tokenFor(storeId: string, conversationId: string): string {
  return `${conversationId}.${mac(storeId, conversationId)}`;
}

/** Returns the conversation id, or null for a bad format, the wrong store, or a tampered MAC. */
export function verifyToken(storeId: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [conversationId, given] = parts;
  if (!UUID.test(conversationId)) return null;
  // Compare the base64url text, not decoded bytes: decoding ignores a last character's spare bits.
  const a = Buffer.from(given);
  const b = Buffer.from(mac(storeId, conversationId));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return conversationId;
}

/** sha256 hex of the token; this is what conversations.token_hash stores, never the token itself. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
