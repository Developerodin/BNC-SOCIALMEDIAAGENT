# AskCart partner API (Social Media Agent)

## 1. Overview

A partner portal (today only the Social Media Agent, C36) gets read-only access to the catalogue, sales and shop details
of every Shopify store whose staff connect it. AskCart holds and refreshes the Shopify tokens itself; you never receive
one. Everything is read live from Shopify on each request, and nothing is stored on AskCart's side (D73). No customer
data (names, emails, phone numbers, addresses) is ever returned.

How it works:

- A merchant connects their store from inside your portal. Their browser goes to AskCart, AskCart is installed if
  needed, and a member of that store's staff approves the connection **inside Shopify admin**.
- You get a one-time code and swap it, server to server, for an AskCart access token for **that one store**.
- You call the read endpoints with `Authorization: Bearer <access_token>`. The store always comes from the token, never
  from the request: there is no shop parameter, and any `?shop=` or shop header you send is ignored.

URLs (`<ASKCART_HOST>` is AskCart's public host):

| What | URL |
|---|---|
| Connect (browser) | `https://<ASKCART_HOST>/partner/connect` |
| Token exchange and revoke (server) | `https://<ASKCART_HOST>/api/partner/token` |
| Read endpoints (server) | `https://<ASKCART_HOST>/api/partner/{orders,products,shop}` |

Everything under `/api/partner` is server to server only: there is no CORS, and every response carries
`Cache-Control: no-store`. The flow follows OAuth 2.0 (RFC 6749) with PKCE (RFC 7636), so a standard OAuth client
library works; the differences are called out below.

## 2. Register your portal

Portals are registered by AskCart with an internal script (C36); there is no self-serve sign-up. Send AskCart:

- the **name** merchants will see on the consent screen,
- every **redirect URI** you will use, as exact strings. They must be `https:` and have no `#fragment`
  (`http://localhost…` is accepted only on non-production AskCart instances). Matching is an exact string comparison:
  no prefix, wildcard, trailing-slash, case or query-string tolerance. `https://portal.example/cb` and
  `https://portal.example/cb/` are different URIs,
- the **scopes** you need (section 7). By default a client may request every grantable scope.

You get back:

- a `client_id`: `pc_` followed by 16 base64url characters (public; it goes in the connect URL),
- a `client_secret`: `pcs_` followed by 43 base64url characters. **It is shown once.** AskCart stores only its
  sha256 hash and cannot show it again. Keep it server side only.

**Rotating the secret.** Ask AskCart to rotate it. The new secret replaces the old one immediately (there is no overlap
period), so deploy the new value straight away. Tokens already issued stay valid; a rotation does not disconnect any
store. Redirect URIs can be replaced the same way, and a client can be disabled, which stops new connects and new token
exchanges.

## 3. Connect a store

```
Merchant's browser             Your portal                AskCart                        Shopify admin
       |  clicks "Connect", types x.myshopify.com |                                              |
       |--------------------------->|                                                           |
       |                            | makes state + PKCE verifier, saves both in this           |
       |                            | user's portal session                                      |
       |<-- 302 to AskCart /partner/connect?client_id&redirect_uri&shop&state&code_challenge... -|
       |------------------------------------------------------------>|                           |
       |                            |                  AskCart installed on the shop?            |
       |                            |                  no  -> 302 to Shopify's install page (3c) |
       |                            |                  yes -> 302 to the consent page in admin   |
       |------------------------------------------------------------------------------------------>|
       |                            |                  staff member logged into x reviews and    |
       |                            |                  clicks Allow (or Cancel)                  |
       |<-- top window goes to redirect_uri?code=...&state=...&shop=x.myshopify.com ---------------|
       |--------------------------->|                                                           |
       |                            | checks state against this session, then                   |
       |                            | POST /api/partner/token {code, client creds, verifier}    |
       |                            |------------------------------->|                           |
       |                            |<-- { access_token, shop, scopes } ------------------------|
       |                            | checks shop.domain == x.myshopify.com, stores the token   |
```

Send the merchant's browser (top level, not in an iframe) to:

```
GET https://<ASKCART_HOST>/partner/connect
  ?client_id=pc_...
  &redirect_uri=<one of your registered URIs, URL-encoded>
  &shop=<store>.myshopify.com
  &state=<opaque, see 3b>
  &code_challenge=<43 base64url chars, see 3a>
  &code_challenge_method=S256
  &scope=read:orders%20read:products%20read:shop     (optional)
```

| Param | Required | Rule |
|---|---|---|
| `client_id` | yes | your registered, non-disabled client |
| `redirect_uri` | yes | an exact match of one of your registered URIs |
| `shop` | yes | the store's `*.myshopify.com` domain (lowercased by AskCart; must match `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`). Not a custom domain |
| `state` | yes | 1 to 512 printable ASCII characters (0x20 to 0x7E) |
| `code_challenge` | yes | `base64url(sha256(code_verifier))`, exactly 43 characters, no padding |
| `code_challenge_method` | yes | `S256`. `plain` is refused |
| `scope` | no | space-separated (send spaces as `%20`), each one of your client's allowed scopes. Omitted: every scope your client is allowed. Unknown, reserved or not-allowed names are refused, never silently dropped |

A connect request stays open for **10 minutes**. If nobody approves it in that time, nothing comes back to your
`redirect_uri`; time out your own pending state too.

Who can approve (C30): any staff member of that store (collaborators and agencies included) who can open AskCart in
Shopify admin **and** has the Shopify permission behind every requested scope (`read_orders` for `read:orders`,
`read_products` for `read:products`). Someone without, say, order access sees a permission message in Shopify admin and
cannot approve; your `redirect_uri` is not called. A staff member can only share data they can already see.

### 3a. PKCE (required)

PKCE S256 is mandatory, even though your portal also has a client secret: it stops a code that leaks from your side
(browser history, a log, a referrer) from being redeemed.

For each connect, make a fresh `code_verifier` of 43 to 128 characters from `[A-Za-z0-9-._~]`, keep it in the user's
portal session, and send its S256 challenge:

```js
import { randomBytes, createHash } from "node:crypto";

const codeVerifier = randomBytes(32).toString("base64url"); // 43 chars
const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url"); // 43 chars
const state = randomBytes(32).toString("base64url");
// save { state, codeVerifier, shop } in this user's portal session, then redirect to /partner/connect
```

Test vector (RFC 7636 Appendix B): verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gives challenge
`E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.

### 3b. `state` (required, and bound to the user's session)

AskCart stores `state` as given and returns it unchanged, byte for byte, on every redirect to your `redirect_uri`
(success and error).

**Your portal must bind `state` to the portal user's own session** and check it on the callback:

- Generate it per connect (at least 128 random bits) and store it, with the PKCE verifier and the shop the user typed,
  in that user's portal session.
- On the callback, accept the code only if `state` equals the one stored in **this browser's** session. Look the
  verifier up through the session, not through `state` alone.
- **Never complete a connect whose `state` you didn't issue to this browser.** Otherwise an attacker can start a
  connect for their own portal account, trick a merchant into approving it, and attach the merchant's store to the
  attacker's account.
- Use each `state` once, and discard it after the callback or after about 10 minutes.

Also check that the callback's `shop` equals the shop the user typed (and check `shop.domain` again after the exchange,
section 4).

### 3c. First install (AskCart not yet installed on the store)

If AskCart isn't installed on the shop (or was uninstalled), `/partner/connect` sends the merchant to Shopify's install
page for AskCart instead of the consent page. The merchant approves AskCart's own Shopify permissions and lands on
AskCart's home page in Shopify admin. **The connect does not resume by itself** (C34): nothing comes back to your
`redirect_uri`.

Tell the merchant before you redirect, and again when they return: *"Finish installing AskCart in Shopify, then click
Connect again."* The second click starts a new connect (new `state` and verifier) and goes straight to the consent
page.

### 3d. Callback and error redirects

On **Allow**, the merchant's top window is sent to:

```
<redirect_uri>?code=<one-time code>&state=<your state>&shop=<store>.myshopify.com
```

The `code` is 43 base64url characters, can be exchanged **once**, and expires **5 minutes** after Allow.

Errors that are redirected to your `redirect_uri` carry `error` (an RFC 6749 code) and, when your `state` was valid,
`state`:

| `error` | `error_description` | When |
|---|---|---|
| `access_denied` | (none) | The staff member clicked Cancel. `shop` is included |
| `invalid_request` | `invalid_shop` | `shop` missing or not a `*.myshopify.com` domain |
| `invalid_request` | `invalid_state` | `state` missing, empty, over 512 characters or not printable ASCII (no `state` is returned) |
| `invalid_request` | `invalid_code_challenge` | `code_challenge` missing or not 43 base64url characters |
| `invalid_request` | `unsupported_code_challenge_method` | `code_challenge_method` missing or not `S256` |
| `invalid_scope` | `invalid_scope` | `scope` names an unknown, reserved or not-allowed scope, or the result is empty |

An unknown or disabled `client_id`, or a `redirect_uri` that isn't an exact registered match, **never redirects**:
AskCart shows a `400` error page on its own domain ("This connect link is not valid"). That's deliberate, so the
connect URL can't be used as an open redirect. If you see it, check your client id and redirect URI strings.

A connect that expires or is refused for staff permissions (section 3) shows its message in Shopify admin and doesn't
redirect to you.

## 4. Exchange the code

Server to server, within 5 minutes of the callback:

```
POST https://<ASKCART_HOST>/api/partner/token
Content-Type: application/json
```

```json
{
  "grant_type": "authorization_code",
  "code": "<code from the callback>",
  "client_id": "pc_...",
  "client_secret": "pcs_...",
  "redirect_uri": "https://portal.example/askcart/callback",
  "code_verifier": "<the verifier saved for this state>"
}
```

- JSON only, body at most 4 kB. Client credentials go in the body (HTTP Basic auth is not read).
- `grant_type` is optional and, when present, must be `authorization_code`.
- `redirect_uri` must be byte for byte the one used on `/partner/connect`.

`200`:

```json
{
  "access_token": "ack_...",
  "token_type": "Bearer",
  "shop": { "domain": "x.myshopify.com", "name": "B&C", "currencyCode": "INR" },
  "scopes": ["read:orders", "read:products", "read:shop"]
}
```

- `access_token` is `ack_` followed by 43 base64url characters (47 in total). It has **no expiry**: it is valid until
  the connection is revoked (C32, section 6). There is no `expires_in` and no `refresh_token`.
- `scopes` is the granted set, always in this order.
- **Required check: `shop.domain` must equal the shop the user typed** (the one saved with the `state`). If it
  doesn't, don't store the token: revoke it with `DELETE /api/partner/token` (section 6) and show an error. `shop.domain`
  is always the store the token is bound to.

**Reconnecting the same store** (C33): a new connect of a store that is already connected to your client replaces the
old connection. The old access token stops working (`401`) as soon as the new code is exchanged, so overwrite the
stored token for that store.

**Don't retry a token call blindly.** A code works once. If you resend it (for example after a network timeout on the
first call), you get `invalid_grant` **and the token issued by the first call is revoked**, because a reused code is
treated as theft (RFC 6749 §4.1.2). Recover by starting a new connect.

Errors (RFC 6749 §5.2), body `{ "error": "<code>" }`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Not JSON, wrong content type, body too large, or a required field missing |
| 401 | `invalid_client` | Unknown or disabled `client_id`, or wrong `client_secret`. Sent with `WWW-Authenticate: Basic` |
| 400 | `invalid_grant` | Code unknown, expired, already used, issued to another client or `redirect_uri`, PKCE verifier wrong, or the store has since uninstalled AskCart |
| 400 | `unsupported_grant_type` | `grant_type` is something other than `authorization_code` (including `refresh_token`, which isn't offered) |
| 429 | `rate_limited` | Over 60 token calls a minute for your client; see `Retry-After` |

## 5. Use the token

Send it on every read:

```
Authorization: Bearer ack_...
```

Each endpoint needs one scope (section 7). Auth outcomes, checked in this order:

| Situation | Response | What to do |
|---|---|---|
| No or malformed Bearer, unknown token, connection revoked (by you, by uninstall, by a reconnect or by the merchant), or AskCart no longer installed on the store | `401 { "error": "invalid_token" }` with `WWW-Authenticate: Bearer error="invalid_token"` | Drop the token and show the merchant "Reconnect your store" |
| The token lacks the endpoint's scope | `403 { "error": "insufficient_scope", "scope": "read:orders" }` | Connect again asking for that scope (an existing token never gains scopes) |
| Over 60 requests a minute for this token | `429 { "error": "rate_limited" }` with `Retry-After` (seconds) | Wait, then continue |
| `?shop=` or any shop header | Ignored | The store is always the token's |

Treat any `401` from a read endpoint as "this connection is gone". The query parameters, response bodies and other
errors are in section 9.

## 6. Disconnect

```
DELETE https://<ASKCART_HOST>/api/partner/token
Authorization: Bearer <access token>
```

- **It revokes the whole connection (grant)**, not only the token you send: every token issued from that connect stops
  at once.
- It accepts the access token **even if it has expired**, and also a refresh token (`ackr_…`) should AskCart ever issue
  them. Under today's long-lived model (C32) there is only the access token.
- **It is idempotent:** `204` whether the connection was active, already revoked, or the token is unknown, so a retry
  after a network drop is safe and nothing leaks about which tokens exist.
- `400 { "error": "invalid_request" }` only when there is no Bearer value.
- No client secret is needed: holding the token is proof enough, and revoking can only reduce access.

Revocations you don't trigger (your next read gets `401 invalid_token`):

- **The merchant uninstalls AskCart:** every connection of that store, to every portal, is revoked in the same step,
  and pending connects for the store are cancelled. **Reinstalling does not bring them back**; the merchant must connect
  again from your portal.
- **Shopify's `shop/redact`** (48 hours after an uninstall): AskCart deletes the store's connections and tokens
  outright.
- **A reconnect** of the same store to your client (section 4) revokes the previous connection.
- **A reused code** (section 4) revokes the connection issued from it.
- **The merchant disconnects your portal from AskCart's side** (a "Connected apps" list in AskCart, C35).

Even before an uninstall webhook is processed, a token whose store is no longer active in AskCart gets `401`.

## 7. Scopes

| Scope | Grantable now | Endpoint | Shopify permission the approving staff member must have |
|---|---|---|---|
| `read:shop` | yes | `GET /api/partner/shop` | none (anyone who can open AskCart) |
| `read:products` | yes | `GET /api/partner/products` | `read_products` |
| `read:orders` | yes | `GET /api/partner/orders` | `read_orders` |
| `write:products` | **reserved, refused** (`invalid_scope`) | none yet | decided later (D73) |
| `write:orders` | **reserved, refused** (`invalid_scope`) | none yet | decided later (D73) |
| `read:customers` | **reserved, refused** (`invalid_scope`) | none yet | decided later (D73) |

A token's scopes are fixed when it is issued. When write scopes arrive they will need a fresh consent from the merchant;
existing tokens never gain scopes.

## 8. Limits

| What | Limit | Over the limit |
|---|---|---|
| Read endpoints | 60 requests per minute **per access token** (so each connected store has its own budget) | `429 rate_limited` with `Retry-After` (seconds) |
| `POST /api/partner/token` | 60 requests per minute **per client**, counted after your client is authenticated | `429 rate_limited` with `Retry-After` |
| `/partner/connect`, `DELETE /api/partner/token` | none | |

Counts are kept per AskCart server instance in a fixed one-minute window; treat 60 a minute as the budget to stay under.

## 9. Read endpoints

### Response shape

All list endpoints return:

```json
{ "items": [], "nextCursor": "string or null", "complete": false, "rateLimited": true }
```

- Up to 100 items per response.
- `nextCursor`: pass it back as `?cursor=` **with the same filters** to get the next page. `null` with `complete: true`
  means the read is finished.
- `complete`: true only when this response reached the end of the list without being cut short.
- `rateLimited` (only present when true): Shopify throttled us mid-read. You get the items read so far (status 200) and a
  `Retry-After: 2` header. Wait, then resume from `nextCursor`. If `nextCursor` is `null` here, nothing was read yet:
  retry the same request.
- Money is `{ "amount": "499.00", "currencyCode": "INR" }`, always in the shop's currency.

### GET /orders

Scope `read:orders`. Exactly one mode per request, otherwise `400`.

| Mode | Parameters | Filter and order |
|---|---|---|
| Incremental | `updatedSince` = ISO 8601 date-time with time zone, e.g. `2026-11-01T00:00:00Z` | `updated_at >= updatedSince`, oldest update first |
| Backfill | `createdFrom`, `createdTo` = `YYYY-MM-DD`, both required, inclusive | created in the range (shop's time zone), oldest first |

Plus optional `cursor`. For incremental sync, store the largest `updatedAt` you have seen and use it as the next
`updatedSince` (orders updated exactly at that instant come back again, so de-duplicate by `id`).

Each item:

```json
{
  "id": "gid://shopify/Order/1001", "name": "#1001",
  "processedAt": "2026-11-02T10:00:00Z", "createdAt": "2026-11-02T10:00:00Z", "updatedAt": "2026-11-03T10:00:00Z",
  "cancelledAt": null, "test": false, "taxesIncluded": true, "sourceName": "web",
  "currentSubtotalPriceSet": { "amount": "100.00", "currencyCode": "INR" },
  "currentTotalDiscountsSet": { "amount": "10.00", "currencyCode": "INR" },
  "currentShippingPriceSet": { "amount": "5.00", "currencyCode": "INR" },
  "currentTotalPriceSet": { "amount": "95.00", "currencyCode": "INR" },
  "totalRefundedSet": { "amount": "0.00", "currencyCode": "INR" },
  "currentTaxLines": [{ "title": "GST", "rate": 0.18, "priceSet": { "amount": "14.49", "currencyCode": "INR" } }],
  "shippingLines": [{
    "title": "Standard",
    "originalPriceSet": { "amount": "5.00", "currencyCode": "INR" },
    "discountedPriceSet": { "amount": "5.00", "currencyCode": "INR" },
    "taxLines": []
  }]
}
```

No line items, customer, email, phone or address data is ever returned. At most 5 shipping lines per order.

**Orders older than 60 days.** Shopify only shows orders created in the last 60 days until it approves the
`read_all_orders` scope (pending). Instead of returning a silently short list:

- a backfill whose `createdFrom` is more than 60 days ago returns `403 { "error": "read_all_orders_pending", "visibleSince": "<ISO>" }`;
- an incremental read returns its items plus `"warning": { "code": "read_all_orders_pending", "visibleSince": "<ISO>" }`,
  because orders created before `visibleSince` are left out even if they were updated recently.

Both go away once Shopify approves the scope.

### GET /products

Scope `read:products`. Active products only, live from Shopify (current price and stock). Optional `cursor`. Walk until
`complete: true`; only a walk that ends with `complete: true` saw every active product, so only then is it safe to
archive products you didn't see.

```json
{
  "id": "gid://shopify/Product/1", "title": "Linen shirt", "handle": "linen-shirt",
  "onlineStoreUrl": "https://store.example/products/linen-shirt", "productType": "Shirt",
  "description": "Plain text description.", "status": "ACTIVE", "featuredImageUrl": "https://cdn.shopify.com/...jpg",
  "variants": [{
    "id": "gid://shopify/ProductVariant/11", "sku": "LS-M", "title": "M",
    "price": { "amount": "499.00", "currencyCode": "INR" }, "compareAtPrice": null,
    "inventoryQuantity": 7, "availableForSale": true
  }]
}
```

`onlineStoreUrl` is null when the product isn't on the online store. Every variant of a product is always included.

### GET /shop

Scope `read:shop`.

```json
{ "name": "B&C", "currencyCode": "INR" }
```

### Errors

Errors are `{ "error": "<code>" }`, plus the extra fields shown.

| Status | Code | Meaning |
|---|---|---|
| 400 | `mode_required`, `one_mode_only`, `invalid_updatedSince`, `invalid_createdFrom`, `invalid_createdTo`, `createdFrom_after_createdTo`, `invalid_cursor` | Bad query parameters |
| 401 | `invalid_token` | Missing, unknown or revoked token, or AskCart is no longer installed on the store. Sent with `WWW-Authenticate: Bearer error="invalid_token"`. Reconnect (section 5) |
| 401 | `unauthorized` | Legacy shared secret missing or wrong (section 11) |
| 403 | `insufficient_scope` | The token lacks the endpoint's scope; `scope` names it |
| 403 | `read_all_orders_pending` | See "Orders older than 60 days" |
| 403 | `access_denied` | AskCart itself lacks a Shopify scope for this data |
| 429 | `rate_limited` | Over 60 requests a minute for this token (or the legacy secret); see `Retry-After` |
| 502 | `upstream_error` | Shopify failed; retry later |
| 503 | `store_reconnect_needed`, `shopify_throttled` | Temporarily unavailable; see `Retry-After`. `store_reconnect_needed` means AskCart's own Shopify access lapsed: the merchant opens AskCart once in Shopify admin. Your token stays valid; don't reconnect your portal for this |
| 503 | `store_not_connected` | Legacy shared secret only: the store isn't installed (section 11) |

## 10. Security notes for portals

- **Store tokens and the client secret encrypted at rest**, server side only. Never send them to a browser.
- **Never log** access tokens, the client secret, codes, PKCE verifiers or `state`. The first 12 characters of a token
  (`ack_` plus 8) are safe to log if you need to tell tokens apart.
- **Strip `code` from the URL after the callback**: handle the callback, then redirect the browser to a clean URL. Send
  `Referrer-Policy: no-referrer` on the callback response so the code never leaks in a `Referer` header.
- **Check `state` against this browser's session** (3b) and **`shop.domain` against the shop the user typed** (section
  4) on every connect.
- **Rotate the client secret** at once if it may have leaked (section 2), and revoke any token you think leaked with
  `DELETE /api/partner/token`.
- Tokens are read-only and never carry customer data, but they do expose a store's sales: treat them like passwords.

## 11. Legacy shared secret (until the portal switches)

Before per-store tokens, the portal read one fixed store (B&C) with a shared secret. That still works, unchanged, until
the portal confirms it has switched to tokens for B&C; AskCart then removes it (C31, Task P11).

- Send `Authorization: Bearer <PARTNER_API_SECRET>` on the read endpoints. The store is fixed on AskCart's side
  (`PARTNER_STORE_DOMAIN`); there is no shop parameter.
- AskCart tells the two apart by format: a Bearer value starting with `ack_` is a token, anything else is checked as the
  legacy secret.
- Legacy responses are as before: `401 unauthorized` for a missing or wrong secret (also when AskCart has switched the
  legacy path off), `503 store_not_connected` when the store isn't installed, and 60 requests a minute per secret.
- The legacy secret can't be used with `/partner/connect`, `/api/partner/token` or scopes. Plan to move B&C onto the
  connect flow like any other store.

## 12. Example: the full flow with curl

Placeholders only: `<ASKCART_HOST>`, `pc_...` and `pcs_...` stand for your real values, which never go in code or logs.

```sh
ASKCART=https://<ASKCART_HOST>
CLIENT_ID=pc_...                          # from registration
CLIENT_SECRET=pcs_...                     # from registration; keep it server side
REDIRECT_URI=https://portal.example/askcart/callback
SHOP=x.myshopify.com                      # what the merchant typed

# 1. PKCE verifier + challenge, and state (keep all three in the user's portal session)
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
VERIFIER=$(openssl rand 32 | b64url)                                     # 43 chars
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | b64url)
STATE=$(openssl rand 32 | b64url)

# 2. Send the merchant's browser here (URL-encode redirect_uri)
echo "$ASKCART/partner/connect?client_id=$CLIENT_ID&redirect_uri=$(jq -rn --arg u "$REDIRECT_URI" '$u|@uri')&shop=$SHOP&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"

# 3. The merchant approves in Shopify admin; your callback receives ?code=...&state=...&shop=...
#    Check state and shop against the session, then exchange the code within 5 minutes:
CODE=<code from the callback>
curl -s -X POST "$ASKCART/api/partner/token" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg code "$CODE" --arg id "$CLIENT_ID" --arg secret "$CLIENT_SECRET" \
        --arg uri "$REDIRECT_URI" --arg v "$VERIFIER" \
        '{grant_type:"authorization_code", code:$code, client_id:$id, client_secret:$secret, redirect_uri:$uri, code_verifier:$v}')"
# -> { "access_token": "ack_...", "token_type": "Bearer", "shop": { "domain": "x.myshopify.com", ... }, "scopes": [...] }
#    Check shop.domain == $SHOP before storing the token.

TOKEN=ack_...

# 4. Read
curl -s -H "Authorization: Bearer $TOKEN" "$ASKCART/api/partner/shop"
curl -s -H "Authorization: Bearer $TOKEN" "$ASKCART/api/partner/products"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$ASKCART/api/partner/orders?createdFrom=2026-10-01&createdTo=2026-10-31"

# next page: same filters plus the cursor
curl -s -H "Authorization: Bearer $TOKEN" \
  "$ASKCART/api/partner/orders?createdFrom=2026-10-01&createdTo=2026-10-31&cursor=<nextCursor>"

# 5. Disconnect (204, also when repeated)
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$ASKCART/api/partner/token"
```
