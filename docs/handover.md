# Handover: end of 2026-11-24

## Where we are
- **M1–M4 are complete and checked live on the dev store** `ask-cart-hv7ufqqy.myshopify.com` (org CellaVei, app AskCart).
  - 299 offline tests pass, and tsc and eslint are clean.
  - The live OpenAI tests in `tests/live/` pass.
- **The M4 chat works end to end.** `POST /api/chat` streams answers over SSE, and `GET /api/chat/history` restores the conversation.
  - Each turn: rewrite the question, search, one live check per turn (D77 market, D72 sold out, D75 subscriptions, D74 gift cards), apply the budget (D87), answer.
  - Models (D80): `gpt-6-luna`, handing off to `gpt-6.1-terra` for harder questions.
  - Answers start in about 3 s.
- **Decisions D69–D88 are logged in `product.md`.** M4 choices C11–C19 are in `docs/superpowers/plans/2026-11-24-m4-plan.md`.
- **The search comparison is in `scripts/mcp-compare/results.md`.**
  - Our search: right product first for 15 of 21 questions.
  - Shopify's Storefront Catalog MCP: 8 of 21, with no results for 10.
  - Our search stays primary.

## How to run it
1. Start Docker Desktop, then run `docker compose up -d`.
2. Run `shopify app dev --config shopify.app.askcart.toml --store ask-cart-hv7ufqqy.myshopify.com`.
3. Smoke-test the chat with `node scripts/chat-smoke.mjs http://localhost:<next port> ask-cart-hv7ufqqy.myshopify.com "<question>" IN`.
   - Add `--token <t>` to continue a conversation.
   - Add `--history --token <t>` to read it back.
4. To force a resync without the UI, run `enqueueSync(storeId)` from a tsx script. The running dev server's worker picks it up.

## Known limits (ponytail notes in the code)
- **Relevance cut-off (D86):** `MIN_SCORE` is 0.18. Nonsense text can still score above real non-English matches, so the model judges what's left.
- **"Cheapest" and budgets (D87)** only rank the 8 search hits, not the whole catalogue.
- **Reopened chat cards (C15)** show the saved snapshot, so prices may be stale.
- **Bulk operations** must stay enabled in the Dev Dashboard. They turn off after 31 days without any bulk query.
- **The dev machine has crashed several times.** Docker stops when it does. Commit each verified step.

## Next
- **M5:** the storefront widget. It includes Add to cart, the AI disclosure notice (D83) and "Clear chat" (D84).
- **Open from the dev-store checklist** (`tests/live/live-products.dev-store.md`):
  - create a second market to check that D77 filtering really hides a product,
  - verify D75 on the ski wax.
- **Before beta:** tune the prompt wording (D49) using real answers.
- **D70:** the order endpoint for the Social Media Agent is still to build. Its rules are in D73.
- **Phase 2 candidates:** D82.
