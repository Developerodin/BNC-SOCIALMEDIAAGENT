# AskCart chat outside Shopify

The AskCart shopping assistant also works on a website that isn't your Shopify theme (WordPress, Wix, a custom
site), and as a plain link. The chat is the same one your store shows: same answers, same products, same look and
settings.

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

## Share it as a link

`https://<askcart-host>/chat/my-store.myshopify.com` opens the chat as a full page. Use it in a newsletter, a social
bio or a QR code.

If the chat is turned off in your AskCart settings, or the store isn't connected, both the embed's panel and the
link show "not found".

## Limits

- **No cart sync.** Outside your Shopify theme the chat can't put items in your cart. The product card's button reads
  **Buy on the store** and opens the product page on your Shopify store in a new tab, with the chosen variant
  selected. The visitor adds it to the cart there.
- **A separate chat history.** The conversation is kept in the visitor's browser for that website (or for the link),
  and isn't shared with your Shopify storefront chat.
- **Button colour.** The embed button is dark by default; the chat inside uses your accent colour.
- The privacy link and "view cart" shortcut of the storefront chat aren't shown.
