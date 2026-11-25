# Lens 4: performance, robustness and operability review of `3c9176e..HEAD`

**Scope.** Today's 49 commits:
- the repo split into `server/` and `shopify/`
- the Ask our AI agent block and its auto-insert
- product questions
- the admin tools (store_overview, refresh_product, browse_collection) and order_status
- the cart summary
- logo upload
- product-sync batching

I also read the scale report. The review was read-only, and the working tree is clean (`git status --porcelain` is empty).

**How things were measured:**
- **Bundle sizes:** an esbuild build into the scratchpad, compared with `git archive 3c9176e`.
- **System prompt sizes:** both versions imported with dummy `SHOPIFY_*` env vars.
- **Turn figures:** `server/scripts/edge-cases/results.json`. The run took 72 turns and 237 OpenAI calls, counting rewrite, query embeddings, answer and tool rounds. Turn time was p50 3.1 s, p90 5.3 s, and 4–8 s when a tool ran. The run was at 06:43 today, before the cart-summary and later prompt commits.

Findings are ranked by likely effect on a live store. Line numbers are `server/...` paths at HEAD.

---

## 1. HIGH: logos of 1–2 MB are blocked by nginx, and the merchant is told the file is too big

- `docs/deploy-ec2.md:172` sets `client_max_body_size 1m;` for the whole server. Only `location /api/webhooks` raises it, to 5m (L175). There is no other override.
- The app allows up to 2 MB:
  - `src/lib/shopify/logo.ts:8`: `MAX_LOGO_BYTES = 2 * 1024 * 1024`
  - the UI check at `src/app/(embedded)/app/page.tsx:639`
  - the UI copy "up to 2 MB" at L714
- `page.tsx:643` sends the raw file as the body.
- **Scenario:** a merchant uploads a 1.4 MB PNG. It passes the client check. nginx answers 413 before Next sees the request. The UI maps 413 to "That file is too big." (L649) for a file the same card says is allowed.
- **Fix (one of):**
  - Add `location = /api/app/logo { client_max_body_size 3m; proxy_pass …same headers… }` to the doc's nginx block.
  - Or lower `MAX_LOGO_BYTES` and the UI copy to 1 MB.

## 2. MEDIUM: one shopper leaving can take `store_overview` and `browse_collection` down for the whole store for 30 s

- `src/lib/chat/admin-tools.ts:97-98`: `gql` races the Admin call against `ctx.signal`, the **first caller's** turn signal.
- `overviewOf` (L138-161) shares that one promise with every concurrent caller in the store. Its `.catch` (L154-157) records **any** rejection in `overviewFailed`, including the AbortError `withTimeout` raises when that shopper leaves (`openai.ts:54-67`).
- **Scenario:**
  1. The overview cache is cold (first call, or the 10 minutes ran out).
  2. Shopper A asks "what do you sell?" and closes the panel inside the 3 s Admin window.
  3. Every other turn in the store sharing that promise gets "Store information is temporarily unavailable".
  4. For the next 30 s, every `store_overview` and every `browse_collection` returns UNAVAILABLE without trying. `browse_collection` goes through `overviewOf` at L299. Each failure logs a `console.error` (L92).
- This happens at any traffic level.
- **Fix:**
  - Fetch the overview with its own 3 s timeout only, without `ctx.signal`. Let each caller race its own signal over the shared promise.
  - Don't record an AbortError in `overviewFailed`.

## 3. MEDIUM: product-questions requests are rate-limited per view, not per generation

**Verified:**
- `askcart-embed.liquid` has `auto_ask_ai` on by default. Its `render 'askcart-ask-ai'` passes no `question_1..3`.
- So the auto block always calls `GET /api/chat/product-questions` (`widget/src/ask-ai-block.ts:116-118`) once it comes within 800 px of the viewport (L59).
- The browser caches the answer for 1 h per product and locale (`route.ts:34`).
- `src/app/api/chat/product-questions/route.ts:14` limits this to 30 per IP and 300 per store per minute (in-memory fixed window). The limit is checked in `storeFor` (`route.ts:24` → `cors.ts:115`) **before** the cache lookup. Reads served from the DB cache use up the same budget that is meant to protect the OpenAI generations.

**When it bites:** once more than 300 uncached (browser-side) product-question requests a minute reach the server for one store. That needs sustained, fairly high traffic, so it is not a day-one problem for the pilot store. Above that rate:
- `tooMany()` (`cors.ts:68-70`) returns the 429 **without CORS headers**. The browser logs a CORS error in the storefront console, and the fetch rejects, so the block gets `[]`.
- The reserved skeleton collapses: `askcart-ask-ai.css` `.askcart-ai__pills[data-askcart-loading]` reserves 3×48 px plus 2 gaps, about 170 px, then `:empty:not([data-askcart-loading])` sets `display:none`. That is a visible layout shift on a product page.
- A 429 isn't cached, so the next view tries again.

**Fix:**
- Limit generations instead: count calls that reach `generate()` per store.
- Raise or drop the store-wide read limit, which is a cheap primary-key lookup. Keep the per-IP limit.
- Add the CORS headers to the 429.

## 4. MEDIUM: product-sync batches have no timeout, and burst mode under throttling

**Verified:**
- `refreshProduct` (`src/lib/sync.ts:197`) calls `adminGraphql` (`src/lib/shopify/admin.ts:6-9`) with **no timeout and no retries**. `request()` gets no `tries`, so `@shopify/graphql-client` makes 0 retries.
- A GraphQL `THROTTLED` comes back as HTTP 200 with errors and throws.
- The client uses the `web-api` adapter (`api.ts:1`), which is the global fetch.
- `PRODUCT_SYNC_WORK` (`src/lib/jobs.ts:61`) fetches 10 jobs and runs them one after another (`settleEach`, L64-76).
- There is one product-sync worker per process, serving **all** stores.
- pg-boss refetches at once after any full batch, whatever the outcome (`node_modules/pg-boss/dist/manager.js:1219-1225`).
- The scale report's Admin was a fake with a fixed delay, so stalls and throttling were never exercised.

**Stalled read:**
- One stalled Shopify read holds the rest of its batch of 10, and every other store's product updates wait behind it, until Node's fetch times out (undici's default header timeout).
- This existed before today, but a batch now holds up to 10 jobs instead of 1.
- **Not verified:** whether 10 stalled reads in a row push the batch past pg-boss's 15-minute expiry.

**Throttling.** This is arithmetic from the repo's own figures, not a measurement:
- Each read requests about 75 points (`jobs.ts` comment), against a bucket of 1,000 restoring 50/s (`admin-tools.ts:103` comment). Shopify deducts the actual cost.
- Burst mode runs about 3.2 reads/s. Once a read's actual cost is above about 16 points (products with many metafields or collections), reads outpace the refill. At 30 points per read, the bucket is empty in about 20 s of a bulk edit.
- From then on, a throttled read fails at once, and burst fetches the next 10. Each queued job uses up its first attempt quickly. The retries (5, with 30 s → 15 min backoff) then compete for a refill of about 50 points/s.
- In a large bulk edit, some jobs can run out of retries. Their stored content then stays stale until the next full re-sync. Price and stock are unaffected, since they come from the live check.
- **The chat's live check uses the same Admin bucket** (`src/lib/shopify/live-products.ts:176`). While it is drained, live checks fail and shoppers get fallback cards without live price or stock.

**Fix:**
- Minimal: `withTimeout(refreshProduct(...), 15_000)` in `syncProduct`.
- Have `adminGraphql` expose `extensions.cost.throttleStatus`, and make the product-sync loop pause while `currentlyAvailable` is low.
- Or pass `tries: 2` so a single 429 or 503 is retried.
- Then run one real bulk CSV edit on the dev store and watch the throttle status and the chat's live check.

## 5. MEDIUM/LOW: the auto-inserted block causes a layout shift and a flash of unstyled content on product pages

- `widget/src/launcher/launcher.ts:72-100` inserts a full-width section after the product section when the deferred launcher script runs, after parsing.
- The block's stylesheet `<link>` is **inside the `<template>`** (`askcart-embed.liquid`), so it only starts loading on insertion. Until it arrives:
  - the block shows in default theme styles (`h2`, bare input)
  - the pills have no reserved height
- When the CSS lands, the block grows by the skeleton, about 170 px. If 0 questions come back (thin product, failure, or finding 3), it collapses again.
- On a page where the insertion point is in the viewport, this counts towards CLS.
- **No layout thrash:** the launcher only uses `querySelector`, `querySelectorAll`, `closest` and `matches`; there are no geometry reads. `ask-ai-block.ts:73` does one `getComputedStyle` (style recalculation only).
- **Fix:**
  - On product pages, put the `<link rel="stylesheet">` (or `rel=preload as=style`) outside the template, so it is cached before insertion.
  - Or keep the wrapper `visibility:hidden` until the link's `load` event.

## 6. LOW/MEDIUM: product questions when OpenAI or the database is down

- **OpenAI down.** `src/lib/chat/product-questions.ts:48-70` waits up to 5 s, returns `failed`, and caches nothing on the server.
  - `inflight` (L76) only merges requests that are in flight at the same moment.
  - So every request for an uncached product makes a 5 s OpenAI attempt, up to the 300 a minute per store from finding 3, each with a `console.warn` (L65).
  - These run on the same OpenAI key as the chat turns. The browser caches the failure for 60 s.
  - **Fix:** remember a failure per key (or a global "OpenAI failing" flag) for about 60 s on the server, like `overviewFailed`.
- **Database down.** `route.ts:24` (`storeFor`, a DB query) sits outside the `try` at L37, so a DB outage gives a 500, despite the header comment's "never a 500". The shopper is unaffected, since the widget maps it to `[]`.
- **Our server hangs.** The widget fetch (`ask-ai-block.ts:41`) has no timeout, so the grey skeleton stays until the browser gives up.

## 7. LOW/MEDIUM: the browse_collection search fallback depends on the overview

- `admin-tools.ts:299` calls `overviewOf` before the search fallback at L301-305.
- Any overview failure becomes UNAVAILABLE for that tool call:
  - the 3 s timeout
  - an Admin error or throttle
  - the 30 s memo from finding 2
- The UNAVAILABLE text tells the model to answer from `<store_data>`, which already holds the turn's own search. So the shopper still gets an answer, but the extra category or budget search that D94 added does not run.
- **Fix:** in `browse`, catch the `overviewOf` failure and go straight to `searchProductBlocks(said, ctx)`. That path needs no Admin call apart from the live check.

## 8. LOW: every chat message waits for a fresh cart.js read

- `widget/src/panel/panel.ts:379` awaits `cartSummaryNow` (`widget/src/cart.ts:97-100`) before the POST starts.
- That is one storefront round trip on every message, capped at 1.5 s. The latency was not measured.
- Opening the panel also calls `refreshCart` (`panel.ts:577`), so the first message after opening reads cart.js twice.
- The race doesn't abort the read, and the timer isn't cleared; both are harmless.
- Server side, `cartAddedTitles` (`src/lib/chat/turn.ts:305`, called at L560) adds one query on `cart_events_conversation_idx`, run before the answer.
- **Fix:** start the read on input focus or the first keystroke, or reuse the state refreshed on open (plus our own adds) while it is only seconds old.

## 9. LOW: OpenAI input tokens per turn went up; cost per page view is new

The model is set by env, so figures are in tokens.

**Per answer call:**
- **System prompt (measured):** `SYSTEM_PROMPT` grew from 1,760 to 5,638 chars, and `LARGE_SYSTEM_PROMPT` from 1,653 to 5,531. That is about +3.9k chars, roughly +1k tokens, on **every answer call**: the first one, each tool round, and any escalation.
- **History card titles:** `turn.ts:188-191` appends each assistant row's card titles (`cartTitle` caps each at 80 chars) to the 20-message history. This history goes to every answer round, and the last 6 messages go to the rewrite. Cards per answer are not hard-capped, since tool results add products. *Estimate:* 5 cards × about 70 chars over 10 assistant rows is about 3.5k chars, roughly 900 tokens per call when the history is full.
- **Cart line:** `src/lib/chat/prompt.ts:113-116`, up to 20 items of at most 80 + 80 + 40 chars. Worst case about 4k chars, roughly 1k tokens. Typical carts are far smaller.
- **Tool rounds:** each round sends all of the above again (up to 3 tool rounds plus the final answer). `store_overview`, `browse_collection` and `order_status` results add up to 3–3.9k chars each.

**Per page view (product questions):**
- One small-model call per (product, locale, content hash): instructions of about 1k chars, content capped at 6,000 chars, output under 300 chars.
- Upper bound: products × locales actually viewed, for example 20k × 6 = 120k calls, once.
- After that, a product is only generated again when its content hash changes.

**Action:** after a day of traffic, check p50/p95 of `messages.input_tokens` (already saved per answer) against last week.

## 10. LOW: animations added today that are not composited

All three are new today, reduced motion turns each one off, and none runs on page load.

| Animation | Where | Cost | Fix |
|---|---|---|---|
| `.panel` `transition: width .24s, height .24s` on Expand (`.wide`; desktop sizes, from `FULL_BELOW = 640`) | `widget/src/panel/styles.ts:11, 21` | Re-lays out the panel and its message list every frame for 240 ms. | Snap the size and fade, or scale with a transform. |
| `.stx` shimmer, `background-position` infinite | `styles.ts:73-74` | Repaints every frame while the status line shows (until the first text), on one line of text. | Acceptable. |
| `ac-swap`, `filter: blur(2px)` for 180 ms on button label swaps | `widget/src/cards.ts:612-615` | Negligible. | None needed. |

## 11. INFO: bundle sizes are within budget, but the launcher's headroom is thin

| File | gzip now | gzip at 3c9176e | Budget |
|---|---|---|---|
| askcart-launcher.js (every storefront page) | 3,436 B | 2,435 B (+41%) | 4,096 B: **660 B left** |
| askcart-widget.js (on click) | 24,499 B | 17,489 B (+40%) | 30,720 B |
| askcart-ask-ai.js | 1,715 B | new | 10,240 B |
| embed.js | 1,891 B | | 4,096 B |
| askcart-hosted.js | 24,600 B | | 30,720 B |

The launcher now ships the auto-insert code to every page, including pages where it never runs. The build fails when a budget is exceeded (`scripts/build-widget.mjs`), so this is a heads-up only.

## 12. LOW: what `store_overview` says at 5k–20k products

- The cost does not grow with the catalogue: one Admin query, cached 10 min per store per process.
- The answer degrades with size:
  - Types and tags are counted over the **first 50 products** in Shopify's default order (`admin-tools.ts:116`). The text says "counted in the first 50" (L186), but at 20k that is not representative.
  - Collections are the first 50 alphabetically (L112). A collection past those is not matched and gets the search fallback (L301-305).
  - The code handles `productsCount` precision `AT_LEAST` ("at least N"). Whether a 20k store hits Shopify's count limit depends on the pinned API version; not verified.
- The browse fallback at 20k costs one search: about 30 ms in Postgres plus about 370 ms for the query embedding, per the scale report, plus one live check.
- The cart summary is fixed in size (at most 20 lines).

## 13. LOW: logo upload operations

- Every upload, including a retry after the 20 s READY poll times out (`logo.ts:89-94`), creates a new Shopify Files entry. Earlier logos are never deleted, so `askcart-logo-*` files pile up in the merchant's Files.
- The worst-case request takes about 60 s: 10 s stage + 20 s PUT + 10 s create + up to 20 s of polling. That fits nginx's `proxy_read_timeout 120s`.
- Memory is fine: `readSmallBytes` stops past 2 MB, with 6 uploads a minute per store.

## 14. LOW: errors swallowed silently, and log volume

- `turn.ts:560` `cartAddedTitles(...).catch(() => [])` hides DB errors with no log. Add a `console.warn` with the storeId.
- `settleEach` (`jobs.ts:71`) logs the **whole error object** for every failed job. A `GraphqlQueryError` carries the response body.
  - In a throttled bulk edit (finding 4), that is one entry per attempt, up to 6 per job.
  - pm2-logrotate is in the deploy doc (`deploy-ec2.md:109`), so the disk is safe, but the log becomes noise.
  - Log `e.message` plus the store id instead.

## 15. Operations and deployment

- **Migrations:** 0021 and 0022 (`product_questions` + RLS) are in order in `drizzle/meta/_journal.json`: idx sequential, `when` strictly increasing (checked). Updating runs `migrate` before `pm2 restart` (`deploy-ec2.md:346`).
- **Deploy order:** the server and its migrations must go out **before** `shopify app deploy` releases the auto block. Otherwise product pages call a route that doesn't exist yet, and the skeleton collapses. L346-349 lists the server first, but doesn't say the order matters; say it.
- **Env vars:** none added today. Every `process.env.*` read is in `.env.example` or the deploy doc (checked).
- **Health check:** there is no health endpoint. pm2 only restarts a crashed process, so a hung process is not detected. This predates today.
- **Scopes:** `write_files,read_files` were added to both tomls and `src/lib/shopify/api.ts:8`, and the doc covers re-approval (`deploy-ec2.md:230`).
  - **Open question (not verified):** `session.ts:32-42` skips the token exchange while stored tokens are valid. After a merchant re-approves, does the stored token carry the new scopes at once, or only after the next refresh?
  - Test on the dev store: re-approve, then upload a logo straight away.

## Checked and fine

- **Memory in long-lived processes.** The maps and caches added today:
  - `overviews` drops expired entries on each fetch.
  - `overviewInflight` and the questions' `inflight` delete themselves in `finally`.
  - `lastRefresh` is swept on each write.
  - `refreshCalls` is a WeakMap.
  - `overviewFailed` is bounded by the number of stores.
  - The rate-limit `windows` map sweeps itself above 5k keys.
  - No unbounded growth.
- **Thundering herd on a popular product's questions:** simultaneous misses share one OpenAI call (`inflight`, single instance). Later requests read the DB row. Generation runs outside any transaction (`product-questions.ts:97-129`), so no pool connection is held during the 5 s call. The pool is `max: 10` (`src/db/client.ts`), shared by chat and workers.
- **order_status** (`src/lib/chat/orders.ts`): 3 s timeout with the turn's signal (L102-106). A failure becomes one sentence for the model plus a `console.warn` with the store id and error name only. The query is bounded: 5 orders × 10 line items × 5 fulfillments × 3 tracking entries.
- **Timeouts on the other new paths:**
  - Admin tools and refresh_product: 3 s
  - questions: 5 s OpenAI
  - cart.js: 1.5 s
  - logo: 10 s per Admin call, 20 s PUT
  - Each failure becomes a sentence for the model or an empty list for the widget, never a broken turn.
- **The pg-boss batch itself:** `perJobResults` + `settleEach` fail only the job that threw, and the queue's 5 retries with backoff apply per job.
