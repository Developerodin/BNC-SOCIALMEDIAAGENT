// Focus trap and the polite live region for the panel (UD17).

const FOCUSABLE = "button:not([disabled]), textarea:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Visible focusable elements inside `root`, in document order (anything inside a [hidden] ancestor is skipped). */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !e.closest("[hidden]"));
}

/** Tab from the last control wraps to the first, Shift+Tab from the first to the last. Returns true when it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement, active: Element | null): boolean {
  if (e.key !== "Tab") return false;
  const list = focusables(root);
  if (!list.length) return false;
  const first = list[0];
  const last = list[list.length - 1];
  const inside = active !== null && root.contains(active);
  if (e.shiftKey ? active === first || !inside : active === last || !inside) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return true;
  }
  return false;
}

/** A visually hidden polite live region; say() announces a finished answer once (never each delta). */
export function liveRegion(): { el: HTMLElement; say(text: string): void } {
  const el = document.createElement("div");
  el.className = "sr";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  return {
    el,
    say(text) {
      el.textContent = text;
    },
  };
}
