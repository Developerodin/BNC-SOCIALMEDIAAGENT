// The header menu (C22): Expand / Collapse (desktop) and "Delete chat", which deletes the chat on our server (D84).
// Labels and visibility are read each time the menu opens, so Expand / Collapse can follow the panel's state.
import { icon } from "./icons";

export type MenuItem = { label: () => string; run: () => void; hidden?: () => boolean };

export function createMenu(t: (k: string) => string, items: MenuItem[]) {
  const wrap = document.createElement("div");
  wrap.className = "mwrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ib menu";
  btn.setAttribute("aria-label", t("menu"));
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.append(icon("menu"));
  const list = document.createElement("div");
  list.className = "mlist";
  list.setAttribute("role", "menu");
  list.hidden = true;

  const buttons = items.map(({ run }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.addEventListener("click", () => {
      hide();
      run();
    });
    list.append(b);
    return b;
  });
  const shown = () => buttons.filter((b) => !b.hidden);

  function show() {
    items.forEach((it, i) => {
      buttons[i].textContent = it.label();
      buttons[i].hidden = !!it.hidden?.();
    });
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    shown()[0]?.focus();
  }
  function hide(refocus = false) {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }

  btn.addEventListener("click", () => (list.hidden ? show() : hide()));
  list.addEventListener("keydown", (e) => {
    const vis = shown();
    const i = vis.indexOf(e.target as HTMLButtonElement);
    if (e.key === "Escape") {
      e.stopPropagation(); // Esc closes the menu, not the panel
      hide(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      vis[(i + (e.key === "ArrowDown" ? 1 : vis.length - 1)) % vis.length].focus();
    } else if (e.key === "Tab") hide();
  });

  wrap.append(btn, list);
  return { el: wrap, button: btn, hide, isOpen: () => !list.hidden };
}
