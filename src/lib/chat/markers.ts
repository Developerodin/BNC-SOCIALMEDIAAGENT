// Turns the model's text stream into shopper text plus product GIDs (D36).
// Every [[…]] is stripped from the text. Only [[product:<n>]] with n in `allowed` (this turn's
// live-checked products, n → GID) becomes a product, once per answer; anything else is dropped.

const HOLD_MAX = 40; // a partial "[[…" longer than this is not a marker
const PRODUCT = /^\[\[\s*product\s*:\s*(\d+)\s*\]\]$/i;

export type ParsedChunk = { text: string; products: string[] };

export function createMarkerParser(allowed: Map<string, string>) {
  let buf = "";
  const seen = new Set<string>();

  function marker(m: string, products: string[]) {
    const n = PRODUCT.exec(m)?.[1];
    const gid = n === undefined ? undefined : allowed.get(String(Number(n)));
    if (gid && !seen.has(gid)) {
      seen.add(gid);
      products.push(gid);
    }
  }

  return {
    push(delta: string): ParsedChunk {
      buf += delta;
      let text = "";
      const products: string[] = [];
      for (;;) {
        const open = buf.indexOf("[[");
        if (open === -1) {
          // Hold a trailing "[": it may be the start of "[[".
          const keep = buf.endsWith("[") ? 1 : 0;
          text += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        text += buf.slice(0, open);
        buf = buf.slice(open);
        const close = buf.indexOf("]]", 2);
        if (close !== -1) {
          marker(buf.slice(0, close + 2), products);
          buf = buf.slice(close + 2);
        } else if (buf.length > HOLD_MAX) {
          buf = buf.slice(2); // not a marker: release it, but never let "[[" reach the shopper
        } else {
          break; // wait for more text
        }
      }
      return { text, products };
    },
    // An unfinished "[[…" at the end is dropped; a lone "[" is text.
    end(): ParsedChunk {
      const text = buf.startsWith("[[") ? "" : buf;
      buf = "";
      return { text, products: [] };
    },
  };
}
