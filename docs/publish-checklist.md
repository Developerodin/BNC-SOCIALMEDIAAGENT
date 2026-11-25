# AskCart: Shopify App Store publish checklist

What Shopify's review checks for public distribution (listed or unlisted), with AskCart's status on 2026-11-24.
Sources: [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
[best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review).
Requirements change; re-read those pages before submitting.

Legend: ✅ done · 🔄 being built · ❌ to do · ⚠️ needs a decision · 🔍 verify

## 1. Blockers before you can even submit

- [ ] ❌ **Hosted on a public HTTPS URL** with a valid certificate (3.1.1). `application_url` and `redirect_urls` in
      `shopify.app.askcart.toml` are still `https://example.com`; Shopify also refuses domains containing "Example" or
      "Shopify".
- [ ] ❌ **`shopify app deploy`** run against the hosted URL (app config + theme app extension released).
- [ ] ❌ **Production database, secrets and workers** on the host (Postgres, `TOKEN_KEY`, `CHAT_TOKEN_SECRET`,
      `OPENAI_*`, pg-boss workers running).
- [ ] ❌ **Automated pre-submission checks** in the Partner/Dev Dashboard all pass.
- [ ] ❌ **API contact email** set, and it must not contain "shopify".
- [ ] ⚠️ **One app in review at a time**: you can't submit a second new app until each published one has 10+ paid
      installs.

## 2. Install, auth and platform

- [ ] ✅ Installs from a Shopify surface; OAuth right after install and reinstall; managed install
      (`use_legacy_install_flow = false`) (2.3.x).
- [ ] ✅ Session tokens through App Bridge for the embedded admin; no third-party cookies (1.1.1).
- [ ] 🔍 Latest App Bridge, with `app-bridge.js` loaded first (2.2.3). Check `server/src/app/(embedded)/layout.tsx`.
- [ ] 🔍 GraphQL Admin API only, no REST (2.2.4). Grep for REST calls before submitting.
- [ ] 🔍 **Expiring offline access tokens** (3.1.2). `store_tokens` has expiry and refresh columns; confirm the
      install requests expiring tokens.
- [ ] ✅ Uninstall handled (`app/uninstalled` webhook revokes partner grants).
- [ ] ❌ No 404s or 500s anywhere in the app or the widget (2.1.x). Needs a full click-through on the hosted app.
- [ ] 🔍 No API version used that deprecates within 90 days (webhooks `api_version = "2026-10"`).

## 3. Scopes and data

- [ ] ⚠️ **`read_all_orders` needs a demonstrated need** (3.2.1). It's only used by the partner and Social Media Agent
      read API. Either justify it in the submission, or drop it from the public app and keep it for custom installs.
- [ ] 🔄 `unauthenticated_read_customers` will be added by the customer-login work. Justify it: verifying a
      customer's identity for chat history.
- [ ] ✅ Mandatory compliance webhooks: `customers/data_request`, `customers/redact`, `shop/redact` are configured.
- [ ] ⚠️ **Protected customer data request** (Dev Dashboard → Access requests). Chat history plus customer IDs from
      the login work make this at least **Level 1**: minimum data, purpose limitation, retention periods (chat
      retention 30/90/365 days exists), encryption in transit and at rest, and opt-out for significant automated
      decisions. Level 2 applies only if we store name, email, phone or address (we don't; keep it that way).
      Note: this can't be requested while the app is in review.
- [ ] ❌ **Privacy policy** page on our site, linked from the listing.

## 4. Theme app extension (the storefront chat)

- [ ] ✅ Theme changes only through a theme app extension (5.1.1).
- [ ] 🔍 Renders without errors in the theme editor and on the storefront (5.1.2). `designMode` is handled; re-check
      on Dawn and Horizon.
- [ ] 🔄 Onboarding with a **deep link** that turns on the app embed (5.1.3). Being built in the "Connect your
      website" card.
- [ ] ✅ Branding: the chat is something customers use, so naming it is allowed (5.1.4).
- [ ] ❌ **Lighthouse**: the storefront score must not drop more than 10 points (home 17%, product 40%, collection 43%,
      averaged over several runs). The launcher is 2.2 KB gzip and lazy-loads the widget; measure on the hosted app.

## 5. Billing

- [ ] ⚠️ **Decide pricing.** Any charge must go through Shopify Billing (Managed App Pricing or the Billing API),
      re-requested on reinstall, with self-serve upgrade and downgrade (1.2.x). A free MVP needs none of this. Nothing is
      built yet.

## 6. Listing (Partner/Dev Dashboard)

- [ ] ✅ Name ≤ 30 characters and brand-led, the same in the TOML and the listing ("AskCart") (4.1.x). Check that
      it's unique in the App Store.
- [ ] ❌ Icon 1200×1200 JPG or PNG, with no text and no Shopify trademarks.
- [ ] ❌ Feature media: a 2–3 minute promo video (screencast at most 25%) or a 1600×900 image.
- [ ] ❌ 3–6 desktop screenshots, 1600×900, at least one of the app UI; no browser chrome, PII, pricing or reviews; alt
      text.
- [ ] ❌ Texts: intro ≤ 100 characters, details ≤ 500, features ≤ 80 each, up to 5 search terms. No "the best", no
      unsupported stats, and no unprovable AI accuracy claims (4.3.3).
- [ ] ❌ Languages: list only fully supported ones. The widget has 6 locales; the admin is English.
- [ ] ❌ Declare the Online Store requirement (the theme embed needs it) (4.3.1).
- [ ] ❌ **Demo screencast** in English: install → onboarding → turn on the embed → a shopper chats → cards → add to
      cart (4.5.3).
- [ ] ❌ **Test access**: a demo dev store and reviewer instructions; any login must work without 2FA (4.5.4–4.5.5).
- [ ] ❌ Emergency developer contact (4.5.6).

## 7. AskCart-specific risks a reviewer may hit

- [ ] 🔄 **Abuse limits on the public chat** (M10). Partly done: per-IP and per-store rate and spend limits on the
      chat, per-customer limits on the proxy session route. Still missing: a monthly cap per store and a bot check.
      The limits are in memory (one instance) and stop honest clients, not a determined abuser.
- [ ] 🔄 **Chat retention job** (30/90/365 days, D41): being added. Verify old conversations are actually deleted.
- [ ] 🔄 **`customers/data_request`**: the webhook is acknowledged but exports nothing. For now a manual export with
      `server/scripts/export-customer-chats.mjs` (being added) answers a request within Shopify's deadline.
- [ ] 🔍 The chat must never show wrong prices or promise stock. Prices and stock come only from live Shopify data
      (prompt rules D37 and D79); keep that true in every new tool.
- [ ] 🔍 The AI notice is shown to shoppers (built). Keep it.

## Faster paths while review is pending

- **Custom distribution:** one merchant's store (or one Plus organization), no review, install link in minutes. Shopify
  forbids making a separate custom app per merchant.
- **MCP-only mode** (proposed, not built): use Shopify's public per-store MCP endpoints, which need no app install, plus
  the embed script. See the discussion of 2026-11-24.
