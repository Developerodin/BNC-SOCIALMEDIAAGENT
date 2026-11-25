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
import { translator } from "../core/i18n";
import { resolveHttpsUrl, safeHex, safeImageUrl, textOn } from "../core/format";
import { tokenStore, uiState } from "../core/storage";
import { runSend } from "../core/turn";
import { liveRegion, trapTab } from "./a11y";
import { icon } from "./icons";
import { createMenu } from "./menu";
import { createMessages, type Renderers } from "./messages";
import { CSS, FULL_BELOW } from "./styles";
import { CARDS_CSS } from "../cards";

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
  /** Drawer header: replaces the assistant's name and subtitle. */
  title?: { eyebrow: string; heading: string };
};

export type Panel = {
  open(args?: OpenArgs): Promise<void>;
  close(): void;
  destroy(): void;
};

const MAX = 2000; // the server's message limit
const COUNT_FROM = 1800;
const DEFAULT_ACCENT = "#0A0A0A";
const DELETE_RETRY_MS = [500, 1000, 2000]; // D84: the server may hold the aborted turn's lock for a moment
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function button(cls: string, label: string, ic: Parameters<typeof icon>[0]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute("aria-label", label);
  b.append(icon(ic));
  return b;
}

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
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", config.name);
  const accent = safeHex(config.accent) ?? DEFAULT_ACCENT;
  panel.style.setProperty("--ac", accent);
  panel.style.setProperty("--ac-fg", textOn(accent));
  panel.style.setProperty("--ac-accent", accent); // the names cards.ts (Task 31) reads
  panel.style.setProperty("--ac-on-accent", textOn(accent));
  panel.style.setProperty("--off", Math.min(200, Math.max(0, Number(config.launcher?.offset) || 0)) + "px");

  // header: back (mobile) · avatar · name · menu · close (desktop)
  const hd = document.createElement("div");
  hd.className = "hd";
  const back = button("ib back", t("back"), "back");
  hd.append(back);
  // Avatar (or the store name's initial when there is none) with a small online dot; name and subtitle beside it.
  const av = document.createElement("span");
  av.className = "av";
  const avatar = safeImageUrl(config.avatarUrl);
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
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  av.append(dot);
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = config.name;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = t("subtitle");
  who.append(name, sub);
  const menu = createMenu(t, [
    { label: t("new_chat"), run: newChat },
    { label: t("delete_chat"), run: () => void deleteChat() },
  ]);
  const closeBtn = button("ib close", t("close"), "close");
  const wideBtn = button("ib wide-btn", t("expand"), "expand");
  wideBtn.setAttribute("aria-pressed", "false");
  hd.append(av, who, menu.el, wideBtn, closeBtn);

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
  const send = button("send", t("send"), "send");
  row.append(input, send);
  const count = document.createElement("div");
  count.className = "count";
  count.hidden = true;
  const notice = document.createElement("p");
  notice.className = "notice";
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
  ft.append(row, count, notice);

  panel.append(hd, offline, messages.log, ft, live.el);
  shadow.append(style, panel);

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
  let drawer = false;
  let loadP: Promise<void> | null = null; // the first open's load, while it runs
  let queued: string | null = null; // a message waiting for loadP; a second open() replaces it instead of sending twice

  function update() {
    offline.hidden = !isOffline;
    send.disabled = busy || isOffline || !input.value.trim();
    const n = input.value.length;
    count.hidden = n <= COUNT_FROM;
    count.textContent = `${n}/${MAX}`;
  }

  function lockScroll(on: boolean) {
    const root = document.documentElement.style;
    if (on && !locked) {
      prevOverflow = root.overflow;
      root.overflow = "hidden";
    } else if (!on && locked) root.overflow = prevOverflow;
    locked = on;
  }

  function layout() {
    const full = opts.inline || window.innerWidth < FULL_BELOW;
    panel.classList.toggle("full", full);
    back.hidden = !full || !!opts.inline;
    closeBtn.hidden = full;
    wideBtn.hidden = full || drawer; // a full-screen sheet is already as large as it gets; a drawer has its own width
    const wide = !full && !drawer && ui.wide.get();
    panel.classList.toggle("wide", wide);
    wideBtn.setAttribute("aria-pressed", String(wide));
    wideBtn.setAttribute("aria-label", t(wide ? "collapse" : "expand"));
    wideBtn.replaceChildren(icon(wide ? "collapse" : "expand"));
    lockScroll(full && !panel.hidden);
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
      b.addEventListener("click", () => submit(q));
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
  }

  function resetChat() {
    turn?.abort();
    messages.log.replaceChildren();
    sugg = null;
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
    const outcome = await runSend(
      api,
      { message, token: tokens.get(), requestId, productId, country: page.country, pageUrl: location.href, signal: ac.signal },
      (e) => {
        if (e.kind === "meta") tokens.set(e.token);
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
  closeBtn.addEventListener("click", () => close());
  back.addEventListener("click", () => close());
  wideBtn.addEventListener("click", () => {
    ui.wide.set(!ui.wide.get());
    layout();
  });
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

  function setHeader(title: OpenArgs["title"]) {
    name.textContent = title ? title.heading : config.name;
    sub.textContent = title ? title.eyebrow : t("subtitle");
    panel.setAttribute("aria-label", title ? title.heading : config.name);
    panel.classList.toggle("titled", !!title);
  }

  async function open(args: OpenArgs = {}) {
    const fromProduct = args.productId != null && args.productId !== productId;
    if (args.productId != null) productId = args.productId;
    drawer = args.mode === "drawer";
    panel.classList.toggle("drawer", drawer);
    setHeader(drawer ? args.title : undefined);
    panel.hidden = false;
    layout();
    ui.open.set(true);
    ui.teaserSeen.set(true);
    setExpanded(true);
    if (args.focus !== false) input.focus();
    const first = !loaded;
    if (first) {
      loaded = true;
      loadP = load().finally(() => {
        loadP = null;
      });
    }
    if (args.message) {
      if (!loadP) return submit(args.message);
      const waiting = queued !== null;
      queued = args.message; // the latest request wins; only the first caller sends it
      if (waiting) return;
      await loadP;
      const m = queued;
      queued = null;
      if (m) submit(m);
    } else if (first) {
      await loadP;
    } else if (fromProduct) {
      // C25: the Ask block opened an existing chat for another product: offer its FAQ questions, send nothing.
      const faq = await loadFaq();
      if (!busy) showSuggestions(hasMessages() ? faq : [...merchantSuggested(), ...faq]);
    }
  }

  function close() {
    if (panel.hidden || opts.inline) return;
    menu.hide();
    panel.hidden = true;
    lockScroll(false);
    ui.open.set(false);
    setExpanded(false);
    opts.launcher?.focus();
  }

  function destroy() {
    turn?.abort();
    lockScroll(false);
    window.removeEventListener("online", onNet);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("resize", layout);
    style.remove();
    panel.remove();
  }

  return { open, close, destroy };
}
