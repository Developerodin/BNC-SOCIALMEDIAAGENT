# Correctness review (lens 1): 3c9176e..HEAD

Scope read: server/src/lib/chat/{answer,budget,turn,prompt,tools,admin-tools,orders,product-questions}.ts, chat + product-questions + logo routes, shopify/logo.ts, sync.ts/jobs.ts/retrieval.ts diffs, widget cart.ts / cards.ts (addControls) / launcher.ts / ask-ai-block.ts / panel.ts (send + open) / rich.ts / core diffs, Liquid embed + ask-ai block + snippet, locales.
Tests run (all pass): tests/widget/{launcher,cart,liquid-escape,core/i18n}, tests/chat/{budget,prompt,answer,admin-tools,tools}.
Nothing was edited.

Ranked by severity, highest first.

---

## 1. MEDIUM: browse_collection matches the wrong collection by substring ("women's" goes to "Men")

`server/src/lib/chat/admin-tools.ts:276-285`

```ts
const score = t === q ? 4 : t.includes(q) ? 3 : q.includes(t) ? 2 : words.length && words.every((w) => t.includes(w)) ? 1 : 0;
if (score && (!best || score > best.score || (score === best.score && c.title.length < best.c.title.length))) best = { c, score };
```

`q.includes(t)` is a raw substring test, and when two titles tie, the shorter one wins. I reproduced this with the function copied verbatim and collections `Men, Women, Sale, All`:

| shopper said | matched collection |
|---|---|
| "womens jackets" | **Men** |
| "women's shoes" | **Men** |
| "wholesale items" | **Sale** |
| "show me all boards" | **All** |

What happens: the model calls browse_collection("women's shoes"). The result is cards from the Men collection, under a header that says `Collection "Men"`. The search fallback never runs because a "match" was found.

Fix: match on whole words (split both sides into words and test word-set containment, or use `\b` boundaries). On a score-2 tie, prefer the **longer** title, which is the more specific one.

## 2. MEDIUM: the "added in this chat" line goes stale and, together with the new cart rules, hides products the shopper removed

- `server/src/lib/chat/turn.ts:305-318`: `cartAddedTitles` reads every `cart_events` row for the conversation. It never checks the cart.
- `server/src/lib/chat/prompt.ts:183`: `Added to cart in this chat: …` is always emitted, even when a `cart` summary is present.
- Prompt rules at `prompt.ts:56` ("…are already in the shopper's cart … don't suggest adding them again") and `prompt.ts:59` ("Never recommend a product that is already in the cart … don't show its card again").

Scenario: the shopper adds the Pro Board from the chat, removes it on the cart page, then asks "which board should I get?". The store_data now says both "Added to cart in this chat: Pro Board" and "The shopper's cart: 1 × Socks …". Rule 56 tells the model the board is in the cart, so it says "You already have this" and leaves out the best match.

Fix (minimal): in `buildInput`, when `opts.cart` is present, drop the `cartAdded` line or keep only the titles that appear in `cart.items`. The live cart is the source of truth. Alternatively, reword rule 56 to "were added in this chat (they may since have been removed; the current cart line wins)".

## 3. MEDIUM: prompt rule contradiction on cart prices

- `prompt.ts:57` lets the model list the cart "with its prices and total".
- `prompt.ts:61` says "Prices come only from the LIVE lines … Never use prices … written in … other store text".

The cart line is not a LIVE line. Asked "what's my cart total?", the model has two conflicting instructions: it may refuse ("the price is shown on the product card") or ignore rule 61. The cart is also a new price source that disagrees with LIVE when a discount applies, because `final_line_price` is the discounted line total.

Fix: add an explicit exception to rule 61, for example "…except the shopper's cart line, whose item prices and total you may repeat when asked about the cart". Optionally also say that cart prices are line totals and should not be compared with LIVE unit prices.

## 4. LOW-MEDIUM: the C05 budget note states a price that C26 hides, in the store currency

`server/src/lib/chat/budget.ts:71-79`, called from `turn.ts` with `currency: store.currencyCode`.

`toPromptStock` (`live-products.ts`) deliberately leaves the price out of a product's LIVE line when the shopper's page currency differs from the product's (C26). The new C05 note bypasses that: `Left out for costing more than the budget: the cheapest of those is "X" at $612.` is always added, formatted in the store currency.

Scenario: a USD store, a shopper browsing in EUR asks for "boards under 500". The LIVE lines carry no price, but the note gives "$612", so the model quotes a USD price to a EUR shopper. That is exactly what C26 exists to prevent.

Fix: pass the shopper currency into `applyBudget`. Skip the C05 note, or drop its price part, when the shopper currency is set and differs from `p.currency`.

Related (low): `live.products` also holds the viewed product (`currentProductId` is added to `ids` in runTurn), and on the tool path, every product checked earlier in the turn (`tools.ts:225` passes `ctx.live`). So the "cheapest left out" can be an unrelated product, for example the $900 jacket being viewed when the shopper asked for boots. Fix: compute the note only over products that are among `hits`.

## 5. LOW-MEDIUM: "You're viewing" price shows raw HTML or entities on stores whose money format contains markup

`shopify/extensions/askcart/blocks/askcart-embed.liquid:9`: `"price":{{ product.price | money | json }}`. It is rendered with `textContent` in `server/widget/src/panel/panel.ts:202-205`.

The `money` filter uses the store's money format. Many stores have `<span class=money>${{amount}}</span>` (set by currency-converter apps) or entity formats such as `&euro;{{amount_with_comma_separator}}`. The widget shows these literally, for example `<span class=money>$19.99</span> · You're viewing`, and the 40-character slice can cut it mid-tag.

Fix: send `product.price` (an integer in cents) plus `cart.currency.iso_code`, and format with Intl in the widget, as `tilePrice` already does. Or strip tags and decode entities on the client before display.

## 6. LOW: the C05 note's merchant title skips sanitizeData on the tool path

On the main path, `priced.note` goes through `buildInput`, which sanitizes it (`prompt.ts:182`). On the tool path it does not:

- `tools.ts:228` and `tools.ts:232`: `note + blocks.join(...)`.
- `tools.ts:229`: `${r.note}`.
- The browse_collection fallback, `admin-tools.ts:305`: `${s.text}`.

All of these go into `data()` without `sanitizeData`. Since C05, `r.note` includes `cheapest.title`, which is raw merchant text. A title containing `[[product:1]]` or `</store_data>` would get through, breaking the stated invariant that all merchant text is sanitized (§7.6). Fix: `note = r.note ? `${sanitizeData(r.note)}\n\n` : ""`, and sanitize the note on line 229 the same way.

## 7. LOW: one long title or quantity over 999 drops the whole cart for mobile clients; a capped cart's total is inconsistent

`turn.ts:285-301` (`parseCartSummary`) returns null for the whole cart if any line fails: title over 80 characters, quantity over 999, or more than 20 lines. The storefront widget truncates titles to 80 and slices to 20 lines (`widget/src/cart.ts:47-74`), so it is safe. It does not clamp quantities, though: a B2B cart line of 1,000 units silently removes the cart from the turn. Mobile apps that send the documented shape with longer titles lose the cart without any error.

Also, the widget slices `items` to 20 lines but keeps the full `total_price`, so the model can be handed a total that doesn't match the listed lines. Fix: clamp the quantity in the widget, or have the server skip a bad line instead of rejecting the cart. When lines were cut, append "and N more items".

## 8. LOW: the answer.ts first-message-item guard can drop the real answer when the first item is only a preamble

`answer.ts:129-139` shows only the first message item's deltas for each response. This is fine for the doubled-answer case it targets. If the model emits a short preamble item (for example "Sure!", or whitespace) followed by the real message item in the same response, with no tool call between them, the real answer is dropped. The shopper sees "Sure!" and the saved row is "Sure!".

I could not show that the current models do this, so this is a watch item, not a confirmed bug. Cheap hardening: lock onto the first item only once it has produced non-whitespace text, or log when a later item is skipped so it can be measured.

## 9. LOW: cards.ts adds a window listener on every detail-sheet open and never removes it

`server/widget/src/cards.ts:40-44`: `watchInCart` registers a `CART_CHANGED` listener for each rendered card or sheet and never removes it. `openSheet` builds a fresh `full` card each time it opens, so every open adds another listener. Each one keeps the detached sheet DOM alive and calls `cartState` on every cart change. The code comment's ceiling ("one small closure per rendered card row") understates this. Fix: return an unsubscribe from `watchInCart` and call it from the sheet's `close()`, or tie the listener to `isConnected`.

## 10. LOW: the cart re-read can double-count an add made while a read is in flight

`server/widget/src/cart.ts:97-99` and `177-181`. `cartSummaryNow` (on every send) and `refreshCart` (on every open) replace `inCart` with a fresh read. If `addToCart` finishes while that read is in flight, the read already includes the add, and then `state.quantities.set(... + quantity)` counts it again. The result is a "2 in your cart" badge and a wrong header count until the next refresh. A comment already notes this for the first read only; it now happens on every message send. Fix: after a successful add, call `refreshCart(page)` instead of mutating the cached state.

---

## Checked and found OK (not findings)

- **Auto-insert placement** (`launcher.ts:72-101`):
  - The installment form is excluded.
  - Forms in `main` are preferred.
  - The `.shopify-section` wrapper places the block after the section.
  - A manual block suppresses the automatic one (the template content is not in the DOM, so the query is correct).
  - `#askcart-root` missing hides a manual block.
- **i18n:** all 6 widget dictionaries are typed `Record<Key,string>`, so a missing key is a type error. The 6 extension locale files have identical key sets.
- **Liquid escaping:**
  - `| t` outputs are not escaped twice.
  - eyebrow and heading use `escape_once`.
  - captures leave only through `| escape`.
  - The liquid-escape test checks the right things.
- **Logo upload:**
  - Rate limit before the body is read.
  - 413 before buffering.
  - Type from magic bytes.
  - ACCESS_DENIED mapped to 403 `missing_scope`.
  - Polling bounded at 20 s.
  - The returned cdn.shopify.com URL passes `isShopifyCdnUrl`.
  - Both app tomls have `write_files,read_files`.
  - Minor: a failure mid-poll leaves an orphan file in Shopify Files.
- **product-questions:**
  - Keyed by store, product and widget locale, with content_hash invalidation.
  - An in-flight map deduplicates simultaneous requests.
  - A failure is not cached (60 s max-age).
- **Orders:** `owned` is computed correctly for new and existing conversations; order_status is offered only when owned.
- `readHistory` with `inArray(... [])`: drizzle 0.45 emits `false`, which is safe.
- pg-boss 12.39 supports `perJobResults` and `burstWhenBatchFull`; `settleEach` returns a result per job id.
- Variant preselect in `addControls`:
  - It starts on the first available variant.
  - A cart variant replaces it until the shopper touches a select.
  - Sold-out variants are skipped.
- **Prompt "clear pick" vs "two or three suggestions"** (rules at `prompt.ts:36`, `38`, `39`): these have different triggers (compare/choose vs a broad request) and are compatible. Not a contradiction.
