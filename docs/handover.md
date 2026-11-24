# Handover: end of 2026-11-24 (session 2)

## Where we are
- **M1–M5 are complete.** The dev store is `ask-cart-hv7ufqqy.myshopify.com` (org CellaVei, app AskCart).
- **M5, the storefront widget, is built and committed** (`0532974` … `9fb2d8a`).
  - Theme app extension in `extensions/askcart/`: the chat app embed, the "Ask about this product" block, the product FAQ block, 6 locales.
  - Widget source in `widget/src/`, built by `scripts/build-widget.mjs`. Size budgets: launcher 4 KB, widget 30 KB gzip.
  - Also built: product cards, Add to cart, thumbs up/down, the AI notice, Clear chat, and the widget settings published to the `askcart.widget` app metafield.
  - The end-to-end test `tests/live/widget.e2e.test.ts` passed against the real dev server and OpenAI.
- **Search provider (D89):** each store can use our search, Shopify's Catalog MCP, or both (`src/lib/search-provider.ts`). Ours stays the default.
- **Price questions** like "cheapest" now search 30 hits (`PRICE_SEARCH_K`), which fixes the D87 limit from the last handover.
- **Multi-store partner connect (D91):** waves 1 and 2 are committed (`b36a64a` … `4a397d7`). The plan is `docs/superpowers/plans/2026-11-24-partner-connect-plan.md`, with choices C30–C37 all accepted.
  - A portal (for example the Social Media Agent) sends the merchant to `GET /partner/connect`. That opens the consent screen inside Shopify admin (`/app/partner-consent`).
  - The portal then swaps the one-time code for a per-store access key at `POST /api/partner/token` (PKCE S256), and disconnects with `DELETE /api/partner/token`.
  - The read endpoints `/api/partner/{orders,products,shop}` accept those keys. The old single-store secret (`PARTNER_STORE_DOMAIN`/`PARTNER_API_SECRET`) still works until the portal switches (C31).
  - Uninstalling the app revokes all grants. A reused code or refresh token revokes its grant.
  - Portals are registered with `scripts/partner-client.mjs`. Secrets are shared out of band, never in chat.
  - Portal docs: `docs/partner-api.md`.

## How to run it
1. Start Docker Desktop, then run `docker compose up -d`.
2. Run `shopify app dev --config shopify.app.askcart.toml --store ask-cart-hv7ufqqy.myshopify.com`.
   - It may still be running in the background from this session (log in `$TEMP/appdev.log`).
3. Smoke-test the chat with `node scripts/chat-smoke.mjs http://localhost:<next port> ask-cart-hv7ufqqy.myshopify.com "<question>" IN`.
4. Admin deep links must use the client_id (`c80e516d95dbbe7b654945e4800a4fa0`), not "askcart":
   `https://admin.shopify.com/store/<handle>/apps/<client_id>/app/<path>`.

## Next: partner connect wave 3 (P10)
Held until the usage reset, then run with at most 1–2 agents.
- An end-to-end test with a stand-in portal: connect → consent → token → read → disconnect, including a check that a revoked key gets 401 through the read guard.
- A test that no tokens, codes, verifiers or secrets reach the logs.
- One combined review of the whole flow.
- **Build the C35 "Connected apps" list** with a Disconnect button on the AskCart home page. No task has built it yet.
- **Bring `docs/partner-api.md` in line with the code:** the error bodies, 401 codes and refresh routing.
- **Remove `SHOPIFY_APP_HANDLE` from `.env.example`.** The connect route uses `SHOPIFY_API_KEY`.
- **Dev-store steps 2–4 in `tests/live/partner-connect.dev-store.md`** (step 1 passed):
  - the install link on a second store,
  - leaving the admin iframe with `_top`,
  - a staff member without Orders permission is refused.
- Optionally move `src/app/api/partner/token/tokens.ts` to `src/lib/partner/tokens.ts`, where the plan put it.

## Known limits
- **C33:** one active connection per store and portal. Allowing more would need a migration (a unique partial index enforces it).
- **Token request bodies:** a chunked body is read whole before the 4 kB check.
- **Relevance cut-off (D86):** `MIN_SCORE` is 0.18.
- **Reopened chat cards (C15)** show the saved snapshot, so prices may be stale.
- **Bulk operations** must stay enabled in the Dev Dashboard. They turn off after 31 days without any bulk query.
- **The dev machine crashes often.** Docker stops when it does, and once `.next` was corrupted: delete `.next` and restart. Commit each verified step.

## After P10
- **P11:** remove the legacy partner secret once the Social Media Agent portal switches to the connect flow.
- **The Social Media Agent's later wishes need your decision first:** write access, customer data and draft orders.
- **Phase 1 milestones:**
  - M6: PDFs, text only (OCR postponed, D90).
  - M7: the dashboard, English first.
  - M8: the suggestions report.
  - M9: our own site.
  - M10: production.

## Owner's manual steps
- Turn on "AskCart chat" in Theme → App embeds, then work through `tests/live/widget.dev-store.md`.
- Set the storefront password for testing.
- Request approval for `read_all_orders`.
- Approve the draft bot wordings before beta (D49).
- From `tests/live/live-products.dev-store.md`: create a second market to check D77, and verify D75 on the ski wax.
