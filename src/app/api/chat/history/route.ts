import { preflight, storeFor } from "@/lib/chat/cors";
import { readHistory } from "@/lib/chat/turn";

// GET /api/chat/history?shop=…: the widget restores a conversation across pages (Task 20, UD13). The token travels in the
// X-Conversation-Token header, never the URL, so it stays out of logs. Shop, CORS and token checks are Task 19's.
// Not cached: with cacheComponents a GET handler is prerendered only when it touches no request data, and this one reads
// req.url and req.headers first (route-handlers.md, "With Cache Components"). Cache-Control: no-store keeps browsers and
// proxies from caching it too. No `runtime` export (cacheComponents doesn't support it).

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "GET, OPTIONS", headers: "X-Conversation-Token" });
}

export async function GET(req: Request) {
  const found = await storeFor(req, new URL(req.url).searchParams.get("shop"));
  if (found instanceof Response) return found;
  const headers = { ...found.cors, "Cache-Control": "no-store" };

  const token = req.headers.get("x-conversation-token");
  if (!token) return Response.json({ error: "invalid_token" }, { status: 401, headers });
  const history = await readHistory(found.store.id, token);
  if (!history.ok) {
    const error = history.status === 401 ? "invalid_token" : "conversation_not_found";
    return Response.json({ error }, { status: history.status, headers });
  }
  return Response.json({ messages: history.messages }, { headers });
}
