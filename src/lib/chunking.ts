const MAX_CHARS = 3200;
const OVERLAP = 400;

// C7: content that fits is one chunk; longer content is windowed with overlap, every
// chunk after the first prefixed "Title: <title>". Windows end on whitespace; if a window
// has none (CJK, long URLs) it is hard-cut at the limit.
export function chunkText(title: string, content: string): string[] {
  if (content.length <= MAX_CHARS) return [content];
  const prefix = `Title: ${title}\n`;
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const max = chunks.length === 0 ? MAX_CHARS : MAX_CHARS - prefix.length;
    let end = Math.min(start + max, content.length);
    if (end < content.length) {
      const ws = content.slice(start, end).search(/\s\S*$/);
      if (ws > OVERLAP) end = start + ws + 1;
    }
    const body = content.slice(start, end);
    chunks.push(chunks.length === 0 ? body : prefix + body);
    if (end >= content.length) break;
    // Step back ~OVERLAP chars, then forward to a word start so the next chunk begins on a boundary.
    let next = end - OVERLAP;
    const gap = content.slice(next).search(/\s/);
    if (gap >= 0 && next + gap + 1 < end) next += gap + 1;
    start = next;
  }
  return chunks;
}
