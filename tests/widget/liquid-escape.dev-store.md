# Dev-store check: Liquid values and escaping in the AskCart app embed (M5 Task 23, Step 3)

Status: PENDING. Not run yet: it needs the embed switched on in the theme editor and a hand-written test metafield.

## Setup
1. `npm run build:widget`, then `shopify app dev` (it uploads the extension to the dev theme preview).
2. In GraphiQL (`shopify app dev`, press `g`), write a test value to the app installation:
   `currentAppInstallation { id }`, then `metafieldsSet` with that `ownerId`, namespace `askcart`, key `widget`,
   type `json`, value `{"v":1,"enabled":true,"welcome":"\"></div><script>alert(1)</script>"}`.
3. Theme editor, App embeds: switch on "AskCart chat". Add a throwaway block (or temporarily print the values below
   as visible text in `askcart-embed.liquid`, outside `#askcart-root`), then remove it.

## Values (record on the home page and on a product page)
| Value | Home | Product page |
|---|---|---|
| `shop.permanent_domain` | | |
| `request.locale.iso_code` | | |
| `localization.country.iso_code` | | |
| `cart.currency.iso_code` | | |
| `request.page_type` | | |
| `product.id` (product pages; **if empty in the embed, stop and report**) | n/a | |
| `routes.cart_add_url` | | |
| `routes.cart_url` | | |
| `shop.privacy_policy.url` | | |
| `request.design_mode` (true in the theme editor) | | |

## Escaping (Review Focus 2)
- [ ] `#askcart-root[data-config]` holds the welcome text as an attribute value; no `<script>` element is created and no
      alert fires. `JSON.parse(document.getElementById('askcart-root').dataset.config).welcome` returns the raw text.
- [ ] `data-page` parses with `JSON.parse` on both pages.
