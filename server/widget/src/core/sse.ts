// Reads the /api/chat SSE stream (Task 25). Blocks are "event: <name>\ndata: <JSON>" separated by a blank line;
// comment lines (": ping") are skipped. CRLF is accepted, also when the CR and LF arrive in different chunks.

export type SseEvent = { event: string; data: unknown };

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // A trailing "\r" stays in the buffer until its "\n" arrives, so the whole-buffer replace still joins them.
      buf = (buf + (done ? decoder.decode() : decoder.decode(value, { stream: true }))).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const e = parseBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (e) yield e;
      }
      if (done) {
        const e = parseBlock(buf);
        if (e) yield e;
        return;
      }
    }
  } finally {
    // The consumer may stop early (on `done`); cancel so the connection closes. Throws are irrelevant here.
    reader.cancel().catch(() => {});
  }
}
