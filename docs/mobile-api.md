# AskCart mobile chat API

The store's own mobile app can use the same AI shopping assistant as the store's website: same answers, same
products, same settings. These are the same endpoints the website chat widget uses, opened to native apps with a
per-store **mobile app key**.

## Before you start

- **Base URL:** `https://<askcart-host>`. The app's public address. It changes until AskCart is hosted (for now it's
  the `shopify app dev` tunnel), so keep it in config, not in code.
- **Shop:** the store's permanent domain, e.g. `my-store.myshopify.com`. Every request names it with `shop`.
- **Mobile app key:** the merchant creates it in Shopify admin → Apps → AskCart → **Mobile app key** → Create key.
  It is shown once and looks like `ackm_` + 43 characters.

## Authentication

Send the key on every request:

```
X-AskCart-App-Key: ackm_…
```

- **Don't send an `Origin` header.** A request with an `Origin` is treated as a website request and the key is
  ignored. Native HTTP clients (URLSession, OkHttp, Dart `http`) don't send one. A WebView does, so call the API
  from native code, not from JavaScript inside a WebView.
- The key ships inside the app, so treat it as an identifier, not a secret. Its protection is the rate limits below
  and the merchant's **Replace key** / **Revoke key** buttons. Replace or revoke stops the old key **at once**, so
  ship the new key in an app update (or load it from your own config server) before replacing.

## Conversations

A conversation is identified by a **conversation token** the server hands out. Send no token to start a new
conversation; the first stream event (`meta`) gives you the token. Store it on the device and send it with every
later request in the conversation. Never put it in a URL.

## Endpoints

| Method and path | What it does |
|---|---|
| `POST /api/chat/session` | Sign a customer in: trade their Shopify `customerAccessToken` for an AskCart session |
| `GET /api/chat/conversations?shop=…` | A signed-in customer's conversations (needs a session) |
| `POST /api/chat` | Send a message, get the answer as a stream |
| `GET /api/chat/history?shop=…` | The conversation's earlier messages |
| `POST /api/chat/feedback?shop=…` | Thumbs up / down on an answer |
| `POST /api/chat/cart-event?shop=…` | Tell AskCart a product from the chat was added to the cart (for the merchant's stats) |
| `DELETE /api/chat/conversation?shop=…` | Clear chat (deletes the conversation) |
| `GET /api/faq?shop=…&product=<id>` | A product's FAQ |

### Signed-in customers

By default every chat is anonymous: it lives behind its conversation token on that device. A customer who is signed in
to the store's **legacy Shopify customer accounts** can keep one history across the website and the app. This needs
the merchant to have approved the `unauthenticated_read_customers` scope (they re-approve when the app update asks).

**`POST /api/chat/session`**: body `{ "shop": "my-store.myshopify.com", "customerAccessToken": "…" }` (the token from the
Storefront API `customerAccessTokenCreate`). AskCart checks it with Shopify and answers
`{ "sessionToken": "…", "expiresAt": 1795525521538 }` (epoch ms, valid 1 hour). Mobile app key only; a request with an
`Origin` gets 403. `401 invalid_customer`: the token is wrong, expired or has no customer, so sign the customer in again.
`503 session_unavailable` (with `Retry-After`): Shopify or the store's setup can't verify right now, retry later.
AskCart never stores or logs the `customerAccessToken`.

Send the session on later requests as the header `X-AskCart-Customer: <sessionToken>` on `POST /api/chat`,
`GET /api/chat/history`, `DELETE /api/chat/conversation`, `POST /api/chat/feedback`, `POST /api/chat/cart-event` and
`GET /api/chat/conversations`. With it, a new conversation
belongs to that customer. Rules:

- A conversation owned by a customer needs that customer's session on **every** call that touches it (chat, history, delete,
  feedback, cart-event); its token alone is not enough. No or expired session: `401 invalid_session`, sign in again and retry.
  Another customer's session: `404 conversation_not_found` (`404 message_not_found` for feedback).
- Anonymous conversations are unchanged: the token alone works, with or without a session, and a session used on one does
  not make it the customer's (guest chats are not adopted when the customer signs in).
- `401 invalid_session` (on any of those endpoints): the session expired or is invalid. Call `POST /api/chat/session` again
  and retry. A stream already running when the session expires finishes normally.
- A session can't be recalled once issued. If a customer is redacted (deleted) in Shopify, their conversations are
  removed, but a session already issued for them still verifies until it expires (at most 1 hour); it can only create new
  conversations, since the old ones are gone.
- Omit the header for a guest. Never send a customer id yourself: only the session counts.

**`GET /api/chat/conversations?shop=…&limit=20&cursor=…`**: needs the session header. Answers

```json
{
  "conversations": [
    { "id": "…", "title": "Do you have waterproof jackets under $100?", "createdAt": "2026-11-24T10:00:00.000Z", "conversationToken": "…" }
  ],
  "nextCursor": "…"
}
```

Latest first. `title` is the first message cut to 80 characters (`null` if empty). Open one by sending its
`conversationToken` to `/api/chat/history` and `/api/chat` as usual. `limit` is 1-50; pass `nextCursor` as `cursor` for the
next page (`null` = last page).

### `POST /api/chat`

Request body (JSON, `Content-Type: application/json`):

```json
{
  "shop": "my-store.myshopify.com",
  "message": "Do you have waterproof jackets under $100?",
  "conversationToken": "…",
  "requestId": "6f1c2a1e-4b8e-4a51-9a5c-2b9e8f0c7d11",
  "productId": "1234567890",
  "country": "US"
}
```

- `message` (required): at most 2,000 characters (`413 message_too_long`).
- `conversationToken`: omit to start a new conversation.
- `requestId`: a new lowercase UUID per message. If you retry the same message after a dropped connection, send the
  **same** `requestId`: you get the saved answer back instead of a second answer.
- `productId` (optional): the numeric id of the product the shopper is looking at, so "is this waterproof?" works.
- `country` (optional): ISO country code, for prices and availability in the shopper's market.

The answer is a **Server-Sent Events** stream (`Content-Type: text/event-stream`). Each event is

```
event: <name>
data: <one line of JSON>

```

Lines starting with `:` are keep-alive pings every 15 seconds; ignore them.

| Event | Data | What to do |
|---|---|---|
| `meta` | `{ "conversationToken": "…" }` | Always first. Save the token. |
| `text` | `{ "delta": "…" }` | Append to the answer bubble. |
| `product` | a **Card** (below) | Show a product card. |
| `error` | `{ "message": "…", "conversationToken": "…" }` | The answer failed; show `message` (it's written for shoppers). |
| `done` | `{ "conversationToken": "…", "messageId": "…" }` | The answer is complete. Keep `messageId` for thumbs. |

If the stream ends without `done` or `error` (connection dropped), retry with the same `requestId`.

**Card:**

```json
{
  "id": "gid://shopify/Product/1234567890",
  "title": "Rain Jacket",
  "imageUrl": "https://cdn.shopify.com/…",
  "url": "https://my-store.com/products/rain-jacket",
  "currency": "USD",
  "available": true,
  "action": "add",
  "stock": { "kind": "count", "n": 3 },
  "price": "89.00",
  "compareAtPrice": "120.00",
  "variants": [
    {
      "id": "44556677889900",
      "title": "M / Blue",
      "options": [{ "name": "Size", "value": "M" }, { "name": "Color", "value": "Blue" }],
      "available": true,
      "stock": { "kind": "in_stock" },
      "price": "89.00",
      "compareAtPrice": null
    }
  ],
  "moreVariants": false
}
```

- `action`: `add` = can go straight to the cart; `view_options` = open the product (e.g. needs a subscription
  choice); `none` = not buyable now.
- `stock.kind`: `count` (only a few left, `n` of them), `in_stock`, or `sold_out`.
- Prices are decimal strings in `currency`.

### Adding to the cart

AskCart doesn't hold the cart; your app does. Use the variant's numeric `id` with your existing cart. With Shopify's
Storefront API (`cartCreate` / `cartLinesAdd`) the merchandise id is `gid://shopify/ProductVariant/<variant id>`.
Then report it, so the merchant sees chat-driven sales:

`POST /api/chat/cart-event?shop=…` with header `X-Conversation-Token` and body

```json
{ "eventId": "<new UUID>", "messageId": "<the answer's messageId>", "productId": "gid://shopify/Product/1234567890", "variantId": "44556677889900", "quantity": 1 }
```

`quantity` is 1–99. Answers `204`.

### `GET /api/chat/history?shop=…`

Header `X-Conversation-Token`. Answers `{ "messages": [ … ] }`: the most recent messages, oldest first. Each message:
`{ "id", "role": "user" | "assistant", "content", "status": "ok" | "cut_off", "cards": [Card], "rating": 1 | -1 | null }`.
Cards are as saved when the answer was given, so prices may be stale: re-check before checkout.

### `POST /api/chat/feedback?shop=…`

Header `X-Conversation-Token`, body `{ "messageId": "…", "rating": 1 }` (`1`, `-1`, or `null` to clear). Answers `204`.

### `DELETE /api/chat/conversation?shop=…`

Header `X-Conversation-Token`. Answers `204`; then forget the token. `409 turn_in_progress` while an answer is
still streaming.

### `GET /api/faq?shop=…&product=<id>`

`product` is the numeric id or the Product GID. Answers `{ "items": [{ "question", "answer" }] }`.

## Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ "error": "empty_message" \| "invalid_body" \| "invalid_request_id" \| "invalid_cursor" }` | Fix the request (`invalid_cursor`: the `cursor` on `/api/chat/conversations` isn't a valid cursor; an unknown one just returns an empty page). |
| 401 | `{ "error": "invalid_token" }` | The conversation token is missing, wrong or expired: drop it and start a new conversation. |
| 401 | `{ "error": "invalid_session" \| "invalid_customer" }` | The customer session / customer token is bad or expired: sign in again (see Signed-in customers). |
| 403 | no body | Wrong, replaced or revoked app key, or an `Origin` header was sent. |
| 404 | `{ "error": "unknown_shop" \| "conversation_not_found" \| "message_not_found" }` | The store isn't using AskCart, or the conversation is gone. |
| 503 | `{ "error": "session_unavailable" }` | Customer sign-in can't be verified right now. |
| 409 | `{ "error": "turn_in_progress" }` | An answer is still streaming in this conversation; wait for it. |
| 413 | `{ "error": "message_too_long" \| "body_too_large" }` | Shorten it. |
| 429 | `{ "error": "rate_limited" }` + `Retry-After: <seconds>` | Too many requests; wait that long. |

## Rate limits (per minute, all endpoints together)

- **30 requests per device IP.**
- **600 requests for the whole store** across all app users.

A normal chat message costs one request, plus one for history when the chat screen opens. Contact us if a busy store
needs more.

Be realistic about what these are: the app key ships inside the app, so the limits stop honest apps from misbehaving, not
a determined abuser (who can rotate IPs, and counters are per server process). The protection against someone running up
the store's AI bill is separate and server-side: per-IP and per-store spend limits on the chat itself.

## Quick test

```bash
curl -N https://<askcart-host>/api/chat \
  -H "X-AskCart-App-Key: ackm_…" \
  -H "Content-Type: application/json" \
  -d '{"shop":"my-store.myshopify.com","message":"What do you sell?","requestId":"'"$(uuidgen | tr A-Z a-z)"'"}'
```
