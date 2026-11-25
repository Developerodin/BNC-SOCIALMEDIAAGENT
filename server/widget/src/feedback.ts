// Thumbs up and down under a bot answer (Task 32, UD14). A rating can be changed, and tapping the pressed thumb again
// clears it (C27). Optimistic: the pressed state flips at once and rolls back, with an announcement, if the save fails.
// After a thumbs-down a small menu offers five fixed reasons (no free text). Escape, a click outside or the thumb again
// closes it and keeps the plain thumbs-down; picking one re-sends the thumbs-down with that reason.
// Text only: nodes are built with createElement / textContent, never HTML strings (Global Constraints).
//
// The caller (the panel, Task 30) skips cut_off answers: the renderer only sees the message id, not the status.
// Clicks are ignored while a save is in flight, so two responses can never land out of order and leave the screen and
// the server disagreeing. Ceiling: a very slow request blocks re-rating until it settles (fetch has no timeout here).
import type { FeedbackReason, FeedbackRenderer, WidgetCtx } from "../../src/lib/widget-contract";
import { tokenStore } from "./core/storage";
import { strokeIcon } from "./panel/icons";

type Rating = -1 | 1 | null;

// Thin outline thumbs (1.5px stroke), like the header icons.
const ICON: Record<-1 | 1, string> = {
  1: "M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3",
  [-1]: "M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17",
};

const REASONS: FeedbackReason[] = ["wrong_products", "wrong_price_stock", "misunderstood", "unclear", "other"];

const icon = (d: string) => strokeIcon(d, 18);

/**
 * Renders the thumbs into `into`, replacing any thumbs rendered there before. Accepts a null id (an answer the server
 * sent without one) and then renders nothing, so it is assignable to the contract's FeedbackRenderer.
 */
export function renderFeedback(into: HTMLElement, messageId: string | null, rating: Rating, ctx: WidgetCtx): void {
  for (const old of Array.from(into.children)) if (old.classList.contains("askcart-feedback")) old.remove();
  if (!messageId) return;
  const id = messageId;

  const group = document.createElement("div");
  group.className = "askcart-feedback";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", ctx.t("rate_answer"));

  const buttons = ([1, -1] as const).map((value) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "askcart-feedback__btn";
    const label = ctx.t(value === 1 ? "helpful" : "not_helpful");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.append(icon(ICON[value]));
    btn.addEventListener("click", () => void choose(value));
    group.append(btn);
    return { btn, value };
  });
  const down = buttons[1].btn;
  down.setAttribute("aria-haspopup", "menu");
  down.setAttribute("aria-expanded", "false");

  let saved: Rating = rating; // what the server has, as far as we know
  let busy = false;
  const show = (r: Rating) => {
    for (const { btn, value } of buttons) btn.setAttribute("aria-pressed", String(r === value));
  };

  // The reasons menu, anchored under the thumbs (styles: .askcart-reasons). Same keys as the header menu: arrows move,
  // Escape closes (and doesn't close the panel), focus goes back to the thumbs-down button.
  let menu: HTMLElement | null = null;
  let root: Node = group; // the document or shadow root the group lives in; read when the menu opens (the group is attached by then)
  const outside = (e: Event) => {
    if (!group.isConnected || !e.composedPath().includes(group)) close();
  };
  function close(refocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    root.removeEventListener("pointerdown", outside, true);
    down.setAttribute("aria-expanded", "false");
    if (refocus) down.focus();
  }
  function openReasons() {
    const m = document.createElement("div");
    menu = m;
    m.className = "mlist askcart-reasons";
    m.setAttribute("role", "menu");
    m.setAttribute("aria-label", ctx.t("reason_menu"));
    const items = REASONS.map((reason) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.tabIndex = -1;
      b.textContent = ctx.t(("reason_" + reason) as "reason_other");
      b.addEventListener("click", () => {
        close(true);
        void sendReason(reason);
      });
      m.append(b);
      return b;
    });
    m.addEventListener("keydown", (e) => {
      const i = items.indexOf(e.target as HTMLButtonElement);
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") e.stopPropagation(); // Esc closes the menu, not the panel
        else e.preventDefault(); // Tab: back to the thumb, so the next Tab continues in order
        close(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        items[e.key === "Home" ? 0 : items.length - 1].focus();
      }
    });
    group.append(m);
    down.setAttribute("aria-expanded", "true");
    root = group.getRootNode();
    root.addEventListener("pointerdown", outside, true);
    items[0].focus();
    m.scrollIntoView?.({ block: "nearest" });
  }

  // Failure keeps the plain thumbs-down that is already saved; the shopper hears it didn't save.
  async function sendReason(reason: FeedbackReason) {
    const token = tokenStore(ctx.page.shop).get();
    if (busy || saved !== -1) return;
    busy = true;
    group.setAttribute("aria-busy", "true");
    const ok = token ? await ctx.api.rate(token, id, -1, reason) : false;
    busy = false;
    group.removeAttribute("aria-busy");
    ctx.announce(ctx.t(ok ? "feedback_thanks" : "feedback_error"));
  }

  async function choose(value: -1 | 1) {
    if (busy) return;
    close();
    const next: Rating = saved === value ? null : value; // C27: the pressed thumb clears
    const token = tokenStore(ctx.page.shop).get();
    show(next);
    busy = true;
    group.setAttribute("aria-busy", "true");
    const ok = token ? await ctx.api.rate(token, id, next) : false; // no reason: changing or clearing clears it on the server
    busy = false;
    group.removeAttribute("aria-busy");
    if (ok) {
      saved = next;
      if (next !== null) ctx.announce(ctx.t("feedback_thanks"));
      if (next === -1 && group.isConnected) openReasons();
    } else {
      show(saved);
      ctx.announce(ctx.t("feedback_error"));
    }
  }

  show(saved);
  into.append(group);
}

// Compile-time check that the wider signature still fits the shared seam.
const _contract: FeedbackRenderer = renderFeedback;
void _contract;
