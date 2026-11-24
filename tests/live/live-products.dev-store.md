# Task 15 Step 3: live card check on the dev store

Status: **not run yet.** Waiting on (1) a second market on the dev store, (2) a fresh store token (the stored one has probably expired: open the app in the Shopify admin once to run the token exchange).

Run each query in the Shopify admin GraphiQL app (API version `2026-10`) or through `adminGraphql`. Record each result below. If a check doesn't come out as expected, stop and report. Don't switch fields or change the code on your own.

Fill in first:

- Date run:
- Run by:
- Dev store domain:
- API version: `2026-10`

---

## 1. D77: `publishedInContext(context: { country })`

**Setup:** in Settings → Markets, create a second market (for example Germany, `DE`). Exclude one product from that market's catalog/publication. Note the product and the two countries.

- Product excluded from the second market (GID):
- Primary market country:
- Second market country:

```graphql
query D77($id: ID!) {
  product(id: $id) {
    id
    title
    primary: publishedInContext(context: { country: US })   # replace US with the primary market's country
    second:  publishedInContext(context: { country: DE })   # replace DE with the second market's country
  }
}
```

Variables: `{ "id": "gid://shopify/Product/<excluded product>" }`

Also run the same query for a product that is in both markets (expected: both `true`).

| Check | Expected | Result |
|---|---|---|
| Excluded product, second market | `false` | |
| Excluded product, primary market | `true` | |
| Product in both markets, both countries | `true`, `true` | |
| `$ctx: {}` with `@include(if: false)` (no country) is accepted by the full query in check 3 | no error | |

---

## 2. D75: `requiresSellingPlan` on the demo ski wax

The ski wax's selling-plan group is attached to its variants only. D75 says to detect plans per variant, because the product-level count misses variant-attached groups. This check confirms whether the product-level `requiresSellingPlan` (which the code uses) is correct anyway.

```graphql
query D75($id: ID!) {
  product(id: $id) {
    id
    title
    requiresSellingPlan
    sellingPlanGroupsCount { count }
    variants(first: 10) {
      nodes {
        id
        title
        sellingPlanGroups(first: 1) { nodes { name } }
      }
    }
  }
}
```

Variables: `{ "id": "gid://shopify/Product/<ski wax>" }`

Then open the ski wax product page on the storefront and note whether a one-time purchase is possible.

| Check | Result |
|---|---|
| Ski wax GID | |
| `requiresSellingPlan` | |
| `sellingPlanGroupsCount.count` | |
| Variants with a selling-plan group | |
| Product page allows one-time purchase? (yes/no) | |
| `requiresSellingPlan` matches the product page? | |

If `requiresSellingPlan` disagrees with what the product page enforces, stop and report: the query would then need `variant.sellingPlanGroups(first: 1)` plus a way to tell "plan required" from "plan optional".

---

## 3. Cost of the real query (9 ids, `VARIANT_CAP = 50`)

Use the exact query from `src/lib/shopify/live-products.ts` (copied here). Pick 9 product GIDs, ideally including the product with the most variants.

```graphql
query LiveProducts($ids: [ID!]!, $ctx: ContextualPublicationContext!, $withCtx: Boolean!) {
  nodes(ids: $ids) {
    ... on Product {
      id status publishedAt isGiftCard requiresSellingPlan tracksInventory hasOnlyDefaultVariant onlineStoreUrl
      featuredMedia { preview { image { url } } }
      options { name values }
      publishedInContext(context: $ctx) @include(if: $withCtx)
      variants(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          id title availableForSale inventoryQuantity inventoryPolicy inventoryItem { tracked }
          price compareAtPrice selectedOptions { name value }
        }
      }
    }
  }
}
```

Run it twice:

- with a country: `{ "ids": [ ...9 GIDs... ], "ctx": { "country": "US" }, "withCtx": true }`
- without: `{ "ids": [ ...9 GIDs... ], "ctx": {}, "withCtx": false }`

Read `extensions.cost` from each response.

| Run | `requestedQueryCost` | `actualQueryCost` | Under 1,000? |
|---|---|---|---|
| With country | | | |
| Without country | | | |

The requested cost must stay under Shopify's single-query limit of 1,000 points. If it doesn't, stop and report (C12 would need revisiting).

---

## 4. Untracked and CONTINUE stock

Pick real products/variants for each case (set them up in the admin if none exist):

- (a) tracked, policy DENY, quantity between 1 and 4,
- (b) tracked, policy CONTINUE ("Continue selling when out of stock"), quantity 0,
- (c) untracked ("Track quantity" off),
- (d) tracked, DENY, quantity 0.

```graphql
query Stock($id: ID!) {
  productVariant(id: $id) {
    id
    title
    availableForSale
    inventoryQuantity
    inventoryPolicy
    inventoryItem { tracked }
  }
}
```

Expected stock wording (code rules: `availableForSale = false` → sold out; tracked + DENY → count; anything else → in stock; the model sees a count only below the threshold, default 5):

| Case | Variant GID | `availableForSale` | `inventoryQuantity` | `inventoryPolicy` | `tracked` | Expected | Storefront agrees? |
|---|---|---|---|---|---|---|---|
| (a) tracked + DENY + 1–4 | | | | | | `count n`, "only n left" | |
| (b) tracked + CONTINUE + 0 | | | | | | `in_stock` | |
| (c) untracked | | | | | | `in_stock` | |
| (d) tracked + DENY + 0 | | | | | | `sold_out` | |

---

## Notes / anything that didn't match

-
