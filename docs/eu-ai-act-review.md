# AskCart: EU AI Act issue-spotting review

> **This is educational EU AI Act issue-spotting. It is not legal advice, and it does not show that any duty is or is not met.** It does not classify the system, does not say whether the system complies, and does not predict enforcement. A qualified lawyer should review any point before anyone relies on it.

## Report header

**Review scope**

- **What was reviewed:** AskCart, a Shopify AI shopping assistant. It covers the storefront chat (launcher, floating panel and drawer), the "Ask our AI agent" product block and its AI-written suggested questions, how the chat behaves (system prompt, tools and chat routes), the hosted chat page and the embed script, the mobile API documentation, and the information merchants see in the admin and the deployment docs.
- **Repository:** `C:/Users/INTEL/Desktop/Shopify extension`, branch `main`.
- **Commit:** the brief named commit `7b668ee`, but the code was at `619e28e` when this review ran. That one later commit moves the block's CSS into `shopify/extensions/askcart/assets/askcart-ask-ai.css` and shortens `shopify/extensions/askcart/blocks/askcart-ask-ai.liquid`, which is in scope. **Every line number in this report refers to `619e28e`.**
- **Review date:** 25 November 2026.
- **Facts supplied by the project owner (treated as facts):**
  - **Roles:** the AskCart team is the provider of the chat system. OpenAI provides the general-purpose AI model through its API. Each merchant that installs AskCart is a deployer.
  - **Intended purpose:** answer product and policy questions, recommend and compare products, add products to the cart, show a signed-in shopper their own order status, and write suggested questions for product pages. It is not used for decisions about people.
  - **First merchant:** Bois & Chiffons, a French store with EU shoppers and prices in EUR.
  - **Go-live:** placed on the market or put into service on or about 25–26 November 2026.
  - **Languages:** en, fr, de, es, it and nl.

**Evidence level**

- The strongest evidence is **source code**. The built bundles `shopify/extensions/askcart/assets/askcart-widget.js` and `server/public/askcart-hosted.js` contain the English notice string.
- Tests that check parts of the notice exist (`server/tests/widget/panel.test.ts`), but they were **not run** for this review. This report therefore does not claim `Tested behaviour`.
- No deployed or user-visible behaviour was observed, so neither `Deployed behaviour` nor `User-visible behaviour` is claimed.

**Legal currency: partial verification**

Live checks were made on 25 November 2026, using English-language versions only.

What was completed:

1. **Modifiers of the base act.** The EUR-Lex record for Regulation (EU) 2024/1689 (CELEX 32024R1689, `.../ALL/?uri=CELEX:32024R1689`) loaded real metadata. Its "Modified by" list shows only Regulation (EU) 2026/1744 (in force 27 July 2026). The automated read counted about 88 amendment rows; that count is approximate.
   - It lists corrigenda R(01) to R(04), which match the pinned register.
   - It lists no delegated or implementing acts.
   - It also shows proposals 52025PC0836 and 52025PC1023. These are proposals, not law.
2. **Relationships of Regulation (EU) 2026/1744.** Its own record (CELEX 32026R1744) lists one corrigendum that is **not in the pinned register**: [32026R1744R(01)](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32026R1744R(01)), dated 29 September 2026, OJ L 2026/90810.
   - It affects only the **German** language version.
   - It corrects Article 1 point (8), which inserts Article 6(1b), in the high-risk classification rules. The words "Unbeschadet des Absatzes 1a" become "Ungeachtet des Absatzes 1a".
   - It does not touch Article 50, 4, 5 or 111, so it affects none of the findings below. The source register is stale on this point and needs human review.
3. **Operative text read.** The following passages were read from the EUR-Lex English pages, through an automated summariser that quotes only in short pieces. They were not read verbatim end to end:
   - Article 50(1), (2), (5) and (6) of the base act.
   - Article 2(1)(a)–(c) and Article 3(3), (4), (9) and (11).
   - The parts of Regulation (EU) 2026/1744 that replace Article 4 (point (5), read in full), replace Article 50(7) (point (20)), add Article 111(4) (point (39)(b)) and amend Article 113 (point (40)) and Article 99 (point (38)).
   - The added Article 111(4) limits the 2 December 2026 deadline for Article 50(2) to providers of systems "placed on the market before 2 August 2026".
4. **Commission guidance pages.** All four pages loaded, and **all four changed after the register's pinned date of 2 August 2026**. Every finding that cites them treats them as **possibly superseded**, and a human must re-read them before relying on them.
   - Guidelines on transparency obligations: published 20 July 2026, last updated 5 November 2026. **The guidelines PDF itself was not read**, so this report attributes nothing to its content.
   - Article 50 questions and answers: last updated 24 July 2026. This is the only guidance content that was actually read.
   - EU icons page: last updated 13 October 2026.
   - Code of Practice page: last updated 19 October 2026. It describes the code as final.

What was not completed:

- The ELI redirect (`data.europa.eu/eli/reg/2024/1689` to `eur-lex.europa.eu/eli/...`) was not followed. The CELEX route was used instead.
- The relationship lists of the four base-act corrigenda were not opened.
- Article 113 point (c) and the wording of the new Article 5 points were read only in part.
- The dates for Chapter III and for the new Article 5 points therefore come from the pinned register, not from today's check.

**Known limits**

- No code was run. No tests were run. The live Bois & Chiffons storefront, theme settings, mobile app and any embedding site were not observed.
- These surfaces were not reviewed:
  - Who writes the product FAQ content. `server/src/lib/faq.ts` reads it from the database, and its authorship was not traced.
  - The admin FAQ editor.
  - The MCP and partner APIs.
  - The social-media agent.
  - `rewrite.ts`, `events.ts` and `budget.ts`, beyond a skim.
- OpenAI's own obligations as the general-purpose model provider were not assessed.

---

## Findings (prioritised)

Findings are ordered by how much they may affect shoppers and how soon the provision applies. The order is not a legal verdict.

### EUAI-001 — Mobile app: the docs do not tell the app developer to show shoppers that they are talking to an AI

1. **Review surface:**
   - `docs/mobile-api.md:1-5` (introduction), `:98-172` (`POST /api/chat` and its event stream) and `:188-205`.
   - The merchant admin's "Mobile app key" card: `server/src/app/(embedded)/app/page.tsx:472-483`.
   - `docs/deploy-ec2.md:297-298`.
2. **Observed evidence:**
   - Line 3 of the mobile docs says the app "can use the same AI shopping assistant".
   - The docs explain the event stream and tell the developer to "Append to the answer bubble" (`:133`). Nowhere do they tell the developer to show an AI-interaction notice, or give the notice text in the six languages.
   - The admin card says only: "Your mobile app sends this key to use the same chat assistant as your store" (`page.tsx:482`).
   - No API field carries a notice string. The event payloads are `meta`, `text`, `product`, `error` and `done` (`server/src/lib/chat/sse.ts:14`).
   - The web notice exists only in the widget's own interface (`server/widget/src/panel/panel.ts:158-160`). The app developer builds their own interface, so the web notice never reaches the app.
3. **Possible AI Act trigger:**
   - Article 50(1): the provider must design an AI system that interacts directly with people so that they are informed they are interacting with AI, unless this is obvious.
   - Article 50(5): the information must be clear and distinguishable, given no later than the first interaction, and accessible.
4. **Role and conditions:**
   - The AskCart team is the provider (supplied fact). The duty is the provider's design duty.
   - The merchant (deployer) or the merchant's app developer builds the interface. Article 50(1) places no matching interaction-disclosure duty on the deployer.
   - The conditions are: the system interacts directly with people through the app (supplied); it is offered in the Union (supplied); the "obvious" exception does not apply (not shown); and the law-enforcement exception does not apply (not relevant here).
   - How a provider meets its design duty when a third party draws the interface is an open question for the human reviewer.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(1) and (5)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), as amended by [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). According to the read, it says the notice should come at the start of the first interaction and that the "obvious" exception is to be read narrowly.
   - Official guidance (possibly superseded): [Commission guidelines on transparency obligations](https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems). The PDF was not read.
   - Official guidance, optional asset (possibly superseded): [EU icons for labelling AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position is: "The use of these EU icons is optional, but the labelling requirements under Article 50 AI Act are not. The use of these icons does not establish legal compliance by itself. Deployers remain responsible for ensuring that any disclosure meets the requirements of Article 50 AI Act. Signatories of the Code of Practice on marking and labelling of AI-generated content must duly implement the measures it contains." Only the first sentence was confirmed on the live page today.
6. **Applicable date:**
   - Article 50 has applied since 2 August 2026.
   - The placement date supplied is on or about 25–26 November 2026, so Article 50(1) applies from the first app interaction.
   - No transition applies to Article 50(1).
7. **Status:** likely relevant
8. **Missing facts:**
   - Whether Bois & Chiffons has a mobile app using the API at launch.
   - What that app shows before or with the first answer.
   - Who builds and controls that interface.
   - Whether any contract or documentation tells the developer what to display.
9. **Next action:** add a required "Tell shoppers it's an AI" section to `docs/mobile-api.md` and the admin card, with the six notice strings from `server/widget/src/core/i18n.ts`. Then check what the live app actually shows.
   - Design suggestion only, not a legal requirement: the API could also return the localised notice text, so that apps do not have to copy it by hand.
10. **Human decision required:** the AskCart team must decide how the provider's disclosure is guaranteed in third-party mobile interfaces (documentation only, an API-delivered notice, or a contractual requirement), and whether the mobile key is issued before that is in place.

### EUAI-002 — "Ask our AI agent" block and drawer: merchant text can replace the AI wording at the first point of interaction

1. **Review surface:**
   - `shopify/extensions/askcart/blocks/askcart-ask-ai.liquid:10-18, 32-33, 35-48, 63-64`
   - `shopify/extensions/askcart/locales/*.json:12-16`
   - `server/widget/src/ask-ai-block.ts:25-33, 89-97, 104-112, 120-128`
   - `server/widget/src/launcher/launcher.ts:124-131`
   - `server/widget/src/panel/panel.ts:486-490, 502, 516-524`
   - `server/tests/widget/panel.test.ts:839-845`
2. **Observed evidence:**
   - By default the block's heading says it is AI. The `ask_ai.heading` strings are "Ask our AI agent", "Demandez à notre agent IA", "Frag unseren KI-Agenten", "Pregunta a nuestro agente de IA", "Chiedi al nostro agente IA" and "Vraag het onze AI-assistent" (`locales/*.json:13`).
   - The merchant can replace the eyebrow and the heading with any text (`askcart-ask-ai.liquid:10-11, 17-18, 63-64`).
   - The shopper's first input happens on the product page: typing in the block's field (`:35-48`) or tapping a pill (`ask-ai-block.ts:111`). The question is sent as soon as the drawer opens (`panel.ts:516-524`).
   - In drawer mode, the block's eyebrow and heading **replace** the "AI shopping assistant" subtitle (`panel.ts:486-490`). An existing test confirms that the eyebrow is shown in its place (`panel.test.ts:839-845`).
   - The footer notice is built for every panel (`panel.ts:158-170`), but no test was found that checks the notice in drawer mode.
   - AI-written pills carry only a sparkle icon, and that icon is hidden from screen readers (`ask-ai-block.ts:28, 110`).
   - The optional note under the input describes the data used, not the use of AI (`locales/en.default.json:16`), and it can be turned off (`askcart-ask-ai.liquid:49-51, 70`).
3. **Possible AI Act trigger:**
   - Article 50(1): inform people that they are interacting with AI.
   - Article 50(5): the information must be clear, given no later than the first interaction, and accessible.
   - The open question is whether "first interaction" begins at the block's input, before the drawer and its footer notice exist.
4. **Role and conditions:**
   - The provider (the AskCart team) carries the design duty.
   - The merchant (deployer) controls the override text, but Article 50(1) is not a deployer duty.
   - The conditions are direct interaction (yes, from the code path) and no "obvious in context" exception. That exception is not shown when the heading has been overridden.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(1) and (5)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act).
   - Official guidance, optional asset (possibly superseded): [EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position is the same as quoted in EUAI-001: the icons are optional, the Article 50 duties are not, and the icons alone do not establish compliance.
6. **Applicable date:** 2 August 2026. It applies from the supplied go-live date of about 25–26 November 2026.
7. **Status:** possibly relevant
8. **Missing facts:**
   - The eyebrow and heading Bois & Chiffons has actually set.
   - Whether the note is on.
   - What a shopper sees and hears from typing in the block to the first answer, in all six languages and with a screen reader.
9. **Next action:**
   - Engineering suggestion: keep AI wording in the drawer header (for example, keep the AI subtitle alongside the block's text), or add short AI wording next to the block's input that the merchant cannot remove.
   - Add a test asserting that the notice appears in drawer mode.
   - Check the live product page.
10. **Human decision required:** the AskCart team must decide whether merchants may override the block's AI heading without a fixed AI line remaining, and what text appears at the block's input.

### EUAI-003 — Storefront chat panel: the AI notice exists in every language; its wording, placement and accessibility need sign-off

1. **Review surface:**
   - `server/widget/src/panel/panel.ts:84-86, 122-128, 143-170, 508`
   - `server/widget/src/core/i18n.ts:1-2, 18, 21, 75, 78, 130, 133, 185, 188, 240, 243, 295, 298`
   - `server/widget/src/panel/styles.ts:69, 77`
   - `server/widget/src/panel/a11y.ts:26-37`
   - `server/tests/widget/panel.test.ts:536-542, 659-688`
   - `product.md:479, 527` (D49, D83)
   - `docs/publish-checklist.md:96`
2. **Observed evidence:**
   - The header always shows a subtitle, "AI shopping assistant", unless the drawer title replaces it (see EUAI-002).
   - The footer always shows "You're chatting with an AI assistant." followed by the retention line (`panel.ts:158-160`). No setting turns it off.
   - All six languages have the notice (`i18n.ts:21, 78, 133, 188, 243, 298`). The file says the wording is a draft "until the user approves it before the beta" (`i18n.ts:2`).
   - The notice is 12 px text in `#666` on `#fff` (`styles.ts:69, 77`), placed below the input.
   - When the panel opens, focus moves to the input (`panel.ts:508`). The notice is not linked to the dialog or the input with `aria-describedby`.
   - The dialog's accessible name is the store name only (`panel.ts:86`). The live region announces answers but not the notice (`a11y.ts:26-37`).
   - Tests exist for English and German (`panel.test.ts:659-688`) but were not run.
3. **Possible AI Act trigger:** Article 50(1) and Article 50(5), covering clarity, timing and accessibility.
4. **Role and conditions:**
   - This is a provider duty (the AskCart team).
   - Direct interaction on the EU storefront is a supplied fact.
   - The notice is the provider's chosen way of informing shoppers. Whether it is clear, early and accessible enough is the open question.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(1), (5)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act).
   - Official guidance, optional asset (possibly superseded): [EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position, as quoted in EUAI-001, applies here too.
6. **Applicable date:** 2 August 2026. It applies from go-live, about 25–26 November 2026.
7. **Status:** likely relevant (a disclosure has been built; its adequacy is the remaining question, not whether it exists)
8. **Missing facts:**
   - Whether the owner has approved the wording.
   - A rendered check in the live theme, since theme CSS or the merchant's colours could affect visibility.
   - A screen-reader walkthrough in fr, de, es, it and nl.
   - Whether the deployed bundle matches source.
9. **Next action:** run one user-visible check on the Bois & Chiffons storefront in each of the six languages, with and without a screen reader, and record the result.
   - Optional design suggestion: link the notice to the dialog with `aria-describedby`, so that it is announced when the panel opens.
10. **Human decision required:** the product owner must approve the notice wording (pending under D49), its placement and its accessibility before or at launch.

### EUAI-004 — Hosted chat page and embed: notice language follows the store, not the visitor

1. **Review surface:**
   - `server/src/app/chat/[shop]/route.ts:51-77`
   - `server/widget/src/hosted.ts:7-11`
   - `server/widget/src/embed.ts:36-61`
   - `docs/embed.md:3-5, 29, 49-52, 84`
2. **Observed evidence:**
   - The hosted page mounts the same panel with `inline: true` (`hosted.ts:11`), so the source includes the same footer notice (`panel.ts:158-170`). No test was found that checks the notice in inline mode.
   - The page's locale is `store.primaryLocale` (`route.ts:53`), not the visitor's language. For a French primary store, German or Dutch visitors to an embedding site or the shared link would see the French notice. The storefront, by contrast, follows the visitor's locale (`askcart-embed.liquid:10`).
   - The embed button's default label is "Chat" (`embed.ts:38`). On other sites nothing says AI before the panel opens.
   - `privacyUrl` is `null` on the hosted page (`route.ts:59`; `docs/embed.md:84`).
3. **Possible AI Act trigger:** Article 50(1) and Article 50(5). The question is whether the notice is clear to the person in their context.
4. **Role and conditions:**
   - This is a provider duty.
   - It is relevant only if the hosted link or the embed is actually used for EU visitors who may not read the store's primary language.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(1), (5)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance, optional asset (possibly superseded): [EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position, as quoted in EUAI-001, applies here too.
6. **Applicable date:** 2 August 2026. It applies from the first use of these surfaces.
7. **Status:** possibly relevant
8. **Missing facts:**
   - Whether Bois & Chiffons will use the embed or the hosted link at launch. `docs/deploy-ec2.md:256-291` describes an app install, so the theme app embed is the main surface.
   - Which sites, and the languages of their audiences.
9. **Next action:** decide whether the hosted page should take the visitor's browser language, or a `locale` hint from `embed.js`, for the notice. Add one test for the notice in inline mode.
10. **Human decision required:** the AskCart team must decide whether the hosted and embed surfaces are offered at launch, and in which language the notice is shown there.

### EUAI-005 — Merchant settings and pre-chat copy can make the assistant look human; merchants get no guidance

1. **Review surface:**
   - `server/src/app/(embedded)/app/page.tsx:657-724`
   - `server/src/lib/widget-config.ts:23-47, 122-139`
   - `server/widget/src/launcher/launcher.ts:82-89, 146-165`
   - `shopify/extensions/askcart/locales/*.json:3-5`
   - `docs/deploy-ec2.md:276-291`
2. **Observed evidence:**
   - The merchant can set the assistant's name, avatar image, welcome message, launcher label and teaser text (`page.tsx:660, 669-676, 693-694, 718-723`).
   - The defaults do not mention AI:
     - launcher "Ask us anything";
     - teaser "Questions? We're here to help." (`en.default.json:3, 5`), with similar wording in the other five locales;
     - welcome "Hi! I can help you find products…" (`widget-config.ts:27`).
   - Neither the admin card nor the merchant steps in deploy-ec2 §5.4 tell the merchant to avoid a human-sounding name, photo or welcome, or explain that the AI notice must stay visible.
   - In the provider's favour: the footer notice cannot be switched off (`panel.ts:160`).
3. **Possible AI Act trigger:** Article 50(1). Design choices by the provider determine whether the AI nature is clear. If the setup suggests a human, the "obvious in context" exception becomes harder to rely on, which is a reason not to rely on it.
4. **Role and conditions:**
   - The provider's design duty is in play.
   - The merchant (deployer) chooses the copy, but Article 50(1) has no deployer counterpart, so this is not framed as a merchant duty.
   - Whether this matters depends on what merchants actually configure.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(1), (5)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). It says the "obvious" exception is read narrowly.
   - Official guidance, optional asset (possibly superseded): [EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position, as quoted in EUAI-001, applies here too.
6. **Applicable date:** 2 August 2026. It applies from go-live.
7. **Status:** possibly relevant
8. **Missing facts:** Bois & Chiffons' actual name, avatar, welcome and teaser settings, and whether the teaser is enabled.
9. **Next action:** add one line to the admin "Chat widget" card and to deploy-ec2 §5.4 saying that shoppers must be able to tell it is an AI, and that the name and avatar should not suggest a person.
   - Copy suggestion only: the default teaser could mention AI.
10. **Human decision required:** the AskCart team must decide whether to restrict or advise on merchant name, avatar and welcome text, and whether the default teaser and launcher copy should mention AI.

### EUAI-006 — System prompt: no rule on answering "Am I talking to a person?"

1. **Review surface:** `server/src/lib/chat/prompt.ts:30-48`, the `rules()` function. It is described here, not reproduced.
2. **Observed evidence:**
   - The prompt casts the model as the store's shopping assistant and tells it to talk like a friendly store assistant (`prompt.ts:34, 37`).
   - No rule was found telling the model to say it is an AI when asked, or never to claim to be human or staff.
   - The file marks the wording as a D49 draft awaiting approval (`prompt.ts:30`).
   - Model behaviour was not tested in this review.
3. **Possible AI Act trigger:** Article 50(1), as a supporting design measure. The visible notice is the main way of informing shoppers. A reply claiming to be human could undercut it.
4. **Role and conditions:** this is a provider duty. Its relevance depends on how the model actually answers identity questions.
5. **Official source level and exact link:** Law: [Regulation (EU) 2024/1689, Article 50(1)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj). Official guidance, optional asset (possibly superseded): [EU icons](https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content). The Commission's position, as quoted in EUAI-001, applies here too.
6. **Applicable date:** 2 August 2026. It applies from go-live.
7. **Status:** possibly relevant
8. **Missing facts:** how the models actually reply to "Are you a real person?" in the six languages, and when the merchant's store text tries to change the rules.
9. **Next action:** add one prompt rule, "If asked, say you are an AI assistant; never claim to be a person or staff", and add an identity question to the live test set in all six languages.
10. **Human decision required:** the product owner must approve the prompt wording, which is pending under D49.

### EUAI-007 — Machine-readable marking of AI-generated chat answers: no marking found

1. **Review surface:**
   - `server/src/lib/chat/sse.ts:4-8, 14`
   - `server/src/app/api/chat/route.ts:45, 56, 109`
   - `server/widget/src/panel/messages.ts:71-76`
   - `server/src/lib/widget-contract.ts:57-59`
   - `docs/mobile-api.md:130-136`
2. **Observed evidence:**
   - The model's text is streamed as plain `text` deltas. The responses carry no header, field or attribute saying that the content is AI-generated.
   - In the page, answers are `div.msg.bot` elements (`messages.ts:72`) with no marking.
   - A repository-wide search found no provenance, watermark or "ai-generated" marker in the reviewed code. That is a negative search result, not proof that no marking exists.
3. **Possible AI Act trigger:** Article 50(2). Providers of systems that generate synthetic text must ensure that outputs are marked in a machine-readable format and are detectable as artificially generated, where technically feasible. Exceptions apply to assistive standard editing, to output that does not substantially alter the deployer's input, and to authorised law-enforcement use.
4. **Role and conditions:**
   - This is a provider duty. The AskCart system generates the answers, using OpenAI's model.
   - Material uncertainties are:
     - how far conversational answers are "synthetic text content" in the sense of the Article;
     - whether any exception or the Commission's stated exclusions cover them;
     - what is technically feasible for streamed text;
     - whether marking at OpenAI's level reaches the output.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(2)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), and [Regulation (EU) 2026/1744, Article 1 point (39)(b), adding Article 111(4)](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). According to the read, it lists exclusions including short strings of characters, source code and purely machine-to-machine output, and narrow business or industrial cases.
   - Voluntary code (page updated 19 October 2026, possibly superseded): [Code of Practice on marking and labelling AI-generated content](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content).
6. **Applicable date:**
   - Article 50(2) has applied since 2 August 2026.
   - The Article 111(4) transition to 2 December 2026 covers only systems placed on the market **before** 2 August 2026. With the supplied placement date of about 25–26 November 2026, the duty applies **from placement**, with no transition.
   - If AskCart was made available to any EU user before 2 August 2026, the date analysis changes.
7. **Status:** possibly relevant
8. **Missing facts:**
   - Whether AskCart was made available on the EU market before 2 August 2026, for example to another merchant.
   - Whether OpenAI marks the outputs it returns.
   - Which exceptions or exclusions the legal reviewer accepts for chat answers.
   - What is technically feasible for streamed text.
9. **Next action:** commission a short legal and technical note on whether chat answers fall under Article 50(2), and what marking (for example, a response header or field, or an attribute on the answer element) would be proportionate. Use the Code of Practice as an implementation reference only.
10. **Human decision required:** the AskCart team, with legal counsel, must decide whether chat answers need machine-readable marking at launch and, if so, which method.

### EUAI-008 — AI-written suggested questions on product pages: no marking found

1. **Review surface:**
   - `server/src/lib/chat/product-questions.ts:10-13, 25-34, 85-130`
   - `server/src/app/api/chat/product-questions/route.ts:6-10, 33-39`
   - `server/src/lib/widget-contract.ts:48`
   - `server/widget/src/ask-ai-block.ts:100-118`
   - `shopify/extensions/askcart/blocks/askcart-ask-ai.liquid:66`
2. **Observed evidence:**
   - When the merchant writes no questions, OpenAI generates up to three questions of at most 80 characters each (`product-questions.ts:11-12, 51-62`).
   - The response is `{ questions: string[] }`, with no marker. The questions are shown as buttons with a sparkle icon that is hidden from screen readers.
   - The merchant is told in the theme editor that "the AI writes questions" (`askcart-ask-ai.liquid:66`). Shoppers are not told.
3. **Possible AI Act trigger:** Article 50(2), machine-readable marking of synthetic text. Whether 80-character questions count as "short strings" excluded in the Commission's view is the main uncertainty.
4. **Role and conditions:** this is a provider duty. The conditions are that the output is synthetic text, that no exception or exclusion applies, and that marking is technically feasible.
5. **Official source level and exact link:**
   - Law: [Regulation (EU) 2024/1689, Article 50(2)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
   - Official guidance (possibly superseded): [Article 50 questions and answers](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). It mentions short strings among the exclusions.
   - Voluntary code (possibly superseded): [Code of Practice](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content).
6. **Applicable date:** 2 August 2026. It applies from placement at about 25–26 November 2026. There is no Article 111(4) transition unless the system was placed on the market earlier (see EUAI-007).
7. **Status:** possibly relevant
8. **Missing facts:**
   - The legal reviewer's view on the short-string exclusion.
   - Whether Bois & Chiffons leaves the questions empty, which turns on AI-written questions.
9. **Next action:** cover these questions in the same legal and technical note as EUAI-007.
10. **Human decision required:** the AskCart team, with counsel, must decide whether suggested questions need marking, or whether merchant-written questions should be the default for EU stores.

### EUAI-009 — AI literacy of staff: provider and deployer

1. **Review surface:**
   - The organisation, not code.
   - Merchant-facing material: `server/src/app/(embedded)/app/page.tsx` and `docs/deploy-ec2.md:276-299`.
2. **Observed evidence:**
   - No evidence was supplied about AI-literacy measures for AskCart staff.
   - The merchant admin and docs contain no AI-literacy material for merchant staff, and none is required to be supplied by the provider.
3. **Possible AI Act trigger:** amended Article 4. Providers and deployers "shall take measures to support the development of AI literacy of their staff and other persons dealing with the operation and use of AI systems on their behalf". It "does not require providers or deployers to guarantee any specific level of AI literacy of any individual."
4. **Role and conditions:**
   - The AskCart team (provider) and each merchant (deployer) each hold their own duty for their own staff.
   - These are separate duties: the provider is not responsible for the merchant's.
5. **Official source level and exact link:** Law: [Regulation (EU) 2026/1744, Article 1 point (5), replacing Article 4](https://data.europa.eu/eli/reg/2026/1744/oj), and [Regulation (EU) 2024/1689, Article 4](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html).
6. **Applicable date:**
   - Article 4 has applied since 2 February 2025, as part of Chapter I.
   - The replaced wording has applied since Regulation (EU) 2026/1744 entered into force on 27 July 2026.
7. **Status:** likely relevant
8. **Missing facts:** what measures the AskCart team has taken, and whether Bois & Chiffons staff who configure or monitor the chat have had any guidance.
9. **Next action:** write down the AskCart team's AI-literacy measures in a short internal note.
   - Optional courtesy, not a provider duty: offer merchants a one-page "how the assistant works and its limits" guide.
10. **Human decision required:** the AskCart team must decide what AI-literacy measures it records for its own staff. Each merchant decides its own.

### EUAI-010 — Prohibited practices (Article 5): no trigger found

1. **Review surface:**
   - `server/src/lib/chat/prompt.ts:30-48`
   - `server/widget/src/launcher/launcher.ts:146-165` (teaser)
   - `server/widget/src/panel/panel.ts` (no countdowns or pressure patterns were found)
   - A search of `server/src` for emotion, sentiment or biometric processing returned no matches.
2. **Observed evidence:**
   - The prompt forbids the model to state prices and requires stock to come only from live data (`prompt.ts:39-41`).
   - No subliminal or deliberately manipulative technique, exploitation of vulnerability, social scoring, biometric or emotion processing was found.
   - No image, video or audio generation was found. The new Article 5(1)(ba)/(bb) points concern realistic image, video or audio material.
3. **Possible AI Act trigger:** Article 5(1)(a)–(b), the manipulative or exploitative practices, and the new Article 5(1)(ba)–(bb).
4. **Role and conditions:** these apply to any operator placing on the market, putting into service or using such a system. The conditions were not shown by the evidence.
5. **Official source level and exact link:** Law: [Regulation (EU) 2024/1689, Article 5](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), and [Regulation (EU) 2026/1744, Article 1 point (7)](https://data.europa.eu/eli/reg/2026/1744/oj).
6. **Applicable date:**
   - Article 5 has applied since 2 February 2025.
   - The new points apply from 2 December 2026, according to the pinned register. That date was not re-verified live today.
7. **Status:** no trigger found in the supplied evidence
8. **Missing facts:** how the model behaves in live conversations, for example whether it pressures shoppers; this was not tested.
9. **Next action:** include a few "pressure and vulnerability" prompts in the live test set, and review the transcripts.
10. **Human decision required:** none now. The product owner decides whether to add these tests.

### EUAI-011 — High-risk classification (Article 6 and Annex III) and the general-purpose model chain: no trigger found

1. **Review surface:**
   - The supplied intended purpose.
   - `server/src/lib/chat/orders.ts:6-11` (order status for the signed-in shopper only).
   - `server/src/lib/chat/tools.ts:1-12` and `server/src/lib/chat/openai.ts:4-17` (calls to the OpenAI API; no fine-tuning or training was found).
2. **Observed evidence:**
   - The tools look up products, policies, the cart and the shopper's own order status.
   - No credit, employment, education, essential-services or other Annex III purpose was found.
   - No fine-tuning or model training was found.
   - OpenAI is the general-purpose model provider (supplied fact).
3. **Possible AI Act trigger:**
   - Article 6(2) with Annex III (high-risk use cases).
   - Chapter V general-purpose model duties, which sit with the model provider.
4. **Role and conditions:** Annex III depends on intended purpose. The supplied purpose excludes decisions about people. The AskCart team is a downstream provider of an AI system, not the provider of a general-purpose model, on this evidence.
5. **Official source level and exact link:** Law: [Regulation (EU) 2024/1689, Article 6, Annex III, Chapter V](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
6. **Applicable date:** for Annex III systems, Chapter III Sections 1–3 apply from 2 December 2027 according to the pinned register; this was only partly re-verified today. Chapter V has applied since 2 August 2025.
7. **Status:** no trigger found in the supplied evidence
8. **Missing facts:** any future change of purpose, such as eligibility, pricing per person or fraud scoring, or any fine-tuning of a model.
9. **Next action:** re-run this check if the intended purpose or the model setup changes.
10. **Human decision required:** the AskCart team must confirm that the intended purpose stays as supplied.

### EUAI-012 — Emotion and biometric disclosure (Article 50(3)) and deepfake or public-interest text (Article 50(4)): no trigger found

1. **Review surface:** the whole of `server/src` and `server/widget/src` was searched for emotion, biometric and image, audio or video generation (no matches). The text outputs reviewed are `product-questions.ts` and the chat answers.
2. **Observed evidence:**
   - No emotion recognition or biometric categorisation was found.
   - No image, audio or video is generated.
   - The generated text is shopping help, not text published to inform the public on matters of public interest.
3. **Possible AI Act trigger:** the deployer duties in Article 50(3) and (4).
4. **Role and conditions:** the merchant would be the deployer. The conditions (emotion or biometric processing, deepfake content, public-interest text) were not shown.
5. **Official source level and exact link:** Law: [Regulation (EU) 2024/1689, Article 50(3)–(4), Article 3(60)](https://data.europa.eu/eli/reg/2024/1689/oj/eng/html), with [Regulation (EU) 2026/1744](https://data.europa.eu/eli/reg/2026/1744/oj).
6. **Applicable date:** 2 August 2026.
7. **Status:** no trigger found in the supplied evidence
8. **Missing facts:** none identified from this review for the reviewed surfaces. The FAQ content and the social-media agent were not reviewed.
9. **Next action:** none for the reviewed surfaces. Re-check if image, voice or published-article features are added.
10. **Human decision required:** none now.

---

## Closing section

### 1. Human decisions now required

1. **Mobile app (EUAI-001):** how the AI notice is guaranteed in third-party mobile interfaces (documentation, a notice delivered by the API, or a contract), and whether mobile keys are issued before that is in place.
2. **Product block (EUAI-002):** whether merchants may override the block's AI heading and eyebrow without a fixed AI line remaining, including in the drawer header.
3. **Wording sign-off (EUAI-003 and EUAI-006):** approval of the notice wording, its placement and its accessibility, and of the system-prompt rules, both pending under D49, before go-live.
4. **Hosted page and embed (EUAI-004):** whether they are offered at launch, and in which language their notice is shown.
5. **Merchant settings (EUAI-005):** whether to advise on or restrict human-like names, avatars and welcome text, and whether the default teaser and launcher copy should mention AI.
6. **Machine-readable marking (EUAI-007 and EUAI-008):** with counsel, whether chat answers and AI-written questions need machine-readable marking at launch, and which method.
7. **AI literacy (EUAI-009):** what AI-literacy measures the AskCart team records for its own staff.
8. **Intended purpose (EUAI-011):** confirmation that it stays as supplied.

### 2. Evidence still needed

- Whether AskCart was made available to any EU user before 2 August 2026. This decides the Article 50(2) date.
- A rendered, screen-reader check of the Bois & Chiffons storefront chat, the product block and the drawer in all six languages, with their actual theme settings.
- Whether a Bois & Chiffons mobile app, embedding site or hosted link is live at launch, and what each shows first.
- Live model answers to identity questions ("Are you human?") in the six languages.
- Whether OpenAI marks its API text outputs.
- A human re-read of the Commission guidelines PDF (updated 5 November 2026), the questions and answers, the icons page and the Code of Practice. All are possibly superseded relative to the pinned register.

### 3. Separate legal signposts (not assessed)

Separate review may be needed under:

- EU data-protection law: chat retention, the privacy link missing on the hosted page (`route.ts:59`), order data, and transfers to OpenAI;
- EU consumer-protection and unfair-commercial-practices law: product recommendations, the teaser, and price and stock statements;
- EU and national accessibility law;
- ePrivacy rules: browser storage;
- platform terms (Shopify).

None of these regimes was assessed here.

### 4. Limitations

- This report is educational issue-spotting under the EU AI Act only. **It is not legal advice and not proof of compliance.**
- It is based on static source code at commit `619e28e`, on supplied facts, and on a partial live legal check made on 25 November 2026. That check found one German-only corrigendum to Regulation (EU) 2026/1744 that is not in the pinned register (it does not affect these findings), and Commission guidance pages updated after the register date.
- No deployed or user-visible behaviour was observed. Tests were not run.
- The statuses describe the strength of the evidence, not legal severity or a risk class.
