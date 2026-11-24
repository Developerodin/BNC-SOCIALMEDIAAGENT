// The message list (Task 30): user and assistant bubbles, the typing indicator, errors with Retry, and notes.
// Text only: every string from the model, the merchant or the server goes through textContent (§7.7, D36).
import type { Card, CardsRenderer, FeedbackRenderer, HistoryItem, WidgetCtx } from "../../../src/lib/widget-contract";

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** renderCards also gets the answer's message id, so a cart add from a card is linked to that answer. Cards are only
 * drawn once the id is known: at `done` for a streamed answer (UD12), or from history. */
export type Renderers = {
  renderCards: (...a: [...Parameters<CardsRenderer>, messageId?: string | null]) => void;
  renderFeedback: FeedbackRenderer;
};

/** One assistant answer being streamed. */
export type Answer = {
  el: HTMLElement;
  append(delta: string): void;
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

  function user(text: string): HTMLElement {
    return add(el("div", "msg user", text));
  }

  /** An assistant bubble: text, then cards, then thumbs. `cutOff` adds the note and skips thumbs. */
  function bot(text: string, cards: Card[], id: string | null, rating: -1 | 1 | null, cutOff: boolean): HTMLElement {
    const wrap = el("div", "msg bot");
    if (text) wrap.append(el("div", "txt", text));
    if (cutOff) wrap.append(el("div", "cut", ctx.t("cut_off")));
    if (cards.length) {
      const box = el("div", "cards");
      wrap.append(box);
      r.renderCards(box, cards, ctx, id);
    }
    if (id && !cutOff) r.renderFeedback(wrap, id, rating, ctx);
    return add(wrap);
  }

  function history(items: HistoryItem[]) {
    for (const m of items) {
      if (m.role === "user") user(m.content);
      else bot(m.content, m.cards, m.id, m.rating, m.status === "cut_off");
    }
  }

  function answer(): Answer {
    const wrap = add(el("div", "msg bot pending"));
    const typing = el("div", "typing");
    typing.setAttribute("aria-label", ctx.t("typing"));
    typing.setAttribute("role", "img");
    typing.append(el("span", ""), el("span", ""), el("span", ""));
    wrap.append(typing);
    let txt: HTMLElement | null = null;
    let text = "";
    let cards: Card[] = [];
    return {
      el: wrap,
      append(delta) {
        if (!txt) {
          txt = el("div", "txt");
          typing.before(txt);
        }
        text += delta;
        txt.textContent = text;
        scroll();
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
          const box = el("div", "cards");
          wrap.append(box);
          r.renderCards(box, cards, ctx, messageId);
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
