# Product: AI Shopping Assistant (Shopify first)

**Shop Assistant**. Design rewritten 2026-11-23 to match the user's decisions D1–D56 (§12). Each design point cites the decision it comes from. Anything the user hasn't decided is listed in §11 as PENDING.

## 1. What and why

A multi-merchant app, similar to Dialog (askdialog.com). A merchant installs it from Shopify, and then:

- their catalog syncs into our app, and they can upload product PDFs,
- a chat widget on their storefront answers shoppers' product questions with OpenAI models, using only that store's data. It recommends products and adds them to the shopper's cart,
- the merchant sees conversations and a report of gaps in their catalog, and maintains a product FAQ.

**Phase 1 only reads from Shopify (D28).** All writes to the store (descriptions, FAQs, specs, tags, discount codes) are designed below and ship in phase 2.

Merchants use the dashboard **inside Shopify admin** or **on our own site** (`app.<domain>`). It's the same backend and the same data.

## 2. Phases (D2, D28)

**Phase 1: read-only core**
1. The merchant installs from Shopify, the catalog syncs automatically, and the bot answers within minutes, with no further setup.
2. Answers are grounded in that store's products, PDFs, and FAQ, and only that store's.
3. Product cards show **live** price, stock, and link at answer time (D25, D37).
4. A shopper adds a product (with the right variant) to their cart from the chat (D30).
5. The merchant uploads PDFs and edits a product FAQ stored in our DB. FAQs are shown on product pages and suggested in chat (D32, D7).
6. The merchant sees conversations and a read-only Suggestions report (D31).
7. The same account works inside Shopify admin and on our site (D12, D13).
8. The bot replies in the shopper's language (D38).

**Phase 2: writes and more (designed in §7.14, built after phase 1)**
- Writes to Shopify through approval modes: descriptions, FAQs, specs, tags, and discount codes (D3–D6, D10, D11).
- Photo search, email/SMS follow-ups, order tracking and customer data (needs Shopify protected-customer-data approval), collections, multi-currency, store translations, team accounts.

**Out of scope:** other platforms (D2). The code keeps Shopify-specific parts in one folder, but there's no platform abstraction.

## 3. Anti-goals

- **Inventing facts**: no invented specs, prices, stock, policies, or discount codes. If the bot doesn't know, it says so.
- **Cross-store leakage** of products, PDFs, FAQs, conversations, or settings (D42).
- **Writing to the store without the merchant's permission** (D3). Phase 1 doesn't write store data at all. In phase 2, every write follows the merchant's chosen mode and is audit-logged (D4).
- **Runaway cost or abuse** by bots or spammers (D40).
- **Breaking or slowing the storefront** (D39).

## 4. Constraints

- **Shopify App Store requirements** (checked 2026-11-23):
  - install starts on Shopify (no "type your store domain"),
  - OAuth runs immediately and the merchant lands in an embedded admin UI,
  - GDPR webhooks are handled,
  - data is deleted on redact,
  - paid plans bill through Shopify,
  - expiring offline tokens are required for new public apps.
- **Public distribution**, unlisted during beta (D14). The distribution choice can't be changed later, and custom distribution can't use Shopify billing.
- Built for Shopify rules 3.1.2 and 3.1.3: core workflows must work inside admin, with no extra sign-up. Logging in on our own site is an **optional add-on** that never blocks install or first use.
- OpenAI is the LLM provider.
- Small team: one deployable and one database on one AWS EC2 server (D17, D20).

## 5. Approach

**B**: our own Next.js app with our own pgvector search, a widget that doesn't depend on Shopify, and our own login. The dashboard runs both embedded in Shopify admin and standalone. (User decision, 2026-11-23.)

The alternative was Shopify's app template with OpenAI file search, embedded only. It needs the least code, but it's tied to Shopify and OpenAI's index, with no dashboard on our own site.

## 6. Shape

```
                 ┌──── AWS EC2: Node (Next.js) under PM2 ── D17 ─────────────────┐
Shopify admin ──>│ /app/*  embedded dashboard (Polaris, App Bridge)               │
Our site ───────>│ /dash/* standalone dashboard (shadcn/ui, Better Auth)          │
Storefront ─────>│ /api/chat (SSE)  /api/faq  /api/widget                         │
Shopify ────────>│ /api/webhooks/shopify                                          │
                 │ pg-boss workers (same process): sync, embed, PDFs, scans       │
                 └── PostgreSQL + pgvector (same EC2) ── S3 (PDFs) ── OpenAI ─────┘
Storefront: theme app extension = app embed (chat bubble) + app block (product FAQ)
```

- **One long-running Node process** under PM2, with no containers (D17). It isn't serverless: SSE streams, workers, and pooled DB connections fit better on one host.
- **PostgreSQL + pgvector on the same EC2 server**, self-managed (D20, D20b). Backups run as a **nightly `pg_dump` to S3**, kept 14 days, with a monthly restore test (D45). **Caddy** sits in front of Node for automatic HTTPS (D46).
- **pg-boss** queue stored in Postgres (D18).
- **`@shopify/shopify-api`** handles token exchange, session tokens, webhook HMAC, and the GraphQL client (D19). We don't hand-write OAuth.
- Shopify parts: `shopify.app.toml` declares scopes, webhooks, and the theme app extension. There's no app proxy.
- Shopify-specific code lives in `lib/shopify/`. Retrieval, chat, and the widget don't depend on Shopify.

## 7. Design: phase 1

### 7.1 Scopes (D29)

- Phase 1 asks for **`read_products`** and **`read_inventory`**, the second so cards can show exact stock.
- `write_products`, `write_discounts`, `read_orders`, and `read_customers` are added together when phase 2 ships. Merchants re-approve once.

### 7.2 Install, accounts, and login (two doors, one account)

**Door 1: Shopify (required, always first)**
1. The merchant installs from the App Store. Install is **Shopify-managed**, with scopes from the toml.
2. The embedded app gets a session token from App Bridge. The server does a **token exchange with `expiring=1`**, then stores the offline access token and refresh token encrypted (AES-256-GCM, key id prefix, `storeId` as AAD).
3. The first load creates the `Store` and an `Account`. Then:
   - it sets the widget config as an **app-data metafield on the `AppInstallation`** (D39). This metafield belongs to the app, not to the merchant's store data, and needs no write scope,
   - it queues the initial sync.

**Door 2: our site (D12, D13, D22)**
- Login uses **Better Auth** with **email + password** and **Google sign-in**. Users are stored in our Postgres, and email is sent over SMTP (configured by env vars).
- In the embedded dashboard, "Use Shop Assistant outside Shopify" lets the merchant sign up or log in. The store joins that login's account **only after the email is verified**. Google emails count as verified.
- **One account can manage several stores** through a store picker. After a store is linked to an account, it's never moved to another one.
- Every session resolves to `(accountId, storeId)`:
  - embedded: `storeId` comes from the Shopify session token,
  - standalone: the selected store is checked against the stores that account owns.

**Tokens**
- A `shopifyClient(storeId)` helper refreshes the access token when it's near expiry, under a row lock on the `StoreToken` row.
  - Access tokens live about 1 h and refresh tokens 90 days, and every refresh returns a new refresh token.
  - The new pair is saved in the same transaction while the lock is held. Otherwise a second concurrent refresh would use a dead token.
- A daily job refreshes tokens that are close to the 90-day expiry, so quiet stores don't lose access.
- A 401 response marks the store "disconnected", and the dashboard shows "Reopen the app from Shopify admin to reconnect".

**Uninstall (D16)**
- `app/uninstalled` disables the store and widget and deletes the tokens immediately.
- `shop/redact` (about 48 h later) deletes all of the store's data, including its S3 files.

### 7.3 Product sync (D23, D24, D25)

- **Indexed products**: `status = ACTIVE` and `onlineStoreUrl != null`.
- **Full sync uses bulk operations for every store** (`bulkOperationRunQuery`). This covers the initial sync, the scheduled re-check, and manual Resync.
  - We poll for completion as well as listening for `bulk_operations/finish`, because the webhook isn't guaranteed.
  - JSONL rows are stitched by `__parentId`. The result URL expires after 7 days, so it's downloaded immediately.
  - Shopify limits how many bulk operations a store can run at once, so sync jobs for one store run one at a time (pg-boss singleton key per store).
  - Progress is shown on Home.
- **Webhooks** (declared in the toml): `products/create`, `products/update`, `products/delete`, `app/uninstalled`, `shop/update`, `bulk_operations/finish`, plus the three GDPR topics.
  - Handlers verify the HMAC on the raw body, dedupe on `X-Shopify-Webhook-Id`, enqueue a job, and return 200 within Shopify's 5 s timeout.
  - Product jobs are **grouped per product for 60 s** (a singleton key with a delay), so bursts collapse. The job re-reads that one product through GraphQL.
- **Safety-net re-check**: a full bulk re-sync at a **frequency the merchant chooses**: daily, weekly, or off, with **daily** as the default (D24, D47). Only products whose `contentHash` changed are re-embedded.
- **What gets embedded** is the stable text: title, description, type, vendor, tags, options, and metafield specs. Price and stock are **not** embedded. They're fetched live at answer time (§7.6).
- Shopify doesn't guarantee that `products/update` fires on inventory-only or publish changes. The design doesn't depend on it, because of the live check and the re-check.

### 7.4 PDFs (D27)

- The merchant uploads PDFs. The **beta limits are 20 MB per file and 50 files per store**, and limits are set per plan later.
- We check the magic bytes, then store the **original in S3** (a private bucket, with keys prefixed by `storeId`).
- A worker extracts the text with **`unpdf` (`isEvalSupported: false`)** in a child process capped at 30 s, 512 MB, and 500 pages.
- If a page has no text layer, it's **OCR'd with `tesseract.js`** in the same capped worker. OCR is slow and CPU-heavy, so these jobs run one at a time to protect chat latency. *Ceiling:* move OCR to a separate worker instance if PDF volume grows.
- The text is chunked (about 800 tokens with overlap) and embedded.
- The upload page warns: **"Shoppers can see anything in these files. Don't upload private info (costs, wholesale prices)."**

### 7.5 Retrieval (D26, D33)

- Embeddings use **`text-embedding-3-small`**. They start at **512 dimensions stored as `halfvec(512)`**. If answer quality on a real catalog isn't good enough, we move to **1536 dimensions**, which means changing the column and re-embedding.
- Table: `Chunk(storeId, source product|doc|faq, productId?, documentId?, faqId?, content, embedding)`.
- **Exact search below 20k chunks per store.** Above that, an HNSW index with `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8), so the per-store filter doesn't starve results.
- `search(storeId, query, k=8)` in `lib/retrieval.ts` is the only retrieval entry point. On a product page, that product's chunks are always included.

### 7.6 Chat (D34–D38)

**API**
- `POST https://app.<domain>/api/chat` with `{shop, conversationToken?, message, productId?}`.
  - CORS allows only that store's domains: myshopify, plus the domains read at sync time and on `shop/update`. Requests with no `Origin` are rejected.
  - The **server mints the conversation**: a random ID plus an HMAC-signed token bound to `storeId`. A forged token, or one from another store, is rejected.
- Input is capped at **2,000 characters**. History is the **last 20 messages**, and answers are capped at **1,000 tokens** (D35).
- Emails and phone numbers are masked **before** the message is stored or sent to OpenAI (D41).

**Prompt**
- A static system prompt (cache-friendly), which includes:
  - the store name,
  - answer only from the provided store data,
  - say when you don't know,
  - reply in the shopper's language (D38),
  - **never state prices** (D37), but the bot **may mention live stock** such as "only 3 left" (D44),
  - mark products as `[[product:<id>]]`.
- Then the retrieved chunks, the history, the current product, and **live stock for the top results**. This is fetched before the model is called, with one Admin GraphQL call of about 100–300 ms (D44). The card check below reuses it.

**Models: small model, escalating to the large one (D34)**
- Every message goes to the small model first.
- If the small model judges the question complex, its answer must **start with `[[escalate]]`**.
- The server buffers the first few tokens before streaming. If the marker is there, it cancels that call and re-asks the large model with the same prompt. Otherwise it streams the small model's answer.
- Exact model names come from env vars (`OPENAI_MODEL_SMALL`, `OPENAI_MODEL_LARGE`) and are picked by testing at build time.
- Calls use `store: false`.
- *Ceiling:* if the small model escalates too often or too rarely, tune the prompt and log the escalation rate per store.

**Product cards (D36, D37, D25)**
- The model writes `[[product:<id>]]`. The server strips markers from the text stream, and **every ID must be in this turn's search results** (or be the current product). Unknown IDs are dropped.
- Before cards are sent, **one** Admin GraphQL `nodes(ids:)` call per turn fetches all of the turn's products (verified 2026-11-24: 8 products cost 21 points). Fields: product `status publishedAt isGiftCard requiresSellingPlan tracksInventory hasOnlyDefaultVariant onlineStoreUrl featuredMedia options`, and per variant `availableForSale inventoryQuantity inventoryPolicy inventoryItem{tracked} price compareAtPrice selectedOptions`.
- Products are dropped unless `status = ACTIVE` and `publishedAt` is set and not in the future. Don't use `onlineStoreUrl`: it is null on password-protected stores (D71/D72). `availableForSale` alone is not enough, because it is `true` for DRAFT, ARCHIVED and unpublished products (verified).
- Cards show the live price (store's default market) and stock. Sold-out cards follow D72. Stock wording (verified on the dev store):
  - `availableForSale = false` → "Sold out".
  - `tracked` with policy DENY → the count from `inventoryQuantity`, for example "only 3 left".
  - Untracked, or policy CONTINUE → "In stock", never a number. Untracked products report 0 while still being buyable.
  - Never use `totalInventory`.
- Link: `url` from the products table (D71 fallback). Never take a URL written by the model. Render it as `https:` only, through React, with `rel="noopener noreferrer"`.
- Retrieved product text is merchant-controlled. The prompt marks it as data, and the system rules win over it (prompt-injection guard).

**SSE events**: `text {delta}`, `product {id, title, imageUrl, url, price, available, stock, variants[]}`, `error {message}`, `done {conversationToken}`.

**Add to cart (D30)**
- The card has a variant picker (preselected if there's only one variant) and an **Add to cart** button.
- The widget calls the storefront's own `POST /cart/add.js` (same origin, the shopper's own cart) with the **numeric** variant ID, then shows "Added · View cart".
- No admin scope is involved. The event is logged for analytics.

### 7.7 Widget and FAQ on the storefront (D39, D32, D7)

**Chat widget (app embed)**
- The app embed renders a tiny bubble in Liquid. Its config (name, color, welcome text, suggested questions, enabled flag) comes from the app-owned metafield, so a page view makes **no call to our server**.
- The store key is `shop.permanent_domain`. The current `product.id` and selected variant are passed on product pages.
- Clicking the bubble lazy-loads `widget.js` from our domain. It's **vanilla JS in a Shadow DOM**, so the theme's CSS can't break it.
- On product pages, the chat shows that product's FAQ questions as suggested questions (D7).

**FAQ block (app block)**
- The merchant places the app block on the product template. It loads that product's FAQ from `GET /api/faq?shop=…&product=…` (public, cached for 5 min, CORS-limited like chat) and renders it.
- The same script injects **FAQ JSON-LD**.
- Known trade-offs, accepted in D32:
  - if our server is down, the block shows nothing,
  - search engines may not read JSON-LD that's injected by JavaScript.
- In phase 2 the FAQ moves to app metafields and is rendered in Liquid (D7).

**Rendering safety**
- Model text is rendered **as text only** (`textContent`), with no HTML or markdown links from the model.
- Links, images, and buttons come only from server events. Image URLs must be on `cdn.shopify.com`, and the accent color must be a valid hex value.

### 7.8 Suggestions report (D8, D31)

Read-only in phase 1. The merchant can copy text and edit the product in Shopify themselves, or add an FAQ entry in our dashboard.

- **The four sources** (D8):
  1. unanswered questions: the bot said it didn't know,
  2. frequent questions,
  3. an AI catalog audit, which flags missing or unclear info per product,
  4. on-demand "Suggest improvements" for products the merchant selects.
- Each suggestion shows the product, the evidence (the shopper questions behind it), and an AI-drafted improvement such as FAQ text, a description edit, specs, or tags.
- **Scan frequency is chosen by the merchant**: daily, weekly, or off (D8). The default is **weekly** (D50). On-demand scans run any time.
- AI audit calls count toward the global spend cap (§7.9).

### 7.9 Cost and abuse limits (D40, D9)

- **Per store**: the free-beta cap is **1,000 messages per month** (D9). Each shopper message counts as 1, whichever model answers it (D48), and the rate limit is **30 messages per minute**.
- **Per IP**: **20 messages per 10 minutes**. After **10 messages** in a conversation, a **Cloudflare Turnstile** challenge appears.
- **Global**: a **$20/day OpenAI spend cap** (env var), calculated from token usage. When it's hit, chat pauses everywhere with a "back soon" message and we get an alert. A hard budget is also set on the OpenAI project.
- Rate-limit counters live in their own table and are updated with `INSERT … ON CONFLICT`. *Ceiling:* move them to Redis if they get hot.

### 7.10 Privacy and GDPR (D41)

- Conversations are deleted after the **merchant-set retention period: 30 days (default), 90 days, or 365 days**. A daily job deletes them per store.
- Emails and phone numbers are masked before they're stored or sent to OpenAI.
- The widget shows a notice that links to the store's privacy policy.
- `customers/data_request` and `customers/redact`: phase 1 doesn't link conversations to customer identity, so we acknowledge with 200 and log. `shop/redact` deletes everything for the store, including S3 files.
- Logs and error tracking scrub tokens, auth codes, and message bodies.

### 7.11 Tenant isolation (D42)

- **Both layers**:
  - all app queries go through `db.forStore(storeId)`, which adds the store filter,
  - **Postgres row-level security** on every store-owned table checks `storeId = current_setting('app.store_id')`, set per transaction, so a query that skips the wrapper still can't see other stores.
- Dashboard routes get `storeId` only from the session, never from request parameters.
- **One automated test** tries to read store B's product, document, FAQ, conversation, and suggestion with store A's session, and it must fail at both layers.

### 7.12 Dashboard pages (D43, D21)

- Inside Shopify admin the pages are built with **Polaris**. On our site they're built with **shadcn/ui**.
- Both use the same API routes and data. Only the UI layer is written twice.

1. **Home**: sync status, progress, and Resync; products indexed; messages this month against the cap; stats; "Enable widget" (a deep link to the theme editor's app embeds); and "Use outside Shopify".
2. **Knowledge + FAQ**: synced products (read-only); PDF upload, list, status, and delete, with the public-content warning; and the per-product FAQ editor.
3. **Conversations + Suggestions**: chat list and detail, top questions, and the Suggestions report (§7.8) with on-demand "Suggest improvements".
4. **Settings**: widget name, color, welcome text, suggested questions, and on/off; bot tone; chat retention; resync frequency; and suggestion scan frequency.

### 7.13 Data model

```
Account(id)                                  -- Better Auth user/session tables link here
Store(id, accountId, shopDomain unique, name, domains[], active, installedAt, settings jsonb,
      syncStatus, lastSyncAt)
StoreToken(storeId, accessTokenEnc, accessExpiresAt, refreshTokenEnc, refreshExpiresAt, keyId)
Product(storeId, shopifyId, handle, title, url, imageUrl, status, published, contentHash, shopifyUpdatedAt)
Document(storeId, name, s3Key, text, status, sizeBytes, pages, ocrUsed)
Faq(storeId, productId, question, answer, position, updatedAt)
Chunk(storeId, source, productId?, documentId?, faqId?, content, embedding halfvec(512))
Conversation(id, storeId, tokenHash, pageUrl, createdAt)
Message(conversationId, role, content, productIds[], model small|large, tokens, createdAt)
Suggestion(storeId, productId, source, kind, draft jsonb, evidence jsonb, createdAt)
RateCounter(key, windowStart, count)
SpendDay(date, estimatedUsd)
pg-boss tables (queue)
```
Every store-owned table has row-level security (§7.11).

### 7.14 Design: phase 2 (built after phase 1)

These are decided (D3–D11), but they ship only in phase 2. They need the phase 2 scopes (D29).

**Approval modes (D4)**
- Every kind of write has a merchant-set mode, and the default is **approve each**. The kinds are discount codes, descriptions, FAQs, specs, and tags.
- The modes are:
  - (a) **approve each**,
  - (b) **batch**: approve or reject all or some of a prepared list,
  - (c) **automatic**: written within the merchant's rules without asking.
- Before any overwrite, a popup shows the current value and the proposed one: "This product currently has X. Allow overwriting with Y?" (D3).
- **Every write and every allow/deny goes in the audit log**: who, when, product, field, old value, new value, and decision (D3, D4). This needs an `AuditLog` table.
- Conflict rule: each draft stores the product's `updatedAt`. If the product changed since then, the draft is re-checked before writing.
- Loop safety: our own write fires `products/update`, which only re-embeds through the hash. We never write in response to a webhook.

**Content (D3, D6, D7)**
- Descriptions use `productUpdate` (`descriptionHtml`).
- FAQs and specs use `metafieldsSet` in the **app's own namespace** (`$app:faq`, `$app:specs`), never in merchant fields.
- The FAQ app block switches to Liquid rendering from the metafield, with server-rendered JSON-LD. The FAQs from phase 1 are migrated.

**Tags (D5)**: `tagsAdd` and `tagsRemove`. Both go through the approval modes and the audit log. Collections come later under the same rules.

**Discounts (D4b, D10, D11)**
- Only when the shopper asks. Codes apply to the **recommended products only**.
- Merchant settings:
  - max % off (default 10%),
  - expiry (default 48 h),
  - per-shopper limit (default 1 per conversation and per IP per day),
  - daily store cap (default 20),
  - single-use on/off,
  - optional minimum order.
- Automatic mode: the server creates a unique code with `discountCodeBasicCreate`, with `customerGets.items` set to the recommended products, the percentage as a 0–1 decimal, and buyer `context` (not the deprecated `customerSelection`).
- Approve-each and batch modes: the bot hands out codes from a **pre-approved pool**. When approving a pool, the merchant picks the **products or collections its codes cover**. The bot hands out a pool code only if the recommended products are in that set. If the pool is empty, or the products aren't covered, it says no discount is available (D51).
- The model never sees or invents codes. Codes are created only by the server, and the chat marker is `[[discount]]`.

**Other phase 2 features** (D2): photo search, email/SMS follow-ups, order tracking and customer data (`read_orders`, `read_customers`, protected-customer-data approval), collections, multi-currency, store translations, team accounts. Each gets a design pass before it's built.

## 8. Failure modes

| Case | Handling |
|---|---|
| Webhook duplicated or out of order | Dedupe on webhook id. An upsert is ignored if the payload's `updated_at` ≤ the stored value. |
| Webhook missed (stock, publish, anything) | Live product check at answer time, plus the scheduled re-check and the Resync button |
| Stock-only webhook storm (flash sale) | One job per product per 60 s, and the hash is unchanged, so nothing is re-embedded |
| Bulk operation finish webhook never arrives | Polling finds the finished operation |
| Token expired, refresh token expired, or revoked | Refreshed under a row lock. If the refresh token dies, the store is "disconnected" and the merchant reopens the app from admin. |
| OpenAI slow or down | 20 s timeout → "Assistant unavailable right now". The storefront is unaffected. |
| Small model escalates wrongly | The answer is merely slower or weaker. The escalation rate is logged per store for prompt tuning. |
| Daily spend cap hit | Chat pauses everywhere with "back soon", and an alert is sent |
| Embedding call fails | pg-boss retries with backoff, and the old chunks stay in place meanwhile |
| Our server down | Chat and the FAQ block show nothing (accepted in D32). The rest of the storefront is unaffected. |
| EC2 disk or DB loss | Restore from the nightly S3 dump, losing up to 24 h of chats and FAQ edits. Products re-sync from Shopify (D45). This is the main risk of self-hosting (D20). |
| Prompt injection (message, PDF, product text) | Text-only rendering, server-validated product IDs, and every query scoped by store. **Residual risk:** a shopper can make the bot recite any uploaded PDF, which is why the upload warning exists. |
| Malicious or huge PDF | `unpdf` with eval disabled, a capped child process, and OCR jobs run one at a time |

## 8b. Scaling and ceilings (2026-11-23)

**Why it can scale without a rewrite**
1. Storefront page views never reach our server. The bubble config comes from the app metafield (D39). We see traffic only when a shopper opens the chat.
2. The app keeps nothing in memory between requests. All state is in Postgres or S3, so more app instances can run behind a load balancer.
3. Heavy work (sync, embeddings, PDFs, OCR, redact) runs in pg-boss jobs. pg-boss supports several workers on several hosts.

**Ceilings** (estimates, not yet measured; see P60)

| Limit | Roughly when | Upgrade |
|---|---|---|
| $20/day OpenAI spend cap (D40) | About 4k–20k messages/day | Raise the env var as revenue allows. This is deliberately the first limit. |
| CPU contention (OCR and embeddings against chat) | Heavy PDF uploads | Run workers in a separate PM2 process: same code, a `WORKERS_ONLY` flag |
| DB on the app server (D20) | A few hundred active stores, or big catalogs | Move to AWS RDS Postgres + pgvector. Only `DATABASE_URL` changes. |
| Vector search | More than 20k chunks per store | HNSW + iterative scan (§7.5) |
| Rate counters in Postgres | Heavy chat traffic | Redis (§7.9) |
| Single server | From day one | 2+ app instances behind an ALB, which needs the DB on RDS first |
| Self-hosted monitoring on the same box (D61) | Server-wide outage | The external uptime ping alerts. Move Grafana and Prometheus off-box if they compete with the app for resources. |

**Upgrade path:** one EC2 → separate worker process + RDS → 2+ app instances + ALB + Redis → read replicas and partitioning by store.

## 9. Open questions (later)

- Pricing and paid plans, before App Store listing. These use **Shopify App Pricing** (managed pricing).
- First real test store. Until then, use a Shopify development store with sample products.

## 10. Reference docs (verified 2026-11-23)

| Topic | Link |
|---|---|
| App Store requirements | https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements |
| Built for Shopify requirements | https://shopify.dev/docs/apps/launch/built-for-shopify/requirements |
| Managed installation | https://shopify.dev/docs/apps/build/authentication-authorization/app-installation |
| Token exchange and expiring tokens | https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange |
| Distribution (public vs custom) | https://shopify.dev/docs/apps/launch/distribution |
| Privacy / compliance webhooks | https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance |
| Webhook subscriptions (toml) | https://shopify.dev/docs/apps/build/webhooks/subscribe |
| Webhook delivery, HMAC, headers | https://shopify.dev/docs/apps/build/webhooks/subscribe/https |
| Webhook topics | https://shopify.dev/docs/api/webhooks/latest |
| `products` query | https://shopify.dev/docs/api/admin-graphql/latest/queries/products |
| GraphQL pagination (25k cap) | https://shopify.dev/docs/api/usage/pagination-graphql |
| Bulk operations | https://shopify.dev/docs/api/usage/bulk-operations/queries |
| GraphQL rate limits | https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits |
| Metafield ownership (`$app`) | https://shopify.dev/docs/apps/build/custom-data/ownership |
| Liquid `app` object | https://shopify.dev/docs/api/liquid/objects/app |
| Liquid `shop` object | https://shopify.dev/docs/api/liquid/objects/shop |
| `tagsAdd` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd |
| `discountCodeBasicCreate` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountCodeBasicCreate |
| Discount minimum requirement | https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DiscountMinimumRequirementInput |
| Theme app extensions | https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration |
| AJAX Cart API (`/cart/add.js`) | https://shopify.dev/docs/api/ajax/reference/cart |
| Billing / App Pricing | https://shopify.dev/docs/apps/launch/billing |
| Development stores | https://shopify.dev/docs/apps/build/dev-dashboard/development-stores |
| Community: sales-channel change doesn't fire webhook | https://community.shopify.dev/t/changing-sales-channel-does-not-trigger-webhook/27906 |

## 11. Pending decisions

None right now. P41–P48 were decided as D44–D51 (§12). UI/UX decisions (UD1–UD25b) live in `ui-ux.md` §4.

## 12. User decisions log (2026-11-23)

The design above was rewritten to match these. If anything conflicts, these win.

- **D1 (P1) Name**: "Shop Assistant".
- **D2 (P2) Scope**: only **other platforms** is out. Everything else is in, but **built in phases**:
  - Phase 1 = the core: chat, sync, PDFs, the 4 write-backs.
  - Phase 2 = photo search, email/SMS follow-ups, order tracking / customer data (needs Shopify protected-customer-data approval), collections, multi-currency, store translations, team accounts.
  - Phase 2 is designed now and built after phase 1.
- **D3 (P3) Content writes**: the AI may also rewrite **product descriptions**, not only FAQs and specs.
  - **Nothing is ever written without the merchant's explicit permission.**
  - Before any write or overwrite, a popup shows "This product currently has X. Allow overwriting with Y?" with the current and proposed content.
  - Every allow or deny is logged as an audit record: who, when, product, field, old value, new value, and decision.
- **D4 (P4, P10 partial) Write approval modes**: every kind of write has a merchant-set mode, and the default is **approve each**.
  - The kinds are discount codes, descriptions, FAQs, specs, and tags.
  - The modes are:
    - (a) **approve each**,
    - (b) **batch**: the agent prepares a list and the merchant approves or rejects all or some of it,
    - (c) **automatic**: written within the merchant's rules without asking.
  - All modes write an audit-log entry for every write.
  - For discounts in modes (a) and (b), the shopper is told a code is pending, or the bot hands out codes from a pre-approved pool.
- **D5 (P5) Tags**: the app may **add and remove** tags. Removals go through the D4 modes and the audit log. Collections come in phase 2 under the same rules.
- **D6 (P6) Specs**: saved in the **app's own metafield namespace**, never in the merchant's fields.
- **D7 (P7) FAQ display**: **both** an app block on the product page **and** suggested questions in the chat widget. The block also outputs **FAQ JSON-LD**.
- **D8 (P8) Suggestion sources**: all four. These are unanswered questions, frequent questions, an AI catalog audit, and an on-demand "Suggest improvements" for selected products. **Scan frequency is chosen by the merchant**: daily, weekly, or off.
- **D4b Discounts in approve-each and batch modes**: the bot hands out codes from a **pre-approved code pool** that the merchant approved in advance. If the pool is empty, it says no discount is available.
- **D9 (P9) Billing**: a **free beta** with a cap of **1,000 messages per store per month**. Paid plans come later through Shopify App Pricing.
- **D10 (P10) Discount trigger**: **only when the shopper asks**. Codes apply to the **recommended products only**, the ones discussed in the chat.
- **D11 (P11) Discount limits**: all of these are merchant-editable settings:
  - max % off (default 10%),
  - code expiry (default 48 h),
  - per-shopper limit (default 1 per conversation and per IP per day),
  - daily store cap (default 20),
  - single-use on/off,
  - optional minimum order value.
- **D12 (P12) Login on our site**: **email + password** and **Google sign-in**.
- **D13 (P13) Multi-store**: one login can manage several stores through a **store picker**. A store joins an account only after the email is verified.
- **D14 (P14) Distribution**: **public, unlisted** during beta.
- **D15 (P15) Scopes**:
  - phase 1 asks for `read_products`, `write_products`, `write_discounts`, and **`read_inventory`**, so the bot can state exact stock such as "only 3 left",
  - phase 2's `read_orders` and `read_customers` are requested **only when phase 2 ships**, and merchants re-approve once.
- **D16 (P16) Uninstall**: disable the store and delete its tokens immediately. All data is deleted when Shopify's `shop/redact` arrives, about 48 h later.
- **D17 (P17) Hosting**: **AWS EC2**, with plain **Node + PM2** (no containers).
- **D18 (P18) Jobs**: **pg-boss** queue stored in the database.
- **D19 (P19) Shopify library**: **`@shopify/shopify-api`**.
- **D20 (P20) Database location**: **on the EC2 server itself** (self-managed, so we handle backups ourselves). The database engine is set in D20b.
- **D20b Database engine**: **PostgreSQL + pgvector**. The engine doesn't affect sync, which always goes through Shopify's API and webhooks.
- **D21 (P21) UI**: **Polaris** inside Shopify admin, **shadcn/ui** on our own site.
- **D22 (P22) Auth**: **Better Auth** (email+password and Google, users stored in our Postgres). **Email is sent via SMTP**; the provider and credentials are configured by env vars.
- **D23 (P23) Sync**: **bulk operations from day one** for every store. Poll for completion as well as listening for the finish webhook, and stitch JSONL rows by `__parentId`.
- **D24 (P24) Webhook bursts**: **grouped per product, 60 s**. The safety-net full re-check runs at a **frequency the merchant chooses**.
- **D25 (P25) Price and stock**: fetched **live from Shopify** at answer time for the products shown, including exact stock (see D15).
- **D26 (P26) Embeddings**: **OpenAI text-embedding-3-small**. The 512 dimensions, halfvec storage, and exact search below 20k chunks are tuning settings, which were decided in D33 (P26b).
- **D27 (P27) PDFs**:
  - **originals are kept in AWS S3**, and the extracted text is indexed,
  - limits are **per plan**, and the beta limit is **20 MB per file and 50 files per store**,
  - scanned PDFs are read with **tesseract.js** (free, runs in Node on our server).
- **D28 Phase 1 is read-only** (2026-11-23): phase 1 only reads from Shopify. **Every write moves to phase 2**: descriptions, FAQs, specs, tags, and discount codes. D3–D6, D8's apply step, D10, and D11 still stand, but they ship in phase 2. This overrides D2's "4 write-backs in phase 1". The knock-on choices are P37–P40.
- **D29 (P37) Phase 1 scopes**: **read-only**: `read_products` + `read_inventory`. `write_products`, `write_discounts`, `read_orders`, and `read_customers` are requested together when phase 2 ships, with one merchant re-approval. Overrides D15's phase 1 list.
- **D30 (P38) Add to cart from chat**: **phase 1**. It changes the shopper's cart, not store data.
- **D31 (P39) Suggestions in phase 1**: generated and shown as a **read-only report** in the dashboard. One-click apply comes in phase 2.
- **D32 (P40) FAQ in phase 1**: FAQs are **stored in our own DB** and edited or approved in our dashboard. The product-page app block loads them from our server. Known trade-offs: the block depends on our server's uptime, and FAQ JSON-LD injected by JS may not be seen by search engines. In phase 2 they move to metafields per D7.
- **D33 (P26b) Embedding tuning**: **tune after testing**. Start with 512 dimensions stored as halfvec, exact search below 20k chunks, and the top 8 results. If quality on a real catalog isn't good enough, move to the full 1536 dimensions.
- **D34 (P28) Chat model**: a **small, fast model by default, escalating to the large flagship**. The small model decides: it returns a hidden "escalate" signal for complex questions, and that message is re-answered by the large model. Exact model names are chosen by testing at build time. OpenAI `store: false`.
- **D35 (P28) Chat limits**: the **last 20 messages** of history, shopper input up to **2,000 characters**, answers up to **1,000 tokens**.
- **D36 (P29) Product cards**: built from **markers in the answer text** (`[[product:id]]`). Every ID is checked against that turn's search results, and unknown IDs are dropped.
- **D37 (P30) Prices**: shown **on cards only**, using the live price. The answer text never states a price.
- **D38 (P31) Language**: the bot answers **in the shopper's language** and translates on the fly.
- **D39 (P32) Widget**: **vanilla JS in a Shadow DOM**. Only the bubble loads with the page, and the chat script loads on first click. Config is stored in the app metafield, and the store key is `shop.permanent_domain`.
- **D40 (P33) Abuse limits**: 30 messages per minute per store; 20 per 10 minutes per IP; Cloudflare Turnstile after 10 messages in a conversation; a **global daily OpenAI spend cap of $20** (env var). When the cap is hit, chat pauses everywhere with a "back soon" message and an alert is sent.
- **D41 (P34) Shopper privacy**: emails and phone numbers are masked before they're stored and before they're sent to OpenAI, and a notice in the chat links to the store's privacy policy. **Retention is set by the merchant (30, 90, or 365 days), and the default is 30 days.**
- **D42 (P35) Tenant isolation**: **both**. A `db.forStore(storeId)` wrapper is used for every query, Postgres row-level security sits underneath as a safety net, and an automated cross-store leak test runs.
- **D43 (P36) Phase 1 dashboard pages**:
  - **Home**: sync status, message usage, stats,
  - **Knowledge + FAQ**: products (read-only), PDFs, FAQ editor,
  - **Conversations + Suggestions**: chat history and the read-only report,
  - **Settings**: widget, tone, retention, resync frequency.
  - Discounts and approval queues come in phase 2.

- **D44 (P41) Stock in text**: the bot **may mention live stock** in its answer. Stock for the top results is fetched before the model is called.
- **D45 (P42) Backups**: a **nightly `pg_dump` to S3**, kept 14 days, plus a monthly restore test.
- **D46 (P43) HTTPS**: **Caddy** in front of the Node/PM2 process.
- **D47 (P44) Resync frequency**: **daily, weekly, or off**, with **daily** as the default.
- **D48 (P45) Message cap counting**: each shopper message counts as **1**, whichever model answers it.
- **D49 (P46) Tuning items** (prompt wording, chunk sizes, card design, notice text): **Claude drafts them, and the user approves** before the beta.
- **D50 (P47) Suggestion scan default**: **weekly**.
- **D51 (P48) Discount pool (phase 2)**: when approving a pool, the merchant picks the products or collections its codes cover. The bot hands out a pool code only if the recommended products are in that set.
- **D52 (P49) DB library**: **Drizzle ORM**. It has native pgvector `halfvec` types and handles row-level security per transaction. Tokens are stored by us, so the Shopify side doesn't depend on this choice.
- **D53 (P50) Polaris flavour**: **Polaris web components**, loaded from Shopify's CDN after App Bridge (needs React 19).
- **D54 (P51) Local dev DB**: **Docker Desktop**, running the `pgvector/pgvector` image.
- **D55 (P52) Shopify accounts**: the user already has a Partner / Dev Dashboard account and a development store.
- **D56 (P53) Tooling**:
  - TypeScript, Next.js App Router (latest stable), Node 22 LTS and npm,
  - Vitest for tests,
  - a git repo in the project folder,
  - Shopify CLI `shopify app dev` for the dev tunnel and install.
- **D57 (P54) Build method**: **subagent-driven**. Each task is built by a fresh agent and checked by a separate reviewer.
- **D58 (P55) shop/redact**: handled by a **background job (pg-boss) from day one**, so pg-boss is set up in M1.
- **D59 (P56) Account at install**: the first install **creates an `Account` in M1** and links the store to it (matches §7.2).
- **D60 (P57) Production domain**: **decided later**, before M10.
- **D61 (P58, P58b) Monitoring**: **Grafana + Prometheus, self-hosted on the production EC2**, plus a **free external uptime ping** on `/api/health` that alerts when the whole server is down. *Known trade-offs:* Prometheus and Grafana take some CPU and RAM from the app, and they go down with the server, which is why the external ping exists.
- **D62 (P59) Staging**: a **small staging EC2** linked to a **separate "Shop Assistant (staging)" Shopify app** on the dev store. Every release goes to staging first.
- **D63 (P60) Load test**: a **k6 test in M10**, about 50 concurrent chats with OpenAI mocked, plus one short real-OpenAI run to measure cost per message.
- **D64 (P61) Data-loss window**: **24 h (nightly backups) is kept until the beta**, and revisited when the DB moves to RDS (point-in-time recovery).
- **D65 Redact after reinstall**: the `shop-redact` job **deletes only a store that is still uninstalled** (`active = false`). A merchant who reinstalls before the job runs keeps their data.
- **D66 Build-time Shopify env**: `next build` **requires the `SHOPIFY_*` env vars**, and fails without them. `SHOPIFY_API_KEY` is needed at build time anyway, so a missing key fails early.
- **D67 M2 sync details**: choices C1–C6 in `docs/superpowers/plans/2026-11-23-m2-product-sync.md`:
  - keep every product, with flags for which are live,
  - save the stable text on the product row,
  - use text-like metafields, skipping `app--` namespaces,
  - show progress as "items read",
  - sync after every token exchange,
  - `shop/update` updates the name only.
- **D68 M3 retrieval details**: choices C7–C10 in `docs/superpowers/plans/2026-11-23-m3-retrieval.md`:
  - chunk products like PDFs (about 800 tokens, with overlap, and the title repeated in every chunk),
  - only `ACTIVE` and published products get chunks,
  - exact search only in phase 1, with HNSW added above 20k chunks per store,
  - embedding spend tracking waits for M10.
- **D69 Order scopes for the Social Media Agent (2026-11-24)**: the user chose to add `read_orders` and `read_all_orders` to this app's scopes, so the separate Social Media Agent project can read B&C's orders through it. Overrides D29's "read-only products + inventory" phase 1 list. `read_all_orders` needs Shopify's approval (protected-data request form). Still open: that project needs a token that never expires, but this app uses expiring offline tokens (`src/lib/shopify/session.ts`).
- **D70 How the Social Media Agent gets order data (2026-11-24)**: Shopify requires expiring offline tokens (new public apps since 2026-04-01; custom apps created on or after 2026-12-01), so a permanent token is impossible. The user chose option A: AskCart keeps and refreshes the token itself, and the Social Media Agent fetches order data through a small protected AskCart endpoint. That way only one party ever refreshes. Not built yet. It comes after the dev-store live check; the endpoint's auth and data shape are still to be decided.
- **D71 Product links without onlineStoreUrl (2026-11-24)**: password-protected stores (every dev store, and live stores before launch) get no `onlineStoreUrl` from Shopify. The product link is then built as `https://<shop>.myshopify.com/products/<handle>`, which redirects to the store's primary domain. The same live check moved "published" from `onlineStoreUrl` to `publishedAt`.
- **D72 Sold-out products (2026-11-24)**: the user chose to still show sold-out products, with a "Sold out" card and no Add to cart, while the bot also suggests in-stock alternatives. Availability comes from each variant's live `availableForSale`; variants that can't be bought are disabled in the picker. Stock stays out of the search index (§7.6 live check), because inventory-only changes don't reliably fire `products/update`. **Open for M4:** §7.6 still says cards use `onlineStoreUrl` and drop products without it, which would hide every product on a password-protected store. It must use `publishedAt` and the D71 link fallback instead.
- **D73 Order access stays in AskCart (2026-11-24)**: after the security review, the user confirmed keeping `read_orders` and `read_all_orders` for every merchant (D69). Accepted consequences: every install grants access to orders and customer PII; the app falls under Shopify's protected customer data rules (App Store review, data-handling duties, working `customers/data_request` and `customers/redact` handling); and a leaked token exposes customer PII. Requirement for D70: the order endpoint returns the minimum fields, is locked server-side to B&C's store, uses its own secret, and never stores orders or returns the Shopify token.
- **D74 Gift cards only when asked (2026-11-24)**: gift cards are left out of normal product suggestions and shown only when the shopper asks for a gift card or voucher. Plan: sync stores `isGiftCard` on products, and search excludes gift cards unless the caller passes an `includeGiftCards` flag. In M4 the chat model sets that flag when it judges the shopper is asking for a gift card in any language, rather than relying on a keyword list.
- **D75 Subscription-only products (2026-11-24)**: when the live card check finds `requiresSellingPlan = true`, the card shows a "View options" button that opens the product page (the store's own plan picker) instead of Add to cart. Products where a plan is optional keep the normal Add to cart, which buys one-time. Detect plans per variant (`variant.sellingPlanGroups`), not with the product-level count, which misses groups attached to variants (verified on the demo ski wax).
- **D76 Cross-language search (2026-11-24)**: before searching, the shopper's question is translated into the store's primary language (`shop.primaryDomain` locale / `shopLocales` primary), only when it differs. The translation is folded into the M4 query-rewrite step where possible, so it costs no extra round trip. The bot still replies in the shopper's language (D38). Indexing the store's own translations stays a phase 2 option.
- **D77 Market and B2B availability at card time (2026-11-24)**: the M4 live card check also asks whether each product is available in the shopper's country, using the storefront's country (`Shopify.country` / localization passed by the widget) with a contextual Admin field such as `publishedInContext(context: {country})` or contextual pricing. The exact field is verified during M4. Products not available there are dropped. It goes into the same single `nodes(ids:)` call. B2B-only catalogs are treated as not available to anonymous shoppers.
- **D78 Keep all tags (2026-11-24)**: every product tag stays in the searchable text, including theme-style tags like `_badge_new` or `filter-color-red`. They sometimes carry useful words such as "red".
- **D79 Live data wins over description text (2026-11-24)**: the M4 system prompt tells the bot to state prices and stock only from the live card data, and never to repeat prices, stock counts, discounts or sale dates written in product descriptions. Descriptions are stored unchanged, because stripping that text is unreliable.
- **D80 Models (2026-11-24)**: the small model is `gpt-6-luna` with reasoning effort none, and the large model is `gpt-6.1-terra` with effort low, set through `OPENAI_MODEL_*` and `OPENAI_REASONING_*`. Checked against OpenAI's official pages on 2026-11-24. `gpt-6.2-sol` is the upgrade path if Terra's answers fall short in the live tests. The system prompt draft (M4 Task 17) is approved as a draft and gets tuned before the beta (D49).
- **D81 One turn at a time per conversation (2026-11-24)**: a second message on a conversation while a turn is still streaming is refused (or waits), and an identical retry of the same message isn't answered twice. Raised by the implementation guide the user shared; fixed in M4.
- **D82 Phase 2 candidates from the user's implementation guide (2026-11-24)**: recognising logged-in website customers through a Shopify App Proxy (verify the HMAC signature, timestamp and replay; never take a customer id from the request body); mobile app chats using the app's own customer login (Storefront `customerAccessToken` for legacy accounts, Customer Account API OAuth with PKCE for new ones); one chat history per customer across web and mobile, with a guest's chats merged on login; order lookups through the Customer Accounts MCP (needs protected customer data approval). The Storefront Catalog MCP is not planned, because its availability isn't documented. All stay out of phase 1.
- **D83 AI disclosure in the widget (2026-11-24)**: the chat widget (M5) shows a short visible notice that the shopper is talking to an AI assistant, as the EU AI Act requires from August 2026. It is shown to every shopper.
- **D84 Shopper can delete their chat (2026-11-24)**: the M5 widget gets a "Clear chat" action that deletes the current conversation and its messages (a token-authorised `DELETE`), for privacy. Listing past chats waits for logged-in customer recognition (D82, phase 2). This comes from the user's implementation guide, which is treated as a source of ideas for AskCart, not as a client spec. The guide's other differences (one store, Node and MongoDB, live MCP lookups without an index, mobile apps) don't change AskCart's architecture (approach B). Two ideas from it are noted for later: tool-calling for orders and policies once they exist, and a client-sent request id for retry de-duplication (used in D81).
- **D85 Prompt fixes from the live test (2026-11-24)**: the bot always writes a real sentence (never only cards), even when store text tries to change its rules. Asked about price, it says the price is shown on the product card instead of "I don't know the price". The live test checks that the reply is not empty.
- **D86 Relevance cut-off (2026-11-24)**: weak search matches are dropped. When nothing relevant is left, the bot says the store doesn't seem to carry it. The threshold is tuned on the 21-question comparison set (scripts/mcp-compare). This was found in the MCP comparison, where our search returned snowboards for "a blender".
- **D87 Budget questions by live price (2026-11-24)**: the query rewrite extracts an optional budget (min/max, in the store currency) and a "cheapest" intent. After the live price check, products outside the budget are dropped and "cheapest" sorts by price. Prices stay out of the search index, so they're never stale. The comparison set showed MCP handles prices and our search did not.
- **Search choice confirmed (2026-11-24)**: in a 21-question comparison on the dev store, our search put the right product first 15 times versus 8 for Shopify's Storefront Catalog MCP. MCP returned nothing for 10 vague, attribute and non-English questions. MCP is faster (250 ms vs 440 ms) and knows prices. Our search stays primary; MCP is not adopted.

**P1–P56 and P26b are decided. The production domain (P57) is deferred to before M10. P58–P61 were decided as D61–D64.**
