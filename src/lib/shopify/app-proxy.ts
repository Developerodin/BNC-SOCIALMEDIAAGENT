import { shopify } from "./api";

// Shopify App Proxy (https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies): the storefront
// calls /apps/askcart/..., Shopify forwards it to us with the query string signed by the app secret and, when a customer is
// logged in, `logged_in_customer_id` added by Shopify itself. The signature check is the library's
// shopify.utils.validateHmac(…, { signator: "appProxy" }): HMAC-SHA256 over the params, constant-time compare, and a 90 s
// timestamp window.
//
// Duplicates: the signature covers repeated keys (joined with ","), but a route that reads one value with get() would read
// the first. A shopper can append `?logged_in_customer_id=<victim>` and Shopify then adds its own copy, so the signature still
// verifies over both. The library rejects repeats of shop / timestamp / signature; we also refuse a repeated
// logged_in_customer_id, so the value the route reads is the one Shopify signed and nothing else.
//
// Replay: a signed URL is valid until the timestamp window passes; inside it, someone who captured the URL could reuse it.
// That needs access to a TLS request, and all it yields is the session for the customer who made it, so there is no nonce store.

// The library sorts keys with localeCompare, Shopify with byte order: extra mixed-case query params could fail closed. Acceptable; our session call adds none.
const SINGLE_VALUE = ["shop", "timestamp", "signature", "logged_in_customer_id"];

/** True when the request is a genuine, fresh App Proxy request with no repeated identity params. */
export async function verifyProxy(params: URLSearchParams): Promise<boolean> {
  if (SINGLE_VALUE.some((k) => params.getAll(k).length > 1)) return false;
  try {
    return await shopify.utils.validateHmac(params, { signator: "appProxy" });
  } catch {
    return false; // missing or stale timestamp, missing signature
  }
}
