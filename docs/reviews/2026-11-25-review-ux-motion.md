# Lens 3: UX, accessibility and motion, compared with Tikamoon/Dialog (2026-11-25)

Scope: `git diff 3c9176e..HEAD`. Widget rebuilt with `node scripts/build-widget.mjs`; the build output matched the repo (git status clean). Nothing in the repo was edited.
Method: the Tikamoon page was live and did not block automation. I declined cookies with "Continuer sans accepter". On both sites a per-frame `requestAnimationFrame` sampler recorded the bounding rect, opacity and transform of the panel elements, along with `getAnimations()` timing and keyframes, transition and animation events, and screenshot bursts every 35–80 ms. I asked one product question ("Est-ce que les portes ferment à clé ?"). No personal data was entered.
Skills: `ui-animation` loaded and applied. `review-animations` refused to load (only the user can invoke it). I did not load `impeccable`, `ui-ux-pro-max` or `animation-performance`, to save context; their checks (targets, contrast, composite-only properties) are covered by hand below.

## Evidence (all under `C:\Users\INTEL\askcart-ui-check\`)
- Scripts: `tika-motion.mjs`, `tika-tab.mjs`, `ours-motion.mjs` (store.mjs + sampler, `RM=1` = reduced motion), `motion-lib.mjs`, `dump.cjs`
- Tikamoon desktop: `tika\desktop\` (open-*.png, close-*.png, motion.json, page@*.webm); montages `tika\m-open.png`, `tika\m-close.png`
- Tikamoon question → stream + tab run: `tika\tab\` (ask-*.png, answer.png, tab.png, motion.json, *.webm); montage `tika\m-ask.png`
- Tikamoon phone 390x844: `tika\phone\` (open-*.png, motion.json, webm); montage `tika\m-phone.png`
- Ours desktop: `shots\motion-desktop\` (l-open-*, l-close-*, d-open-*, d-close-*, s-open-*, s-close-*, cart-*, motion.json, webm); montage `tika\m-ours-drawer.png`
- Ours phone: `shots\motion-phone\`; ours with reduced motion: `shots\motion-rm\`

## 1. Tikamoon/Dialog side panel: measured spec

| Property | Tikamoon desktop (1280x860) | Tikamoon phone (390x844) |
|---|---|---|
| Trigger | pill or the block's input+Enter, and the right-edge "t." tab | pill |
| What moves | the whole panel wrapper, by `translateX`, driven by JS (a spring); no opacity change; contents do not animate in (the white card arrives blank or with skeletons, then fills) | nothing: full screen, shown in one frame (no fade or slide) |
| Start offset | +1265 px = 100% of viewport width (the card starts fully off-screen) | – |
| Curve | **critically damped spring, ω ≈ 13.3 rad/s** (stiffness ≈ 177, damping ≈ 26.6, mass 1, no overshoot). Fit within about 4% at every frame and reproduced on a second run. 50% at about 150 ms, 95% at about 350 ms, settled at about 700 ms | – |
| CSS equivalent | `640ms linear(0, .1 6.3%, .288 12.5%, .474 18.8%, .628 25%, .744 31.3%, .828 37.5%, .886 43.8%, .925 50%, .952 56.3%, .969 62.5%, .98 68.8%, .988 75%, .992 81.3%, .995 87.5%, .997 93.8%, 1)`; bezier fallback `cubic-bezier(0.3,0.48,0.08,1)` 640ms (max error 2.1%) | – |
| Backdrop | `rgba(0,0,0,.3)`, **appears instantly** (no fade), no blur | same, `rgba(0,0,0,.3)` |
| Panel box | floating card **680 px wide**, inset **16 px** on top, right and bottom (828 px tall), **radius 16 px**, `box-shadow: 0 16px 32px -16px rgba(0,0,0,.12), 0 8px 16px -8px rgba(24,24,37,.08)`, white | full screen |
| Close | **no exit animation**: panel and backdrop are gone within one sampled frame (≤ 77 ms); the "t." tab is already docked | Escape closes, also with no animation |
| Escape | **does not close** on desktop | closes |
| Scroll lock | `html` and `body` get `overflow:hidden` | same |
| Focus | goes to the panel textarea on open. **No focus trap**: Tab leaves the dialog into the site header. No `role=dialog` or `aria-modal`. After close, focus goes to `<body>` (desktop) or stays on the hidden textarea (phone) | – |
| Header | right-aligned icon row (bag, restart, a divider, ×) at **36×36 px**; centred large logo, then "Votre expert Tikamoon"; a "vous consultez" product card (skeleton while loading) | same |
| Loading | a typewriter status line with a block caret ("Préparation de la réponse" → "Compréhension de votre ques▌"), a sparkle icon that pulses (rotate 0→3°, scale .8↔1, 1.5 s ease-in-out, looping) and a shimmer text gradient (2.5 s linear) | same |
| Answer | text arrives in chunks every ~20–130 ms; each **paragraph fades in opacity 0→1 over 2000 ms `cubic-bezier(.22,.61,.36,1)`** as it is added (no translate, no word-by-word animation). Thumbs-up/down appear after | same |
| Block pill | 50 px tall, radius 24, `1px solid #dddce2`, 14 px/500 Inter `#575665`, `transition: transform .15s` | 50 px tall |
| Edge tab ("t.") | appears after the first close: `div role=button tabindex=0` with **no accessible name**, 193×64, radius `6px 0 0 6px`, `box-shadow 0 0 20px #c0c0c0`, parked at `translateX(129px)` so 64 px shows; `transition: transform .5s ease-in-out`. Clicking it reopens with the same spring (second run measured) | not present (bottom stack) |
| Phone/desktop input focus | the input itself has `outline:none`; the focus ring is a 1px + 3px grey `box-shadow` on the form, 120 ms ease | – |

## 2. Ours: measured

| Moment | What animates | Duration / easing | Notes |
|---|---|---|---|
| Launcher → floating panel (desktop) | opacity 0→1, translateY 8→0, scale .96→1, origin bottom-right | 220 ms `cubic-bezier(0.22,1,0.36,1)` (CSS `in`) | good; textarea focused; focus trap works; Escape closes |
| Floating close | WAAPI opacity→0, translateY 8, scale .97 | 160 ms `cubic-bezier(0.23,1,0.32,1)` | focus back on the launcher (good) |
| Pill → drawer (desktop) | translateX(100%)→0 | 300 ms `cubic-bezier(0.32,0.72,0,1)` (`sl`) | **no backdrop, no scroll lock, flush to the edge, radius 0, 420 px**; user message `up` 200 ms; status `fd` 150 ms |
| Drawer close | WAAPI translateX→100% | 220 ms `cubic-bezier(0.23,1,0.32,1)` | focus back on the pill (good, better than Tikamoon) |
| Phone launcher → full screen | opacity + translateY 16 | 240 ms open / 180 ms close | `html` overflow hidden (good) |
| Phone pill → drawer | `.panel.full.drawer` slides from the right | 300 ms open / 220 ms close | Tikamoon shows it in one frame |
| Status → first text | status fades in 150 ms at +54 ms; the text bubble `.txt.in` fades once in 150 ms; cards `up` 240 ms with a 0/40/80/120 ms stagger, images fade 200 ms | – | the harness's mock sends the whole stream in one response, so per-delta cadence could not be measured (the text arrived in a single frame at 2.59 s) |
| Add to cart | `ac-swap` label (translateY 4 + blur 2px + opacity, 180 ms), `ac-pop` badge (scale .9, 180 ms), header `.cbadge` WAAPI scale 1→1.25→1 (300 ms) | – | confirmation appears on the control (good) |
| Detail sheet | transform translateX(100%)→0, 300 ms `(0.32,0.72,0,1)`; out 200 ms, same curve | – | focus goes to Back, Escape closes the sheet only, focus returns to the opener (good) |
| Reduced motion | panel, drawer, messages: no animation; the sheet uses a 150 ms opacity fade; swaps use `ac-fade` | – | correct |

## 3. Side by side: drawer (product-page "side bar")

| Property | Tikamoon | Ours today | Change to match |
|---|---|---|---|
| Moving property | transform X (spring) | transform X | same |
| Distance | 100% of the wrapper (off-screen) | 100% | `translateX(calc(100% + 16px))` once inset (the shadow must clear the edge) |
| Open duration | settles in ≈ 640–700 ms (95% at 350 ms) | 300 ms | 640 ms (with the spring-shaped curve below it does not feel slow) |
| Open easing | critically damped spring ω 13.3 | `cubic-bezier(.32,.72,0,1)` | `linear(...)` above, `cubic-bezier(0.3,0.48,0.08,1)` fallback |
| Backdrop | rgba(0,0,0,.3), instant | none | add a scrim, rgba(0,0,0,.3). Recommend a 200 ms opacity fade rather than Tikamoon's hard cut (ours slides and fades together). Clicking it closes the drawer |
| Width | 680 px card | 420 px flush | `width:min(680px, calc(100vw - 32px))` (**user decision**: 680 is wide for 3-up cards; 480–560 is a middle option) |
| Inset / radius / shadow | 16 / 16 / `0 16px 32px -16px rgba(0,0,0,.12), 0 8px 16px -8px rgba(24,24,37,.08)` | 0 / 0 / floating shadow | copy exactly |
| Close | none (hard cut) | 220 ms slide | **keep ours** (the "paired states" rule: if open animates, close animates). Add a scrim fade-out of 200 ms |
| Scroll lock | yes | phone only | lock on desktop drawer too |
| Escape | no (desktop) | yes | keep ours |
| Focus return | body | opener | keep ours |
| Phone | instant full screen | 300 ms slide | keep ours, or drop to instant to match (**user decision**; ours is better feedback) |

## 4. Concrete changes (exact values; none applied)

1. **Drawer box**: `server/widget/src/panel/styles.ts:17`. Replace the `.panel.drawer{...}` rule with:
   `.panel.drawer{top:16px;bottom:16px;right:16px;left:auto;width:min(680px,calc(100vw - 32px));height:auto;max-height:none;border-radius:16px;box-shadow:0 16px 32px -16px rgba(0,0,0,.12),0 8px 16px -8px rgba(24,24,37,.08);transform-origin:right center;animation:sl .64s cubic-bezier(0.3,0.48,0.08,1)}`
   then add `@supports (animation-timing-function:linear(0,1)){.panel.drawer{animation-timing-function:linear(0,.1 6.3%,.288 12.5%,.474 18.8%,.628 25%,.744 31.3%,.828 37.5%,.886 43.8%,.925 50%,.952 56.3%,.969 62.5%,.98 68.8%,.988 75%,.992 81.3%,.995 87.5%,.997 93.8%,1)}}`
   and `.panel.full.drawer{inset:0;width:100%;height:100dvh;border-radius:0;box-shadow:none}` (the phone stays full screen).
   In `@keyframes sl` (line 23): `from{transform:translateX(calc(100% + 16px))}`.
   Note: the shared `.panel` rule (line 10) has `transition:width .24s, height .24s`. These are layout properties, and with `height:auto` the drawer has nothing to tween. Keep the transition only on `.panel.wide` toggles, or switch the expand to a transform.
2. **Scrim**: `panel.ts` (create it beside the panel, around line 86) plus CSS: `.scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.3);animation:fd .2s cubic-bezier(0.22,1,0.36,1)}.scrim[hidden]{display:none}`. Show it only when `drawer && !full`; a click on it calls `close()`. In `hidePanel()` (`panel.ts:625-629`), run `scrim.animate([{opacity:1},{opacity:0}],{duration:200,easing:"cubic-bezier(0.23,1,0.32,1)",fill:"forwards"})` next to the panel exit, and hide the scrim in `done()`. Add `.scrim` to the reduced-motion block (`styles.ts:96`).
3. **Drawer exit** (`panel.ts:627`): `transform:"translateX(calc(100% + 16px))"`, duration 240 for the drawer (keep the curve). Add the scrim as in item 2.
4. **Scroll lock** (`panel.ts:292`): `lockScroll((full || drawer) && !panel.hidden)`. Compensate for the scrollbar so the page does not shift 15 px on Windows: on lock, set `document.documentElement.style.paddingRight = (innerWidth - document.documentElement.clientWidth) + "px"` and restore it on unlock.
5. **Answer reveal like Tikamoon (optional)**: Tikamoon fades each paragraph in over 2 s. Ours fades the bubble once (150 ms). `renderRich` (`panel/rich.ts:22-23`) rebuilds every node on each delta, so a per-paragraph CSS animation would restart on every delta. To match, `renderRich` must keep the finished blocks and rebuild only the last one, then add `.nw{animation:fd .6s cubic-bezier(.22,.61,.36,1) both}` to newly created blocks. 600 ms is enough; 2 s reads sluggish with long answers. Medium effort, low priority.
6. **Loading status**: already close to Tikamoon (sparkle + shimmer). Tikamoon also types the status text out with a caret. Not worth copying.
7. **Edge tab**: if the user wants the "t." tab behaviour (it docks after the first close), our `launcher.style="tab"` already exists (`launcher/launcher.ts:25-33`). Tikamoon's tab is a `div role=button` with no name. Ours is a real `<button>` with `aria-label`, so it is better as is. (**User decision**: show the tab automatically after the first drawer close.)

## 5. Other UX/a11y bugs in today's changes

| # | Severity | Finding | Where | Fix |
|---|---|---|---|---|
| A | **High** | Desktop drawer says `aria-modal="true"` but has no backdrop, no `inert` on the page and no scroll lock. Clicking the page leaves the drawer open, and **focus moves to `<body>` outside the "modal"** (measured, `outsideClickState.active = BODY`). Screen readers hide the page while sighted users keep using it | `panel.ts:87-88`, `:292` | the scrim (item 2) makes outside clicks close the drawer. Or, if no scrim is wanted, drop `aria-modal` for the drawer and floating panel and drop the Tab trap |
| B | **High** | **Focus is lost in the cards carousel**: Tab from the last tile focuses "Next product". The smooth scroll then ends, `sync()` sets `next.hidden=true` (display:none) while it has focus, and focus falls to `<body>`, outside the dialog trap (measured desktop sequence `…Nova → OUT:BODY → Helpful`; with reduced motion, `scroll:auto`, it does not happen) | `cards.ts:567-570` | in `sync`, before hiding: `if ((track.getRootNode() as ShadowRoot).activeElement === next && hideNext) track.querySelector<HTMLElement>("li:last-child button")?.focus()` (same for prev). Or keep the arrows rendered with `aria-disabled` instead of `hidden` |
| C | Medium | The floating panel is also `aria-modal` with a focus trap while the page stays usable (the same contradiction, but expected for a chat bubble) | `panel.ts:88` | set `aria-modal` only in drawer and full-screen modes |
| D | Medium | Auto-inserted section: `.askcart-ai-section{padding:0 1.5rem;max-width:var(--page-width,1200px)}` sits on an element that also has Dawn's `page-width`. The stylesheet arrives later (inside the `<template>`, in body order) with equal specificity, so it **overrides Dawn's `@media (min-width:750px){.page-width{padding:0 5rem}}`**: on desktop the block sits 15 px in while the product section sits 50 px in (from code; not run on a real Dawn) | `askcart-ask-ai.css:32` | scope the fallback with `.askcart-ai-section:not(.page-width)` or `:where(.askcart-ai-section)` (zero specificity), so a theme's `.page-width` wins |
| E | Medium | The block's input boundary and pill borders are `rgba(fg,.35)` ≈ `#acacac` on white = **2.2:1**, below the 3:1 WCAG 1.4.11 minimum for the only visual boundary of the input. The panel already uses `#8a8a8a` for this reason. The input has `outline:0`; focus shows only as a 1px border colour change | `askcart-ask-ai.css:7,19-21` | use `--askcart-line: rgba(var(--askcart-fg-rgb,127,127,127),.55)` (≈ #7d7d7d, ≈4:1 on white for #121212). Add `.askcart-ai__form:focus-within{box-shadow:0 0 0 2px rgba(var(--askcart-fg-rgb,18,18,18),.6)}` (a 2px ring, like Tikamoon's 1+3px) |
| F | Low | Below 44 px: the feedback thumbs are 32×32 (`styles.ts:78`) and the carousel arrows 36×36 (`cards.ts:620`). WCAG 2.2 AA 2.5.8 (24 px) passes; the platform/44 px guidance fails. Tikamoon uses 36 px too | – | add the `::before{inset:-6px}` hit-area trick already used on `.send` |
| G | Low | Reopening during the exit animation: `cancelExit()` jumps the panel to fully visible with no entrance (a hard cut) because `panel.hidden` is false, so the CSS entrance does not replay | `panel.ts:557-572, 606-610` | instead of cancel, `exit.reverse()` (WAAPI retargets smoothly) |
| H | Low | Floating → drawer while the panel is open (a pill tapped with the bubble open): the class swap restarts `sl` from 100% and the width/height transition tweens at the same time (from code, not measured) | `panel.ts:566`, `styles.ts:10` | acceptable once the transition is scoped to `.wide` (item 1) |
| I | Low | RTL: the drawer, the sheet (`translateX(100%)`), `.panel` `text-align:left`, `.askcart-ai__pill text-align:left` and `.askcart-ai__form padding:0 4px 0 1.1em` are all physical. On Arabic or Hebrew stores the pill text and input padding sit on the wrong side | `askcart-ask-ai.css:15,19`, `styles.ts` | `text-align:start`, `padding-inline:1.1em 4px`; in the panel, mirror the drawer with `:host(:dir(rtl))` |
| J | Info | Long text: the block pills wrap (`overflow-wrap:anywhere`), the heading wraps, and the viewing title has an ellipsis. Fine | – | – |
| K | Info | The block pills play `askcart-in` (200 ms) when they replace the skeleton on load. This is motion without a user trigger, but it is small and gated for reduced motion. Acceptable | `askcart-ask-ai.css:15` | – |

Where we are already better than the reference (keep these): Escape closes on desktop; focus returns to the pill or launcher; the dialog has a role and label; Tab is trapped; the exit animates; reduced motion is fully honoured.
