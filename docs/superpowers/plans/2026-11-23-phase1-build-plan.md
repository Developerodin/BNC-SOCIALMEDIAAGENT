# Shop Assistant: Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Next.js app that a merchant installs from Shopify. It syncs their catalog and serves an AI chat widget on their storefront. Phase 1 only reads from Shopify.

**Architecture:**
- One Next.js app (App Router) runs as a single Node process on EC2 under PM2, with PostgreSQL and pgvector on the same server.
- Shopify reaches it in three ways:
  - the **embedded admin** (`/app/*`, App Bridge plus Polaris web components),
  - **webhooks** (`/api/webhooks/shopify`),
  - a **theme app extension** (the chat app embed and the FAQ / "Ask about this product" app blocks), which calls our public APIs.
- Our own site (`/dash/*`) reuses the same API routes.

**Tech Stack:**
- TypeScript, Next.js App Router, React 19, Node 22 LTS, npm
- Drizzle ORM, PostgreSQL + pgvector
- `@shopify/shopify-api`, Shopify CLI
- Vitest
- pg-boss, OpenAI
- Better Auth, shadcn/ui, Polaris web components
- AWS S3, Caddy, PM2

**Spec:** `product.md` (D1–D56) and `ui-ux.md` (UD1–UD25b). Where the two conflict, the decisions logs win.

## How the app gets into Shopify

1. **Development** (milestone M1):
   - Run `shopify app config link` to link this folder to the app in your Partner / Dev Dashboard account. This writes `shopify.app.toml`.
   - `shopify app dev` reads `shopify.web.toml` and starts `npm run dev`. It also:
     - opens a Cloudflare tunnel,
     - updates the app URLs,
     - pushes scopes and webhooks from the toml,
     - deploys the theme app extension as a draft,
     - prints an install link for your dev store.
   - Opening that link runs **Shopify-managed install**. Shopify shows the consent screen with `read_products` and `read_inventory`, then opens our `/app` page inside the admin iframe.
   - On first load, the page's session token is exchanged for an expiring offline token. That creates the `Store` row.
2. **Production** (milestone M10):
   - Run `shopify app deploy` to push the config and extension version.
   - The app URL points to `https://app.<domain>` on EC2.
   - Distribution is **public, unlisted** (D14): merchants install through a link from the Partner dashboard until the App Store listing.

## Milestones

Each milestone gets its own detailed plan when the previous one is done, so the plans are written against real code. Only M1 is detailed below.

| # | Milestone | Done when |
|---|---|---|
| **M1** | **Foundation and Shopify install** | `shopify app dev` installs on the dev store, the embedded Home shows the store name, the tokens are stored encrypted, uninstall and the GDPR webhooks work, and the cross-store leak test passes |
| M2 | Product sync (§7.3) | Uses the pg-boss queue from M1 for bulk sync, product webhooks grouped for 60 s, scheduled re-check (D47), and sync progress on Home |
| M3 | Retrieval (§7.5) | Chunk, embed (512 / halfvec), and `search(storeId, query, k=8)` returns the right store's products |
| M4 | Chat API (§7.6) | SSE chat with server-minted tokens, small→large escalation, markers and live cards, masking, D35 limits, and chat history across pages (UD13) |
| M5 | Storefront extension (§7.7, UD1–UD18) | App embed plus Shadow DOM widget, cards, add to cart, persistence, feedback, i18n and a11y, plus the FAQ block and the "Ask about this product" block |
| M6 | PDFs (§7.4) | S3 upload, unpdf, tesseract OCR, and indexing |
| M7 | Embedded dashboard (§7.12, UD19–UD25) | Polaris pages: Home checklist and metrics, Knowledge + FAQ, Conversations, Settings with live preview, and 6 languages |
| M8 | Suggestions report (§7.8) | Four sources, weekly scan, read-only report |
| M9 | Our own site (§7.2 door 2) | Better Auth, account linking after email verification, store picker, shadcn pages, dark mode, language picker |
| M10 | Limits, privacy and production (§7.9, §7.10, §8b, D45–D46, D61–D64) | Rate and spend limits, Turnstile, retention job, token-refresh job, EC2 + PM2 + Caddy, nightly backups, staging EC2 + staging Shopify app, Prometheus metrics endpoint + Grafana alerts + external uptime ping on `/api/health`, k6 load test, `shopify app deploy`, and D49 copy approved |

## Global Constraints

- Phase 1 scopes are exactly `read_products,read_inventory` (D29). Nothing writes store data. The only exception is the app-owned `AppInstallation` metafield (§7.2).
- Offline tokens are **expiring** (token exchange with `expiring`). Tokens are stored with AES-256-GCM, a key-id prefix, and `storeId` as AAD.
- Every store-owned query goes through `forStore(storeId, fn)`, and Postgres RLS checks `current_setting('app.store_id')` (D42).
- Webhooks: verify the HMAC on the raw body, dedupe on `X-Shopify-Webhook-Id`, and answer within 5 s.
- `storeId` in dashboard routes comes only from the session, never from request parameters.
- Every HTML response carries a CSP `frame-ancestors` header: per shop on `/app*`, and `'none'` everywhere else (an App Store requirement).
- The runtime DB role is never a superuser, because superusers bypass RLS.
- App Bridge `<script>` comes right after `<meta name="shopify-api-key">`, as a plain blocking tag in server HTML (not `next/script`). Polaris comes after it. `SHOPIFY_API_KEY` must be set at build time too.
- Commit messages describe the change only: no co-author, session link, or test mentions (CLAUDE.md §0).

## Review Focus

Items 6–8 were added by the 4-lens review on 2026-11-23.

1. **Two first loads at once** (the merchant double-opens the app) must not create two `Store` rows or lose a token. `shopDomain` is unique, and the store upsert must hold up. Test in Task 4.
2. **Reinstall after uninstall** must reactivate the same `Store`, get fresh tokens, and keep the data if `shop/redact` hasn't arrived yet. Test in Task 4.
3. **Concurrent token refresh**: two requests that find an expired access token must refresh exactly once. Test in Task 3.
4. **A webhook with a valid HMAC but replayed** (same webhook id) must be processed once. Test in Task 5.
5. **`shop/redact` for a store we never saw** must still return 200 and not crash. Test in Task 5.
6. **A pooled DB connection reused after `forStore`** must still see 0 rows, not throw. Test in Task 2.
7. **The admin frames the app for a shop we don't know, or for a malformed `shop`** must give `frame-ancestors 'none'`. Test in Task 4.
8. **A webhook handler fails halfway** and must not be marked done, so Shopify's retry runs it again. Test in Task 5.

---

### Task 1: Project skeleton, local DB, and Shopify link

**Files:**
- Create (by tools): the Next.js app in the repo root via `npx create-next-app@latest . --ts --app --eslint --src-dir --import-alias "@/*" --use-npm`
- Create: `docker-compose.yml`, `.env.example`, `shopify.web.toml`, `vitest.config.ts`, `.gitignore` additions (`.env`, `.shopify/`)
- Modify: `shopify.app.toml` (created by `shopify app config link`)
- Test: `tests/smoke.test.ts`

- [ ] **Step 1:** `git init`, then run create-next-app as above. Next.js may refuse a non-empty folder, so move `product.md`, `ui-ux.md`, `agent.md` and `docs/` aside and back. Expected: `npm run dev` serves on port 3000.
- [ ] **Step 2:** `docker-compose.yml` with the service `db: image pgvector/pgvector:pg17`, port `5432:5432`, user, password and db `shopassist`, and a named volume. Run `docker compose up -d`. Expected: `docker compose exec db psql -U shopassist -c "CREATE EXTENSION IF NOT EXISTS vector;"` succeeds.
- [ ] **Step 3:** `npm i -D vitest` and `vitest.config.ts` with the `@` alias. Write `tests/smoke.test.ts`: `expect(1).toBe(1)`. Run `npx vitest run`. Expected: PASS.
- [ ] **Step 4:** `shopify app config link`, choosing the existing app or creating "Shop Assistant". Then edit `shopify.app.toml`:
  - `[access_scopes] scopes = "read_products,read_inventory"`, with `use_legacy_install_flow = false`,
  - `[webhooks] api_version` set to the latest stable version the CLI offers. Pin that exact value, and use the same value as `apiVersion` in `shopifyApi` (Task 3).
  - subscriptions for `app/uninstalled` → `/api/webhooks/shopify`,
  - `compliance_topics = ["customers/data_request","customers/redact","shop/redact"]` → the same URI,
  - `embedded = true` and `application_url` left to the CLI.
- [ ] **Step 5:** `shopify.web.toml` in the root: `name = "web"`, `webhooks_path = "/api/webhooks/shopify"`, and `[commands] dev = "npm run dev -- --port $PORT"`. Run `shopify app dev`. Expected: the CLI prints a preview URL, and opening it on the dev store shows the consent screen listing only the two read scopes.
- [ ] **Step 6:** Commit with the message "Scaffold Next.js app, local pgvector DB and Shopify app config".

### Task 2: Database, Drizzle schema, and RLS

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `drizzle/0000_init.sql` (generated) and `drizzle/0001_rls.sql` (hand-written)
- Test: `tests/db/tenant-isolation.test.ts`

**Interfaces:**
- Produces:
  - **Two connection strings:**
    - `DATABASE_ADMIN_URL`, the owner role, used only by migrations and test seeding,
    - `DATABASE_URL`, the non-superuser role `app_user`, used by `db` at runtime. A superuser bypasses RLS, so the app must never run as one.
  - `db` (the Drizzle client on `DATABASE_URL`)
  - `forStore<T>(storeId: string, fn: (tx) => Promise<T>): Promise<T>`, which runs `fn` in a transaction after `select set_config('app.store_id', $1, true)`
  - tables:
    - `accounts(id uuid pk, createdAt)`. M9 links Better Auth users to it.
    - `stores(id uuid pk, accountId uuid not null fk → accounts, shopDomain text unique, name, active bool, installedAt, settings jsonb default '{}')`. Per D59, the first install creates the Account (§7.2).
    - `storeTokens(storeId pk fk → stores ON DELETE CASCADE, accessTokenEnc, accessExpiresAt, refreshTokenEnc, refreshExpiresAt, keyId)`
    - `webhookEvents(id text pk, topic, shopDomain, receivedAt)`
  - Other tables arrive in later milestones, and every store-owned one uses `ON DELETE CASCADE` from `stores`.
  - `tests/global-setup.ts` (Vitest `globalSetup`) runs the migrations against `TEST_DATABASE_ADMIN_URL` (database `shopassist_test`) and truncates between files.

- [ ] **Step 1:** Write `tests/db/tenant-isolation.test.ts`. Seed stores A and B, each with a `storeTokens` row, using the admin connection. Then:
  - `forStore(A, tx => tx.select().from(storeTokens))` returns only A's row,
  - a raw `db.select().from(storeTokens)` outside `forStore` returns **0 rows**, and returns 0 rows **again after a `forStore` call on the same pooled connection** (pool size 1 in this test). After a local `set_config`, the setting reverts to `''` rather than NULL, and `''::uuid` throws.
  - **RLS coverage:** every table in `public` with a `store_id` column has `relrowsecurity` and `relforcerowsecurity` set in `pg_class`. This catches future tables that forget RLS.
- [ ] **Step 2:** Run `npx vitest run tests/db`. Expected: FAIL (the modules don't exist).
- [ ] **Step 3:** `npm i drizzle-orm postgres && npm i -D drizzle-kit`. Write the schema and client, then `npx drizzle-kit generate`. `0001_rls.sql`:
  - creates the role `app_user` with `GRANT SELECT, INSERT, UPDATE, DELETE` on all tables, plus `ALTER DEFAULT PRIVILEGES` for future ones,
  - on `store_tokens` (and every future store-owned table): `ENABLE` + `FORCE ROW LEVEL SECURITY`, and a policy `USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)`.
  - `stores` itself isn't RLS-protected, because install and webhook lookups go by `shopDomain`.
- [ ] **Step 4:** `npx drizzle-kit migrate`, then `npx vitest run tests/db`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add Drizzle schema with row-level security per store".

### Task 3: Token encryption and refresh

**Files:**
- Create: `src/lib/crypto.ts`, `src/lib/shopify/api.ts`, `src/lib/shopify/tokens.ts`
- Test: `tests/crypto.test.ts`, `tests/shopify/tokens.test.ts`

**Interfaces:**
- Produces:
  - `encrypt(plain: string, storeId: string): string`, in the format `k1:<iv>:<tag>:<ct>` (base64)
  - `decrypt(enc: string, storeId: string): string`, which throws on the wrong `storeId`
  - `shopify`, the `shopifyApi({...})` instance with `apiKey`, `apiSecretKey`, `scopes`, `hostName`, `isEmbeddedApp: true` and the web-api adapter
  - `saveTokens(storeId, t: {accessToken, accessExpiresAt, refreshToken, refreshExpiresAt}): Promise<void>`
  - `getAccessToken(storeId): Promise<string>`, which refreshes when less than 5 min of validity is left, under `SELECT … FOR UPDATE` on the `storeTokens` row. The new pair is saved in the same transaction.

- [ ] **Step 1:** Write the tests:
  - encrypt then decrypt returns the same text,
  - decrypting with another `storeId` throws,
  - decrypting a tampered ciphertext throws,
  - with the refresh function mocked to resolve after 50 ms, `Promise.all([getAccessToken(A), getAccessToken(A)])` with an expired token calls the refresh **exactly once**, and both calls return the new token.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:crypto` `aes-256-gcm`, using `TOKEN_KEY` (32-byte base64) from env and `setAAD(Buffer.from(storeId))`. The refresh call is `shopify.auth.refreshToken({ shop, refreshToken })`. **Check the exact name and signature in the installed `@shopify/shopify-api` version first**, and keep it behind a small injectable function so the test can mock it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Encrypt Shopify tokens and refresh them under a row lock".

### Task 4: Embedded auth, store creation, and Home

**Files:**
- Create:
  - `src/lib/shopify/session.ts`, `src/lib/stores.ts`, `src/middleware.ts`
  - `src/app/(embedded)/layout.tsx`, `src/app/(embedded)/app/page.tsx`
  - `src/app/(site)/layout.tsx`, `src/app/(site)/page.tsx`
  - `src/app/api/app/me/route.ts`
- Delete: `src/app/layout.tsx` and `src/app/page.tsx` from create-next-app. Two **separate root layouts** in route groups mean the App Bridge tags load only on embedded pages; a nested layout can't put a blocking `<script>` in `<head>`.
- Test: `tests/shopify/session.test.ts`, `tests/stores.test.ts`, `tests/middleware.test.ts`

**Interfaces:**
- Consumes: `shopify`, `saveTokens` and `forStore`
- Produces:
  - `authenticateEmbedded(req: Request): Promise<{ storeId: string; shop: string }>`. It reads `Authorization: Bearer <idToken>`, decodes it with `shopify.session.decodeSessionToken`, and throws `Response(401)` on failure. If the store has no valid tokens, it calls `shopify.auth.tokenExchange({ shop, sessionToken, requestedTokenType: OfflineAccessToken, expiring: true })` (**check the flag name in the installed version**), then `upsertStore` and `saveTokens`.
  - `upsertStore(shopDomain): Promise<{ storeId, accountId, created: boolean }>`. In one transaction:
    - for a new store, it creates an `accounts` row, then inserts the store with that `accountId`,
    - on conflict (`shop_domain`), it sets `active = true` and keeps the existing `accountId`.

    Two simultaneous first loads must not leave an orphan account. Insert the store with `ON CONFLICT DO NOTHING RETURNING`, and if nothing came back, delete the account just created and read the existing row.
  - `GET /api/app/me` returns `{ shop, name }`. `name` is fetched once after the token exchange with the GraphQL query `{ shop { name } }` and saved on `stores.name`.
  - `middleware.ts`:
    - **`/` with a `shop` or `host` query** (Shopify opens the app URL at the root) redirects to `/app` and keeps the full query string. Without one, the request goes to the `(site)` page.
    - **iframe protection** on every HTML response:
      - `/app*` sends `Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com`. `<shop>` comes from the `shop` query param and must match `^[a-z0-9-]+\.myshopify\.com$`; otherwise the response uses `frame-ancestors 'none'`.
      - every other page sends `frame-ancestors 'none'`.

- [ ] **Step 1:** Write the tests:
  - a missing or forged bearer token gives 401,
  - the middleware gives `/?shop=a.myshopify.com&host=x` a 307 to `/app?shop=a.myshopify.com&host=x`,
  - `/app?shop=a.myshopify.com` gets a CSP containing `frame-ancestors https://a.myshopify.com https://admin.shopify.com`,
  - `/app?shop=evil.com` and `/dash` get `frame-ancestors 'none'`,
  - `Promise.all([upsertStore('a.myshopify.com'), upsertStore('a.myshopify.com')])` gives one store row, the same `storeId`, and **exactly one** `accounts` row,
  - `upsertStore` on an inactive (uninstalled) store sets `active = true` and keeps its `storeId` and `accountId`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. In `src/app/(embedded)/layout.tsx` (the root layout with its own `<html>`), the server-rendered `<head>` contains, in this order:
  - `<meta name="shopify-api-key" content={process.env.SHOPIFY_API_KEY} />`,
  - `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`,
  - `<script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script>`, using the URL current in Shopify's docs at build time (`polaris.js` or `polaris-2.js`),
  - with `{/* eslint-disable-next-line @next/next/no-sync-scripts */}` on each script.

  `page.tsx` is a client component. It calls `fetch('/api/app/me', { headers: { Authorization: 'Bearer ' + await shopify.idToken() } })` and renders `<s-page heading="Shop Assistant"><s-text>Connected to {name}</s-text></s-page>`.

  After the store is created, the initial-sync job is only a TODO hook for M2. Write the `AppInstallation` metafield in M5, when the widget config exists.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `shopify app dev` and open the app on the dev store. Expected:
  - Home shows "Connected to <store name>",
  - `select shop_domain, active from stores` has one row,
  - `store_tokens.access_token_enc` starts with `k1:`.
- [ ] **Step 5:** Commit with the message "Embedded admin auth with expiring offline token exchange".

### Task 5: Job queue, webhooks, uninstall and GDPR

**Files:**
- Create: `src/lib/jobs.ts`, `src/instrumentation.ts`, `src/app/api/webhooks/shopify/route.ts`, `src/lib/shopify/webhooks.ts`
- Test: `tests/shopify/webhooks.test.ts`, `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `shopify`, `db` and `forStore`
- Produces:
  - `handleWebhook(req: Request): Promise<Response>`. It reads the raw body once, then `shopify.webhooks.validate({ rawBody, rawRequest: req })`, giving 401 if invalid.
  - **The dedupe insert and the topic handler run in one transaction.** It inserts the `webhookEvents(id)` row `ON CONFLICT DO NOTHING`. If the row already existed, it returns 200 without processing. If the handler throws, the transaction rolls back and the route returns 500, so Shopify's retry is processed rather than skipped as a duplicate.
  - Topic handlers:
    - `app/uninstalled`: `active = false`, and the `storeTokens` row is deleted **inside `forStore(storeId)`**, because RLS hides it otherwise and the delete would silently affect 0 rows,
    - `customers/data_request` and `customers/redact`: log and return 200 (§7.10),
    - `shop/redact`: **enqueue** the job `shop-redact` with `{ shopDomain }` and return 200 (D58). The job deletes the `stores` row (`ON DELETE CASCADE` removes the rest) and then the `accounts` row if no other store uses it. S3 cleanup gets added in M6.
  - `src/lib/jobs.ts`:
    - `boss`, a pg-boss instance on `DATABASE_ADMIN_URL`, because pg-boss manages its own schema,
    - `startWorkers(): Promise<void>`, which registers `shop-redact` with retries `retryLimit: 5` and exponential backoff,
    - `enqueue(name, data, opts?)`.
  - `src/instrumentation.ts` `register()` calls `startWorkers()` only when `process.env.NEXT_RUNTIME === 'nodejs'`, so the workers run in the same process as the app (§6).
  - Unknown shops get 200.

- [ ] **Step 1:** Write the tests, signing bodies with `crypto.createHmac('sha256', SECRET).update(body).digest('base64')`:
  - a bad HMAC gives 401,
  - `app/uninstalled` sets `active = false` and leaves no token row,
  - the same webhook id sent twice is processed once (spy on the handler),
  - a handler that throws on the first delivery gives 500, and the retry with the same id is processed (gives 200 and the state changes),
  - `shop/redact` for an unknown shop gives 200,
  - `shop/redact` for a known store enqueues `shop-redact` and returns 200 without deleting anything inline,
  - in `tests/jobs.test.ts`, running the `shop-redact` handler leaves no `stores`, `store_tokens` or orphan `accounts` rows for that shop, and running it twice is harmless,
  - a valid `customers/redact` gives 200.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** `npm i pg-boss`. Implement. The route exports `POST = handleWebhook` and `runtime = 'nodejs'`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then, with `shopify app dev` running:
  - `shopify app webhook trigger --topic app/uninstalled --address <tunnel>/api/webhooks/shopify` returns 200,
  - uninstalling on the dev store marks the row inactive,
  - reinstalling reactivates the same `storeId`.
- [ ] **Step 5:** Commit with the message "Add pg-boss queue and handle uninstall and GDPR compliance webhooks".

**M1 exit check:** `npx vitest run` passes everything. Install, uninstall, then reinstall on the dev store shows Home each time, with one `stores` row.
