// The small Markdown subset models write in answers: **bold** and "- " bullet lines. Everything else stays plain text.
// Nodes are built with createElement / textContent only, never HTML strings (§7.7, D36), so model text can't inject markup.

const BULLET = /^\s*[-*•]\s+(.*)$/;
const BOLD = /\*\*(.+?)\*\*/g;

/** Appends `text` to `parent`, with **x** as <strong>. An unclosed "**" (mid-stream) stays as typed. */
function inline(parent: HTMLElement, text: string) {
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const b = document.createElement("strong");
    b.textContent = m[1];
    parent.append(b);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Replaces `box`'s content with `text` rendered: runs of bullet lines become a <ul>, other lines keep their line breaks
 * (the bubble is white-space: pre-wrap). Called again on every streamed delta, so it rebuilds from scratch. */
export function renderRich(box: HTMLElement, text: string) {
  box.replaceChildren();
  let list: HTMLElement | null = null;
  let plain: string[] = [];
  const flush = () => {
    // Line breaks next to a list are dropped: the list's own margin spaces it.
    const t = plain.join("\n").replace(/^\n+|\n+$/g, "");
    if (t) inline(box, t);
    plain = [];
  };
  for (const line of text.split("\n")) {
    const m = BULLET.exec(line);
    if (m) {
      flush();
      if (!list) box.append((list = document.createElement("ul")));
      const li = document.createElement("li");
      inline(li, m[1]);
      list.append(li);
    } else if (list && !line.trim()) {
      continue; // a blank line between bullets doesn't end the list
    } else {
      list = null;
      plain.push(line);
    }
  }
  flush();
}
