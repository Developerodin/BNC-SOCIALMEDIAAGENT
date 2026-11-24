import { customerOf } from "@/lib/chat/customer";
import { preflight, storeFor } from "@/lib/chat/cors";
import { deleteConversation } from "@/lib/chat/turn";

// DELETE /api/chat/conversation?shop=…: the widget's "Clear chat" (D84) deletes the current conversation and its messages.
// The token travels in the X-Conversation-Token header, never the URL, so it stays out of logs. Shop, CORS and token checks
// are Task 19's, as in GET /api/chat/history. A conversation already gone is a 204 too (idempotent); one whose turn is still
// running is a 409, and the widget can retry once the answer is done. No `runtime` export (cacheComponents doesn't support it).

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "DELETE, OPTIONS", headers: "X-Conversation-Token" });
}

export async function DELETE(req: Request) {
  const found = await storeFor(req, new URL(req.url).searchParams.get("shop"));
  if (found instanceof Response) return found;
  const headers = { ...found.cors, "Cache-Control": "no-store" };

  const token = req.headers.get("x-conversation-token");
  if (!token) return Response.json({ error: "invalid_token" }, { status: 401, headers });
  const who = customerOf(req, found.store.id);
  if (!who.ok) return Response.json({ error: "invalid_session" }, { status: 401, headers });
  const deleted = await deleteConversation(found.store.id, token, who.customer);
  if (!deleted.ok) {
    const error = deleted.status === 401 ? "invalid_token" : deleted.status === 404 ? "conversation_not_found" : "turn_in_progress";
    return Response.json({ error }, { status: deleted.status, headers });
  }
  return new Response(null, { status: 204, headers });
}
