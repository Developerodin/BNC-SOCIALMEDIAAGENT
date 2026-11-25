import { randomBytes } from "node:crypto";
import { sha256Hex } from "@/lib/partner/secrets";

// The merchant's mobile app key (docs/mobile-api.md): lets the store's own native app call the storefront chat routes,
// which otherwise only accept the store's website Origin. It ships inside the app, so it is not a secret in practice:
// it names the store and turns on the rate limits in cors.ts, and the merchant can replace or revoke it.

export const MOBILE_KEY_HEADER = "x-askcart-app-key";
const MOBILE_KEY_PREFIX = "ackm_";

/** A new key (`ackm_` + 43 base64url chars). Store only `hash`; `prefix` (first 12 chars) is safe to show and log. */
export function newMobileKey(): { key: string; hash: string; prefix: string } {
  const key = MOBILE_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, hash: sha256Hex(key), prefix: key.slice(0, 12) };
}
