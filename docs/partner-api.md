# AskCart partner API (Social Media Agent)

Read-only access to one Shopify store's catalogue and sales, served by AskCart (D70, D73). AskCart holds and refreshes the
Shopify token itself; you never receive it. Everything is read live from Shopify on each request and nothing is stored.

Base URL: `https://<ASKCART_HOST>/api/partner`

## Auth

Send the shared secret on every request:

```
Authorization: Bearer <PARTNER_API_SECRET>
```

The store is fixed on AskCart's side (`PARTNER_STORE_DOMAIN`); there is no shop parameter, and any you send is ignored.
Server to server only: there is no CORS, and responses carry `Cache-Control: no-store`.

## Limits

60 requests per minute per secret. Over that you get `429` with `Retry-After` (seconds).

## Response shape

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

## GET /orders

Exactly one mode per request, otherwise `400`.

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

## GET /products

Active products only, live from Shopify (current price and stock). Optional `cursor`. Walk until `complete: true`; only a
walk that ends with `complete: true` saw every active product, so only then is it safe to archive products you didn't see.

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

## GET /shop

```json
{ "name": "B&C", "currencyCode": "INR" }
```

## Errors

Errors are `{ "error": "<code>" }`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `mode_required`, `one_mode_only`, `invalid_updatedSince`, `invalid_createdFrom`, `invalid_createdTo`, `createdFrom_after_createdTo`, `invalid_cursor` | Bad query parameters |
| 401 | `unauthorized` | Missing or wrong secret |
| 403 | `read_all_orders_pending` | See "Orders older than 60 days" |
| 403 | `access_denied` | The app lacks a Shopify scope for this data |
| 404 | `not_found` | The endpoint is switched off |
| 429 | `rate_limited` | Over 60 requests a minute; see `Retry-After` |
| 502 | `upstream_error` | Shopify failed; retry later |
| 503 | `store_not_connected`, `store_reconnect_needed`, `shopify_throttled` | Temporarily unavailable; see `Retry-After`. Reconnect means the merchant must open AskCart in Shopify admin |

## Example

```sh
curl -s -H "Authorization: Bearer $PARTNER_API_SECRET" \
  "https://<ASKCART_HOST>/api/partner/orders?createdFrom=2026-10-01&createdTo=2026-10-31"

# next page: same filters plus the cursor
curl -s -H "Authorization: Bearer $PARTNER_API_SECRET" \
  "https://<ASKCART_HOST>/api/partner/orders?createdFrom=2026-10-01&createdTo=2026-10-31&cursor=<nextCursor>"
```
