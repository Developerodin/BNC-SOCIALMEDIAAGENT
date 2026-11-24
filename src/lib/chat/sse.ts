// Server-sent events for POST /api/chat (§7.6). Each event is "event: <name>\ndata: <JSON>\n\n";
// JSON.stringify never emits a raw newline, so one data line always holds the whole payload.

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

/** A comment line; sent every PING_MS so proxies don't close an idle stream. */
export const PING = ": ping\n\n";
export const PING_MS = 15_000;

export type SseEvent = "text" | "product" | "error" | "done";

export function sseEvent(event: SseEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
