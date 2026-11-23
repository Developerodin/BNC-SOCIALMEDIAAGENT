import { expect, test } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

test("encrypt then decrypt round-trips", () => {
  const enc = encrypt("shpat_secret", "store-1");
  expect(enc.startsWith("k1:")).toBe(true);
  expect(decrypt(enc, "store-1")).toBe("shpat_secret");
});

test("decrypting with another storeId throws", () => {
  expect(() => decrypt(encrypt("x", "store-1"), "store-2")).toThrow();
});

test("decrypting tampered ciphertext throws", () => {
  const [k, iv, tag, ct] = encrypt("shpat_secret", "store-1").split(":");
  const flipped = Buffer.from(ct, "base64");
  flipped[0] ^= 1;
  expect(() => decrypt([k, iv, tag, flipped.toString("base64")].join(":"), "store-1")).toThrow();
});
