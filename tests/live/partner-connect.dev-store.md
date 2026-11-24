# Partner connect: dev-store checks (Task P0)

Store: ask-cart-hv7ufqqy.myshopify.com (org CellaVei, app AskCart, client_id c80e516d95dbbe7b654945e4800a4fa0)

## Step 1: deep link into the embedded app, with AskCart installed. PASSED (2026-11-24)

- **Works:** `https://admin.shopify.com/store/ask-cart-hv7ufqqy/apps/c80e516d95dbbe7b654945e4800a4fa0/app/partner-consent?request=test123`
- **Fails:** `…/apps/askcart/…` gives Shopify's own 404 ("There's no page at this address"). The admin URL needs the app's client_id (or its real app handle), not "askcart".
- **What the app server received:**
  `GET /app/partner-consent?admin_theme=admin-next&embedded=1&hmac=…&host=…&id_token=…&locale=en&request=test123&session=…&shop=ask-cart-hv7ufqqy.myshopify.com&timestamp=…`
  - The path is kept.
  - Our own query parameter (`request`) is kept.
  - Shopify adds `shop` and a signed `id_token` (the session token).
- **Result:** the main design (consent inside Shopify admin) holds. No fallback F.
- **Use in P4:** build the redirect as `https://admin.shopify.com/store/<store handle>/apps/<SHOPIFY_API_KEY>/app/partner-consent?request=<id>`, where the store handle is the myshopify subdomain.

## Step 2: install link on a store without AskCart. NOT RUN
Needs a second dev store. Run it during P10.

## Step 3: leaving the admin iframe with `_top`. NOT RUN
Check it during P5 or P10.

## Step 4: online-token fields for the owner and for staff without Orders. NOT RUN
Needs a staff account with no Orders permission. Run it during P10.
