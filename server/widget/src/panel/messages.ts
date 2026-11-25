// The message list (Task 30): user and assistant bubbles, the typing indicator, errors with Retry, and notes.
// Text only: every string from the model, the merchant or the server goes through textContent (§7.7, D36); answers get
// bold and bullets from rich.ts, which builds nodes the same way.
import type { Card, CardsRenderer, FeedbackRenderer, HistoryItem, StatusStep, WidgetCtx } from "../../../src/lib/widget-contract";
import { resolveHttpsUrl } from "../core/format";
import { icon } from "./icons";
import { renderRich } from "./rich";

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** renderCards also gets the answer's message id, so a cart add from a card is linked to that answer. Cards are only
 * drawn once the id is known: at `done` for a streamed answer (UD12), or from history. */
export type Renderers = {
  renderCards: (...a: [...Parameters<CardsRenderer>, messageId?: string | null, onAdded?: (title: string, cartHref: string | null) => void]) => void;
  renderFeedback: FeedbackRenderer;
};

/** One assistant answer being streamed. */
export type Answer = {
  el: HTMLElement;
  append(delta: string): void;
  /** `status`: what the assistant is doing, shown until the first text. */
  status(step: StatusStep): void;
  card(card: Card): void;
  /** The retried stream replaces whatever the dropped one showed (Review Focus 5). */
  reset(): void;
  /** `done`: cards after the text (UD12), then thumbs when there's an id (UD14). Returns the full text. */
  finish(messageId: string | null): string;
  remove(): void;
};

export function createMessages(ctx: WidgetCtx, r: Renderers) {
  const log = el("div", "log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "off"); // the separate live region announces finished answers only
  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };
  const add = (node: HTMLElement) => {
    log.append(node);
    scroll();
    return node;
  };

  /** `live` bubbles fade in; history is drawn instantly. */
  function user(text: string, live = true): HTMLElement {
    return add(el("div", live ? "msg user in" : "msg user", text));
  }

  /** "✓ <title> added to your cart · View cart": a system line (not a bubble) right after the answer's bubble and the
   * notes already there. Text and the link are built from nodes; a title is never markup. Skipped when the chat was cleared. */
  function addedNote(after: HTMLElement, title: string, cartHref: string | null, live: boolean) {
    if (!after.isConnected) return;
    const note = el("div", "note", ctx.t("added_note", { title }));
    if (live) note.setAttribute("role", "status"); // polite; history notes are not announced again on load
    if (cartHref) {
      const a = el("a", "", ctx.t("view_cart")) as HTMLAnchorElement;
      a.href = cartHref;
      a.rel = "noopener noreferrer";
      if (ctx.page.hosted) a.target = "_top"; // leave the iframe: the cart is the store's page
      note.append(" · ", a);
    }
    let at = after;
    while (at.nextElementSibling?.classList.contains("note")) at = at.nextElementSibling as HTMLElement;
    at.after(note);
    scroll();
  }

  /** An assistant bubble: text, then cards, then thumbs. `cutOff` adds the note and skips thumbs. */
  function bot(text: string, cards: Card[], id: string | null, rating: -1 | 1 | null, cutOff: boolean, cartAdds: { title: string }[] = []): HTMLElement {
    const wrap = el("div", "msg bot");
    if (text) {
      const txt = el("div", "txt");
      renderRich(txt, text);
      wrap.append(txt);
    }
    if (cutOff) wrap.append(el("div", "cut", ctx.t("cut_off")));
    if (cards.length) {
      const box = el("div", "cards");
      wrap.append(box);
      r.renderCards(box, cards, ctx, id, (title, href) => addedNote(wrap, title, href, true));
    }
    if (id && !cutOff) r.renderFeedback(wrap, id, rating, ctx);
    add(wrap);
    // The hosted page can't tell the store's cart URL from history (live adds learn it from the bridge's reply).
    const href = ctx.page.hosted ? null : resolveHttpsUrl(ctx.page.cartUrl);
    for (const a of cartAdds) if (a && typeof a.title === "string" && a.title) addedNote(wrap, a.title, href, false);
    return wrap;
  }

  function history(items: HistoryItem[]) {
    for (const m of items) {
      if (m.role === "user") user(m.content, false);
      else bot(m.content, m.cards, m.id, m.rating, m.status === "cut_off", m.cartAdds);
    }
  }

  function answer(): Answer {
    const wrap = add(el("div", "msg bot pending"));
    // The status line: shown at once ("Understanding your question…"), updated by `status` events, removed at the first token.
    const typing = el("div", "status");
    typing.setAttribute("role", "status");
    typing.setAttribute("aria-live", "polite");
    const stx = el("span", "stx", ctx.t("status_understanding"));
    typing.append(icon("sparkle"), stx);
    wrap.append(typing);
    let step: StatusStep = "understanding";
    let txt: HTMLElement | null = null;
    let text = "";
    let cards: Card[] = [];
    return {
      el: wrap,
      append(delta) {
        if (!txt) {
          txt = el("div", "txt in");
          wrap.prepend(txt);
          typing.remove(); // the status line is for the wait before the first token (a retried stream starts without it)
        }
        text += delta;
        renderRich(txt, text, true); // each new paragraph fades in
        scroll();
      },
      status(s) {
        if (s === step || !typing.isConnected) return; // a repeat isn't announced again
        step = s;
        stx.textContent = ctx.t(`status_${s}`);
      },
      card(c) {
        cards.push(c);
      },
      reset() {
        txt?.remove();
        txt = null;
        text = "";
        cards = [];
      },
      finish(messageId) {
        typing.remove();
        wrap.classList.remove("pending");
        if (cards.length) {
          const box = el("div", "cards in"); // live answer: the cards fade up once
          wrap.append(box);
          r.renderCards(box, cards, ctx, messageId, (title, href) => addedNote(wrap, title, href, true));
        }
        if (messageId) r.renderFeedback(wrap, messageId, null, ctx);
        if (!wrap.childElementCount) wrap.remove();
        scroll();
        return text;
      },
      remove() {
        wrap.remove();
      },
    };
  }

  /** A system line (an error), optionally with a Retry button. role=alert so it is announced. */
  function error(text: string, retry?: () => void): HTMLElement {
    const box = el("div", "err");
    box.setAttribute("role", "alert");
    box.append(el("span", "", text));
    if (retry) {
      const b = el("button", "retry", ctx.t("retry")) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", () => {
        box.remove();
        retry();
      });
      box.append(b);
    }
    return add(box);
  }

  function clearErrors() {
    log.querySelectorAll(".err").forEach((e) => e.remove());
  }

  return { log, user, bot, history, answer, error, clearErrors, add };
}
