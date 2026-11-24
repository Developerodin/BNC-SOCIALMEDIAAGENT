# Handover: end of 2026-11-24 (session 3) → go-live work on 2026-11-25

## Where we are
- **One branch: `main`** (GitHub `Developerodin/BNC-SOCIALMEDIAAGENT`, last commit `becb53d`). `m1-foundation` was merged
  into it and deleted. Working tree clean. Full suite on the final code: 1,165 passed, 1 skipped; tsc, eslint and all
  widget size budgets clean.
- Dev store `ask-cart-hv7ufqqy.myshopify.com` (org **CellaVei**, app **AskCart**, client_id `c80e516d95dbbe7b654945e4800a4fa0`).
  The app runs only locally so far (`shopify app dev`); **nothing is hosted yet**.
- Migrations go up to **0020** (applied locally). Dev DB: `shopassist`; tests: `shopassist_test`.

## Built today (all reviewed by Opus, 4-lens reviewed, merged)
- **Mobile API:** per-store mobile app key (admin card), rate limits; `docs/mobile-api.md`.
- **Agent tools over Shopify MCP:** `store_policies` (now `ask_business`, fallback to the old policies tool until
  2027-01-15), `search_products` (second search), `product_details` (`get_product`, needs `UCP_AGENT_PROFILE_URL`).
- **Chat outside Shopify:** hosted page `/chat/<shop>` + one-line `embed.js`; per-store **allow-list** (off by default);
  postMessage **cart bridge** (Add to cart into the shopper's real Shopify cart from the embed); `docs/embed.md`.
- **Customer identity:** mobile sign-in with the legacy `customerAccessToken`, website sign-in via **App Proxy**
  (`/apps/askcart/session`), owned conversations, history across web + app, `customers/redact` deletes, data-request
  export script `scripts/export-customer-chats.mjs`.
- **Admin home** (Polaris layout): setup guide checklist (Turn on chat deep link), **Chat widget settings** card (name,
  accent, avatar, launcher, welcome, 4 suggested questions, teaser; localized defaults), Connect your website (SSRF-safe
  check + Allow button), Mobile app key, Product sync.
- **Widget refresh:** theme-matching header (avatar, "AI shopping assistant", online dot), greeting + chips, clearer
  bubbles/cards, **⤢ expand mode** (3 cards per row), "Choose Color" pickers with hints, daily-cap message.
- **MCP-only pilot** (stores without an install): `stores.mode='mcp'`, catalog from Shopify UCP payloads, breakers and a
  5 s budget, 100 messages/day, jobs skip these stores, `scripts/provision-mcp-store.mts`. Plan:
  `docs/superpowers/plans/2026-11-24-mcp-only-plan.md` (v3 at top; self-serve signup is the later phase).
- Hardening from reviews: rate limits on every chat path, embedding timeout 3 s, rewrite timeout **8 s**, retention job,
  no shopper text in logs, storefront-token minting at most hourly, `write_app_proxy` scope, UTF-8 fix.

## Tomorrow: go live on Bois and Chiffon (store in a *different* organization)
Follow `docs/deploy-ec2.md` top to bottom. In order:
1. **EC2** (§1–4): Ubuntu 24.04, ≥ t3.small, **Elastic IP**, a domain pointing at it, Postgres 17 + pgvector,
   **nightly backup + one restore test (required)**, Node 22, `.env` (save `TOKEN_KEY` and `CHAT_TOKEN_SECRET` in a
   password manager; set `UCP_AGENT_PROFILE_URL=https://<domain>/ucp-agent-profile.json`), `npm run build`,
   `npx drizzle-kit migrate`, pm2 (`--kill-timeout 10000`, pm2-logrotate), Nginx + TLS. **One instance only.**
2. **Shopify** (§5, from the dev machine): set the 3 URLs in `shopify.app.askcart.toml` (app, auth redirect,
   `[app_proxy] url`), commit, `npm run build:widget`, `shopify app deploy`.
3. **Outside-org install (§5.3):** Dev Dashboard → AskCart → **IP allowlist** = the Elastic IP (and on every app in
   CellaVei); declare **network access** if asked; **Distribution → Custom** → Bois and Chiffon's `.myshopify.com`
   domain → install link. Custom distribution is permanent and serves one merchant.
4. **Merchant (§5.4):** install while logged in to *their* admin → products sync → Setup guide → Turn on chat → Save.
5. **Smoke test (§6)** on their storefront: product question with cards, add to cart, "return policy" (ask_business),
   logged-in history, `pm2 logs askcart` clean.
6. **Phase 0 of MCP-only** (only once hosted): record real `search_catalog`/`lookup_catalog`/`ask_business` payloads,
   confirm currency context, media hosts, Retry-After, password-store behaviour; replace the schema-derived fixtures.

## Decisions still open (owner)
- MCP-only self-serve: billing outside Shopify vs App Store rules; who answers shoppers' data requests; legal read of
  Shopify API Terms §2.3.14/§2.3.24 for app-less use.
- Public App Store app (new app, likely new org): when to start; `docs/publish-checklist.md` is the list.
- Whether to drop ~40 old `shopassist_t*/w*/p*` databases in local Docker (from earlier sessions; unused).
- Partner connect wave 3 (P10) from the previous handover is still pending: E2E test with a stand-in portal, log-leak
  test, "Connected apps" list with Disconnect, `docs/partner-api.md` alignment.

## Working notes
- **Run locally:** Docker Desktop → `docker compose up -d` → `shopify app dev --config shopify.app.askcart.toml --store
  ask-cart-hv7ufqqy.myshopify.com` (storefront password: Online Store → Preferences → Store access). Open AskCart once
  after each restart (it saves the tunnel URL for the widget). View the real storefront, not `127.0.0.1:9293`.
- **Agents work in `.claude/worktrees/`**; while those exist `shopify app dev` refuses to start ("only one web
  configuration"). Remove finished worktrees (unlink their `node_modules` junction first) or run from a copy outside the
  repo.
- **Save files as UTF-8** (a Windows-1252 byte once crashed Turbopack while tests still passed).
- **Docker stops when the machine crashes**; restart it before tests or `shopify app dev`.
- Commit rules: no co-author / session trailers, never mention tests in messages.
