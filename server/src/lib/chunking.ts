const MAX_CHARS = 3200;
// One token is never more than one UTF-8 byte, so this keeps every chunk under the model's 8,191-token input limit
// whatever the script (Burmese, Khmer and emoji can run past 1 token per char).
const MAX_BYTES = 8000;
const OVERLAP = 400;

/** True when index i of s falls between the two halves of a surrogate pair, so cutting there would break a character. */
export function splitsPair(s: string, i: number): boolean {
  const lo = s.charCodeAt(i);
  const hi = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff;
}

/** The furthest end from start that keeps the slice within maxChars UTF-16 units and maxBytes UTF-8 bytes, on a character boundary. */
function fitEnd(s: string, start: number, maxChars: number, maxBytes: number): number {
  let end = start;
  let bytes = 0;
  while (end < s.length) {
    const cp = s.codePointAt(end)!;
    const units = cp > 0xffff ? 2 : 1;
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (end + units - start > maxChars || bytes + w > maxBytes) break;
    end += units;
    bytes += w;
  }
  return end;
}

// C7: content that fits is one chunk; longer content is windowed with overlap, every
// chunk after the first prefixed "Title: <title>". A window is at most MAX_CHARS and MAX_BYTES.
// Windows end on whitespace; if a window has none (CJK, long URLs) it is hard-cut at the limit.
export function chunkText(title: string, content: string): string[] {
  if (content.length <= MAX_CHARS && Buffer.byteLength(content, "utf8") <= MAX_BYTES) return [content];
  const prefix = `Title: ${title}\n`;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const first = chunks.length === 0;
    let end = fitEnd(content, start, first ? MAX_CHARS : MAX_CHARS - prefix.length, first ? MAX_BYTES : MAX_BYTES - prefixBytes);
    if (end < content.length) {
      const ws = content.slice(start, end).search(/\s\S*$/);
      if (ws > OVERLAP) end = start + ws + 1;
    }
    const body = content.slice(start, end);
    chunks.push(first ? body : prefix + body);
    if (end >= content.length) break;
    // Step back ~OVERLAP chars, then forward to a word start so the next chunk begins on a boundary.
    let next = end - OVERLAP;
    const gap = content.slice(next).search(/\s/);
    if (gap >= 0 && next + gap + 1 < end) next += gap + 1;
    else if (splitsPair(content, next)) next -= 1;
    start = next;
  }
  return chunks;
}
