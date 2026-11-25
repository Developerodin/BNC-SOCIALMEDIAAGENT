// Turns the model's text stream into shopper text plus product GIDs (D36).
// Every [[…]] is stripped from the text. Only [[product:<n>]] with n in `allowed` (this turn's
// live-checked products, n → GID) becomes a product, once per answer; anything else is dropped.
// A marker that stands where a product NAME is needed ("For a small flat, [[product:3]] is the best fit") is replaced by the
// product's title instead of leaving a hole. The text is also tidied on the way out: no space before ! ? ; : (French style),
// no double or trailing spaces, no dangling ":" before a removed marker. To decide, whitespace and a trailing ":" are held
// back until the next text arrives, and a marker waits for the first character after it.

const HOLD_MAX = 40; // a partial "[[…" longer than this is not a marker
const PRODUCT = /^\[\[\s*product\s*:\s*(\d+)\s*\]\]$/i;
const SP = "[ \\t\\u00a0\\u202f]";
const HELD = new RegExp(`${SP}*:?${SP}*$`);
const TAIL_MAX = 80;
// Words after which a noun must follow, so a marker there stands for a name ("the [[…]]", "[[…]] and [[…]]").
const NEEDS_NOUN = /(?:^|[\s(])(?:the|a|an|our|and|or|le|la|les|l['’]|un|une|notre|ce|cette|et|ou|der|die|das|ein|eine|und|oder|el|los|las|una)$/i;
const LIST_ITEM = /(?:^|\n)[ \t]*(?:[-*•]|\d{1,2}[.)])$/;

export type ParsedChunk = { text: string; products: string[] };

const LOOK = 80;
/** Letters and digits only, lowercase: "**Margot  Sofa**" and "margot sofa" compare equal. */
const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** What follows a marker on its line: "wait" for more text, "end" (end of line or text), or the first character. */
function peek(rest: string): "wait" | "end" | string {
  for (const c of rest) {
    if (c === "\n") return "end";
    if (!/[ \t  ]/.test(c)) return c;
  }
  return "wait";
}

/** The sentence goes on after the marker, so the marker was its subject: a comma, dash, bracket or a lowercase word. */
const continues = (c: string) => c !== "end" && /^[,;—–(-]$|^\p{Ll}$/u.test(c);

export function createMarkerParser(allowed: Map<string, string>, titleOf?: (gid: string) => string | undefined) {
  let buf = "";
  const seen = new Set<string>();
  let held = ""; // trailing spaces and ":" of the text so far, released when more text follows
  let tail = ""; // the last released characters, for context
  let any = false; // something has been released

  /** Cleans a piece of text and releases it; the trailing spaces and ":" stay held. */
  function release(piece: string): string {
    const s = held + piece;
    const h = HELD.exec(s)![0];
    held = h;
    let body = s.slice(0, s.length - h.length);
    if (!body && !h) return "";
    body = body
      .replace(new RegExp(`${SP}+(?=[.,!?;:])`, "g"), "") // no space before French punctuation
      .replace(new RegExp(`(\\S)${SP}{2,}`, "g"), "$1 ")
      .replace(new RegExp(`${SP}+\\n`, "g"), "\n");
    // Spaces that start the piece after a word (held spaces joined by later ones) become one.
    if (tail && !/\s$/.test(tail)) body = body.replace(new RegExp(`^${SP}{2,}`), " ");
    // Lines that held only a removed marker leave blank lines: never more than one in a row.
    const nl = /\n*$/.exec(tail)![0].length;
    body = body.replace(/^\n+/, (m) => "\n".repeat(Math.max(0, Math.min(m.length, 2 - nl)))).replace(/\n{3,}/g, "\n\n");
    if (body) {
      any = true;
      tail = (tail + body).slice(-TAIL_MAX);
    }
    return body;
  }

  /** The product a marker names, registered once per answer (so its card is not held up while the marker waits). */
  function register(m: string, products: string[]): string | undefined {
    const n = PRODUCT.exec(m)?.[1];
    const gid = n === undefined ? undefined : allowed.get(String(Number(n)));
    if (gid && !seen.has(gid)) {
      seen.add(gid);
      products.push(gid);
    }
    return gid;
  }

  function marker(m: string, products: string[], rest: string): { text: string; rest: string } {
    const gid = register(m, products);
    const next = peek(rest);
    const prev = (tail + held).trimEnd();
    const atStart = !any && !prev;
    const title = gid ? titleOf?.(gid)?.trim() : undefined;
    // The model already wrote the name next to the marker ("- [[product:1]] **Margot Sofa**"): nothing to fill in.
    const named = !!title && (squash(rest.slice(0, title.length + 16)).startsWith(squash(title)) || squash(tail + held).endsWith(squash(title)));
    const needsName =
      !!title &&
      !named &&
      (LIST_ITEM.test(prev) || NEEDS_NOUN.test(prev) || ((atStart || /[,;:(—–-]$/.test(prev)) && next !== "wait" && continues(next)));
    if (needsName) {
      const before = tail + held;
      const lead = !before || /[(\s'’"«]$/.test(before) ? "" : " ";
      return { text: release(lead + title), rest };
    }
    // Removed marker: a ":" that introduced it is dropped when a "." follows, or ends the sentence when more text follows.
    // At the end of a line it stays: the product card appears right below the text.
    if (/:$/.test(held.trimEnd()) && next !== "end" && next !== "wait") {
      held = /^[.!?]$/.test(next) ? "" : ".";
    }
    // "word [[…]] word" keeps one space; a space already held or leading the rest is not doubled.
    const before = tail + held;
    const gap = !before || /\s$/.test(before);
    // "- [[…]] — Margot Sofa": the bullet's own name follows, so the dash that joined it to the marker goes too.
    const tidy = named && LIST_ITEM.test(prev) ? rest.replace(/^[ \t]*[—–:-][ \t]*/, "") : rest;
    return { text: "", rest: gap ? tidy.replace(new RegExp(`^${SP}+`), "") : tidy };
  }

  function run(ending: boolean): ParsedChunk {
    let text = "";
    const products: string[] = [];
    for (;;) {
      const open = buf.indexOf("[[");
      if (open === -1) {
        // Hold a trailing "[": it may be the start of "[[".
        const keep = !ending && buf.endsWith("[") ? 1 : 0;
        text += release(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep);
        break;
      }
      text += release(buf.slice(0, open));
      buf = buf.slice(open);
      const close = buf.indexOf("]]", 2);
      if (close !== -1) {
        const rest = buf.slice(close + 2);
        // The marker waits for what follows it: its first character, and enough text to see whether a name comes next.
        if (!ending && (peek(rest) === "wait" || (rest.length < LOOK && !rest.includes("\n")))) {
          register(buf.slice(0, close + 2), products);
          break;
        }
        const r = marker(buf.slice(0, close + 2), products, rest);
        text += r.text;
        buf = r.rest;
      } else if (buf.length > HOLD_MAX) {
        buf = buf.slice(2); // not a marker: release it, but never let "[[" reach the shopper
      } else {
        break; // wait for more text
      }
    }
    return { text, products };
  }

  return {
    push(delta: string): ParsedChunk {
      buf += delta;
      return run(false);
    },
    // An unfinished "[[…" at the end is dropped; a lone "[" is text. Held trailing spaces are dropped; a held ":" stays.
    end(): ParsedChunk {
      const out = run(true);
      if (buf.startsWith("[[")) buf = "";
      out.text += release(buf);
      buf = "";
      const colon = held.replace(new RegExp(`^${SP}+`), "").replace(new RegExp(`${SP}+$`), "");
      held = "";
      return { text: out.text + colon, products: out.products };
    },
  };
}
