# M5 Task 33: storefront widget, end-to-end check on the dev store

Status: **automated part done (2026-11-24); the browser part is PENDING** and needs the store owner in a real browser
on Dawn and on Horizon. Record every result below. If a step doesn't come out as expected, write down what you saw
and stop; don't change code to make it pass.

- Dev store: `ask-cart-hv7ufqqy.myshopify.com` (currency INR)
- App server: `shopify app dev` (Next.js on `http://localhost:55990`, tunnel `https://reveals-chest-fruit-levels.trycloudflare.com` on 2026-11-24; the tunnel changes on every restart, see "Using URL:" in the log)
- Widget build: `npm run build:widget` (see sizes below)

---

## Part A: automated results (already run)

### A1. Size budgets (`tests/widget/bundle-size.test.ts`, runs `scripts/build-widget.mjs`)

| File | Raw | Gzip | Budget | Result |
|---|---|---|---|---|
| `askcart-launcher.js` | 4,435 B | 2,060 B | 4,096 B | pass |
| `askcart-widget.js` | 39,457 B | 14,538 B | 30,720 B | pass |
| `askcart-faq.js` | 1,444 B | 804 B | 10,240 B | pass |
| `askcart-ask.js` | 549 B | 354 B | 10,240 B | pass |

The test also checks that the built files contain no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.

### A2. No HTML sink in `widget/src` (`tests/widget/no-innerhtml.test.ts`)

Every `.ts` file under `widget/src` is scanned with comments removed for `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`createContextualFragment`, `DOMParser`, `document.write`, `eval(` and `new Function(`. Result: none. The plan
allowed one exception (a static SVG icon module), but `panel/icons.ts` builds its SVG with `createElementNS`, so no
file needs the exception.

### A3. Liquid escaping (`tests/widget/liquid-escape.test.ts`)

Every `{{ … }}` in `extensions/askcart/blocks/*.liquid` must end in `| escape`. The only exceptions are
`block.shopify_attributes` (Shopify's editor attributes), `'key' | t` (Shopify escapes translations unless the key
ends in `_html`, and none of ours does), and `| json` values inside a `{% capture %}` that is output through
`| escape`. Two outputs didn't follow the rule and now end in `| escape`: `product.id` in `askcart-ask.liquid`
(a number, so it was safe) and the `asset_url` in `askcart-embed.liquid`.

### A4. Live end to end without a browser (`tests/live/widget.e2e.test.ts`)

Run: `WIDGET_E2E_BASE=<tunnel> npx vitest run tests/live/widget.e2e.test.ts --disableConsoleIntercept`.
The test loads the **built** `askcart-launcher.js` into a happy-dom page on `https://ask-cart-hv7ufqqy.myshopify.com/`
with the embed's `#askcart-root` data attributes. The config is the real `buildWidgetConfig` output for the dev
store's row. The launcher injects `askcart-widget.js` from a `cdn.shopify.com` URL, which a happy-dom virtual
server answers from `extensions/askcart/assets`. The real tunnel, chat route and OpenAI answer the requests.

How requests reach the server: the widget's requests use Node's `fetch` with `Origin: https://ask-cart-hv7ufqqy.myshopify.com`.
The shim preflights every request that isn't "simple" and checks `Access-Control-Allow-Origin` (and the allowed
methods and headers) like a browser does. The server's CORS check against `stores.domains` is the real one.
happy-dom's own fetch did reach the server with the right Origin. But happy-dom 21 throws "Controller is already
closed" after the widget cancels the SSE reader on `done`, which browsers allow. That's a happy-dom bug
(`FetchBodyUtility.nodeToWebStream`), so the test uses the shim.

Result on 2026-11-24: **pass** (about 6.5 s).

| Check | Result |
|---|---|
| No request to our server before the click (page view) | pass: 0 requests |
| Click the launcher: `askcart-widget.js` injected once, panel opens | pass |
| Ask "What's your cheapest snowboard?": `POST /api/chat` 200, answer streamed | pass |
| Card with a live INR price | pass: `₹629.95` |
| Token never in a URL (Review Focus 3) | pass |
| Thumbs up: `POST /api/chat/feedback` 204, `messages.rating = 1` in the dev DB | pass |
| Remount on a new page with the same storage: `GET /api/chat/history` 200, same question, same answer, same card, thumbs-up still pressed | pass |
| Delete chat: `DELETE /api/chat/conversation` 204, token removed, the conversation and its messages are gone from the dev DB | pass |

The bot's answer, first run: "The Multi-managed Snowboard is listed as the cheapest snowboard and is in stock." A second
run gave "The Multi-managed Snowboard is the cheapest snowboard in the store and is in stock." with the same card.

The card as rendered: title "The Multi-managed Snowboard" linking to
`https://ask-cart-hv7ufqqy.myshopify.com/products/the-multi-managed-snowboard`, price `₹629.95`, no compare-at price,
"In stock", a `cdn.shopify.com` image and an "Add to cart" button. As stored in `messages.cards`: product
`gid://shopify/Product/11051154047288`, variant `53934784839992` ("Default Title"), `currency: "INR"`,
`price: "629.95"`, `stock: in_stock`, `action: "add"`.

Note for answer quality (not a widget bug): Shopify's standard dev-store data lists "The Collection Snowboard:
Hydrogen" at 600.00, below 629.95. Search returns the closest products, not a list sorted by price, so "cheapest"
is answered only from the retrieved set. Check Hydrogen's live price and status before reading anything into this.

### A5. Storefront CSP (checklist item 10)

`curl -D - https://ask-cart-hv7ufqqy.myshopify.com/` (302 to `/password`) and `/password` (200) both send
`content-security-policy: block-all-mixed-content; frame-ancestors 'none'; upgrade-insecure-requests;`.
**There is no `connect-src` rule**, so Shopify doesn't block our `fetch` to the app. Recheck once on an unlocked theme
page (step B10).

### A6. Unit-level coverage already in the suite

The `tests/widget/*` files (happy-dom, mocked fetch) cover Review Focus 1, 3, 5 and 6 and the panel behaviour. Review
Focus 4 is covered by `tests/api/chat-feedback.test.ts` and `chat-cart-event.test.ts`.

---

## Part B: steps that need a person in a browser (PENDING)

Fill in first:

- Date run:
- Run by:
- Tunnel URL (from `shopify app dev`, "Using URL:"):
- Chrome version:
- Real phone (model, browser):

### B0. Setup (once)

1. In the repo: `npm run build:widget`, then make sure `shopify app dev` is running. Press `p` in its terminal to
   open the preview, or open the store admin.
2. **Open the app once in the Shopify admin** (Apps → AskCart). This writes the widget config, with the current tunnel
   as `apiBase`, to the app metafield (`syncWidgetConfig`). Do this again after every `shopify app dev` restart,
   because the tunnel URL changes.
3. **Storefront password.** Admin → Online Store → Preferences → Password protection. Copy the password (or turn
   protection off for the session and back on afterwards). Open the storefront and enter the password. Without it,
   every page is `/password` and the embed doesn't run on theme pages.
4. **Themes.** Admin → Online Store → Themes. You need **Dawn** and **Horizon** in the library. Add them from the
   Theme Store (free) if they're missing. Run part B on one theme, then use "Preview" on the other and run it again.
   Each theme has its own embed and block settings.
5. **Enable the app embed** (per theme): Customize → the left sidebar's **App embeds** icon → switch on
   **"AskCart chat"** → Save. If the toggle doesn't appear, `shopify app dev` isn't running or the extension didn't
   upload (look for errors in its terminal).
6. **Place the blocks** (per theme): Customize → template selector → Products → Default product. In the
   product-information section, use "Add block" → Apps → **"Ask about this product"**. Add a section or block with
   **AskCart FAQ** below it. Save.
7. In Chrome DevTools, use the Network tab with "Preserve log" on and the filter set to the tunnel host.

Record per theme: ✅ / ❌ and a short note.

| # | Step | Dawn | Horizon |
|---|---|---|---|
| B1 | Load the home page with the Network tab open. **No request to the tunnel host** until you click the launcher. The launcher pill shows bottom right. | | |
| B2 | Click the launcher and ask "What's your cheapest snowboard?". Text streams in, then a card with an INR price. | | |
| B3 | **Add to cart in the real theme.** On a card, click "Add to cart". Expect "Added · View cart". The Network tab shows `POST /cart/add.js` (or Shopify's `updateCart` action), and `/cart.js` shows the right variant id. "View cart" opens `/cart`. | | |
| B4 | **Cart icon refresh (UD11, input for C21).** Right after the add, without a reload: does the theme's cart icon count change? Does a cart drawer open? Write exactly what happens. Then reload: the count must be right. | | |
| B5 | Sold-out product (D72): badge, no Add. Ski wax (D75). A product with many variants (C12): pickers, or "View options". | | |
| B6 | With the panel open, go to another page. The panel reopens with the history (UD13). Menu → New chat starts over. Menu → Delete chat → confirm: the chat is gone, and `select count(*) from conversations where id = '<id>'` is 0. | | |
| B7 | DevTools → Network → Offline in the middle of an answer, then Online. One retry, no duplicate answer (D81). Same chat in two tabs, send in both: the second waits and then answers. | | |
| B8 | Thumbs up, then reload: still pressed. `select rating from messages order by created_at desc limit 5` shows it. `select count(*) from cart_events` went up by one per add in B3. | | |
| B9 | Language selector FR, then DE: labels follow, and the bot answers in that language. | | |
| B10 | Response headers of a theme page (not `/password`): note any `Content-Security-Policy` `connect-src`. Expected: none (see A5). | | |
| B11 | Keyboard only: Tab to the launcher, Enter, type, Enter to send, Tab through the cards, add one, Esc closes. Screen reader (NVDA or VoiceOver): the answer is read once. OS "reduce motion" on: no animation. | | |
| B12 | **Review Focus 7, theme isolation.** Customize → Theme settings → Custom CSS (or edit `base.css` in a duplicate theme): add `* { color: red !important; } button { all: unset; } html { font-size: 10px; }`. The launcher and panel look unchanged (take screenshots before and after). Remove the CSS. | | |
| B13 | In the theme editor (design mode), the launcher shows and opens. If the chat call fails, note the editor preview's origin from the failed request's `Origin` header. It's probably not in `stores.domains`, so CORS refuses it. Record it for M7. | | |
| B14 | Mobile: Chrome DevTools device mode at 375 px, then one real phone. The panel is full screen, the back arrow closes it, and the keyboard doesn't cover the input. | | |
| B15 | **`transform` on body** (Task 26 ceiling): on each theme, the launcher stays fixed bottom right while scrolling and with a cart drawer open. | | |

### B-notes (anything unexpected, with screenshots)

-
