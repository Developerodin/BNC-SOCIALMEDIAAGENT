# Partner Connect: Multi-Store, Portal-Initiated Connect Flow, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks in the same wave (see "Parallel build waves") own disjoint files and can be built by separate agents at the same time.

**Goal:** Any merchant who uses the Social Media Agent portal can connect their own Shopify store from inside the portal. The portal sends the merchant's browser to AskCart. AskCart installs itself on the store if needed and shows a consent screen inside Shopify admin, where only that store's staff can approve. The portal then receives a one-time code and swaps it, server to server, for a revocable AskCart token for that one store. With that token it reads `/api/partner/orders`, `/products` and `/shop` exactly as today. The store always comes from the token, never from the request.

**Scope:** the portal's proposed contract (points 1–6, below) plus the four refinements the portal was told to expect: PKCE, token format and lifetime, consent by authenticated store staff, and a scopes list ready for later writes. It carries D69, D70, D73 and D90 and replaces D73's "locked server-side to B&C's store" with "locked server-side to the store the token was issued for". That replacement needs the user's OK, which is part of **C31**.

**Built right after M5 (M5 is done).** The task numbers use a `P` prefix (P0–P11) so they don't collide with M6's numbering, and the decision numbers continue from M5's C20–C29 at **C30**.

**Out of scope (later):**
- the merchant's "Connected apps" list with a Disconnect button in the dashboard (M7, see **C35**). The backend revoke-by-id is cheap, but the UI is M7's,
- write scopes (`write:*`) and any customer data (D73). The scope list reserves the names, and nothing grants them,
- a shared rate limit across instances (M10),
- self-serve portal registration for other developers (**C36**).

**The portal's proposed contract (the basis, unchanged unless a refinement says so):**
1. AskCart registers the portal: `client_id` + `client_secret`, and an allow-list of exact `redirect_uri`s.
2. `GET /partner/connect?shop=<x>.myshopify.com&state=<opaque>&redirect_uri=<allow-listed>&client_id=<id>` in the browser. Install AskCart if needed, show consent, then redirect to `redirect_uri?code=<one-time, ~5 min>&state=<unchanged>&shop=<shop>`.
3. `POST /api/partner/token` `{ code, client_id, client_secret, redirect_uri }` → `{ access_token, shop: { domain, name, currencyCode }, scopes }`. The token is per store and per portal client, revocable, read-only and never a Shopify token.
4. The read endpoints keep their shape and take `Authorization: Bearer <access_token>`. The store comes from the token.
5. `DELETE /api/partner/token` (Bearer) revokes. Uninstall and `shop/redact` revoke every token for the store, so the portal's next call gets 401 and it shows "reconnect".
6. Rate limit per token, logs without tokens, and no customer data.

**Refinements this plan adds (the portal was told to expect them):**
- **PKCE (S256) is required:** `code_challenge` + `code_challenge_method=S256` on `/partner/connect`, and `code_verifier` on `/api/partner/token`.
- **Optional `scope`** on `/partner/connect` (space-separated). Default: every scope the client is registered for.
- **Token format:** opaque `ack_…`, long-lived until revoked (**C32**). The response adds `token_type: "Bearer"`.
- **Consent happens inside Shopify admin**, so the approver is proven to be staff of that exact store (design point (a)).
- **Errors follow OAuth 2.0 (RFC 6749) codes**, so any OAuth client library understands them.

**Contract addition from the portal (2026-11-24, accepted in full):**
1. `DELETE /api/partner/token` revokes the **whole grant**: the access token, its refresh token, and everything else issued from the same code or grant, not just the token presented.
2. It accepts an **expired** (otherwise valid) access token, or the refresh token.
3. It is idempotent: `204` when already revoked.
4. The portal's client handles either token model (one long-lived opaque token, or access + refresh). It uses PKCE S256 on both ends, and **checks that `shop.domain` in the token response equals the shop the user typed**.

This plan models it as a **`partner_grants`** record (store, client, scopes, created and revoked timestamps) that every token hangs off. Revocation is always per grant: one `UPDATE partner_grants SET revoked_at`, and every token of that grant stops at once.

**Architecture (one connect):**
1. **Portal → `GET /partner/connect`** (top-level browser, our domain). It checks `client_id`, the exact `redirect_uri`, `shop`, `state` and the PKCE challenge, then saves a **connect request** (10 min to approve) and redirects:
   - AskCart active on the shop → the **embedded consent page** deep link: `https://admin.shopify.com/store/<handle>/apps/<app-handle>/app/partner-consent?request=<id>`,
   - not installed (or uninstalled) → Shopify's **install link** for the shop. After the install the merchant clicks Connect in the portal again (**C34**).
2. **Consent page inside Shopify admin** (`/app/partner-consent`, App Bridge). The page fetches the request with a fresh session token. The server proves the user is logged into *this* shop's admin (session token `dest` = the request's shop) and runs `authenticateEmbedded`, which also gives the store its offline Shopify token on a first open. The page shows "Allow <portal name> to read this store's products, orders and shop details".
3. **Allow → `POST /api/app/partner-consent`.** The server exchanges the same session token for a short **online** token, used only to read `associated_user` (who is clicking) and `associated_user_scope` (what this staff member may see). It checks the approver rule (**C30**) and then throws the online token away. It mints a one-time code, saves its hash, and returns the redirect URL. The page sends the top window to `redirect_uri?code&state&shop`.
4. **Portal → `POST /api/partner/token`** with code, client credentials, `redirect_uri` and `code_verifier`. The code is used once (atomically) and checked against the client, `redirect_uri` and PKCE. It becomes a **grant** (store, client, scopes) plus its tokens: one `ack_…` access token, plus an `ackr_…` refresh token if C32 picks access + refresh. All are sha256 at rest.
5. **Portal → read endpoints** with `Bearer ack_…`. The guard hashes the token and finds the row. It checks the token isn't expired and its grant isn't revoked, then the scope, the rate limit and that the store is active. It passes `{ storeId, shop }` to the unchanged `queries.ts`.
6. **Portal → `DELETE /api/partner/token`** with the access token (even if expired) or the refresh token. This revokes the grant, so every token of it stops.

**Tech stack:** as M5, with nothing new to install. Node `crypto` for randomness, hashing and PKCE, `@shopify/shopify-api` 15.1.2 `tokenExchange` (online), Drizzle + Postgres with RLS, Next.js 16.4.6 route handlers, App Bridge (already loaded by `src/app/(embedded)/layout.tsx`) and Polaris web components.

**Spec:** this file plus product.md D69, D70, D73, D88–D90. The current implementation is `src/lib/partner/**`, `src/app/api/partner/**`, `docs/partner-api.md` and `tests/api/partner-*.test.ts` (commit `ed15d9b`). The earlier plans' Global Constraints still apply.



## Decisions (user, 2026-11-24): every recommendation accepted

C30 = (a): any staff member who can open AskCart and see orders and products may approve (agencies included).
C31 = (a): keep the old B&C shared secret alongside the new tokens until the portal switches, then remove it (P11).
C32 = (a): long-lived opaque tokens, valid until disconnected (access + refresh stays a switch).
C33 = (a): a new connection of the same store to the same portal replaces the old grant.
C34 = (a): after a first-time install, the merchant clicks Connect again.
C35 = (b): a small "Connected apps" list with Disconnect on the AskCart home page now (M7 is not soon).
C36 = (a): only the user's own portal, registered by script.
C37 = (a): add the data-sharing line to the privacy policy and app listing now.
Speed mode: tests first, one combined 4-lens review at the end.


## Research notes (checked 2026-11-24)

The Shopify AI toolkit wasn't available, so these come from shopify.dev pages and Shopify community threads fetched directly. Items marked **verify** get a step in Task P0 on the dev store before any code relies on them.

**Session tokens (ID tokens)** ([session tokens](https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens))
- Claims: `iss` (the shop's `/admin`), `dest` (the shop URL), `aud` (our client id), `sub` (**the user the token was issued for**), `exp`/`nbf`/`iat`, `jti`, and `sid` (one session per user and app). The token is signed HS256 with our app secret.
- Lifetime is about one minute, so fetch a fresh one with `shopify.idToken()` for every request.
- **This is the proof we need at consent.** Only a page running inside the admin of shop X, for a logged-in user of X who may open AskCart, can get a token whose `dest` is X. A page on our own domain outside admin can't get one at all.

**Online access tokens by token exchange** ([token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange))
- `requested_token_type = urn:shopify:params:oauth:token-type:online-access-token`, with the session token as `subject_token`.
- The response carries `associated_user` { `id`, `account_owner`, `collaborator`, `email`, `email_verified` } and `associated_user_scope`, which is **the intersection of the app's scopes and the user's own permissions**. A staff member without order access gets a scope string without `read_orders`.
- The token expires after 24 h or on admin logout, and has no refresh token. If the user lacks access, the error has `ACCESS_DENIED` in `errors[n].extensions.code`.
- The installed library types this as `session.onlineAccessInfo.{associated_user, associated_user_scope}` (`node_modules/@shopify/shopify-api/dist/ts/lib/auth/oauth/types.d.ts`).
- **Can a non-embedded page in our app get an online token?** Only through the authorization code grant (`/admin/oauth/authorize` with `grant_options[]=per-user`, a callback, HMAC check and a state cookie). Shopify now steers apps away from that flow to managed installation and token exchange ([app installation](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation)). It still exists, and it is the fallback design (F) below if Task P0 finds the embedded deep link unusable.

**Managed installation and install links**
- Scaffolded apps install through Shopify managed installation: the merchant approves the toml scopes, and the app gets tokens by token exchange on first load. That is what `authenticateEmbedded` already does.
- The app-installation page **doesn't document an install-link URL or a return path.** In the community, managed-install apps use a store-specific link: `https://admin.shopify.com/store/<handle>/oauth/install?client_id=<api key>` (and the older `https://<shop>/admin/oauth/install?client_id=`). Custom-distribution apps use a signed `oauth/install_custom_app` link from the Partner Dashboard, and listed apps use their App Store page. **Verify** which link works for AskCart's distribution on the dev store, and where the merchant lands after the install.
- A community thread reports that a link to `https://admin.shopify.com/apps/<app-handle>` (with no store) works for an installed app ([thread](https://community.shopify.dev/t/managed-install-direct-link-to-open-embedded-shopify-from-marketing-site/20204)). No official page says whether a path and query after the handle survive **an install**. Treat it as lost: that is why **C34** exists.

**Embedded deep links**
- `https://admin.shopify.com/store/<handle>/apps/<app-handle>/<path>?<query>` loads our iframe at `<application_url>/<path>?<query>` plus Shopify's own `embedded, hmac, host, id_token, locale, session, shop, timestamp`. The forwarding is reported by developers, not documented ([thread](https://community.shopify.dev/t/embedded-app-iframe-now-loads-at-app-url-apps-handle-instead-of-app-url-404-on-open-for-some-shops/35338)).
- The same thread reports Shopify sometimes loading `<application_url>/apps/<handle>`, which Shopify staff later said was fixed. **Verify** that the path and our `request` query reach `/app/partner-consent` on an installed dev store.
- **Leaving the iframe:** after Allow, the page must send the *top* window to the portal. **Verify** that `window.open(url, "_top")` works under App Bridge (`app-bridge.js`), and whether App Bridge v4 needs its own navigation call for external URLs.

**Next.js 16.4.6** (`node_modules/next/dist/docs/01-app/03-api-reference/`)
- `03-file-conventions/route.md`: route handlers take `GET/POST/DELETE(request: Request)`. A handler that reads `request.url`/headers is dynamic. Keep M4's rule of no `runtime` export under `cacheComponents: true`.
- `04-functions/redirect.md`: `redirect()` sends **307** (and is called outside `try`). For the OAuth redirects we return `Response.redirect(url, 302)` ourselves, which is what OAuth clients expect and is unambiguous for a GET.
- `04-functions/cookies.md`: `cookies().set` only works in route handlers and server functions. **The design uses no cookies.** The iframe is a third-party context where browsers block or partition them, and session tokens replace them.
- `src/proxy.ts` already sets `frame-ancestors 'none'` on every non-`/app` page, so `/partner/connect` can't be framed, and `/app/*` may be framed only by `admin.shopify.com` and the shop.


## Design decisions with security reasoning

### (a) How the merchant is proven to be that store's staff: consent inside Shopify admin (decided)

| Option | Proves "staff of this shop"? | Cost | Verdict |
|---|---|---|---|
| **E. Embedded consent page** (deep link into AskCart in admin; App Bridge session token, plus an online-token exchange for user details) | Yes. `dest` = the shop and `sub` = the user, signed by Shopify. The online exchange adds owner and collaborator flags and the user's own permissions. | One page, one API route. Reuses `authenticateEmbedded`. No cookies. | **Chosen** |
| F. Top-level OAuth on our domain (`/admin/oauth/authorize?grant_options[]=per-user` → our callback → our consent page) | Yes, with an online token from the code grant | Callback route, HMAC check, a signed state cookie, our own consent-page session and CSRF token, and still a separate embedded load to get the offline token | Fallback only if P0 fails |
| G. Public consent page on our domain with no Shopify login | **No.** Anyone with the link could approve. | n/a | Rejected |

Why E is safe:
- **The approver is bound to the store:** the server refuses unless the session token's `dest` hostname equals the connect request's `shop` (404, to reveal nothing).
- **Their permissions are checked too:** `associated_user_scope` must include the Shopify scope behind every granted partner scope (`read_orders` for `read:orders`, `read_products` for `read:products`). A staff member who can't see orders in admin can't hand orders to a portal. Who else may approve (owner only, collaborators?) is **C30**.
- **No CSRF:** Allow is a `POST` with `Authorization: Bearer <session token>`. A cross-site form can't produce one.
- **No clickjacking:** the page only renders data after App Bridge hands it a session token, which only happens inside admin. `src/proxy.ts` limits framing to admin and the shop.
- **The online token is thrown away** right after the check. It is never stored or logged. We store only the Shopify user id of the approver (no email; it's PII).

### (b) When AskCart isn't installed (decided, with C34 for the UX)

`/partner/connect` checks `stores.active` for the shop:
- **active** → the consent deep link,
- **missing or inactive** → the install link verified in P0. The merchant approves AskCart's scopes in Shopify admin, AskCart opens on its home page, and `authenticateEmbedded` creates the store and its offline token as for any install.

Whether the consent request survives the install is undocumented (research notes), so the safe default is that it doesn't. The connect request stays pending for 10 minutes. The portal tells the merchant "Finish installing AskCart, then click Connect again", and the second click goes straight to consent. Auto-resuming the pending request on the app home is **C34** (b), with its risk spelled out there.

An installed app whose offline token has expired is still `active`. The consent page's `authenticateEmbedded` call does a fresh exchange, so the portal's reads work right after consent.

### (c) Authorization code (decided)

- **32 random bytes, base64url (43 chars).** Only `sha256(code)` is stored (`partner_connect_requests.code_hash`, unique).
- **5 minutes** from Allow (`code_expires_at`). The connect request itself expires 10 minutes after `/partner/connect` if nobody approves.
- **Single use, atomically:** `UPDATE … SET status='exchanged' WHERE code_hash=$1 AND status='approved' AND code_expires_at > now() RETURNING …`. Two parallel exchanges: exactly one wins.
- **Replay = theft signal** (RFC 6749 §4.1.2): a code that is already `exchanged` returns `invalid_grant` **and revokes the grant issued from it** (`partner_grants.connect_request_id`), so its access and refresh tokens die together.
- **Bound to the client:** `client_id` must equal the request's, and `redirect_uri` must equal the request's byte for byte (and it was already an exact allow-list match at connect).
- **PKCE S256 required:** `code_challenge` (43 base64url chars) and `code_challenge_method=S256` at connect. At the token call, `base64url(sha256(code_verifier)) === code_challenge`, compared in constant time, with a verifier of 43–128 chars from `[A-Za-z0-9-._~]`. `plain` is refused. Why PKCE when the portal also has a secret: it stops a code that leaks (browser history, a referrer, a log on the portal side) from being redeemed by anyone who also got the secret, and it is the OAuth 2.1 default for every client. The portal was warned.
- **`state` is passed through untouched:** stored as given (1–512 printable ASCII characters, else `invalid_request`) and returned unchanged on both success and error redirects. **The portal must bind `state` to the merchant's own portal session** (and look the PKCE verifier up through that session, not through `state` alone). That is what stops a merchant who is tricked into approving someone else's connect link from connecting the attacker's portal account to their store. This is written into `docs/partner-api.md` as a portal requirement.

### (d) Token format and lifetime (decided format, PENDING lifetime C32)

- **Format:** `ack_` + 43 base64url characters (32 random bytes, 256 bits). The prefix lets AskCart (and GitHub-style secret scanners) recognise a leaked token, and lets the guard tell new tokens from the legacy secret without a database call.
- **At rest:** only `sha256(token)` (hex, unique index), plus `token_prefix` = the first 12 characters (`ack_` + 8) for logs and the future M7 list. Plain sha256 is enough: the token has 256 bits of entropy, so a stolen hash can't be brute-forced, and a slow hash would cost every request.
- **Opaque, not a JWT:** each request already reads the database (store active check), so a self-contained token saves nothing. It would also make revocation need a deny-list.
- **Grant and tokens:** a **grant** is the merchant's approval: one store, one client, a scope set, `created_at` and `revoked_at`. Tokens are rows under a grant with `kind` = `access` | `refresh` and an optional `expires_at`. Validity = the token is not expired, **and** its grant is not revoked, **and** the store is active. Revocation never touches tokens one by one. It sets `partner_grants.revoked_at`, which kills every token of the grant in one statement. That is what the portal's contract addition (1) asks for.
- **Lifetime, recommended (C32 (a)):** one access token with no `expires_at`, valid until its grant is revoked (by the portal, by uninstall, by redact, by a replayed code, or by the merchant in M7). `last_used_at` is updated at most once an hour.
- **Ready either way:** if C32 picks access + refresh, the same tables carry it:
  - the access token gets `expires_at = now() + 1 h`,
  - a refresh token `ackr_…` is issued alongside, and the token endpoint accepts `grant_type=refresh_token`,
  - each refresh rotates the refresh token (the old one stops), and **a reused old refresh token revokes the whole grant** (theft signal, like a replayed code).

  The portal already supports both models.
- **Why (a) is recommended over access + refresh:** refresh pays off when tokens are carried in many places or can't be revoked centrally. Here both sides are servers, every call is checked against the database, and revocation is immediate. Refresh would add a second secret and a refresh race on the portal (the same problem D70 avoided for Shopify tokens).

### (e) Client registration (decided)

- Table `partner_clients`: `client_id` (text `pc_` + 16 random base64url), `name` (shown on the consent screen), `secret_hash` (sha256 hex of `pcs_` + 32 random bytes), `redirect_uris text[]` (exact strings, `https:` only, no fragment; `http://localhost` allowed only when `NODE_ENV !== 'production'`), `allowed_scopes text[]`, `created_at`, `disabled_at`.
- Seeded by a CLI script, `scripts/partner-client.mjs` (`create | list | rotate-secret | set-redirects | disable`), on `DATABASE_ADMIN_URL`, like `seed-faq.mjs`. The secret is printed **once** and never stored in plain text.
- **Matching:** `redirect_uri` is an exact string match against the list: no prefix, no wildcard and no normalisation. An unknown `client_id` or a non-matching `redirect_uri` **never redirects**. It shows an error page on our domain, so `/partner/connect` can't be used as an open redirector.
- `rotate-secret` replaces the hash right away. A two-secret overlap isn't needed while there is one portal; that is noted as a ceiling.

### (f) Scopes (decided)

`src/lib/partner/scopes.ts` is the single list:

| Partner scope | Grantable now | Endpoint | Shopify scope the approver must hold |
|---|---|---|---|
| `read:shop` | yes | `GET /api/partner/shop` | none (any staff who can open AskCart) |
| `read:products` | yes | `GET /api/partner/products` | `read_products` |
| `read:orders` | yes | `GET /api/partner/orders` | `read_orders` |
| `write:products`, `write:orders`, `read:customers` | **reserved, refused** (`invalid_scope`) | none yet | decided with write and customer scopes later (D73) |

The granted set is: the requested `scope` (or the client's `allowed_scopes` when omitted), intersected with what is grantable, and it must be non-empty. Write scopes later need three things: a new AskCart Shopify scope in the toml (merchants re-approve), the reserved name moved to grantable, and **a fresh consent**. Existing tokens never gain scopes.

### (g) Revocation (decided; the merchant-facing list is M7)

- **The unit of revocation is the grant.** Every path below sets `partner_grants.revoked_at` and `revoked_reason`, and never revokes a single token alone.
- **`APP_UNINSTALLED`:** in the same transaction that deactivates the store, `UPDATE partner_grants SET revoked_at = now(), revoked_reason = 'app_uninstalled' WHERE store_id = … AND revoked_at IS NULL`, and every pending or approved connect request for that shop is set to `expired`. A reinstall does **not** bring grants back: the portal must reconnect.
- **`shop/redact`:** `shopRedact` deletes the store, and `partner_grants` and `partner_tokens` go with it (`ON DELETE CASCADE`). It also deletes the shop's `partner_connect_requests` (keyed by shop domain, so they have no foreign key).
- **Belt and braces:** the guard also refuses a token whose store isn't active, so a token is dead the moment the uninstall commits, even if a revoke failed.
- **The portal:** `DELETE /api/partner/token` with any token of the grant, including an expired access token or the refresh token.
- **M7 (note only):** "Connected apps" in the dashboard lists active grants for the store (client name, scopes, connected on, last used, approved by) with Disconnect. Until then see **C35**.

### (h) Migration from the B&C-only secret (PENDING C31)

**Recommended:** run both side by side until the portal switches, then remove the old one. The guard tries the token path when the Bearer value starts with `ack_`, and otherwise the legacy `PARTNER_STORE_DOMAIN` + `PARTNER_API_SECRET` path, unchanged. When the portal confirms it has switched, Task P11 deletes the legacy path and the two env vars. Until then, unsetting `PARTNER_STORE_DOMAIN` turns the legacy path off (401 instead of today's 404, because the endpoints now exist for token holders).

### (i) Rate limits (decided)

- **Reads:** the existing `rateLimit(key)` (60 per minute, fixed window, in memory) is keyed by `partner_tokens.id` for token callers and by the secret hash for legacy, so each store connection has its own budget.
- **`POST /api/partner/token`:** `rateLimit("token:" + client_id)`, checked after client authentication, so unauthenticated junk can't drain a real client's budget. Bad secrets aren't limited, for the same reason as today (a 256-bit secret can't be guessed).
- **`/partner/connect`:** no limit. It only writes a short-lived row, and nothing happens without staff approval. Expired rows are cleaned on each insert (see failure modes).
- **Ceiling:** in-memory, so N instances allow N × 60 and a restart resets counts. This moves to Postgres or Redis with M10.


## Full HTTP contract

All JSON responses carry `Cache-Control: no-store`. None send CORS headers. Logs carry `token_prefix`, token id, client id and store id only, never a token, code, client secret, code verifier or `state`.

### `GET /partner/connect` (browser, our domain)

Query:

| Param | Required | Rule |
|---|---|---|
| `client_id` | yes | a registered, non-disabled client |
| `redirect_uri` | yes | exact match in the client's list |
| `shop` | yes | `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` after lowercasing |
| `state` | yes | 1–512 printable ASCII characters |
| `code_challenge` | yes | 43 base64url characters |
| `code_challenge_method` | yes | `S256` |
| `scope` | no | space-separated, a subset of the client's `allowed_scopes`; default all of them |

Responses:
- **Bad or missing `client_id` or `redirect_uri`:** `400` HTML error page ("This connect link is not valid"), **no redirect**.
- **Any other invalid param:** `302` to `redirect_uri?error=invalid_request&error_description=<code>&state=<state if valid>`. `error_description` is one of `invalid_shop, invalid_state, invalid_code_challenge, unsupported_code_challenge_method`, or `invalid_scope` (with `error=invalid_scope`).
- **OK:** a connect request is saved, then `302` to the consent deep link (AskCart active on the shop) or to the install link (not installed). `Referrer-Policy: no-referrer`.

### `GET /api/app/partner-consent?request=<id>` (embedded, `Authorization: Bearer <session token>`)

- `authenticateEmbedded`, and the session token's shop must equal the request's shop.
- `200 { clientName, shop: { domain, name }, scopes: ["read:orders", …], expiresAt }`.
- **Errors:**
  - `401` invalid session,
  - `404 { error: "not_found" }` for an unknown request, another shop's request, or one that isn't pending,
  - `410 { error: "expired" }`.

### `POST /api/app/partner-consent` (embedded, Bearer session token), body `{ requestId, decision: "allow" | "deny" }`

- **allow:**
  1. online token exchange,
  2. approver rule (**C30**) and permission check (f),
  3. atomic `pending → approved` with `code_hash` and `code_expires_at = now() + 5 min`,
  4. `200 { redirectUrl: "<redirect_uri>?code=<code>&state=<state>&shop=<shop>" }`.
- **deny:** `pending → denied`, then `200 { redirectUrl: "<redirect_uri>?error=access_denied&state=<state>&shop=<shop>" }`.
- **Errors:**
  - `403 { error: "staff_permission_missing", missing: ["read_orders"] }`,
  - `403 { error: "approver_not_allowed" }` (C30),
  - `404`,
  - `409 { error: "already_decided" }` (a double click),
  - `410 { error: "expired" }`.
- The page then runs `window.open(redirectUrl, "_top")` (P0-verified).

### `POST /api/partner/token` (server to server), JSON body ≤ 4 kB

```json
{ "grant_type": "authorization_code", "code": "…", "client_id": "pc_…", "client_secret": "pcs_…",
  "redirect_uri": "https://portal.example/askcart/callback", "code_verifier": "…" }
```

`grant_type` is optional and, when present, must be `authorization_code`.

`200`:

```json
{ "access_token": "ack_…", "token_type": "Bearer",
  "shop": { "domain": "x.myshopify.com", "name": "B&C", "currencyCode": "INR" },
  "scopes": ["read:orders", "read:products", "read:shop"] }
```

- **Only if C32 picks access + refresh:** the response also has `"expires_in": 3600, "refresh_token": "ackr_…"`, and the endpoint also accepts `{ "grant_type": "refresh_token", "refresh_token", "client_id", "client_secret" }`. That returns a new access token and a new refresh token for the same grant, with the same response shape. Under the recommended (a), neither field appears and `refresh_token` is `unsupported_grant_type`.
- `shop.domain` is always the grant's store. **The portal compares it with the shop the user typed**, and drops the token (DELETE) if they differ. `shop.name` and `currencyCode` come from `stores`. When either is null, they are fetched with `fetchShop` from `queries.ts`.

Errors (RFC 6749 §5.2):
- `400 invalid_request`: bad JSON, a missing field, or the wrong content type,
- `401 invalid_client`: unknown, disabled or wrong secret, sent with `WWW-Authenticate: Basic`,
- `400 invalid_grant`: unknown, expired, used, wrong client, wrong `redirect_uri`, bad PKCE, or the store is no longer active,
- `400 unsupported_grant_type`,
- `429 rate_limited` with `Retry-After`.

### `DELETE /api/partner/token` (`Authorization: Bearer <access or refresh token>`)

- **Revokes the whole grant** the token belongs to (`partner_grants.revoked_reason = 'portal'`): every access and refresh token issued from that code or grant stops at once.
- **Accepts an expired access token** or a refresh token (`ack_…` or `ackr_…`). The lookup is by hash only, ignoring `expires_at`. An expired token still proves the portal once held that grant, which is what revocation needs.
- **Idempotent:** `204` when the grant was active, already revoked, or the token is unknown (RFC 7009 style, so nothing leaks). `400 invalid_request` when there is no Bearer value.
- No client secret is required. The token itself is the proof, and revoking can only reduce access.

### `GET /api/partner/{orders,products,shop}` (`Authorization: Bearer ack_…`)

The query parameters, response bodies and the 400/403/502/503 errors don't change. Auth outcomes, in order:

| Check | Response |
|---|---|
| no or bad Bearer, unknown or expired token, a refresh token used as access, grant revoked, store inactive | `401 { error: "invalid_token" }` + `WWW-Authenticate: Bearer error="invalid_token"`. The portal shows "reconnect". |
| token lacks the endpoint's scope | `403 { error: "insufficient_scope", scope: "read:orders" }` |
| over 60/min for this token | `429 { error: "rate_limited" }` + `Retry-After` |
| `?shop=` or any shop header | ignored, as today |

The legacy secret path keeps today's responses until P11 (`401 unauthorized`, `503 store_not_connected`).


## Data model (Task P1, migration `0014_partner_connect.sql`)

```
partner_clients            -- no store_id, so not under RLS; app_user: SELECT only
  client_id text PK, name text not null, secret_hash text not null,
  redirect_uris text[] not null, allowed_scopes text[] not null,
  created_at timestamptz default now(), disabled_at timestamptz

partner_connect_requests   -- keyed by shop domain (the store may not exist yet), so no store_id and no RLS
  id uuid PK default gen_random_uuid(),            -- goes in the deep link; 122 random bits
  client_id text not null references partner_clients,
  shop_domain text not null, redirect_uri text not null, state text not null,
  code_challenge text not null, scopes text[] not null,
  status text not null check (status in ('pending','approved','denied','exchanged','expired')),
  expires_at timestamptz not null,                 -- now() + 10 min
  code_hash text unique, code_expires_at timestamptz,
  approved_by_user_id text, decided_at timestamptz, exchanged_at timestamptz,
  created_at timestamptz default now()
  index (shop_domain), index (expires_at)

partner_grants             -- the merchant's approval; the unit of revocation. RLS ENABLE + FORCE (has store_id)
  id uuid PK, store_id uuid not null references stores on delete cascade,
  shop_domain text not null,                       -- denormalised for logs and the M7 list
  client_id text not null references partner_clients,
  scopes text[] not null,
  connect_request_id uuid unique references partner_connect_requests on delete set null,
  granted_by_user_id text,                         -- Shopify staff user id; no email
  created_at timestamptz not null default now(),
  revoked_at timestamptz, revoked_reason text      -- 'portal' | 'app_uninstalled' | 'code_replay' | 'refresh_replay' | 'reconnect' | 'merchant'
  index (store_id, client_id) where revoked_at is null

partner_tokens             -- hang off a grant; RLS ENABLE + FORCE (has store_id)
  id uuid PK, grant_id uuid not null references partner_grants on delete cascade,
  store_id uuid not null references stores on delete cascade,   -- copy of the grant's, for RLS
  kind text not null check (kind in ('access','refresh')),
  token_hash text not null unique, token_prefix text not null,
  expires_at timestamptz,                          -- null = until the grant is revoked (C32 (a))
  replaced_at timestamptz,                         -- refresh rotation only (C32 (c)); a used old refresh token = theft
  created_at timestamptz not null default now(), last_used_at timestamptz
  index (grant_id)
```

**RLS while looking up by hash.** The guard and DELETE don't know the store until they find the token. `partner_tokens` gets a policy that allows either key:

```sql
CREATE POLICY store_or_token ON partner_tokens USING (
  store_id = nullif(current_setting('app.store_id', true), '')::uuid
  OR token_hash = nullif(current_setting('app.partner_token_hash', true), ''));
```

`partner_grants` keeps the plain `store_isolation` policy. The helper `forTokenHash(hash, fn)` works in three steps, all transaction-local like `forStore`:
1. it sets `app.partner_token_hash` and reads the one token row,
2. it sets `app.store_id` to that row's `store_id`,
3. it runs `fn(tx, token)`, which can join the grant.

App code can only ever see the store whose token it holds, so tenant isolation is unchanged. Inserts and revokes otherwise run under `forStore`.


## Global constraints

- **The store comes only from the token** (or legacy env). No route reads `shop` from the query, headers, host or body for authorization, except `/partner/connect`, where `shop` is the *requested* store and is then proven by the session token at consent.
- **Never log or return secrets.** Tokens, codes, client secrets, code verifiers, Shopify tokens and online tokens never appear in logs, error bodies or URLs we produce, except the code in the one redirect to the allow-listed `redirect_uri`. Every new test file includes a `console.*` spy assertion.
- **Hash every bearer secret at rest** with sha256 and compare in constant time (`timingSafeEqual` on equal-length digests, as `auth.ts` does now).
- **No open redirect.** Only exact allow-listed `redirect_uri`s, and only after the client is known.
- **`queries.ts` is reused as is.** `PartnerStore` stays exported from `auth.ts` with the same shape.
- **No customer data.** The scope list can't grant it (D73).
- **D49 items:** the consent screen wording and the error page text are drafts until the user approves them.
- **One owner per file** (see waves). `src/db/schema.ts` and `drizzle/**` belong to P1 only.

## Review focus (one combined 4-lens review at the end, D90)

1. **Cross-store consent:** a session token for shop B can't read or approve a request for shop A (404, and the row is unchanged). Task P5.
2. **Code replay and race:** two parallel exchanges → one grant. A third (replay) → `invalid_grant`, and that grant is revoked with all its tokens. Task P6.
2b. **Grant-wide revoke (the portal's contract addition):** DELETE with the access token, an expired access token, or the refresh token revokes the grant, so every token of it stops. It returns 204 again when repeated, and leaves other grants alone. Task P6.
3. **Binding:** the right code with another client, another `redirect_uri` or a wrong verifier → `invalid_grant`. Task P6.
4. **Open redirect:** an unknown client or a near-miss `redirect_uri` (trailing slash, different case, extra query) → 400 page, no `Location`. Task P4.
5. **Store from token only:** a token for store A with `?shop=B` reads A. A revoked token, or a token whose store is inactive → 401. Task P7.
6. **Revocation on uninstall and redact** across all of the store's tokens, and none of another store's. Task P8.
7. **No secrets in logs** across the whole flow. Task P10.
8. **Permissions:** staff without `read_orders` can't grant `read:orders`. Task P5.

---

### Task P0: Dev-store checks that the design relies on

**Depends on:** nothing. Manual, run alongside P1 and P2.

**Files:** Create `tests/live/partner-connect.dev-store.md` (results and the exact URLs that worked).

- [ ] **Step 1:** On the installed dev store, open `https://admin.shopify.com/store/<handle>/apps/<app-handle>/app/partner-consent?request=test123` and record the iframe URL. Does the path reach `/app/partner-consent`, and does `request=test123` survive? Try the `/apps/<handle>` form without the store too.
- [ ] **Step 2:** On a second dev store **without** AskCart, try `https://admin.shopify.com/store/<handle>/oauth/install?client_id=<api key>` and `https://<shop>/admin/oauth/install?client_id=<api key>`. Record which one installs, where the merchant lands afterwards, and whether any appended path or query survives.
- [ ] **Step 3:** In a throwaway embedded page, check that `window.open("https://example.com/?x=1", "_top")` leaves admin. If not, find App Bridge v4's documented external navigation.
- [ ] **Step 4:** Call `shopify.auth.tokenExchange({ requestedTokenType: OnlineAccessToken })` with a live session token. Record the `onlineAccessInfo` fields for the owner and for a staff account with no Orders permission. Is `read_orders` missing from `associated_user_scope`, or is the exchange refused?
- [ ] **Step 5:** Write the outcome into the file. **If Step 1 fails** (path or query lost even when installed), stop and switch P4/P5 to fallback design F (top-level OAuth), then tell the user before building.
- [ ] **Step 6:** Commit with the message "Record the dev-store checks for the partner connect flow".

### Task P1: Tables, migration and RLS

**Depends on:** nothing.

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0014_partner_connect.sql`, `drizzle/meta/*` (generated), `src/lib/partner/db.ts` (`forTokenHash`)
- Test: `tests/db/partner-tables.test.ts`

- [ ] **Step 1:** Write the tests:
  - with `app.store_id` = A, a grant or token row of B isn't visible,
  - with `app.partner_token_hash` = h, exactly the token with that hash is visible and nothing else, and `forTokenHash` then sees that token's grant and no other store's grants,
  - deleting a store deletes its grants and tokens, and deleting a grant deletes its tokens,
  - `kind` rejects `'foo'`, and `connect_request_id` is unique on grants (one grant per code),
  - the `status` check rejects `'foo'`,
  - `code_hash` and `token_hash` are unique,
  - `app_user` can't `INSERT` into `partner_clients`,
  - the existing "every table with a store_id has RLS" test passes untouched.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Add the four tables (data model above), generate the migration, and append the RLS policy and `GRANT`s by hand, as `0013_widget_rls.sql` does. Add `forTokenHash`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add tables for portal clients, connect requests, grants and tokens".

### Task P2: Scopes and secret helpers (the shared contract)

**Depends on:** nothing.

**Files:**
- Create: `src/lib/partner/scopes.ts`, `src/lib/partner/secrets.ts`
- Test: `tests/partner/scopes.test.ts`, `tests/partner/secrets.test.ts`

**Interfaces:**
- `scopes.ts`: `PARTNER_SCOPES` (the table in (f)), `type PartnerScope`, `GRANTABLE`, `parseScopeParam(s, allowed): PartnerScope[] | { error }`, `SHOPIFY_SCOPE_FOR: Record<PartnerScope, string | null>`, and `ENDPOINT_SCOPE = { orders: "read:orders", products: "read:products", shop: "read:shop" }`.
- `secrets.ts`:
  - `newToken(kind: "access" | "refresh")` → `{ token, hash, prefix }` (`ack_` or `ackr_`),
  - `newCode()` → `{ code, hash }`,
  - `newClientSecret()`,
  - `sha256Hex(s)`,
  - `safeEqualHex(a, b)`,
  - `verifyPkceS256(verifier, challenge): boolean`,
  - `isValidVerifier`, `isValidChallenge`, `isValidState`,
  - constants `ACCESS_PREFIX = "ack_"`, `REFRESH_PREFIX = "ackr_"`, `CODE_TTL_MS = 300_000`, `REQUEST_TTL_MS = 600_000`, and `TOKEN_MODEL: "long_lived" | "access_refresh"` (C32, default `"long_lived"`) with `ACCESS_TTL_MS = 3_600_000` used only by `"access_refresh"`.

- [ ] **Step 1:** Write the tests:
  - RFC 7636 Appendix B vector (`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`),
  - `plain` is impossible by construction,
  - verifiers of 42 and 129 characters are refused,
  - tokens start with `ack_`, are 47 characters long, are unique over 1,000 draws, and `prefix` is the first 12,
  - `write:orders` is refused by `parseScopeParam`, and an empty result is an error,
  - `state` with a control character or over 512 characters is refused.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`).
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add partner scopes, token and PKCE helpers".

### Task P3: Portal registration script

**Depends on:** P1, P2.

**Files:**
- Create: `scripts/partner-client.mjs`
- Test: `tests/partner/client-script.test.ts`

Commands: `node --env-file=.env scripts/partner-client.mjs create --name "Social Media Agent" --redirect https://… [--redirect …] [--scopes read:orders,read:products,read:shop]`, plus `list`, `rotate-secret <client_id>`, `set-redirects <client_id> --redirect …` and `disable <client_id>`. It uses `DATABASE_ADMIN_URL` (a developer tool, like `seed-faq.mjs`). It prints `client_id` and the secret once, with a "store this now; it can't be shown again" line.

- [ ] **Step 1:** Write the tests:
  - a created client's printed secret verifies against the stored hash using `sha256Hex` from `secrets.ts`, so the script and the server agree,
  - a non-https redirect is refused unless `--dev`,
  - a reserved scope is refused,
  - `rotate-secret` makes the old secret fail,
  - `list` never prints a hash.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. The script can't import TS, so it inlines the same two hashing lines, and the test locks that they match.
- [ ] **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add a script to register partner portals".

### Task P4: `GET /partner/connect`

**Depends on:** P1, P2, and P0's link formats.

**Files:**
- Create: `src/app/partner/connect/route.ts`, `src/lib/partner/connect.ts`
- Test: `tests/api/partner-connect.test.ts`

**Interfaces:** `startConnect(url: URL): Promise<Response>`, `consentUrl(shop, requestId)`, `installUrl(shop)` (formats from P0; app handle from new env `SHOPIFY_APP_HANDLE`, API key from `SHOPIFY_API_KEY`), and `errorPage(code)` (static HTML, no reflected input).

- [ ] **Step 1:** Write the tests:
  - **Review Focus 4:** an unknown client, a disabled client, and a `redirect_uri` with a trailing slash, different case or extra query each get 400 with no `Location` header,
  - a bad shop, missing state or `plain` method → 302 to `redirect_uri` with `error` and the state unchanged, byte for byte (a state with `&`, `=` and `%` is URL-encoded once and round-trips),
  - an active store → the consent URL holds the new request id, and the row has `pending`, `expires_at` about 10 minutes out, and `scopes` = the client's default,
  - an inactive or missing store → the install URL,
  - the response has `Referrer-Policy: no-referrer`,
  - expired rows older than a day are deleted on insert,
  - the request id never appears in logs.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement (`Response.redirect(url, 302)`, no `runtime` export, and the cleanup `DELETE … WHERE expires_at < now() - interval '1 day'` before the insert).
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add the portal connect entry point".

### Task P5: Consent in Shopify admin

**Depends on:** P1, P2, and P0's results.

**Files:**
- Create: `src/app/api/app/partner-consent/route.ts`, `src/lib/partner/consent.ts`, `src/app/(embedded)/app/partner-consent/page.tsx`
- Test: `tests/api/partner-consent.test.ts`

**Interfaces:**
- `getConsent(req)` and `decideConsent(req)` implement the contract above.
- `staffCheck(sessionToken, shop, scopes)` → `{ userId } | { error, missing? }`. It calls `shopify.auth.tokenExchange({ shop, sessionToken, requestedTokenType: RequestedTokenType.OnlineAccessToken })`, reads `onlineAccessInfo`, applies **C30** (built behind one constant `APPROVER_RULE` set to the recommended option until decided), and discards the session.
- `authenticateEmbedded` from `session.ts` is reused without changes.
- **The page:**
  - Polaris `s-page` "Connect <portal name>",
  - what it can read, as bullets, and what it can't ("customer names, emails, phone numbers or addresses", "change anything"),
  - Allow and Cancel buttons,
  - the expiry and permission errors shown in words.
  - On success it runs `window.open(redirectUrl, "_top")`.

- [ ] **Step 1:** Write the tests (`tokenExchange` and `decodeSessionToken` mocked, as in `tests/shopify/session.test.ts`):
  - **Review Focus 1:** a shop B token on a shop A request → 404 on GET and POST, and the row stays `pending`,
  - **Review Focus 8:** `associated_user_scope` without `read_orders` → 403 `staff_permission_missing`, and no code is minted,
  - allow → `approved`, `code_hash` set, `code_expires_at` about 5 minutes out, `approved_by_user_id` = the Shopify user id, and the returned URL has `code`, `state` unchanged and `shop`,
  - the hash of the returned code equals the stored `code_hash`,
  - a second allow → 409,
  - deny → `access_denied`,
  - an expired request → 410,
  - an online-exchange `ACCESS_DENIED` → 403,
  - the online access token and the code never reach `console.*`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. The approve step is one conditional `UPDATE … WHERE id = $1 AND status = 'pending' AND expires_at > now()`.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add the portal consent screen in Shopify admin".

### Task P6: Token endpoint (exchange and revoke)

**Depends on:** P1, P2.

**Files:**
- Create: `src/app/api/partner/token/route.ts`, `src/lib/partner/tokens.ts`
- Test: `tests/api/partner-token.test.ts`

**Interfaces:**
- `exchangeCode(body)`: authenticates the client, checks the rate limit, then in one transaction:
  1. selects the request by `code_hash` `FOR UPDATE`,
  2. if it's `exchanged`, revokes its token (`revoked_reason = 'code_replay'`) and returns `invalid_grant`,
  3. checks status, expiry, `client_id`, `redirect_uri` and PKCE,
  4. sets `exchanged`,
  5. resolves the active store by `shop_domain`,
  6. applies **C33** (built behind one constant, default = recommendation; "replace" revokes the old grant with `revoked_reason = 'reconnect'`),
  7. under `forStore`, inserts the **grant**, then its access token (and, only when `TOKEN_MODEL = "access_refresh"`, a 1 h `expires_at` plus a refresh token).

  It returns the response above.
- `refreshGrant(body)`: built only for `TOKEN_MODEL = "access_refresh"`, otherwise `unsupported_grant_type`. It checks the client, then the refresh token (its grant is live and belongs to this client). It rotates: the old refresh row gets `replaced_at`, and a new access and refresh token are issued on the **same grant**. A refresh token presented after `replaced_at` revokes the grant (`refresh_replay`).
- `revokeGrantByToken(token)`: `forTokenHash` with no expiry filter, then `UPDATE partner_grants SET revoked_at = now(), revoked_reason = 'portal' WHERE id = token.grant_id AND revoked_at IS NULL`. Always 204.
- `PartnerStore` isn't touched.

- [ ] **Step 1:** Write the tests:
  - **Review Focus 2:** `Promise.all` of two exchanges → exactly one 200, then a replay → `invalid_grant`, and the grant is revoked, so the first access token (and its refresh token, under `access_refresh`) gets 401,
  - **the portal's contract addition:**
    - DELETE with the access token → 204, and **every token of that grant** stops working,
    - DELETE with an **expired** access token (fake timers past `expires_at`, under `access_refresh`) → 204, and the grant is revoked,
    - DELETE with the refresh token → 204, and the grant is revoked,
    - DELETE twice → 204 both times,
    - another grant of the same store and client (C33 (b) setting) is untouched,
  - under `access_refresh`: refresh rotates, the old refresh token reused → `invalid_grant`, and the grant is revoked,
  - the response `shop.domain` equals the connect request's shop,
  - **Review Focus 3:** another client's credentials, a `redirect_uri` that differs by one character, a wrong verifier, and an expired code (fake timers at +5 min + 1 s) → `invalid_grant`,
  - a wrong secret → 401 `invalid_client`,
  - non-JSON → 400,
  - a store uninstalled between consent and exchange → `invalid_grant`,
  - the response has `Cache-Control: no-store` and the token isn't in the DB in plain text (only its sha256),
  - DELETE with an unknown token → 204, and with no header → 400.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Add the partner token exchange and revoke endpoint".

### Task P7: Bearer tokens on the read endpoints

**Depends on:** P1, P2.

**Files:**
- Modify: `src/lib/partner/auth.ts`, `src/app/api/partner/orders/route.ts`, `src/app/api/partner/products/route.ts`, `src/app/api/partner/shop/route.ts`, `tests/api/partner-auth.test.ts`
- Create: `tests/api/partner-bearer.test.ts`
- `src/lib/partner/rate-limit.ts` and `queries.ts` are not changed.

**Interfaces:**
- `partnerGuard(req, scope: PartnerScope): Promise<PartnerStore | Response>`:
  - `ack_` → `forTokenHash` lookup (`kind = 'access'`, `expires_at IS NULL OR expires_at > now()`) joined to its grant (`revoked_at IS NULL`; scopes come from the grant) and `stores.active` → scope → `rateLimit(token.id)` → an hourly `last_used_at` touch (`UPDATE … WHERE last_used_at IS NULL OR last_used_at < now() - interval '1 hour'`),
  - anything else → the legacy path (C31).
- Each route passes its `ENDPOINT_SCOPE`.

- [ ] **Step 1:** Write the tests:
  - **Review Focus 5:** an A token with `?shop=B` and `x-shopify-shop-domain: B` → reads A (`adminGraphql` is called with A's id),
  - grant revoked → 401 with `WWW-Authenticate`,
  - expired access token → 401,
  - an `ackr_` refresh token used as Bearer → 401,
  - store inactive → 401,
  - a token with only `read:shop` on `/orders` → 403 `insufficient_scope`,
  - two tokens each get their own 60/min,
  - `last_used_at` is written once in two quick calls,
  - legacy secret calls still pass the existing `partner-auth` and `partner-data` tests, except that "unset PARTNER_STORE_DOMAIN" now gives 401 (update that one test and say so in the commit).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Authenticate partner reads with per-store tokens".

### Task P8: Revoke on uninstall and redact

**Depends on:** P1.

**Files:**
- Modify: `src/lib/shopify/webhooks.ts` (`APP_UNINSTALLED`), `src/lib/jobs.ts` (`shopRedact`)
- Test: `tests/shopify/partner-revoke.test.ts`

- [ ] **Step 1:** Write the tests:
  - **Review Focus 6:** uninstall of A → every A grant has `revoked_reason = 'app_uninstalled'` (so all their access and refresh tokens stop), B's grants are untouched, and A's pending and approved requests become `expired`,
  - the webhook replay (same id) is a no-op,
  - a reinstall (`upsertStore`) doesn't revive grants,
  - `shopRedact` removes A's grants and tokens (cascade) and A's connect requests, and keeps an active reinstalled store's rows (D65).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. The revoke runs inside `forStore(s.id, …, tx)` in the existing handler transaction, so a failure rolls back the dedupe row and Shopify retries.
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit with the message "Revoke partner tokens when a store uninstalls or is redacted".

### Task P9: Partner API docs and env

**Depends on:** this plan's contract (no code).

**Files:** Modify `docs/partner-api.md` and `.env.example` (add `SHOPIFY_APP_HANDLE`, and mark `PARTNER_STORE_DOMAIN`/`PARTNER_API_SECRET` as legacy until P11).

New `docs/partner-api.md` outline:
1. **Overview:** what a portal can read, per-store tokens, and nothing stored (D73).
2. **Register your portal:** what AskCart needs from you (name, exact redirect URIs), what you get (`client_id`, secret once), and how to rotate.
3. **Connect a store:** the sequence diagram (portal → `/partner/connect` → install if needed → consent in Shopify admin → `redirect_uri?code&state&shop` → `POST /api/partner/token`).
   - **3a PKCE:** how to make a verifier and challenge, with a code sample.
   - **3b `state`:** required, bound to the user's portal session, and checked on return. *The portal must not complete a connect whose state it didn't issue to this browser.*
   - **3c First install:** "finish installing, then click Connect again" (C34).
   - **3d Error redirects:** `access_denied`, `invalid_request`, `invalid_scope`.
4. **Exchange the code:** the request, response and errors. **Check `shop.domain` equals the shop the user typed**, and DELETE the token if not. Refresh (`grant_type=refresh_token`) is documented only if C32 picks access + refresh.
5. **Use the token:** Bearer, scopes per endpoint, 401 → reconnect, 403 `insufficient_scope`.
6. **Disconnect:** `DELETE /api/partner/token` revokes the whole grant (every token from that connect). It takes the access token, even if expired, or the refresh token, and it is idempotent (204). Also covers what uninstall and redact do.
7. **Scopes:** the table, with reserved write scopes.
8. **Limits:** 60/min per token, 60/min per client on the token endpoint.
9. **Response shape, `/orders`, `/products`, `/shop`, errors:** the current sections unchanged, with the new 401/403 rows.
10. **Security notes for portals:** store tokens encrypted, never log them, strip `code` from your URL after use (send `Referrer-Policy: no-referrer` on the callback), and rotate a secret if leaked.
11. **Legacy shared secret:** how it works until the switch date (C31), then removed.
12. **Example:** a curl flow end to end.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Commit with the message "Document the partner connect flow".

### Task P10: End-to-end check with a stand-in portal, plus review

**Depends on:** P3–P9 merged.

**Files:**
- Create: `scripts/partner-connect-smoke.mjs` (a tiny local portal: makes the verifier and state, opens the connect URL, listens on `http://localhost:<port>/callback`, exchanges, calls `/shop`, `/products`, `/orders`, then DELETE), `tests/api/partner-flow.test.ts`
- Append to `tests/live/partner-connect.dev-store.md`

- [ ] **Step 1:** `partner-flow.test.ts` runs the whole flow in-process (session token and online exchange mocked):
  - connect → consent → token → `/shop` → uninstall webhook → `/shop` 401,
  - **Review Focus 7:** a spy on `console.*` across the run finds none of the token, code, client secret, verifier, state or online token.
- [ ] **Step 2:** On the dev store:
  - register a dev client with the localhost callback, run the smoke script, and approve as the owner, then as a staff account without Orders (expect the permission message),
  - uninstall and confirm the 401,
  - reinstall, run it again, and record a second store connected with the same client (multi-store).
- [ ] **Step 3:** Run the combined 4-lens review (D90) against the Review Focus list. Fixes go through the owning tasks' files, one agent at a time.
- [ ] **Step 4:** Commit with the message "Check the partner connect flow end to end".

### Task P11: Remove the legacy shared secret (after the portal switches; waits on C31)

**Depends on:** the portal confirming it uses tokens for B&C, and C31.

**Files:** Modify `src/lib/partner/auth.ts`, `tests/api/partner-auth.test.ts`, `tests/api/partner-data.test.ts` (switch them to tokens), `docs/partner-api.md` §11 and `.env.example`.

- [ ] Steps: a test that `Bearer <old secret>` → 401 → FAIL → remove the legacy branch → PASS → commit "Remove the legacy partner shared secret".


## Parallel build waves

Each wave starts when the tasks it depends on are merged. Inside a wave, every task owns its files exclusively.

| Wave | Tasks (run together) | File ownership |
|---|---|---|
| **1** | **P0** dev-store checks (manual) | `tests/live/partner-connect.dev-store.md` |
| | **P1** tables | `src/db/schema.ts`, `drizzle/0014_*`, `drizzle/meta/*`, `src/lib/partner/db.ts`, `tests/db/partner-tables.test.ts` |
| | **P2** scopes and secrets | `src/lib/partner/scopes.ts`, `src/lib/partner/secrets.ts`, `tests/partner/{scopes,secrets}.test.ts` |
| **2** | **P3** registration script | `scripts/partner-client.mjs`, `tests/partner/client-script.test.ts` |
| | **P4** connect | `src/app/partner/connect/route.ts`, `src/lib/partner/connect.ts`, `tests/api/partner-connect.test.ts` |
| | **P5** consent | `src/app/api/app/partner-consent/route.ts`, `src/lib/partner/consent.ts`, `src/app/(embedded)/app/partner-consent/page.tsx`, `tests/api/partner-consent.test.ts` |
| | **P6** token endpoint | `src/app/api/partner/token/route.ts`, `src/lib/partner/tokens.ts`, `tests/api/partner-token.test.ts` |
| | **P7** Bearer guard | `src/lib/partner/auth.ts`, `src/app/api/partner/{orders,products,shop}/route.ts`, `tests/api/partner-auth.test.ts`, `tests/api/partner-bearer.test.ts` |
| | **P8** revocation | `src/lib/shopify/webhooks.ts`, `src/lib/jobs.ts`, `tests/shopify/partner-revoke.test.ts` |
| | **P9** docs | `docs/partner-api.md`, `.env.example` |
| **3** | **P10** end to end and review | `scripts/partner-connect-smoke.mjs`, `tests/api/partner-flow.test.ts`, appends to `tests/live/partner-connect.dev-store.md` |
| **later** | **P11** remove legacy | `src/lib/partner/auth.ts`, `tests/api/partner-{auth,data}.test.ts`, `docs/partner-api.md`, `.env.example` |

**Notes:**
- Wave 2 has seven independent agents. P4 and P5 read P0's results. If P0 Step 5 triggers fallback F, P4 and P5 are re-planned (a callback route replaces the embedded page) before they start. P3, P6, P7, P8 and P9 are unaffected.
- P6 (writes tokens) and P7 (reads tokens) share only P1's columns and P2's helpers, both merged in Wave 1. Neither imports the other.
- P7 is the only task that changes `auth.ts`, and `PartnerStore` keeps its shape, so `queries.ts` and `partner-data.test.ts` stay untouched.
- Shared files that only one task may change: `src/db/schema.ts` and `drizzle/**` (P1), `src/lib/partner/scopes.ts` and `secrets.ts` (P2; a later change needs a short note in the PR and Wave 2 rebased), `.env.example` (P9). P4 reads `SHOPIFY_APP_HANDLE` but doesn't edit `.env.example`.
- **No task touches** `src/lib/partner/queries.ts`, `params.ts`, `rate-limit.ts`, `src/lib/shopify/session.ts` or `src/lib/stores.ts`.


## Failure modes and ceilings

| What happens | Behaviour | Handled? |
|---|---|---|
| The merchant closes the tab mid-flow | The request expires after 10 minutes, and the portal never gets a code. The portal times out its own state. | Yes |
| Double click on Allow | The conditional update lets one through, and the second gets 409. The page ignores 409 if it already redirected. | Yes |
| The portal retries the token call after a network drop | The first call used the code, so the retry is `invalid_grant` **and revokes the token the first call issued**. The portal must reconnect. That is the RFC trade-off (theft protection beats retry convenience), and it is documented for the portal. | Deliberate |
| Two parallel exchanges | One wins (`FOR UPDATE` plus a status check). | Yes |
| The store uninstalls between consent and exchange | `invalid_grant`. | Yes |
| The uninstall webhook is delayed or lost | The guard refuses tokens of inactive stores. If the webhook never arrives, the store is still active in our DB and so are its tokens. That's the same exposure as today's Shopify token. | Partly: depends on Shopify delivery and retries |
| The online token exchange fails (Shopify down) | 502 on Allow, with "Try again". Nothing changes. | Yes |
| The offline token expires later | The reads return today's `503 store_reconnect_needed`. The merchant opens AskCart once, and the partner token stays valid. | Yes (existing) |
| The deep link loses the path or query on install | C34 (a): the merchant clicks Connect again. | Yes |
| The deep link loses it even when installed | P0 stops the build and switches to fallback F. | Gate |
| A client secret leaks | `rotate-secret`. Grants already issued stay valid, so revoke them by client with SQL until M7. | Partly. **Ceiling:** no "revoke all grants of a client" command; add it to the script if needed. |
| A token leaks | Revoke the grant by the portal (DELETE, even with an expired token), by uninstall, or by M7 Disconnect. Read-only, no customer PII (D73), 60/min. | Yes |
| The portal lost its only live token but still has an expired one | DELETE with the expired token still revokes the grant. | Yes |
| DELETE succeeds but the portal's network drops before the 204 | A retry gets 204 again (idempotent). | Yes |
| Refresh race (only under C32 (c)): two portal workers refresh at once | The second presents an already-rotated refresh token, which revokes the grant, so the portal must reconnect. The portal must serialise refreshes. That's the cost named in C32. | Deliberate |
| Many instances | The rate limit is per instance (×N). Moves to M10's shared store. | Ceiling |
| `partner_connect_requests` growth | Rows older than a day are deleted on each new connect. A store that never connects again leaves at most a day of rows. | Yes |
| Per-request cost | One indexed lookup by hash plus the store join, and one write per hour per token. | Fine to about 1,000 req/s |
| Clock skew | All expiry uses the DB's `now()`, never the app clock. | Yes |


## Open decisions (PENDING)

Nothing that depends on a pending choice is final until the user decides. Where a task needs a default to keep moving, it builds the recommended option behind one constant and says so.

- **C30 Who in a store may approve a portal connection.**
  - (a) any staff member who can open AskCart **and** can see orders and products in Shopify admin,
  - (b) the store owner only,
  - (c) anyone who can open AskCart, whatever their other permissions.
  - **Recommended: (a).** A staff member can only share what they can already see, and owners don't become a bottleneck. Collaborators (agencies) count as staff under (a). If you'd rather keep agencies out, say so and we add that one check.
- **C31 The old B&C-only shared secret.**
  - (a) keep it working next to the new tokens until the portal has switched, then remove it,
  - (b) switch it off as soon as the new flow ships,
  - (c) keep both for good.
  - **Recommended: (a).** The portal keeps working while it changes over, and the old single-store secret then disappears, leaving one way in to secure. This also replaces D73's "locked to B&C's store" with "locked to the store the merchant approved".
- **C32 How long a portal's access lasts.**
  - (a) until it is disconnected (by the portal, by uninstalling AskCart, or later by the merchant in the dashboard),
  - (b) like (a), but it also stops after 90 days without use,
  - (c) a short pass renewed every hour with a second "renewal" code.
  - **Recommended: (a).** It's simple for the portal and can be cut off instantly at any time. (b) is a small safety net if the portal might abandon connections. (c) adds work on both sides and buys little here, because every request is already checked live and disconnecting is instant. The portal said it can handle either, and the tables are built so (c) is a switch, not a rebuild.
- **C33 When the same store connects to the same portal again.**
  - (a) the new connection (grant) replaces the old one, and the old access stops,
  - (b) both stay active side by side.
  - **Recommended: (a).** There's never a forgotten second key to the same store. If one store will be connected from two separate portal workspaces, choose (b).
- **C34 After AskCart is installed for the first time during a connect.**
  - (a) the merchant lands on AskCart's home page and clicks Connect in the portal once more,
  - (b) AskCart's home page picks up the waiting request by itself and shows the approval screen.
  - **Recommended: (a).** One extra click, but a merchant can never be shown an approval that someone else started. (b) is smoother, but only safe if the portal always checks the return code, so (a) doesn't depend on that.
- **C35 How a merchant disconnects a portal before the dashboard's "Connected apps" page (M7).**
  - (a) wait for M7. Until then they disconnect from the portal, or by uninstalling AskCart,
  - (b) add a small "Connected apps" list with a Disconnect button to the AskCart home page now (about half a day).
  - **Recommended: (a)** if M7 follows soon after, otherwise (b). A merchant should always be able to cut access from their own side.
- **C36 Which portals can connect.**
  - (a) only your own Social Media Agent, registered by us with a script,
  - (b) later, other developers' portals too, after a review by you.
  - **Recommended: (a) now,** and decide (b) when there's a real request. Every outside portal adds a party that holds access to merchants' sales data.
- **C37 Telling merchants about data shared with portals.** Sharing order data with another service is a privacy topic under Shopify's protected customer data rules (D73).
  - (a) add a line to AskCart's privacy policy and app listing now ("with your approval, AskCart can share product, order totals and shop details with connected services you choose; never customer details"),
  - (b) add it at App Store submission.
  - **Recommended: (a).** The consent screen already says it, and the policy should match before any real merchant connects.

Decided in this plan (no user input needed, reasoning above): consent inside Shopify admin (a), PKCE required (c), opaque `ack_` tokens hashed with sha256 under a revocable grant (d), grant-wide idempotent revocation that accepts expired or refresh tokens (the portal's contract addition), clients in a DB table with an exact redirect match (e), the scope names (f), revocation on uninstall and redact (g), and per-token rate limits (i).


## Sources

- Session tokens (claims, lifetime): https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
- Token exchange, online tokens and `associated_user` / `associated_user_scope`: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
- Managed installation (no install-link or return-path documentation): https://shopify.dev/docs/apps/build/authentication-authorization/app-installation
- Authorization code grant (fallback F): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Store-agnostic link into an installed embedded app (community): https://community.shopify.dev/t/managed-install-direct-link-to-open-embedded-shopify-from-marketing-site/20204
- Iframe path and query forwarding reports (community, staff said fixed): https://community.shopify.dev/t/embedded-app-iframe-now-loads-at-app-url-apps-handle-instead-of-app-url-404-on-open-for-some-shops/35338
- Custom-app install links and parameters (community): https://community.shopify.com/t/install-custom-app-link-doesnt-allow-additional-parameters/118621/1
- RFC 6749 (OAuth 2.0: §4.1.2 code reuse, §5.2 errors), RFC 7636 (PKCE, Appendix B vector), RFC 6750 (Bearer, `WWW-Authenticate`), RFC 7009 (revocation responses)
- Next.js 16.4.6 local docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, `04-functions/redirect.md`, `04-functions/cookies.md`
