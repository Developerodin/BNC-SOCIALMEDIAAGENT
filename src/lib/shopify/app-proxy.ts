import { createHmac } from "node:crypto";
import { safeEqualHex } from "@/lib/partner/secrets";

// Shopify App Proxy (https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies): the storefront
// calls /apps/askcart/..., Shopify forwards it to us with the query string signed by the app secret and, when a customer is
// logged in, `logged_in_customer_id` added by Shopify itself (a shopper can't set it: it is covered by the signature).
// The signature is HMAC-SHA256 (hex) over every param except `signature`, as "key=value" (repeated keys joined with ","),
// sorted, concatenated with no separator. @shopify/shopify-api has no helper for this scheme (its validateHmac is the OAuth one).
//
// Replay: a signed URL is valid until MAX_AGE_MS passes; inside it, someone who captured the URL could reuse it. That needs
// access to a TLS request, and all it yields is the session for the customer who made it, so there is no nonce store.

const MAX_AGE_MS = 120_000;
const MAX_FUTURE_MS = 30_000;

export function proxySignature(params: URLSearchParams, secret: string): string {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) {
    if (k === "signature") continue;
    grouped.set(k, [...(grouped.get(k) ?? []), v]);
  }
  const message = [...grouped].map(([k, v]) => `${k}=${v.join(",")}`).sort().join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** True when `signature` matches (constant time) and `timestamp` is fresh. */
export function verifyProxy(params: URLSearchParams, secret: string, now = Date.now()): boolean {
  const given = params.get("signature");
  const ts = params.get("timestamp");
  if (!given || !ts || !/^\d{1,12}$/.test(ts)) return false;
  if (!safeEqualHex(proxySignature(params, secret), given)) return false;
  const age = now - Number(ts) * 1000;
  return age <= MAX_AGE_MS && age >= -MAX_FUTURE_MS;
}
