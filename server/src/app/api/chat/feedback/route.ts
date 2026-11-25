import { customerOf } from "@/lib/chat/customer";
import { preflight, storeFor } from "@/lib/chat/cors";
import { parseFeedback, rateMessage, readSmallJson } from "@/lib/chat/events";

// POST /api/chat/feedback?shop=…: thumbs up or down on an answer (UD14), changeable and clearable (C27). Body
// `{ messageId, rating: 1 | -1 | null, reason? }` (reason only with -1), at most 2 kB. The token travels in the X-Conversation-Token header, never the URL.
// Shop, CORS and token checks are Task 19's. Only an assistant message of the token's conversation in this store can be
// rated (Review Focus 4); anything else is a 404. No `runtime` export (cacheComponents doesn't support it).

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "POST, OPTIONS", headers: "Content-Type, X-Conversation-Token, X-AskCart-Customer" });
}

export async function POST(req: Request) {
  const found = await storeFor(req, new URL(req.url).searchParams.get("shop"));
  if (found instanceof Response) return found;
  const headers = { ...found.cors, "Cache-Control": "no-store" };

  const token = req.headers.get("x-conversation-token");
  if (!token) return Response.json({ error: "invalid_token" }, { status: 401, headers });
  const body = await readSmallJson(req);
  if (body === "too_large") return Response.json({ error: "body_too_large" }, { status: 413, headers });
  const feedback = body && parseFeedback(body);
  if (!feedback) return Response.json({ error: "invalid_body" }, { status: 400, headers });

  const who = customerOf(req, found.store.id);
  if (!who.ok) return Response.json({ error: "invalid_session" }, { status: 401, headers });
  const rated = await rateMessage(found.store.id, token, feedback, who.customer);
  if (!rated.ok) {
    const error = rated.session ? "invalid_session" : rated.status === 401 ? "invalid_token" : "message_not_found";
    return Response.json({ error }, { status: rated.status, headers });
  }
  return new Response(null, { status: 204, headers });
}
