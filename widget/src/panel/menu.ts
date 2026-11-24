// The header menu (C22): "New chat" forgets the chat in this browser only; "Delete chat" deletes it on our server (D84).
import { icon } from "./icons";

export function createMenu(t: (k: string) => string, items: { label: string; run: () => void }[]) {
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

  const buttons = items.map(({ label, run }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.textContent = label;
    b.addEventListener("click", () => {
      hide();
      run();
    });
    list.append(b);
    return b;
  });

  function show() {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    buttons[0]?.focus();
  }
  function hide(refocus = false) {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }

  btn.addEventListener("click", () => (list.hidden ? show() : hide()));
  list.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (e.key === "Escape") {
      e.stopPropagation(); // Esc closes the menu, not the panel
      hide(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
    } else if (e.key === "Tab") hide();
  });

  wrap.append(btn, list);
  return { el: wrap, button: btn, hide, isOpen: () => !list.hidden };
}
