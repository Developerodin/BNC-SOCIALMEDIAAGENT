# UI / UX: Shop Assistant

This is the companion to `product.md`. It defines how the storefront widget and the merchant dashboard look and behave.

§1 and §2 are the original question list, with the options and Claude's recommendation for each (marked "Rec"). **All of them were decided on 2026-11-23, and §4 (UD1–UD25b) is what counts.** Where §4 differs from a recommendation, §4 wins: for example U8 (never shown), U12 (cards after the text), U15 (no fallback), U23b (black) and U25 (localised dashboard).

**Already fixed by `product.md`:**
- D21: Polaris inside Shopify admin, shadcn/ui on our site.
- D39: the widget is vanilla JS in a Shadow DOM, and only the bubble loads with the page.
- D30: add to cart, showing "Added · View cart".
- D36 and D37: product cards come from markers, and prices appear on cards only.
- D41: a privacy notice that links to the store's policy.
- D43: the four dashboard pages.
- D49: Claude drafts the card design and notice text, and the user approves them.

## 1. Storefront widget: pending

- **U1 Launcher style**:
  - (a) a round icon bubble
  - (b) a pill with a label ("Ask us anything")
  - (c) the merchant picks
  - Rec: (c), with (b) as the default, because a label gets more clicks than a bare icon.
- **U2 Launcher position**:
  - (a) fixed at the bottom right
  - (b) the merchant picks left or right and a vertical offset
  - Rec: (b), because other apps' bubbles (reviews, cookie bars) often sit in the same corner.
- **U3 Chat window on desktop**:
  - (a) a floating panel of about 380×600
  - (b) a full-height side drawer
  - Rec: (a)
- **U4 Chat window on mobile**:
  - (a) full screen
  - (b) a bottom sheet covering about 85% of the screen
  - Rec: (a), because the keyboard and cards need the room.
- **U5 Product-page entry point**:
  - (a) the bubble only
  - (b) also an optional app block with an "Ask about this product" button near add-to-cart
  - Rec: (b)
- **U6 Opening behaviour**:
  - (a) the widget never opens itself
  - (b) an optional teaser line next to the bubble after N seconds, which the merchant turns on or off
  - Rec: (b), off by default.
- **U7 Merchant customisation**:
  - Beyond name, colour, welcome text and suggested questions:
    - (a) nothing more
    - (b) add an avatar or logo, the launcher label and the position from U2
  - The font is inherited from the theme in both cases.
  - Rec: (b)
- **U8 "Powered by Shop Assistant" line**:
  - (a) always shown
  - (b) hidden
  - (c) shown during the beta and removable on paid plans later
  - Rec: (c)
- **U9 Product card layout**:
  - (a) vertical cards in a horizontal carousel
  - (b) a compact list of rows
  - Rec: (a) when there are 2 or more products, and a single full card when there is 1.
- **U10 Stock on cards**:
  - (a) always the exact number
  - (b) "In stock", switching to "Only N left" below a threshold (default 5), and "Sold out"
  - Rec: (b)
- **U11 After add to cart**:
  - (a) "Added · View cart" only
  - (b) also fire a `cart:updated` event and try the theme's cart-drawer refresh
  - Rec: (a) plus the event, without theme-specific hacks, because cart drawers differ by theme.
- **U12 Where cards appear in an answer**:
  - (a) inline, at the marker's position
  - (b) grouped after the text
  - Rec: (a)
- **U13 Conversation across page loads**:
  - (a) a fresh chat on every page
  - (b) the chat continues across pages in the same browser, using the server token in localStorage
  - Rec: (b), because shoppers click a card and keep asking.
- **U14 Answer feedback**:
  - (a) none
  - (b) thumbs up or down on each answer, which feeds the suggestions report
  - Rec: (b)
- **U15 Human fallback**:
  - (a) none
  - (b) when the bot doesn't know, show a "Contact the store" link to the store's contact page or email
  - Rec: (b)
- **U16 Privacy notice placement**:
  - (a) a small footer line in the chat
  - (b) a click-to-accept screen before the first message
  - Rec: (a)
- **U17 Accessibility target**:
  - WCAG 2.1 AA, which covers keyboard use, a focus trap in the open panel, screen-reader labels, reduced motion and contrast checks on the merchant's colour.
  - Rec: yes.
- **U18 Widget interface language**:
  - Labels such as "Send" and "Add to cart":
    - (a) English only
    - (b) follow the storefront locale for a starting set of languages
  - Merchant-typed text stays as typed.
  - Rec: (b), starting with EN, FR, DE, ES, IT and NL, because the bot already answers in the shopper's language (D38).

## 2. Merchant dashboard: pending

- **U19 Onboarding**:
  - (a) a setup checklist on Home: sync done → enable the embed → test the chat → customise
  - (b) a step-by-step wizard
  - Rec: (a)
- **U20 Widget preview**:
  - (a) none
  - (b) a live preview next to the Settings form
  - Rec: (b)
- **U21 Home metrics**:
  - Conversations, messages against the cap, add-to-carts from chat, the unanswered rate and the top 5 questions.
  - Rec: these five.
- **U22 Conversations view**:
  - A list with filters (unanswered, led to add-to-cart, thumbs down, date) and a detail view showing the cards as the shopper saw them.
  - Rec: yes.
- **U23 Our site's look**:
  - (a) neutral shadcn with one accent colour
  - (b) a custom brand identity first
  - Rec: (a) now, and a brand pass before the App Store listing.
- **U24 Dark mode on our site**:
  - (a) light only
  - (b) light and dark
  - Rec: (b), because it's built into shadcn. Polaris follows the admin.
- **U25 Dashboard language**:
  - Rec: English only in phase 1.

## 3. Mockups

These will be added as each item is decided.

## 4. Decisions log

- **UD1 (U1) Launcher style** (2026-11-23): **the merchant picks** between a pill with a label and a round icon. The default is the **pill** ("Ask us anything").
- **UD2 (U2) Launcher position** (2026-11-23): **the merchant picks** the left or right side and a vertical offset from the bottom. The defaults are the right side and 20 px.
- **UD3 (U3) Desktop window** (2026-11-23): a **floating panel** of about 380×600 above the launcher. The store page stays visible.
- **UD4 (U4) Mobile window** (2026-11-23): **full screen**, with a back arrow to close it.
- **UD5 (U5) Product-page entry point** (2026-11-23): an **optional app block** with an "Ask about this product" button that the merchant places near add-to-cart. It opens the chat with that product as context.
- **UD6 (U6) Teaser** (2026-11-23): an **optional teaser** line next to the launcher, **off by default**. The merchant sets the delay (default 8 s) and the text. The chat never opens by itself.
- **UD7 (U7) Customisation** (2026-11-23): the merchant can also set an **avatar or logo**, the **launcher label**, and the style and position from UD1 and UD2. The font is inherited from the theme. Where the avatar is hosted is set by UD7b.
- **UD7b (U7b) Avatar hosting** (2026-11-23): the merchant **pastes a `https://cdn.shopify.com/` URL**, and anything else is rejected. This adds no scope and no hosting, and the cdn.shopify.com-only image rule in product.md §7.7 still holds.
- **UD8 (U8) Branding line** (2026-11-23): **never shown**. The widget has no "Powered by" line.
- **UD9 (U9) Card layout** (2026-11-23): with **2 or more products, vertical cards in a horizontal carousel**. With **1 product, a single full-width card**.
- **UD10 (U10) Stock on cards** (2026-11-23):
  - "In stock" by default,
  - "Only N left" below a threshold the merchant can edit (default **5**),
  - "Sold out" at zero, with Add disabled.
- **UD11 (U11) After add to cart** (2026-11-23): the widget shows "Added · View cart" and dispatches a `cart:updated` window event. There are no theme-specific refresh hacks. *Known trade-off:* the theme's cart badge may stay stale until the next page load.
- **UD12 (U12) Card placement** (2026-11-23): **grouped after the answer text**, using the UD9 layout (a carousel, or a single card when there's 1 product).
- **UD13 (U13) Chat across pages** (2026-11-23): the chat **continues across pages**.
  - The server's conversation token is kept in localStorage, and the history is reloaded from our server using that token.
  - If the panel was open on the previous page, it reopens.
  - A "New chat" button clears the token.
- **UD14 (U14) Answer feedback** (2026-11-23): **thumbs up and down** under each bot answer. A thumbs down feeds the Suggestions report and the conversation filter.
- **UD15 (U15) Human fallback** (2026-11-23): **none**. When the bot doesn't know, it says so and shows no contact link.
- **UD16 (U16) Privacy notice** (2026-11-23): a **small footer line** under the input box. It says this is an AI assistant, states the retention period, and links to the privacy policy. No accept click is needed. The exact wording is drafted by Claude and approved by the user (D49).
- **UD17 (U17) Accessibility** (2026-11-23): **WCAG 2.1 AA**:
  - full keyboard use and Esc to close,
  - a focus trap in the open panel,
  - screen-reader labels and an aria-live region for new answers,
  - respect for prefers-reduced-motion,
  - a contrast check on the merchant's accent colour, with a warning in Settings if it fails.
- **UD18 (U18) Widget label language** (2026-11-23): the labels **follow the storefront locale** for **EN, FR, DE, ES, IT and NL**, and fall back to English. Merchant-typed text is shown as typed.
- **UD19 (U19) Onboarding** (2026-11-23): a **setup checklist on Home** that ticks itself off: catalog synced → widget enabled → test message sent → look customised. The rest of the dashboard is usable at any time.
- **UD20 (U20) Widget preview** (2026-11-23): a **live preview** of the real widget next to the Settings form, updated instantly. It also serves the "Send a test message" step.
- **UD21 (U21) Home metrics** (2026-11-23): **all four**:
  - conversations and messages against the cap,
  - add-to-carts from chat,
  - the unanswered rate and thumbs-down count,
  - the top 5 questions.
- **UD22 (U22) Conversations page** (2026-11-23): a list with **filters** (unanswered, led to add-to-cart, thumbs down, date), and a detail view that **replays the chat with its cards** and ratings as the shopper saw them.
- **UD23 (U23) Our site's look** (2026-11-23): **neutral shadcn with one accent colour** in phase 1, and a brand pass before the App Store listing. The accent colour itself is set by UD23b.
- **UD23b (U23b) Accent colour** (2026-11-23): **black `#0A0A0A`**, the monochrome shadcn default.
- **UD24 (U24) Dark mode on our site** (2026-11-23): **light and dark**. It follows the system setting, with a toggle for Light, Dark or System. In dark mode the black accent flips to near-white, as in the shadcn default.
- **UD25 (U25) Dashboard language** (2026-11-23): inside Shopify admin, the dashboard **follows the admin locale** for **EN, FR, DE, ES, IT and NL**, and falls back to English. On our own site, the language is set by UD25b.
- **UD25b (U25b) Language on our site** (2026-11-23): it **starts from the browser language** and can be changed in a **picker that's saved to the user's account**. The supported languages are the same 6.

**U1–U25, U7b, U23b and U25b are all decided. Nothing is pending.**
