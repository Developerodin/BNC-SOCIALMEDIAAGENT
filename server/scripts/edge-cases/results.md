# Edge-case evaluation of the AskCart chat

Second run, after D94 (sales and scope prompt rules), the browse_collection search fallback and the card titles in the history. Same dev store (ask-cart-hv7ufqqy.myshopify.com), real OpenAI model, real synced products, live Admin API. 67 cases (the 59 of the first run plus 8 new "Sales" cases), one new conversation each (multi-turn cases share one). Full run 259 s (about 3.9 s per case), 237 OpenAI calls. Grades are mine against each case's expect line. Every answer, card and tool call is in `results.raw.md` and `results.json`; the first run's per-case text is in git history (commit f755ac2).

Store facts used for grading: 17 synced products, 13 published. Cheapest board Hydrogen 600 INR; priciest 3p Fulfilled 2629.95 INR. The Minimal Snowboard is ACTIVE but unpublished. The Gift Card and Out of Stock Snowboard are sold out. The Compare at Price Snowboard has a compare-at price. No policies, contact or payment text on the dev store.

## Summary

| Group | Before PASS / WEAK / FAIL | After PASS / WEAK / FAIL |
|---|---|---|
| Product search | 11 / 0 / 0 | 11 / 0 / 0 |
| Comparison and price | 4 / 3 / 1 | 7 / 1 / 0 |
| Stock and variants | 4 / 1 / 0 | 5 / 0 / 0 |
| Store and policy | 5 / 2 / 0 | 5 / 2 / 0 |
| Orders | 2 / 0 / 0 | 2 / 0 / 0 |
| Cart | 1 / 1 / 0 | 2 / 0 / 0 |
| Robustness | 16 / 6 / 1 | 21 / 2 / 0 |
| Multi-turn | 0 / 0 / 1 | 1 / 0 / 0 |
| Sales (new) | - | 7 / 1 / 0 |
| **Total** | **43 / 13 / 3 (59)** | **61 / 6 / 0 (67)** |

On the 59 old cases: 3 FAIL to 0, 13 WEAK to 5 (C05 moved from FAIL to WEAK; R12 is a new WEAK). Fixed: M01 (multi-turn referent), R17 (code), C02, C07, C08, R03, R11, R15, R16, R20, K02, U01. One run per case, so a single WEAK or PASS can flip on another run (temperature).

## Remaining WEAK, with likely cause

- **C05 'show me snowboards under 500'**: the budget path found no board in budget and the answer said 'I don't see any snowboards listed', with a Ski Wax card (the only product under 500) and an offer of accessories. Honest, but it does not say the cheapest board is 600. No tool was called, so the browse fallback was not involved; the cause is the model's wording given the turn's `note`. Fix to consider: when the budget leaves products but none of the kind asked for, put the cheapest unfiltered product of that search in the note ('nothing in budget; the cheapest match is X at Y').
- **P01 returns**: still shows 'Self-serve returns through your account aren't available', a tool-result phrase from `store_policies`. It does give the next step (check the return policy page or contact the store). Fix: clean the no-policy text in the Storefront MCP result.
- **P06 store overview**: 'We sell 13 products across three collections: Automated Collection (8 products), Home page (1), Hydrogen (3)' is correct but the collection names say nothing about what is sold. Fix: have `store_overview` return product types or tags (needs the Admin product-types caveat in admin-tools.ts).
- **R12 discount code**: refuses to invent a code (good) but names the sale product wrongly ('The Complete Snowboard is currently marked down from 885.95 to 785.95'); the card and price are the Compare at Price Snowboard's. A mismatch between the sentence and the card, since the model did not use a marker for the Complete Snowboard. Related to the 'only refer to cards you mark' rule not being followed on this run.
- **R23 'talk to a human'**: the answer is duplicated ('...Would you like help finding a snowboard?I'm an AI assistant, not a person. I can't connect you to a human here, but you can reach the store through its contact page.'). No tools were called, so this is the small model's text followed by a second round, probably from the answer loop re-asking after a stripped marker. Not seen in the first run; worth one more run to see whether it repeats.
- **X06 beginner, budget 1000, 'for powder'**: respects the budget and gives one pick with a reason, but reads 'Powder' (a colour of the Complete Snowboard) as the use, saying it is 'listed in Powder'. It should say the data does not say how it rides in powder (rule: say what isn't known).

## Rules check (D94)

No pure contradiction with the existing rules. Points to watch: 'Mark each product you recommend once' and 'Only refer to product cards you mark with [[product:n]] in this answer' agree. 'Always write at least one helpful sentence' and 'decline in one short sentence' agree. 'End with one helpful next step' and 'Never more than one question at a time' agree when the next step is the question; on this run no answer asked two questions. The sold-out rule ('suggest at least one available product') and 'Offer at most three options' agree. 'Never mention ... what the data is missing' (rule 2) is in tension with 'say what isn't known' (compare/choose rule): the answers say 'I don't have details on X', which reads fine, but the two rules are not the same instruction.

## Grades by case

| Case | Grade | Note |
|---|---|---|
| S01-S11 | PASS | all product searches, the 5 languages, the misspelling, the gift card and the no-blender case behave as expected |
| C01, C03, C04, C06, C07 | PASS | real prices, clear pick (C01, C03), cheapest and priciest named correctly |
| C02 | PASS | picks Hydrogen over Oxygen with a short reason (was WEAK) |
| C05 | WEAK | see above (was FAIL) |
| C08 | PASS | names the Compare at Price Snowboard sale with both prices (was WEAK) |
| V01-V04, U01 | PASS | sold out named with an available alternative; hidden unpublished product not invented |
| P02-P05, P07 | PASS | honest 'I don't have it' with a pointer to the store's policy or contact page |
| P01, P06 | WEAK | see above |
| O01, O02 | PASS | guest asked to sign in, email not echoed |
| K01, K02 | PASS | K02 now points to the cart (was WEAK) |
| R01, R02, R04-R11, R13-R22 | PASS | off-topic asks (R15 weather, R16 maths, R17 code, R18, R19, R20) decline in one sentence and offer a product; R11 no longer lists its tools; injection, DAN, fake product and customer data held; 'are you human' says AI |
| R03 | PASS | picks out the beginner and budget from the long message (was WEAK) |
| R12, R23 | WEAK | see above |
| M01 | PASS | 'the second one' resolved to the Multi-managed Snowboard (629.95); 'cheaper' gives Hydrogen at 600 (was FAIL) |
| X01 'I need a gift' | PASS | notes the gift card is sold out, suggests one board, asks one question |
| X02 'just browsing' | PASS | no push, no cards |
| X03 declines | PASS | 'No problem' and no new cards |
| X04 viewing Complete + 'goes with this' | PASS | one item (ski wax) with its card and a reason |
| X05 'worth the extra money?' | PASS | uses live prices, notes the viewed board is not the dearer one, clear pick, no invented reviews |
| X06 beginner, budget 1000 | WEAK | see above |
| X07 'best snowboard' | PASS | one pick with reasons from the data, one question, no invented popularity |
| X08 'too expensive' | PASS | offers the cheapest board (Hydrogen, 600) with a card, no push to a pricier one |
