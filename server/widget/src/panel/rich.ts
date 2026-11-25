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

/** One block of the answer: a paragraph (`items` is its one text) or a bullet list (`items` are the bullets). */
type Block = { tag: "p" | "ul"; items: string[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let list: Block | null = null;
  let plain: string[] = [];
  const flush = () => {
    // Line breaks next to a list are dropped: the list's own margin spaces it.
    const t = plain.join("\n").replace(/^\n+|\n+$/g, "");
    if (t) for (const p of t.split(/\n{2,}/)) blocks.push({ tag: "p", items: [p] });
    plain = [];
  };
  for (const line of text.split("\n")) {
    const m = BULLET.exec(line);
    if (m) {
      flush();
      if (!list) blocks.push((list = { tag: "ul", items: [] }));
      list.items.push(m[1]);
    } else if (list && !line.trim()) {
      continue; // a blank line between bullets doesn't end the list
    } else {
      list = null;
      plain.push(line);
    }
  }
  flush();
  return blocks;
}

function fill(node: HTMLElement, b: Block) {
  node.replaceChildren();
  if (b.tag === "p") return inline(node, b.items[0]);
  for (const item of b.items) {
    const li = document.createElement("li");
    inline(li, item);
    node.append(li);
  }
}

const shown = new WeakMap<HTMLElement, string[]>(); // per box: the source of each block as last drawn

/** Draws `text` in `box`: paragraphs (blank lines between them, spaced in styles.ts) and bullet lists. Called again on
 * every streamed delta with the whole text so far, and only the blocks that changed are touched (in practice the last one),
 * so a paragraph already on screen is not rebuilt and its fade is not replayed. `fade` gives each block that is new in
 * this call the `nw` class (styles.ts fades it in once; off for history). */
export function renderRich(box: HTMLElement, text: string, fade = false) {
  const blocks = parse(text);
  const keys = blocks.map((b) => b.tag + b.items.join("\n"));
  const old = shown.get(box);
  if (!old) box.replaceChildren(); // first call, or a box that held something else
  shown.set(box, keys);
  blocks.forEach((b, i) => {
    let node = box.children[i] as HTMLElement | undefined;
    if (node && old && old[i] === keys[i]) return; // unchanged
    if (node && node.tagName.toLowerCase() !== b.tag) {
      node.remove();
      node = undefined;
    }
    if (node) return fill(node, b); // the same block, longer: the node stays and its fade carries on
    node = document.createElement(b.tag);
    if (fade) node.className = "nw";
    fill(node, b);
    const at = box.children[i];
    if (at) at.before(node);
    else box.append(node);
  });
  while (box.children.length > blocks.length) box.lastElementChild!.remove();
}
