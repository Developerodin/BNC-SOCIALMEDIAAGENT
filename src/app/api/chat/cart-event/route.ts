import { customerOf } from "@/lib/chat/customer";
import { preflight, storeFor } from "@/lib/chat/cors";
import { logCartEvent, parseCartEvent, readSmallJson } from "@/lib/chat/events";

// POST /api/chat/cart-event?shop=…: logs an Add to cart from a chat card (UD11, §7.6; the UD21 metric). Body
// `{ eventId, messageId?, productId, variantId, quantity }`, at most 2 kB. The token travels in the X-Conversation-Token
// header, never the URL. A retried eventId is a 204 and adds no row; a messageId outside the token's conversation is
// stored as null (Review Focus 4). No `runtime` export (cacheComponents doesn't support it).
// `// ponytail:` no rate limit until M10 (D40); add this route to M10's per-IP limit list.

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
  const event = body && parseCartEvent(body);
  if (!event) return Response.json({ error: "invalid_body" }, { status: 400, headers });

  const who = customerOf(req, found.store.id);
  if (!who.ok) return Response.json({ error: "invalid_session" }, { status: 401, headers });
  const logged = await logCartEvent(found.store.id, token, event, who.customer);
  if (!logged.ok) {
    const error = logged.session ? "invalid_session" : logged.status === 401 ? "invalid_token" : "conversation_not_found";
    return Response.json({ error }, { status: logged.status, headers });
  }
  return new Response(null, { status: 204, headers });
}
