// Shared helpers for the widget core tests: SSE bodies and streams built from strings.
export function streamOf(chunks: string[], opts: { error?: boolean } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  // One chunk per pull, so an error comes after the chunks are read (error() in start() would discard queued chunks).
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else if (opts.error) c.error(new TypeError("network error"));
      else c.close();
    },
  });
}

export const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function sseResponse(chunks: string[], opts: { error?: boolean } = {}): Response {
  return new Response(streamOf(chunks, opts), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Cards are thumbnails until tapped: opens each one's detail sheet so its controls can be queried. */
export function openSheets(into: HTMLElement): void {
  into.querySelectorAll<HTMLElement>(".ac-tile").forEach((t) => t.click());
}
