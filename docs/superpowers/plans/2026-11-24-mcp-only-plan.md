# Plan: MCP-only mode (AskCart on any Shopify store, no app install)

## v3 — build order after the 4-lens plan review (overrides v2 and the original below)

### Pilot (build now; one store, provisioned by hand)
- **P1 MCP data path** (seam: `stores.mode` `'app'|'mcp'`, one migration + check constraint; `mode='mcp'` implies the
  MCP provider):
  - For `mcp` stores bypass `searchProducts`' provider logic (its "mcp" branch still embeds and reads our tables).
  - `mcpSearch` keeps the payload: a **per-turn** `Map<gid, ucpProduct>` (never module-level), filled from both
    available=true/false calls merged with the existing `mergeProducts`; misses (current product, tool hits) via
    **`lookup_catalog`** (≤10 ids/call), not `get_product` per id.
  - Pure `toLiveProduct()` → `LiveProduct`: decimal prices from minor units with the currency's own decimals
    (`Intl.NumberFormat(…).resolvedOptions().maximumFractionDigits`), `Stock` in_stock/sold_out only, numeric variant ids
    from validated `^gid://shopify/ProductVariant/\d+$`, url/image (image only on `cdn.shopify.com`), `gift_card`
    filtered unless `includeGiftCards`, selling plans → `action:'view_options'` (as the installed app).
  - `checkProducts`/`ToolContext.check`/`searchMore` branch on `mode` **before** the currency gate; no `fallbackCards`
    (reads our table) for `mcp`.
  - Every UCP call sends `context.currency = store.currencyCode` (and country when known); budget questions may use
    `filters.price{min,max}` (minor units).
  - **Degraded mode:** search returns `{hits, status:'ok'|'degraded'}`; degraded → a store-data note "the catalog is
    temporarily unavailable" (never "we don't carry that"). Per-store **and** global circuit breaker honouring
    `Retry-After` by not calling (never sleeping inside a turn).
  - **MCP time budget** ≈5 s per turn for catalog calls; recompute `TURN_LOCK` from the real timeouts (rewrite 8 s +
    MCP + 60 s answer).
  - Jobs skip `mcp` stores: `resyncScan` (filter in SQL), `startSync`, `embedStore`, widget metafield sync,
    `refreshShopInfo`. Hide the FAQ block for `mcp`.
  - Logging per call: tool, status kind, ms, retryAfter, cache hit — never query text or IPs.
- **P2 provisioning script** `scripts/provision-mcp-store.mts` (tsx, importing `upsertStore`, `parseHost`, and
  exported `fetchPage`/`pageShop`): verifies by hand-run fetch of `https://{shop}.myshopify.com/`, then sets
  `mode='mcp'`, account, `name`, lowercased `domains` (myshopify + custom), non-empty `settings.embedDomains`,
  `currencyCode` (from a UCP `price_range` currency), `primaryLocale`. Never calls the Admin API.
- **P3 `ask_business`** (independent, deadline 2027-01-15, also for installed stores): 8–10 s timeout; fall back to
  `/api/mcp` only on error; no profile URL → `/api/mcp` directly; output wrapped as store data, no prices/stock quoted
  from it (D37); confirm the capability key in Phase 0.
- **P4 cart bridge** — **owner decision pending** (else hosted cards keep "Buy on the store"): `embed.ts` checks
  `e.origin` **and** `e.source === frame.contentWindow`; strict schema `{type:"askcart:add", variantId:/^\d{1,20}$/,
  qty:1-10}`; posts only from a trusted click, never model output; replies with `targetOrigin = appOrigin`; reuses
  `cart.ts` `addToCart` (`Shopify.routes.root + 'cart/add'`, `updateCart`/`cart:updated`), returns 422 messages, keeps
  `logCartAdd`; "View cart" link instead of promising a cart-count refresh. `embed.ts` reads `Shopify.country` and the
  product id at runtime (no Liquid).
- **Pilot kill switch:** `stores.active=false` (already checked by `storeFor`). Hard **daily message cap** (cheap).
- **Phase 0 (needs hosting):** real payload fixtures, currency context, media host, `lookup_catalog`, Agentic channel
  toggle, `buyer_ip` effect, bot protection on our server fetch, password-store `tools/call`. Success metrics: zero-result
  rate, p95 first token, 429 count, add-to-cart success.

### Self-serve (after the pilot proves search quality)
Login (magic link over SMTP with **nodemailer**, port 587, SPF/DKIM; token bound to a pre-auth cookie nonce; 32-byte
token, `DELETE … RETURNING`; one address, no CR/LF; per-email and per-IP limits; `Referrer-Policy: no-referrer`),
store claims + verification (real element parse, `https://{shop}.myshopify.com` only, inconclusive fetches never count
as failures, embed.js heartbeat), dashboard on a **separate host from the hosted chat** (`chat.` subdomain), cookie
`withStore` option with ownership check, monthly/daily caps with a per-IP daily share, small cap for password-protected
(dev/trial) stores, global daily OpenAI spend ceiling, DB kill switch flag, uninstalled-row reuse wipes app-era chats,
keys and partner tokens and cancels a pending shop-redact, OAuth install hands ownership to the installer,
"live token wins" dispute rule, DPA/privacy notice, raw IPs not stored, schema probe + alerts every 15 min.

### Realistic sizes
Pilot P1+P2: ~2 days. P3: ~0.5 day. P4: ~0.5 day. Self-serve: ~5–6 days. Rollback runbook: set
`active=false` on `mode='mcp'` rows before deploying older code.

---

## v2 changes after the Opus plan review (these override the sections below)

**Owner decisions (2026-11-24):** free cap **500 messages/month** per MCP store (+ 100/day safety); a store already
claimed by another account that verifies again is **held for manual review** (never touches an installed `mode='app'`
row; an inactive uninstalled row is reused); **password-protected stores supported** (paste also into
`layout/password.liquid`); login emails go out over **SMTP** (host/port/user/pass/from in env; one small dependency such
as nodemailer, or a minimal SMTP client).

**Blockers fixed in the design:**
1. **Theme cart:** the embed always renders `/chat/<shop>` in our iframe (`hosted: true`, no `cartAddUrl`, no country or
   product context), so it can't call `/cart/add.js`. Add a **postMessage bridge** in `widget/src/embed.ts`: the iframe
   posts `{variantId, qty}`; the parent checks `e.origin === appOrigin` and calls the store's `/cart/add.js`, then
   refreshes the cart count. Pass product handle/id and country into the iframe via `data-*`/URL. **The UCP cart leaves
   the MVP**; off-Shopify sites keep "Buy on the store".
2. **Currency:** `checkProducts` (`turn.ts`) only live-checks when `store.currencyCode` is set and otherwise reads our
   `products` table. Branch on `mode` **before** that gate; set `currencyCode` at verification from the page's
   `Shopify.currency.active`; convert UCP minor units with the currency's own decimals (JPY has none).
3. **Verification spoofing:** never trust a merchant-supplied URL. Always fetch `https://{claimed}.myshopify.com/`,
   follow redirects only, take the custom domain from where it lands; parse a real
   `<script src="{appOrigin}/embed.js" data-shop data-verify>` element (not a substring match, which reviews or product
   JSON could echo). Phase 0 also tests whether Shopify's bot protection blocks our server fetch.

**Important additions:** cookie-path `withStore` checks the user's account **owns** the store in `X-AskCart-Store`
(no IDOR), with a users→accounts link in the schema; caps **per account and per email domain** plus throttled signups
and magic-link sends (free dev/trial stores make abuse easy); the usage increment is one atomic
`INSERT … ON CONFLICT DO UPDATE … RETURNING` **before the rewrite call**, and a `requestId` replay doesn't count twice;
count Shopify calls per turn (search = 2 calls, get_product = 2) and send `dev.ucp.buyer_ip` so limits apply per shopper;
filter gift cards and selling plans from the UCP payload (`gift`, `selling_plan`), not our rows; transcripts and IPs
**are** personal data: dashboard export/delete per conversation, a DPA and privacy notice at signup; restate the data
posture as "no catalog table; transcripts keep the product snapshots the shopper saw, deleted by retention"; check
OpenAI's no-training terms; kill switch is a **DB flag**, not an env var; hide the FAQ block for MCP stores;
re-verification refreshes `domains`; magic links single-use, deleted atomically, no account enumeration, new session on
login.

**New decisions still open:** billing MCP-only merchants outside Shopify vs App Store billing rules; who answers
shoppers' data requests; whether `ask_business` ships first.

**Re-scoped order (realistic sizes):**
- **Now (independent, protects the installed app):** Phase 1c `ask_business` with a fallback to `/api/mcp` until
  2027-01-15. Note it makes policies depend on the public profile URL; its answers are Shopify-written, treated as
  store data.
- **Pilot (2–3 days):** Phase 1 (MCP data path incl. currency gate) + the postMessage cart bridge + a **provisioning
  script** that creates an MCP store row after a manual check of the paste. No dashboard yet.
- **After the pilot proves search quality (4–5 days):** Phase 2 (login, verification, dashboard, authorization tests).
- **Then (2 days):** Phase 3 caps/kill switch (the caps are needed before any self-serve signup).
- Phase 0 needs hosting first: no MCP call works without the public profile URL.

---

Status: draft for review, 2026-11-24. Inputs: three research passes on Shopify's public agent endpoints, the codebase's
install dependencies, and merchant accounts/verification. Goal: a merchant who has **not** installed AskCart (App Store
review takes weeks–months) can still give shoppers the AskCart chat, using only Shopify's public per-store endpoints and
our embed script, while the full app goes through review.

## What MCP-only can and can't do

| Capability | Installed app | MCP-only |
|---|---|---|
| Product search | Our semantic search over synced products | Shopify `search_catalog` (UCP, keyword-like, D89) |
| Price, availability, variants, images, URL | Admin API live check + our rows | From `search_catalog` / `get_product` payloads |
| Stock **counts** ("only 3 left") | Yes | **No.** Only available / sold out |
| Policies, FAQs, shipping, contact | `/api/mcp` policies tool (deprecated) | `ask_business` (UCP) |
| Add to cart | Theme Ajax cart (theme widget) | Shopify **UCP cart** → `continue_url` link to the store's cart (hosted page / other sites); theme pages can still use the Ajax cart |
| Checkout | Shopify checkout | Shopify checkout via `continue_url`. **Never** `complete_checkout` |
| Widget on the storefront | One-click app embed | Merchant pastes our `<script>` into `theme.liquid` |
| Merchant settings | Embedded Shopify admin | **Our own dashboard** (new) |
| Customer login / shared history, partner API, mobile customer sign-in | Yes | **No** (need an install). Guest chat only |
| Webhooks (uninstall, GDPR redact) | Yes | No. Guest-only chats hold no customer data |

## Facts that shape the plan (from Shopify docs, verified on the dev store where marked)

- **No registration for the Anonymous tier**: catalog and cart tools, lowest rate limits; 429 + `Retry-After` must be
  honoured. Signed tier (RFC 9421 keys in our profile) is needed for checkout tools; we don't need it.
- Calls need our **UCP agent profile** at a public URL (`public/ucp-agent-profile.json`). It currently declares only
  catalog search/lookup. **Add `dev.ucp.shopping.cart` and `dev.ucp.common.ask`** (pinned versions).
- `search_catalog` returns `id, handle, title, description, url, media, price_range (minor units + currency), options,
  variants[{id, price, availability.available}]`, pagination; accepts `context{address_country, language, currency}`.
- `create_cart` returns `cart.id, totals, continue_url, expires_at`. It does **not** merge with the shopper's existing
  storefront cart; `update_cart` replaces the whole cart.
- `search_shop_policies_and_faqs` (`/api/mcp`, what our `store_policies` tool uses today) is **deprecated, maintained
  until 2027-01-15**. Successor: `ask_business` (needs `dev.ucp.common.ask` in the profile). This affects the installed
  app too.
- [LIVE] `/api/ucp/mcp` answered `tools/list` on our password-protected dev store and sends `access-control-allow-origin: *`.
- Shopify has changed this surface three times in 2026 (catalog → UCP in April, policies tool deprecation, cart tool
  moves). **Pin versions, watch the changelog, and expect breakage.**
- **Terms risk:** Shopify API Terms §2.3.24 bars training AI on API data and reproducing substantial catalog portions;
  §2.3.14 bars scraping. Whether they bind an app-less agent is unclear. Our posture: **no catalog persistence** (short
  in-memory caches only), no training, chat logs only. **Needs a legal read before selling MCP-only.**
- Merchant opt-out: unknown. The "Agentic" sales channel toggles may or may not switch off `/api/ucp/mcp`.

## Phase 0: spikes and decisions (≈2 h, before any build)

1. **Agentic channel test:** on the dev store, switch the Agentic channel off, then re-probe `tools/call search_catalog`.
   Tells us whether merchants can opt out (and whether we must detect it).
2. **Real calls with the updated profile:** deploy the profile publicly (needs hosting), then call `search_catalog`,
   `get_product`, `ask_business`, `create_cart` on the dev store (password-protected) and one public store. Record exact
   payloads into test fixtures; confirm `url`, `media`, numeric variant ids, currency context.
3. **Legal read** of API Terms §2.3.14/§2.3.24 for app-less use (owner's task).
4. Owner decisions (below).

## Phase 1: chat data path for MCP stores (≈1 day; 2 Sonnet agents in parallel)

Seam: a `mode` field (`'app' | 'mcp'`, default `'app'`) on `stores`, selected in `storeFor` (`src/lib/chat/cors.ts`) and
carried on `TurnStore` (`src/lib/chat/turn.ts`).

- **1a. MCP-native search** (`src/lib/search-provider.ts`, `src/lib/shopify/catalog-mcp.ts`): for `mcp` stores, call
  `search_catalog` and **keep the payload** instead of dropping results not in our `products` table
  (`catalog-mcp.ts:78`). Hits carry `content` = title + description (sanitized, size-capped). No `search()` / embedding
  call for these stores.
- **1b. MCP "live check"** (`checkProducts` in `turn.ts`, `ToolContext.check`): build `LiveProduct` from the catalog
  payload (and `get_product` for the current product / tool hits): price, compare-at, availability → `Stock` in_stock /
  sold_out only, variants with numeric ids (for `/cart/add.js`), options, url, image, per-product currency. Cards,
  `applyBudget`, `buildInput`, tools and storage then work unchanged.
- **1c. Policies via `ask_business`** for **both** modes (replace `/api/mcp` before 2027-01-15); keep `store_policies`
  as the tool name the model sees.
- **1d. Jobs skip `mcp` stores:** `resyncScan`/`startSync` (`src/lib/sync.ts`), `embedStore` (`src/lib/indexing.ts`),
  widget metafield sync, shop-info refresh. Otherwise store-sync retries 5× and fails every day.
- **1e. Profile:** add cart + ask capabilities; serve `/ucp-agent-profile.json` as `application/json` with open CORS.

## Phase 2: merchant accounts, verification, dashboard (≈1.5 days; 2 Sonnet agents)

- **Login: email magic link.** No new libraries; send mail with `fetch` to Resend/Postmark. Tables `users`,
  `login_tokens` (15 min, hashed), `web_sessions` (30 days, hashed). Cookie `__Host-askcart_session` (HttpOnly, Secure,
  SameSite=Lax). `/login/verify` signs in on a **POST** button, never on GET (mail scanners prefetch links). CSRF: every
  non-GET must carry `Origin == appOrigin()` + JSON + an `X-AskCart-Store` header.
- **Proving store control:** the merchant adds `x.myshopify.com` → a `store_claims` row with a public verify token →
  the dashboard gives one line for `theme.liquid`:
  `<script src=".../embed.js" data-shop="x.myshopify.com" data-verify="ackv_…" defer>`. **Verify** fetches the
  storefront with the existing SSRF-safe fetcher (`src/lib/website-check.ts`) and passes only if the page's
  `Shopify.shop` equals the claimed shop **and** our tag carries the token. One paste = installs the chat + proves
  control. Only then is the `stores` row created (`mode='mcp'`, domains and `embedDomains` from the verified host), so
  nobody can squat a domain. Password pages: tell them to paste it into `layout/password.liquid` too, or verify after
  launch. A daily job re-verifies; 3 failures over ≥72 h → suspended + email; a later pass lifts it.
- **Dashboard** `/dashboard` (in `src/app/(site)`): generalise `withStore` (`src/lib/admin-route.ts`) to accept either the
  embedded Bearer session or the site cookie + store header (cookie path never does a token exchange). Reuse the
  existing routes/cards: embed allow-list, website check, setup guide (shows the paste snippet instead of the theme
  deep link for `mcp`), widget settings. Extract the cards from `src/app/(embedded)/app/page.tsx` into shared components
  taking a fetcher. Hide for `mcp`: sync status, mobile **customer** sign-in, partner consent.

## Phase 3: cost control and cart (≈0.5–1 day; 1 Sonnet agent)

- `usage_monthly(store_id, month, messages)`; a turn increments it **before** any OpenAI call; over the cap → 402
  `limit_reached`, polite widget message. `stores.monthly_message_cap`, `plan` placeholder (Stripe later),
  `suspended_reason` checked next to `active` in `storeFor` and `/chat/<shop>`; global `MCP_ONLY_DISABLED` env switch;
  tighter per-store web limit for `mcp`.
- **Cart for hosted page / other sites:** "Add to cart" calls `create_cart` / `update_cart` server-side, keeps the cart
  id with the conversation, and shows **Go to checkout** = `continue_url` (https-checked, never logged). On the store's
  own theme pages, keep the Ajax cart. Never call checkout tools.

## Phase 4: upgrade path (≈2 h)

Installing the real app later hits `upsertStore`'s `shop_domain` conflict (`src/lib/stores.ts`) and reuses the **same
row**: set `mode='app'`, clear an `unverified` suspension, queue the first sync. Chats, settings, embed list and usage
carry over; the dashboard user keeps access (same `account_id`).

## Risks and failure modes (named, not all handled)

- **Shopify changes or withdraws the endpoints** → MCP stores lose search/cart until we adapt. Pin versions; a health
  check per store; the chat degrades to policies-only with an honest message.
- **Rate limits (anonymous tier)** at a busy store → 429s. Honour `Retry-After`, short per-store cache of searches (in
  memory, minutes), and consider the Signed tier later.
- **Merchant removes the snippet** → re-verification suspends after 72 h.
- **Terms** (above) → legal read before charging for MCP-only.
- **No stock counts** in MCP mode → the "only N left" wording never appears; the prompt rules still hold.
- **Single instance**: rate limits and caches stay in memory (known limit).

## Out of scope

Billing/Stripe, teams and roles, Google login, customer login for MCP stores, partner API for MCP stores,
`complete_checkout`, multi-instance rate limiting.

## Decisions for the owner

1. Free monthly message cap for MCP-only stores (e.g. 500), and a daily cap too?
2. If a second account verifies a store already claimed by someone else: transfer automatically (the live theme decides)
   or hold for support review?
3. When the real app is uninstalled: fall back to MCP-only if the snippet is still verified, or switch the chat off?
4. Re-verification schedule and grace period (daily, 72 h?).
5. Support password-protected stores in the MVP?
6. Email provider and sending domain (Resend or Postmark).
7. Who does the legal read of Shopify's API Terms for app-less use?

## Order and sizes

Phase 0 (≈2 h, needs hosting) → Phases 1 and 2 in parallel (≈1.5 days with 4 Sonnet agents, each reviewed by Opus) →
Phase 3 (≈0.5–1 day) → Phase 4 (≈2 h) → 4-lens review → pilot on one MCP-only store. Phase 1c (`ask_business`) also
protects the installed app and should land before 2027-01-15 regardless.

## Sources

- https://shopify.dev/docs/agents · https://shopify.dev/docs/agents/ucp
- https://shopify.dev/docs/agents/catalog/storefront-catalog
- https://shopify.dev/docs/agents/get-started/profile
- https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp · https://shopify.dev/docs/agents/checkout/mcp
- https://shopify.dev/docs/agents/ask · https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting
- https://shopify.dev/changelog/storefront-catalog-mcp-now-implements-ucp
- https://shopify.dev/changelog/posts/storefront-mcp-policies-and-faqs-tool-is-being-deprecated-in-favor-of-ucp-mcp-ask-tool
- https://www.shopify.com/legal/api-terms · https://www.shopify.com/legal/terms-agentic-storefronts
