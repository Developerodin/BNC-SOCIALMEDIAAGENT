import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ID = "k1";

function key(): Buffer {
  const k = Buffer.from(process.env.TOKEN_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** AES-256-GCM; storeId is bound as AAD so a ciphertext can't be replayed under another store. */
export function encrypt(plain: string, storeId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(storeId));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [KEY_ID, iv, c.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(":");
}

export function decrypt(enc: string, storeId: string): string {
  const [kid, iv, tag, ct] = enc.split(":");
  if (kid !== KEY_ID || !iv || !tag || ct === undefined) throw new Error("Unrecognised ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(storeId));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export const CURRENT_KEY_ID = KEY_ID;
