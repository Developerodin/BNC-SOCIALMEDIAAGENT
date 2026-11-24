// Thumbs up and down under a bot answer (Task 32, UD14). A rating can be changed, and tapping the pressed thumb again
// clears it (C27). Optimistic: the pressed state flips at once and rolls back, with an announcement, if the save fails.
// Text only: nodes are built with createElement / textContent, never HTML strings (Global Constraints).
//
// The caller (the panel, Task 30) skips cut_off answers: the renderer only sees the message id, not the status.
// Clicks are ignored while a save is in flight, so two responses can never land out of order and leave the screen and
// the server disagreeing. Ceiling: a very slow request blocks re-rating until it settles (fetch has no timeout here).
import type { FeedbackRenderer, WidgetCtx } from "../../src/lib/widget-contract";
import { tokenStore } from "./core/storage";

type Rating = -1 | 1 | null;

const NS = "http://www.w3.org/2000/svg";
const ICON: Record<-1 | 1, string> = {
  1: "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z",
  [-1]: "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z",
};

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

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

  let saved: Rating = rating; // what the server has, as far as we know
  let busy = false;
  const show = (r: Rating) => {
    for (const { btn, value } of buttons) btn.setAttribute("aria-pressed", String(r === value));
  };

  async function choose(value: -1 | 1) {
    if (busy) return;
    const next: Rating = saved === value ? null : value; // C27: the pressed thumb clears
    const token = tokenStore(ctx.page.shop).get();
    show(next);
    busy = true;
    group.setAttribute("aria-busy", "true");
    const ok = token ? await ctx.api.rate(token, id, next) : false;
    busy = false;
    group.removeAttribute("aria-busy");
    if (ok) {
      saved = next;
      if (next !== null) ctx.announce(ctx.t("feedback_thanks"));
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
