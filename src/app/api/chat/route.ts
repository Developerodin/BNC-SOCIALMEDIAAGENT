import { preflight, storeFor } from "@/lib/chat/cors";
import { MAX_INPUT_CHARS } from "@/lib/chat/limits";
import { PING, PING_MS, SSE_HEADERS, sseEvent } from "@/lib/chat/sse";
import { openTurn, runTurn } from "@/lib/chat/turn";

// POST /api/chat: one chat turn, streamed as SSE (§7.6, Task 19). No `runtime` export: cacheComponents
// is on, and it doesn't support the segment option (route handlers run on Node.js by default).
// Abuse limits (rate limits, the monthly cap, Turnstile) come in M10 (D40): don't expose this on a live store before then.

const MAX_PAGE_URL = 2048;

export function OPTIONS(req: Request) {
  return preflight(req);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "unknown_shop" }, { status: 404 });
  const found = await storeFor(req, body.shop);
  if (found instanceof Response) return found;
  const { store, cors } = found;
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers: cors });

  const { message, conversationToken } = body;
  if (typeof message !== "string" || !message.trim()) return fail("empty_message", 400);
  if (message.length > MAX_INPUT_CHARS) return fail("message_too_long", 413); // D35
  if (conversationToken != null && typeof conversationToken !== "string") return fail("invalid_token", 401);
  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, MAX_PAGE_URL) : null;

  const opened = await openTurn(store, { token: conversationToken ?? undefined, message, pageUrl });
  if (!opened.ok) return fail(opened.status === 401 ? "invalid_token" : "conversation_not_found", opened.status);

  // The shopper leaving aborts the turn (and its OpenAI request). On `next dev` both req.signal and the stream's
  // cancel() fire on a client abort (req.signal first; neither on a normal end); both are kept since abort() is idempotent.
  // SSE_HEADERS' "no-transform" also keeps Next's built-in compression from buffering this stream.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  const enc = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const ping = setInterval(() => write(PING), PING_MS);
      // Not awaited: start() must return so the response can begin streaming.
      void runTurn({
        store,
        conversationId: opened.conversationId,
        token: opened.token,
        history: opened.history,
        message: opened.message,
        productId: typeof body.productId === "string" ? body.productId : undefined,
        country: typeof body.country === "string" ? body.country : undefined,
        signal: ac.signal,
        send: (event, data) => write(sseEvent(event, data)),
      })
        .catch((err) => console.error("chat stream failed", { storeId: store.id, error: err instanceof Error ? err.name : typeof err }))
        .finally(() => {
          clearInterval(ping);
          req.signal.removeEventListener("abort", onAbort);
          if (closed) return;
          closed = true;
          controller.close();
        });
    },
    cancel() {
      closed = true;
      ac.abort();
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...cors } });
}
