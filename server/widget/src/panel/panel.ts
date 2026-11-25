// The chat panel (Task 30: UD3, UD4, UD13, UD16, UD17, UD18, D81, D83, D84). Vanilla DOM in the host's shadow root.
// Text only: merchant, model and server strings go through textContent; URLs and colours are checked first (§7.7).
//
// Failure modes handled here (turn retries themselves live in core/turn.ts):
//   - history fails (network, 5xx): the token is kept and the chat starts empty; the next message continues it,
//   - history 401/404: the token is dropped (UD13),
//   - unavailable / busy / offline after runSend's own retries: an error line with Retry, reusing the requestId (D81),
//   - Delete chat while an answer streams: the turn is aborted and settled first, then DELETE uses the token from its
//     `meta` event (D84). 409 (the server hasn't released the turn yet) or a network error is retried after 0.5, 1 and
//     2 s; after that the token is kept and the shopper is told.
// Two tabs: each shows only what it sent until the next open reloads history. `// ponytail:` a `storage` listener
// could sync tabs live; not needed for the beta.
import type { PageContext, WidgetApi, WidgetConfig, WidgetCtx } from "../../../src/lib/widget-contract";
import { MAX_INPUT_CHARS as MAX } from "../../../src/lib/chat/limits"; // the server's message limit
import { translator } from "../core/i18n";
import { brandLogo, formatPrice, resolveHttpsUrl, safeHex, safeImageUrl, textOn } from "../core/format";
import { tokenStore, uiState } from "../core/storage";
import { runSend } from "../core/turn";
import { liveRegion, trapTab } from "./a11y";
import { icon } from "./icons";
import { createMenu } from "./menu";
import { createMessages, type Renderers } from "./messages";
import { CSS, FULL_BELOW } from "./styles";
import { CARDS_CSS } from "../cards";
import { CART_CHANGED, cartState, cartSummaryNow, refreshCart } from "../cart";

export type PanelOptions = Renderers & {
  api: WidgetApi;
  /** Gets focus back when the panel closes (UD17). */
  launcher?: HTMLElement | null;
  /** The hosted page: always open, fills the window, nothing to close (the embed's iframe has its own close button). */
  inline?: boolean;
  /** Test seam for runSend's retry waits. */
  wait?: (ms: number) => Promise<void>;
};

export type OpenArgs = {
  productId?: string | null;
  focus?: boolean;
  /** Sent as if typed, once the chat has loaded (the "Ask our AI agent" block). */
  message?: string;
  /** "drawer": a full-height panel on the right (the block's chat). Anything else is the floating panel. */
  mode?: "floating" | "drawer";
  /** Accepted for the block's open contract; the header is the same everywhere now, so it is not shown. */
  title?: { eyebrow: string; heading: string };
};

export type Panel = {
  open(args?: OpenArgs): Promise<void>;
  close(): void;
  destroy(): void;
};

const COUNT_FROM = 1800;
const CLOSED = "askcart:closed"; // fired on window when the shopper closes the panel; launcher.ts listens (its own copy of the name)
const DEFAULT_ACCENT = "#0A0A0A";
const DELETE_RETRY_MS = [500, 1000, 2000]; // D84: the server may hold the aborted turn's lock for a moment
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function button(cls: string, label: string, ic: Parameters<typeof icon>[0], size = 22): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute("aria-label", label);
  b.append(icon(ic, size));
  return b;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createPanel(shadow: ShadowRoot, config: WidgetConfig, page: PageContext, opts: PanelOptions): Panel {
  const { api } = opts;
  const t = translator(page.locale);
  const tokens = tokenStore(page.shop);
  const ui = uiState(page.shop);
  const live = liveRegion();
  const ctx: WidgetCtx = { config, page, api, t, announce: live.say };
  const messages = createMessages(ctx, opts);

  // --- skeleton ---
  const style = document.createElement("style");
  style.textContent = CSS + CARDS_CSS;
  const panel = document.createElement("div");
  panel.className = "panel";
  if (config.launcher?.side === "left") panel.classList.add("left");
  if (opts.inline) panel.classList.add("inline");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", config.name);
  const accent = safeHex(config.accent) ?? DEFAULT_ACCENT;
  panel.style.setProperty("--ac", accent);
  panel.style.setProperty("--ac-fg", textOn(accent));
  panel.style.setProperty("--ac-accent", accent); // the names cards.ts (Task 31) reads
  panel.style.setProperty("--ac-on-accent", textOn(accent));
  panel.style.setProperty("--off", Math.min(200, Math.max(0, Number(config.launcher?.offset) || 0)) + "px");

  // header: a bar (back on a phone · cart · new chat · menu · divider · close) over the centred logo and "Your {store} expert".
  // The AI notice sits above the input and is never hidden (docs/eu-ai-act-review.md).
  const hd = document.createElement("div");
  hd.className = "hd";
  const bar = document.createElement("div");
  bar.className = "bar";
  const back = button("ib back", t("back"), "back");
  const actions = document.createElement("div");
  actions.className = "actions";
  const cartHref = resolveHttpsUrl(page.cartUrl);
  const cartLink = document.createElement("a");
  cartLink.className = "ib cart";
  cartLink.setAttribute("aria-label", t("cart"));
  cartLink.append(icon("cart", 22));
  if (cartHref) {
    cartLink.href = cartHref;
    cartLink.rel = "noopener noreferrer";
    if (page.hosted) cartLink.target = "_top"; // leave the iframe: the cart is the store's page
  } else cartLink.hidden = true;
  // The cart's item count, from the same cached cart read the cards use. Not on the hosted page: it has no cart access.
  const cartCount = document.createElement("span");
  cartCount.className = "cbadge";
  cartCount.hidden = true;
  cartCount.setAttribute("aria-hidden", "true"); // the link's accessible name carries the count
  cartLink.append(cartCount);
  let shownCount = -1; // the first read only sets it; a later rise bumps the badge (never under reduced motion)
  const showCartCount = () => {
    void cartState(page).then(({ itemCount: n }) => {
      const wasHidden = cartCount.hidden;
      if (n > shownCount && shownCount >= 0 && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        cartCount.animate?.(
          wasHidden ? [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }] : [{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }],
          { duration: wasHidden ? 200 : 300, easing: "cubic-bezier(0.22,1,0.36,1)" },
        );
      }
      shownCount = n;
      cartCount.hidden = n <= 0;
      cartCount.textContent = n > 9 ? "9+" : String(n);
      cartLink.setAttribute("aria-label", n > 0 ? t(n === 1 ? "cart_item" : "cart_items", { count: n }) : t("cart"));
    });
  };
  if (!page.hosted) window.addEventListener(CART_CHANGED, showCartCount);
  const newBtn = button("ib newchat", t("new_chat"), "newchat");
  // Logo: the merchant's avatar, else the store's Shopify brand logo (shown whole), else a round monogram (the store
  // name's first letter in the accent colour).
  const av = document.createElement("span");
  av.className = "av";
  const avatar = brandLogo(config.avatarUrl, page.logo);
  if (avatar) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.src = avatar;
    av.append(img);
  } else {
    const ini = document.createElement("span");
    ini.className = "avatar initial";
    ini.setAttribute("aria-hidden", "true");
    ini.textContent = (Array.from(config.name.trim())[0] ?? "?").toUpperCase();
    av.append(ini);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = t("expert", { store: config.name });
  // Expand / Collapse lives in the menu (desktop floating panel only); the full-screen sheet and the drawer have their own size.
  const canWiden = () => !panel.classList.contains("full") && !drawer;
  const menu = createMenu(t, [
    {
      label: () => t(panel.classList.contains("wide") ? "collapse" : "expand"),
      hidden: () => !canWiden(),
      run: () => {
        ui.wide.set(!ui.wide.get());
        layout();
      },
    },
    { label: () => t("delete_chat"), run: () => void deleteChat() },
  ]);
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.setAttribute("aria-hidden", "true");
  const closeBtn = button("ib close", t("close"), "close");
  actions.append(cartLink, newBtn, menu.el, sep, closeBtn);
  bar.append(back, actions);
  hd.append(bar, av, name);

  // "You're viewing" (product pages): checked here, hidden when absent or invalid.
  const vw = page.viewing;
  const vwTitle = typeof vw?.title === "string" ? vw.title.trim().slice(0, 200) : "";
  const viewing = document.createElement("div");
  viewing.className = "viewing";
  viewing.hidden = !vwTitle;
  if (vw && vwTitle) {
    const vwImg = safeImageUrl(vw.image);
    if (vwImg) {
      const i = document.createElement("img");
      i.alt = "";
      i.src = vwImg;
      viewing.append(i);
    }
    const txt = document.createElement("div");
    txt.className = "vw-txt";
    const ttl = document.createElement("span");
    ttl.className = "vw-title";
    ttl.textContent = vwTitle;
    // "<price> · You're viewing" under the title.
    // Liquid sends minor units (cents) and the page's currency, so a store's money format (HTML, entities) never reaches us.
    const price = typeof vw.price === "number" && page.currency ? (formatPrice(vw.price / 100, page.currency, page.locale) ?? "") : "";
    const label = document.createElement("span");
    label.className = "vw-label";
    label.textContent = price ? `${price} · ${t("viewing")}` : t("viewing");
    txt.append(ttl, label);
    viewing.append(txt);
  }

  const offline = document.createElement("div");
  offline.className = "offline";
  offline.setAttribute("role", "status");
  offline.textContent = t("error_offline");

  // footer: input, Send, counter, notice (UD16, D83)
  const ft = document.createElement("div");
  ft.className = "ft";
  const row = document.createElement("div");
  row.className = "row";
  const input = document.createElement("textarea");
  input.rows = 1;
  input.maxLength = MAX;
  input.placeholder = t("input_placeholder");
  input.setAttribute("aria-label", t("input_label"));
  const send = button("send", t("send"), "send", 18);
  row.append(input, send);
  const count = document.createElement("div");
  count.className = "count";
  count.hidden = true;
  const notice = document.createElement("p");
  notice.className = "notice";
  notice.id = "askcart-notice";
  panel.setAttribute("aria-describedby", notice.id); // read out when the dialog opens
  notice.textContent = `${t("ai_notice")} ${t("retention", { days: config.retentionDays })}`;
  const privacy = resolveHttpsUrl(page.privacyUrl); // Liquid gives shop.privacy_policy.url as a path
  if (privacy) {
    const a = document.createElement("a");
    a.href = privacy;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = t("privacy");
    notice.append(" ", a);
  }
  ft.append(notice, row, count); // the AI notice sits right above the input, always visible

  panel.append(hd, viewing, offline, messages.log, ft, live.el);
  // The dimmed backdrop behind the desktop drawer: a click on it closes the drawer (the pointer's way of leaving a modal).
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.hidden = true;
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", () => close());
  shadow.append(style, scrim, panel);

  // --- state ---
  let busy = false;
  let isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  let loaded = false;
  let productId: string | null = page.productId;
  let faqFor: string | null = null;
  let faqQs: string[] = [];
  let turn: AbortController | null = null;
  let turnDone: Promise<void> | null = null; // settles when the running turn's runTurn has finished
  let sugg: HTMLElement | null = null;
  let locked = false;
  let prevOverflow = "";
  let prevPad = "";
  let drawer = false;
  let loadP: Promise<void> | null = null; // the first open's load, while it runs
  let queued: string | null = null; // a message waiting for loadP; a second open() replaces it instead of sending twice
  let nextMessage: string | null = null; // a message from a pill or the block that came in while an answer streamed (latest wins)
  let opener: HTMLElement | null = null; // what had focus on the page when the panel opened, to give it back on close

  function update() {
    offline.hidden = !isOffline;
    input.placeholder = t(hasMessages() ? "continue_placeholder" : "input_placeholder");
    send.disabled = busy || isOffline || !input.value.trim();
    const n = input.value.length;
    count.hidden = n <= COUNT_FROM;
    count.textContent = `${n}/${MAX}`;
  }

  function lockScroll(on: boolean) {
    const root = document.documentElement.style;
    if (on && !locked) {
      prevOverflow = root.overflow;
      prevPad = root.paddingRight;
      // Hiding the scrollbar widens the page by its width; pad the same amount so the page doesn't shift sideways.
      const bar = window.innerWidth - document.documentElement.clientWidth;
      root.overflow = "hidden";
      if (bar > 0) root.paddingRight = bar + "px";
    } else if (!on && locked) {
      root.overflow = prevOverflow;
      root.paddingRight = prevPad;
    }
    locked = on;
  }

  function layout() {
    const full = opts.inline || window.innerWidth < FULL_BELOW;
    panel.classList.toggle("full", full);
    back.hidden = !full || !!opts.inline;
    closeBtn.hidden = full;
    sep.hidden = full;
    panel.classList.toggle("wide", !full && !drawer && ui.wide.get());
    // Modal only where the page really is blocked: the full-screen sheet and the drawer (scrim). The floating bubble leaves the page usable.
    if (full || drawer) panel.setAttribute("aria-modal", "true");
    else panel.removeAttribute("aria-modal");
    scrim.hidden = !drawer || full || panel.hidden;
    // The launcher (the edge tab sits at the very edge) would show in the drawer's 16px gutter: out of sight while the card is open.
    if (opts.launcher) opts.launcher.style.visibility = drawer && !full && !panel.hidden ? "hidden" : "";
    lockScroll((full || drawer) && !panel.hidden);
  }

  // --- intro: welcome, then suggested questions (merchant's + up to 3 FAQ questions for the product, D7, C25) ---
  async function loadFaq(): Promise<string[]> {
    if (!productId) return [];
    if (faqFor !== productId) {
      faqFor = productId;
      faqQs = (await api.faq(productId)).slice(0, 3).map((f) => f.question);
    }
    return faqQs;
  }

  function showSuggestions(qs: string[]) {
    sugg?.remove();
    sugg = null;
    if (!qs.length) return;
    sugg = document.createElement("div");
    sugg.className = "sugg";
    sugg.setAttribute("role", "group");
    sugg.setAttribute("aria-label", t("suggested"));
    for (const q of qs) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.addEventListener("click", () => sendOrQueue(q));
      sugg.append(b);
    }
    messages.add(sugg);
  }

  const hasMessages = () => messages.log.querySelector(".msg") !== null;
  const merchantSuggested = () => (Array.isArray(config.suggested) ? config.suggested.filter((s) => typeof s === "string" && s).slice(0, 4) : []);

  function showWelcome() {
    if (!config.welcome) return;
    const w = document.createElement("p");
    w.className = "welcome";
    w.textContent = config.welcome;
    messages.add(w);
  }

  async function load() {
    showWelcome();
    let token = tokens.get();
    if (!token) {
      // A signed-in shopper with no local chat continues their latest one (a chat started in the app shows up here).
      token = await api.latest();
      if (token) tokens.set(token);
    }
    if (token) {
      let h = await api.history(token);
      if (h === "reset") {
        tokens.clear();
        // A newly signed-in customer whose old local chat isn't theirs: continue their own latest one instead.
        const own = await api.latest();
        if (own) {
          tokens.set(own);
          h = await api.history(own);
        }
      }
      if (h && h !== "reset") messages.history(h);
      // null: a transient failure. Keep the token; the next message continues the conversation.
    }
    const faq = await loadFaq();
    if (!hasMessages()) showSuggestions([...merchantSuggested(), ...faq]);
    else if (faq.length) showSuggestions(faq);
    update(); // the placeholder follows whether history was loaded
  }

  function resetChat() {
    turn?.abort();
    messages.log.replaceChildren();
    sugg = null;
    nextMessage = null;
    showWelcome();
    showSuggestions([...merchantSuggested(), ...faqQs]);
    update();
  }

  // --- sending (D81) ---
  async function runTurn(message: string, requestId: string) {
    busy = true;
    update();
    const answer = messages.answer();
    const ac = new AbortController();
    turn = ac;
    const cart = !page.hosted && cartHref ? await cartSummaryNow(page) : null; // the hosted page has no cart access
    const outcome = await runSend(
      api,
      { message, token: tokens.get(), requestId, productId, country: page.country, currency: page.currency, pageUrl: location.href, cart, signal: ac.signal },
      (e) => {
        if (e.kind === "meta") tokens.set(e.token);
        else if (e.kind === "status") answer.status(e.step);
        else if (e.kind === "text") answer.append(e.delta);
        else if (e.kind === "card") answer.card(e.card);
        else if (e.kind === "replace") answer.reset();
        else tokens.clear(); // reset: the token died, runSend resends without it
      },
      opts.wait,
    );
    if (turn === ac) turn = null;
    busy = false;
    const retry = () => {
      if (!busy) startTurn(message, requestId);
    };
    switch (outcome.kind) {
      case "done": {
        tokens.set(outcome.token);
        const text = answer.finish(outcome.messageId);
        live.say(text || t("new_answer"));
        break;
      }
      case "unavailable":
        if (outcome.token) tokens.set(outcome.token);
        answer.remove();
        messages.error(t("error_unavailable"), retry);
        break;
      case "capped":
        if (outcome.token) tokens.set(outcome.token);
        answer.remove();
        messages.error(t("error_capped")); // no Retry: it would fail the same way until tomorrow
        break;
      case "busy":
        answer.remove();
        messages.error(t("error_busy"), retry);
        break;
      case "offline":
        answer.remove();
        messages.error(t("error_offline"), retry);
        break;
      case "too_long":
        answer.remove();
        messages.error(t("error_too_long"));
        break;
      default: // aborted (New chat / Delete chat while a turn ran)
        answer.remove();
    }
    update();
    if (outcome.kind === "done") flushNext();
    else if (outcome.kind === "aborted") nextMessage = null;
    else holdNext(); // the turn failed: leave the waiting question in the input for the shopper to send
  }

  /** A message from outside the input box (a pill, the block). It is never dropped: sent when the running answer is
   * done, or put in the input box when offline. One slot: a newer message replaces an older waiting one. */
  function sendOrQueue(text: string) {
    const message = text.trim();
    if (!message) return;
    if (isOffline) {
      input.value = message;
      update();
      input.focus();
    } else if (busy) nextMessage = message;
    else submit(message);
  }

  function flushNext() {
    const m = nextMessage;
    nextMessage = null;
    if (m) sendOrQueue(m);
  }

  function holdNext() {
    if (nextMessage && !input.value) {
      input.value = nextMessage;
      update();
    }
    nextMessage = null;
  }

  function submit(text: string) {
    const message = text.trim();
    if (busy || isOffline || !message) return;
    sugg?.remove();
    sugg = null;
    messages.clearErrors();
    messages.user(message);
    if (text === input.value) input.value = "";
    startTurn(message, crypto.randomUUID());
  }

  /** runTurn, with `turnDone` tracking it so Delete chat can wait for an aborted turn to settle. */
  function startTurn(message: string, requestId: string) {
    const p = runTurn(message, requestId);
    const done: Promise<void> = p.finally(() => {
      if (turnDone === done) turnDone = null;
    });
    turnDone = done;
  }

  // --- menu actions (C22) ---
  function newChat() {
    tokens.clear(); // local only: the merchant still sees the old chat in reports
    resetChat();
    input.focus();
  }

  async function deleteChat() {
    if (!window.confirm(t("delete_confirm"))) return;
    // D84: a running turn is stopped first, so its token (from `meta`) is known and the server can release the turn.
    // If it is aborted before `meta` arrived there is no token yet, and the chat is only cleared here.
    turn?.abort();
    await turnDone;
    const token = tokens.get();
    if (token) {
      busy = true; // no new message into a conversation that is being deleted
      update();
      let ok = await api.deleteConversation(token);
      // `// ponytail:` WidgetApi.deleteConversation only says ok or not, so a network error is retried like a 409.
      for (const ms of DELETE_RETRY_MS) {
        if (ok) break;
        await (opts.wait ?? sleep)(ms);
        ok = await api.deleteConversation(token);
      }
      busy = false;
      update();
      if (!ok) {
        messages.error(t("delete_failed"));
        flushNext();
        return;
      }
    }
    tokens.clear();
    resetChat();
    live.say(t("chat_deleted"));
    input.focus();
  }

  // --- events ---
  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(input.value);
    }
  });
  send.addEventListener("click", () => submit(input.value));
  newBtn.addEventListener("click", newChat);
  closeBtn.addEventListener("click", () => close());
  back.addEventListener("click", () => close());
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (menu.isOpen()) menu.hide(true);
      else close();
    } else trapTab(e, panel, shadow.activeElement);
  });
  const onNet = () => {
    isOffline = navigator.onLine === false;
    update();
  };
  const onOffline = () => {
    isOffline = true;
    update();
  };
  window.addEventListener("online", onNet);
  window.addEventListener("offline", onOffline);
  window.addEventListener("resize", layout);
  update();

  function setExpanded(on: boolean) {
    opts.launcher?.setAttribute("aria-expanded", String(on));
  }

  async function open(args: OpenArgs = {}) {
    const fromProduct = args.productId != null && args.productId !== productId;
    if (panel.hidden || exit) {
      const a = document.activeElement;
      opener = a instanceof HTMLElement && a !== document.body && a !== shadow.host ? a : null; // the host means our own button
    }
    if (args.productId != null) productId = args.productId;
    drawer = args.mode === "drawer";
    ui.drawer.set(drawer); // a reload on the next page reopens it the same way
    panel.classList.toggle("drawer", drawer);
    viewing.hidden = !vwTitle || productId !== page.productId; // the card is about the page's product
    reviveExit();
    // Restored on a page load (focus:false): no entrance animation without a shopper action. Class changes only while hidden,
    // so removing it later can't replay the animation.
    if (panel.hidden) {
      panel.classList.toggle("still", args.focus === false);
      scrim.classList.toggle("still", args.focus === false);
    }
    panel.hidden = false;
    layout();
    ui.open.set(true);
    ui.teaserSeen.set(true);
    setExpanded(true);
    if (!page.hosted && cartHref) refreshCart(page); // the shopper may have changed the cart on the page; redraws the badges
    if (args.focus !== false) input.focus();
    const first = !loaded;
    if (first) {
      loaded = true;
      loadP = load().finally(() => {
        loadP = null;
      });
    }
    if (args.message) {
      if (!loadP) return sendOrQueue(args.message);
      const waiting = queued !== null;
      queued = args.message; // the latest request wins; only the first caller sends it
      if (waiting) return;
      await loadP;
      const m = queued;
      queued = null;
      if (m) sendOrQueue(m);
    } else if (first) {
      await loadP;
    } else if (fromProduct) {
      // C25: the Ask block opened an existing chat for another product: offer its FAQ questions, send nothing.
      const faq = await loadFaq();
      if (!busy) showSuggestions(hasMessages() ? faq : [...merchantSuggested(), ...faq]);
    }
  }

  let exit: Animation | null = null; // the closing animation, while it runs
  let scrimExit: Animation | null = null; // the backdrop's fade-out, while it runs
  function cancelExit() {
    exit?.cancel();
    scrimExit?.cancel();
    exit = scrimExit = null;
    panel.inert = false;
  }
  /** Reopened while it was still leaving: play the exit backwards from where it is, so the panel comes back smoothly
   * instead of jumping to fully open. Once it is back at the start the held end frame is dropped. */
  function reviveExit() {
    panel.inert = false;
    for (const a of [exit, scrimExit]) {
      if (!a) continue;
      a.onfinish = () => {
        a.cancel();
        if (exit === a) exit = null;
        if (scrimExit === a) scrimExit = null;
      };
      a.reverse();
    }
  }

  /** Hides the panel after a short exit animation (WAAPI: CSS can't animate to display:none, and a media query can't
   * stop it, so reduced motion is checked here). Focus and state are already handled by close(). */
  function hidePanel() {
    const done = () => {
      panel.hidden = true;
      scrim.hidden = true;
      if (opts.launcher) opts.launcher.style.visibility = "";
      panel.classList.remove("still");
      scrim.classList.remove("still");
      lockScroll(false); // a resize while it was leaving may have locked the page again
      cancelExit(); // drop the held end frames, or they would keep the panel invisible when it reopens
    };
    if (reducedMotion() || typeof panel.animate !== "function") return done();
    const dr = panel.classList.contains("drawer");
    const full = panel.classList.contains("full") && !dr;
    const floating = dr && !panel.classList.contains("full"); // the desktop drawer is a card inset 16px from the edge: it must clear the shadow too
    const rtl = getComputedStyle(panel).direction === "rtl"; // the drawer sits on the left in right-to-left pages
    panel.inert = true; // nothing to click while it leaves
    const a = (exit = panel.animate(
      dr
        ? [{ transform: "none" }, { transform: `translateX(calc(${rtl ? "-1 * " : ""}(100%${floating ? " + 16px" : ""})))` }]
        : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: full ? "translateY(16px)" : "translateY(8px) scale(.97)" }],
      { duration: floating ? 240 : dr ? 220 : full ? 180 : 160, easing: "cubic-bezier(0.23,1,0.32,1)", fill: "forwards" },
    ));
    if (!scrim.hidden) scrimExit = scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "cubic-bezier(0.23,1,0.32,1)", fill: "forwards" });
    a.onfinish = () => {
      if (exit === a) done();
    };
  }

  function close() {
    if (panel.hidden || exit || opts.inline) return;
    menu.hide();
    hidePanel();
    if (!exit) lockScroll(false); // while it slides out the page stays locked: unlocking would bring the scrollbar back and shift the page under it (done() unlocks)
    ui.open.set(false);
    setExpanded(false);
    if (opts.launcher) opts.launcher.style.visibility = ""; // visible again (and focusable) before focus goes back to it
    window.dispatchEvent(new Event(CLOSED)); // the launcher docks as the edge tab (launcher.ts)
    // Back to where the shopper was; the launcher when that is gone (it has no button on pages the scope hides it from).
    const restore = opener?.isConnected ? opener : opts.launcher?.isConnected ? opts.launcher : null;
    opener = null;
    restore?.focus();
  }

  function destroy() {
    turn?.abort();
    cancelExit();
    lockScroll(false);
    if (opts.launcher) opts.launcher.style.visibility = "";
    window.removeEventListener("online", onNet);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("resize", layout);
    window.removeEventListener(CART_CHANGED, showCartCount);
    style.remove();
    panel.remove();
  }

  return { open, close, destroy };
}
