# Our search vs Storefront Catalog MCP

- Store: ask-cart-hv7ufqqy.myshopify.com
- Run at: 2026-11-24T08:11:44.760Z
- Agent profile: https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json
- Ours: `search(storeId, query, 10, { includeGiftCards })`, top 5 distinct products. Latency includes the OpenAI embedding call.
- MCP: `search_catalog` with `pagination.limit = 5`, no context or filters (so the default `filters.available = true` applies). Latency is the full HTTP round trip.
- Grading: hit@1 / hit@5 when a top title contains an expected string; queries expecting nothing pass only on zero results; n/a = no expected answer.

## Summary

| | Ours | MCP |
|---|---|---|
| Latency | 21 ok calls; mean 436 ms, p50 433 ms, p95 470 ms | 21 ok calls; mean 253 ms, p50 258 ms, p95 297 ms |
| Grades | hit@1: 15, n/a: 2, hit@5: 2, fail: 2 | hit@1: 8, n/a: 2, miss: 9, pass: 2 |
| Queries with zero results | 0 | 10 |
| Errors | 0 | 0 |
| Same top-1 product (both answered) | 7 / 11 | |

## exact-complete: "the complete snowboard"

exact name. Expected: The Complete Snowboard.

| # | Ours (473 ms, hit@1) | MCP (304 ms, hit@1) |
|---|---|---|
| 1 | The Complete Snowboard (score 0.695) | The Complete Snowboard (INR 699.95, available) |
| 2 | The 3p Fulfilled Snowboard (score 0.590) | The Multi-managed Snowboard (INR 629.95, available) |
| 3 | The Multi-managed Snowboard (score 0.555) | The Multi-location Snowboard (INR 729.95, available) |
| 4 | The Videographer Snowboard (score 0.540) | The Compare at Price Snowboard (INR 785.95, available) |
| 5 | The Multi-location Snowboard (score 0.540) | The 3p Fulfilled Snowboard (INR 2629.95, available) |

## exact-videographer: "do you have the videographer snowboard?"

exact name. Expected: The Videographer Snowboard.

| # | Ours (430 ms, hit@1) | MCP (279 ms, hit@1) |
|---|---|---|
| 1 | The Videographer Snowboard (score 0.676) | The Videographer Snowboard (INR 885.95, available) |
| 2 | The Multi-location Snowboard (score 0.476) | The Multi-managed Snowboard (INR 629.95, available) |
| 3 | The Multi-managed Snowboard (score 0.460) | The Complete Snowboard (INR 699.95, available) |
| 4 | The Complete Snowboard (score 0.455) | The Multi-location Snowboard (INR 729.95, available) |
| 5 | The 3p Fulfilled Snowboard (score 0.451) |  |

## partial-hydrogen: "hydrogen snowboard"

partial name. Expected: Hydrogen.

| # | Ours (445 ms, hit@1) | MCP (287 ms, hit@1) |
|---|---|---|
| 1 | The Collection Snowboard: Hydrogen (score 0.618) | The Collection Snowboard: Hydrogen (INR 600.00, available) |
| 2 | The Collection Snowboard: Liquid (score 0.598) | The Collection Snowboard: Oxygen (INR 1025.00, available) |
| 3 | The Collection Snowboard: Oxygen (score 0.584) | The Collection Snowboard: Liquid (INR 749.95, available) |
| 4 | The Multi-managed Snowboard (score 0.523) | The Multi-location Snowboard (INR 729.95, available) |
| 5 | The 3p Fulfilled Snowboard (score 0.517) | The Multi-managed Snowboard (INR 629.95, available) |

## partial-oxygen: "oxygen"

partial name. Expected: Oxygen.

| # | Ours (442 ms, hit@1) | MCP (268 ms, hit@1) |
|---|---|---|
| 1 | The Collection Snowboard: Oxygen (score 0.339) | The Collection Snowboard: Oxygen (INR 1025.00, available) |
| 2 | The Collection Snowboard: Hydrogen (score 0.202) |  |
| 3 | The Collection Snowboard: Liquid (score 0.190) |  |
| 4 | The Complete Snowboard (score 0.139) |  |
| 5 | Selling Plans Ski Wax (score 0.134) |  |

## partial-liquid: "the liquid board"

partial name. Expected: Liquid.

| # | Ours (437 ms, hit@1) | MCP (282 ms, hit@1) |
|---|---|---|
| 1 | The Collection Snowboard: Liquid (score 0.395) | The Collection Snowboard: Liquid (INR 749.95, available) |
| 2 | The Videographer Snowboard (score 0.340) |  |
| 3 | The 3p Fulfilled Snowboard (score 0.329) |  |
| 4 | The Complete Snowboard (score 0.318) |  |
| 5 | The Inventory Not Tracked Snowboard (score 0.299) |  |

## vague-beginner: "something for a beginner"

vague intent. Expected: no fixed answer.

| # | Ours (422 ms, n/a) | MCP (229 ms, n/a) |
|---|---|---|
| 1 | The 3p Fulfilled Snowboard (score 0.241) |  |
| 2 | The Complete Snowboard (score 0.240) |  |
| 3 | The Collection Snowboard: Oxygen (score 0.184) |  |
| 4 | Selling Plans Ski Wax (score 0.180) |  |
| 5 | The Videographer Snowboard (score 0.171) |  |

## vague-gift-budget: "a gift under 1000 rupees"

vague intent + price. Expected: Gift Card / Ski Wax.

| # | Ours (397 ms, hit@1) | MCP (249 ms, miss) |
|---|---|---|
| 1 | Gift Card (score 0.379) |  |
| 2 | The Complete Snowboard (score 0.246) |  |
| 3 | The Inventory Not Tracked Snowboard (score 0.237) |  |
| 4 | The Videographer Snowboard (score 0.235) |  |
| 5 | The 3p Fulfilled Snowboard (score 0.233) |  |

## vague-cheapest: "what's your cheapest snowboard?"

vague intent + price. Expected: no fixed answer.

| # | Ours (443 ms, n/a) | MCP (259 ms, n/a) |
|---|---|---|
| 1 | The Compare at Price Snowboard (score 0.537) | The Multi-managed Snowboard (INR 629.95, available) |
| 2 | The 3p Fulfilled Snowboard (score 0.515) | The Multi-location Snowboard (INR 729.95, available) |
| 3 | The Out of Stock Snowboard (score 0.489) | The Complete Snowboard (INR 699.95, available) |
| 4 | The Videographer Snowboard (score 0.479) | The Collection Snowboard: Hydrogen (INR 600.00, available) |
| 5 | The Complete Snowboard (score 0.476) | The 3p Fulfilled Snowboard (INR 2629.95, available) |

## vague-premium: "a premium board, money is no object"

vague intent. Expected: Complete / Multi-location / Multi-managed.

| # | Ours (424 ms, hit@1) | MCP (226 ms, miss) |
|---|---|---|
| 1 | The Complete Snowboard (score 0.480) |  |
| 2 | The Multi-managed Snowboard (score 0.377) |  |
| 3 | The Multi-location Snowboard (score 0.365) |  |
| 4 | The 3p Fulfilled Snowboard (score 0.360) |  |
| 5 | The Compare at Price Snowboard (score 0.357) |  |

## attr-159: "a 159 cm board"

attribute. Expected: The Complete Snowboard / The Multi-managed Snowboard.

| # | Ours (422 ms, hit@1) | MCP (212 ms, miss) |
|---|---|---|
| 1 | The Multi-managed Snowboard (score 0.430) |  |
| 2 | The Complete Snowboard (score 0.422) |  |
| 3 | The 3p Fulfilled Snowboard (score 0.412) |  |
| 4 | The Out of Stock Snowboard (score 0.373) |  |
| 5 | The Videographer Snowboard (score 0.370) |  |

## attr-weight: "a snowboard that weighs 7 pounds"

attribute. Expected: The Complete Snowboard.

| # | Ours (430 ms, hit@1) | MCP (297 ms, hit@1) |
|---|---|---|
| 1 | The Complete Snowboard (score 0.535) | The Complete Snowboard (INR 699.95, available) |
| 2 | The Multi-managed Snowboard (score 0.513) | The Multi-managed Snowboard (INR 629.95, available) |
| 3 | The Videographer Snowboard (score 0.510) | The Multi-location Snowboard (INR 729.95, available) |
| 4 | The Compare at Price Snowboard (score 0.492) | The 3p Fulfilled Snowboard (INR 2629.95, available) |
| 5 | The 3p Fulfilled Snowboard (score 0.481) |  |

## attr-color: "a board in the Sunset colour"

attribute. Expected: The Complete Snowboard.

| # | Ours (430 ms, hit@1) | MCP (220 ms, miss) |
|---|---|---|
| 1 | The Complete Snowboard (score 0.424) |  |
| 2 | The Out of Stock Snowboard (score 0.376) |  |
| 3 | The 3p Fulfilled Snowboard (score 0.356) |  |
| 4 | The Multi-location Snowboard (score 0.354) |  |
| 5 | The Collection Snowboard: Oxygen (score 0.332) |  |

## attr-sale: "any snowboards on sale or discounted?"

attribute. Expected: Compare at Price.

| # | Ours (422 ms, hit@5) | MCP (286 ms, miss) |
|---|---|---|
| 1 | The Out of Stock Snowboard (score 0.587) | The Multi-managed Snowboard (INR 629.95, available) |
| 2 | The Compare at Price Snowboard (score 0.561) | The Multi-location Snowboard (INR 729.95, available) |
| 3 | The Complete Snowboard (score 0.547) | The Complete Snowboard (INR 699.95, available) |
| 4 | The 3p Fulfilled Snowboard (score 0.513) | The 3p Fulfilled Snowboard (INR 2629.95, available) |
| 5 | The Multi-location Snowboard (score 0.511) |  |

## accessory-wax: "ski wax"

accessory. Expected: Ski Wax.

| # | Ours (425 ms, hit@1) | MCP (258 ms, hit@1) |
|---|---|---|
| 1 | Selling Plans Ski Wax (score 0.510) | Selling Plans Ski Wax (INR 9.95, available) |
| 2 | The Multi-location Snowboard (score 0.375) | The Complete Snowboard (INR 699.95, available) |
| 3 | The Videographer Snowboard (score 0.375) | The Multi-managed Snowboard (INR 629.95, available) |
| 4 | The Inventory Not Tracked Snowboard (score 0.367) | The Multi-location Snowboard (INR 729.95, available) |
| 5 | The 3p Fulfilled Snowboard (score 0.367) | The Videographer Snowboard (INR 885.95, available) |

## accessory-subscription: "can I subscribe to get wax delivered regularly?"

accessory. Expected: Ski Wax.

| # | Ours (453 ms, hit@1) | MCP (224 ms, miss) |
|---|---|---|
| 1 | Selling Plans Ski Wax (score 0.437) |  |
| 2 | The 3p Fulfilled Snowboard (score 0.196) |  |
| 3 | The Videographer Snowboard (score 0.195) |  |
| 4 | The Multi-location Snowboard (score 0.191) |  |
| 5 | The Complete Snowboard (score 0.191) |  |

## lang-fr: "Je cherche une planche à neige haut de gamme"

French. Expected: Complete / Multi-location / Multi-managed.

| # | Ours (433 ms, hit@5) | MCP (215 ms, miss) |
|---|---|---|
| 1 | The Compare at Price Snowboard (score 0.490) |  |
| 2 | The 3p Fulfilled Snowboard (score 0.488) |  |
| 3 | The Complete Snowboard (score 0.481) |  |
| 4 | The Multi-managed Snowboard (score 0.470) |  |
| 5 | The Out of Stock Snowboard (score 0.467) |  |

## lang-hi: "मुझे एक स्नोबोर्ड चाहिए"

Hindi. Expected: Snowboard.

| # | Ours (402 ms, hit@1) | MCP (279 ms, hit@1) |
|---|---|---|
| 1 | The Compare at Price Snowboard (score 0.192) | The Multi-managed Snowboard (INR 629.95, available) |
| 2 | The Videographer Snowboard (score 0.179) | The Multi-location Snowboard (INR 729.95, available) |
| 3 | The 3p Fulfilled Snowboard (score 0.178) | The Complete Snowboard (INR 699.95, available) |
| 4 | Selling Plans Ski Wax (score 0.176) | The Collection Snowboard: Hydrogen (INR 600.00, available) |
| 5 | The Collection Snowboard: Oxygen (score 0.171) | The 3p Fulfilled Snowboard (INR 2629.95, available) |

## sold-out: "the out of stock snowboard"

sold-out product. Expected: The Out of Stock Snowboard.

| # | Ours (470 ms, hit@1) | MCP (256 ms, miss) |
|---|---|---|
| 1 | The Out of Stock Snowboard (score 0.813) | The Multi-managed Snowboard (INR 629.95, available) |
| 2 | The Inventory Not Tracked Snowboard (score 0.601) | The Multi-location Snowboard (INR 729.95, available) |
| 3 | The 3p Fulfilled Snowboard (score 0.555) | The Complete Snowboard (INR 699.95, available) |
| 4 | The Compare at Price Snowboard (score 0.551) | The 3p Fulfilled Snowboard (INR 2629.95, available) |
| 5 | The Complete Snowboard (score 0.545) | The Collection Snowboard: Oxygen (INR 1025.00, available) |

## gift-card: "can I buy a gift card?"

gift card (includeGiftCards). Expected: Gift Card.

| # | Ours (436 ms, hit@1) | MCP (199 ms, miss) |
|---|---|---|
| 1 | Gift Card (score 0.563) |  |
| 2 | Selling Plans Ski Wax (score 0.291) |  |
| 3 | The Videographer Snowboard (score 0.206) |  |
| 4 | The Multi-location Snowboard (score 0.202) |  |
| 5 | The Inventory Not Tracked Snowboard (score 0.192) |  |

## off-catalogue: "a kitchen blender"

not sold here. Expected: nothing.

| # | Ours (470 ms, fail) | MCP (216 ms, pass) |
|---|---|---|
| 1 | The Collection Snowboard: Liquid (score 0.173) |  |
| 2 | The Videographer Snowboard (score 0.168) |  |
| 3 | Selling Plans Ski Wax (score 0.165) |  |
| 4 | The Collection Snowboard: Oxygen (score 0.153) |  |
| 5 | The Collection Snowboard: Hydrogen (score 0.150) |  |

## nonsense: "qwzx blorft 9000 zzkv"

nonsense. Expected: nothing.

| # | Ours (454 ms, fail) | MCP (262 ms, pass) |
|---|---|---|
| 1 | The Videographer Snowboard (score 0.274) |  |
| 2 | The Inventory Not Tracked Snowboard (score 0.258) |  |
| 3 | The Compare at Price Snowboard (score 0.246) |  |
| 4 | The 3p Fulfilled Snowboard (score 0.246) |  |
| 5 | The Collection Snowboard: Oxygen (score 0.242) |  |
