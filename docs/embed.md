# AskCart chat outside Shopify

The AskCart shopping assistant also works on a website that isn't your Shopify theme (WordPress, Wix, a custom
site), and as a plain link. The chat is the same one your store shows: same answers, same products, same look and
settings.

## Allow your website first

Embedding is **off** until you allow the site: only listed sites can show your chat, so nobody else can use it (and
your AI usage) from their page. In the AskCart admin, open **Connect your website**, type the address, and press
**Allow chat on <your site>**. (Up to 10 sites; the same list is available at `/api/app/embed-domains` for the admin
app.) Your store's own domains are always allowed.

On a site that isn't allowed, the visitor's browser shows its own "refused to connect" message inside the chat frame.
That is the browser enforcing the allow-list, not an AskCart error page. The plain link `/chat/<store>` still shows
"not found" until at least one site is allowed.

## Add it to any website

Paste this once, before `</body>`:

```html
<script src="https://<askcart-host>/embed.js" data-shop="my-store.myshopify.com" defer></script>
```

- `<askcart-host>` is AskCart's public address (for now the `shopify app dev` tunnel; it changes until AskCart is
  hosted, so ask whoever runs AskCart for the current one).
- `data-shop` is your store's permanent domain, ending in `.myshopify.com`.
- Optional: `data-label="Ask us"` changes the button text (default "Chat").

A chat button appears bottom-right. Nothing is loaded from AskCart until a visitor clicks it. The chat opens in a
panel (full screen on a phone); the button turns into a close button.

## A store that has not installed AskCart (MCP-only, pilot)

For a pilot store the chat reads products from Shopify's public endpoints instead of an install (no sync, no Admin
access). We create its row by hand, then the merchant pastes the tag above into `theme.liquid` (and
`layout/password.liquid` for a password-protected store):

```
cd server && npx tsx --env-file=.env --tsconfig tsconfig.json scripts/provision-mcp-store.mts my-store.myshopify.com --name "My Store"
```

The script fetches the storefront and prints whether our tag is on the page (check it by hand), reads the currency from
a live search, and sets `mode = 'mcp'`, the domains and the allowed embedding sites. It refuses a store that installed
the app. To switch the chat off, set `active = false` on the row. Limits: 100 shopper messages per day per store; stock
counts ("only 3 left") are not available, only in stock or sold out.

## Share it as a link

`https://<askcart-host>/chat/my-store.myshopify.com` opens the chat as a full page. Use it in a newsletter, a social
bio or a QR code.

If the chat is turned off in your AskCart settings, the store isn't connected, or no site is allowed yet, both the
embed's panel and the link show "not found".

## Add to cart on a Shopify storefront (cart bridge)

When `embed.js` runs on one of your own Shopify pages (for example a theme where you pasted the snippet instead of
enabling the app embed), the chat can add to the real cart. The chat frame asks the page by `postMessage`; the page
adds the item with the theme's own cart code and answers. The card then shows **Added to cart** and a **View cart**
link. Both sides check who they are talking to: the page only accepts messages from AskCart's own frame (origin and
window), and only a strict `{variantId, qty 1-10}` request from a real click; the reply goes to AskCart's origin
only. The chat frame only talks to your store's own domains. The page also tells the chat the visitor's country and
the product being viewed, as hints only.

The page confirms receipt at once. If nothing confirms within about 2 seconds (not a Shopify page, or a store domain
AskCart doesn't know), the button shows **Buy on the store** for the next click, then offers Add to cart again. If the
page confirmed but the store's cart is very slow (over 15 seconds), the card says **Check your cart** with a View cart
link instead of guessing.

The address that serves `/chat/<store>` (the `<askcart-host>` in the snippet) must not redirect to another host, such
as apex to `www`. The bridge and the panel's close button compare the exact origin of the frame, so after a redirect
they silently stop working. Use the final address in the snippet.

## Limits

- **No cart sync on other sites.** Outside a Shopify storefront the chat can't put items in your cart. The product
  card's button reads **Buy on the store** and opens the product page on your Shopify store in a new tab, with the
  chosen variant selected. The visitor adds it to the cart there.
- **A separate chat history.** The conversation is kept in the visitor's browser for that website (or for the link),
  and isn't shared with your Shopify storefront chat.
- **Button colour.** The embed button is dark by default; the chat inside uses your accent colour.
- The privacy link and "view cart" shortcut of the storefront chat aren't shown.
