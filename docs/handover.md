# Handover: end of 2026-11-25 → 2026-11-26

## Where we are
- **`main` is 10 commits ahead of `origin/main`, NOT pushed** (local head `384021d` + this handover). Last pushed: `8672df3`.
  The user's rule: run the **4-lens review before push**, and show any bot/prompt wording word-for-word for approval first.
- EC2: https://askcart.13.232.66.119.sslip.io (pm2 `askcart`), runs app **Shop Assistant** (BnC org,
  client_id `b8c22f4b59fbb4181923cc9c1ff099d0`, `shopify.app.bnc.toml`). AskCart (CellaVei, `shopify.app.askcart.toml`) is the dev app.
- EC2 is behind even `origin/main`: the user still has to pull + restart (see "Deploy" below).
- Migrations now go to **0025** (0023 sales + ratings, 0024 its RLS, 0025 `messages.feedback_reason`).

## Merged locally today (not pushed)
1. **Widget** (`17f3780`): prices always with a dot (`formatPrice` en-US, e.g. €1,452.43); "You're viewing: <title>" divider
   when the shopper moved to another product page (localStorage `lastProduct`); jump-to-latest round button; thumbs tooltips already existed.
2. **Ranking tools** (`c81cc86`): daily `sales-scan` 03:00 UTC + per-store `sales-snapshot` (table `product_sales`, units/orders only,
   last 30 days); `products.rating/rating_count` from review-app metafields at sync (D95); chat tools `trending_products`,
   `top_rated_products` (≥3 reviews), `featured_collection` (best_sellers | sale, matched by name in 6 languages). Trending shows ranking only, no numbers.
3. **Chat code fixes** (`f321d6f`, edge-case report #1,2,4,8–11,14,15 + tester #10): price sort only within 0.08 of the best hit
   (`HEAD_MARGIN`, budget.ts); search tool kept on budget turns; missing product names filled from the title (markers.ts);
   card price follows the variant discussed; max 3 cards unless more asked; empty rewrite = no search; merchant HTML/MD stripped
   (`plainText`); shopper-typed `[[product:n]]` stripped; tools time out at 15 s, failed tool-result request retried once without tools.
4. **Card icons** (`d5ac501`): similar-products (bottom-left) + add-to-cart (bottom-right) over the card image. Similar sends a
   message + `similarTo` gid; server validates store ownership, searches by the product's own embedding, same type first,
   excludes self / sold-out / cart, ≤3 cards.
5. **Thumbs-down reasons** (`a9d245c`): menu after thumbs-down with 5 reasons (no free text), column `messages.feedback_reason`
   (0025); internal page **`/ops/feedback`** (Basic auth, password = `OPS_SECRET`; 404 when unset) with per-store up/down,
   % down, reasons, latest 50 bad answers. Merchants can't see it.
- Merge conflicts resolved by hand in `turn.ts` (similar turn + empty-query + stripProductRefs), `admin-tools.ts`, `icons.ts`;
  typed the send mocks in `tests/widget/panel.test.ts`. tsc clean; chat/widget/api/retrieval tests 1266/1267 in one run
  (one similar-icon panel test flaked; passed alone and in the full widget run 556/556). **Full suite not yet run on merged main.**
- Widget gzip 27,755 B / 30,720 B budget (≈3 KB headroom left).

## NOT merged: prompt wording (waiting for user approval)
- Branch `worktree-agent-a19f7d543196c6175`, commits `866643c`, `0f60215`, `151b951` (prompt.ts, rewrite.ts, tools.ts).
  Rebased on main before the code-fix merge → **expect conflicts in rewrite.ts / tools.ts / prompt.ts** when merging.
- The 18 rules were shown to the user word-for-word in chat on 2026-11-25. Topics: off-topic decline + steer back to the
  earlier need, "yes" loop, lead from the stated limit, too-expensive → cheapest same type, buying moment → "tap Add to cart" + one
  complement, concrete complements, best-seller/sale tools, think-it-over / found elsewhere, "never say the store doesn't sell
  something you haven't looked for", no internal words, no invented options, size unit conversion, currency note, no % off,
  name before marker, 3–6 word queries ("lit chambre sommier"), store_policies only for store rules, search each missing type.
- Also pending approval, already merged inside the code-fix / icons commits:
  - A. rewrite.ts: "If the message needs no product search at all (thanks, a greeting, a question about the store's shipping, returns or contact), set query to an empty string."
  - B. rewrite.ts: too-expensive → sort cheapest, query = product type, not the product's name.
  - C. turn.ts note for a similar turn: "The shopper asked for products similar to "{title}"…"
  - The 3 new tool descriptions (trending / top-rated / featured collection).
- Eval evidence: worktree `server/.edge/` (before*.json, final*.json, real2.json); code-fix evidence `scratchpad\cfix\after2.md, after3.md`.

## Open questions for the user (ask first thing)
1. Approve the 18 rules + A, B, C + 3 tool descriptions (or name changes).
2. Furniture examples in the shared prompt ("bedding in the bed's size", "other sofas for a sofa", "lit chambre sommier"): keep or make generic? (Every store shares the prompt.)
3. Short/ambiguous messages ("yes", "bed?") sometimes answered in French after the wording change (Y2 4/4, L8 3/6). Add a rule "short messages keep the conversation's language"?
4. Approve UI strings in 6 languages (all in `server/widget/src/core/i18n.ts`, marked PENDING):
   - `jump_latest`: Jump to latest / Aller au dernier message / Zur neuesten Nachricht / Ir al último mensaje / Vai all'ultimo messaggio / Naar het laatste bericht
   - `similar_label` / `similar_message`: "Show products similar to {title}" / "Show me products similar to {title}" (+ fr de es it nl)
   - `reason_menu` + 5 reasons: Why wasn't this helpful? · Wrong products shown · Wrong price or stock · Didn't understand me · Answer too long or unclear · Other (+ fr de es it nl)
5. Ops page: "% down" = down ÷ (up+down); dates in UTC; OK?
6. Trending: show numbers (units sold) or ranking only (current)?

## Next steps (in order)
1. Get the answers above; apply wording changes; merge the wording branch (resolve conflicts), rerun the chat eval briefly if wording changed.
2. Full suite: `cd server; npx vitest run --exclude "tests/live/**"` (Docker Desktop + `docker compose up -d` first) and `npx tsc --noEmit`, `node scripts/build-widget.mjs`.
3. **4-lens review** (correctness, security/privacy — incl. `/ops/feedback` auth, `product_sales` + sales job, `similarTo` validation;
   UX/accessibility — icons on card image, reasons menu, jump button, divider; performance — daily sales job + Shopify API budget,
   ops page one transaction per store, similar search). Fix findings.
4. Live check on the French fixture, then push (commit messages: no co-author, no URLs, no test mentions).
5. Give the user the EC2 update (they run it):
   ```
   cd ~/askcart && git pull && cd server && npm ci && npm run build && npx drizzle-kit migrate && pm2 restart askcart --update-env
   ```
   plus set `OPS_SECRET` (see `docs/deploy-ec2.md`).

## Waiting on the user
- EC2 logs for tester #10 "Assistant unavailable" on return policy:
  `pm2 logs askcart --lines 400 --nostream | grep -iE "polic|error|unavailable|timeout" | tail -40`
- BnC's real `*.myshopify.com` domain (`boisandchiffons.myshopify.com` gave unknown_shop).
- `PARTNER_API_SECRET` + `PARTNER_STORE_DOMAIN` on EC2 (for the Social Media Agent; the user sets these manually).
- Pull + restart EC2 (BnC sync recovery, partner API, room fix are pushed but not live).

## Offered, not decided
- Partner API RESERVE 1000 → 500; Elastic IP / IP allowlist + real domain; a separate AskCart Dev app; protected customer data level 1; DB backups.
- Quotes (draft orders) was raised and **dropped** by the user — don't build.

## Notes
- User is on **Windows** (PowerShell 5.1) — give PC commands for Windows; EC2 commands are Linux.
- User asked to keep usage low near session limits; avoid spawning many agents at once.
- Worktrees under `.claude/worktrees/agent-*` can be removed after the wording branch is merged
  (`git worktree remove …`); scratch DBs `shopassist_test_wfix/_cfix/_fb/_words`, `shopassist_words_edge`, `shopassist_edge2` can be dropped.
