import { and, eq, sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { cartEvents, conversations, messages } from "@/db/schema";
import { UUID, verifyToken } from "./token";

// Task 27: the widget's two small write endpoints, POST /api/chat/feedback (UD14, C27) and POST /api/chat/cart-event (UD11,
// §7.6). Review Focus 4: every write is scoped to the token's conversation in the token's store, inside forStore (RLS).
// `// ponytail:` no rate limit until M10 (D40); a script with a valid token could flood cart_events. M10's per-IP limit
// must list these routes too.

/** Each route reads at most this many bytes of body. */
export const MAX_BODY = 2048;

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d{1,20}$/;
const NUMERIC_ID = /^\d{1,20}$/;

/**
 * Reads a JSON object body of at most MAX_BODY bytes: stops reading once the limit is passed, so a large body is never
 * buffered. Returns "too_large", or null for anything that isn't a JSON object.
 */
export async function readSmallJson(req: Request): Promise<Record<string, unknown> | null | "too_large"> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) return "too_large";
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const uuidOf = (v: unknown): string | null => (typeof v === "string" && UUID.test(v.toLowerCase()) ? v.toLowerCase() : null);

export type Feedback = { messageId: string; rating: 1 | -1 | null };

/** `{ messageId, rating: 1 | -1 | null }`; rating must be present (null clears it, C27). */
export function parseFeedback(body: Record<string, unknown>): Feedback | null {
  const messageId = uuidOf(body.messageId);
  const { rating } = body;
  if (!messageId || !(rating === 1 || rating === -1 || rating === null)) return null;
  return { messageId, rating };
}

export type CartEvent = { eventId: string; messageId: string | null; productId: string; variantId: string; quantity: number };

/** `{ eventId, messageId?, productId, variantId, quantity }`: a Product GID, a numeric variant id string, quantity 1–99. */
export function parseCartEvent(body: Record<string, unknown>): CartEvent | null {
  const eventId = uuidOf(body.eventId);
  const messageId = body.messageId === undefined || body.messageId === null ? null : uuidOf(body.messageId);
  const { productId, variantId, quantity } = body;
  if (!eventId) return null;
  if (body.messageId !== undefined && body.messageId !== null && !messageId) return null;
  if (typeof productId !== "string" || !PRODUCT_GID.test(productId)) return null;
  if (typeof variantId !== "string" || !NUMERIC_ID.test(variantId)) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
  return { eventId, messageId, productId, variantId, quantity };
}

/**
 * Sets or clears the rating of an assistant message in the token's conversation. A bad or other-store token → 401; a
 * message that isn't an assistant message of this conversation in this store (or doesn't exist) → 404, nothing changed.
 */
export async function rateMessage(storeId: string, token: string, f: Feedback): Promise<{ ok: true } | { ok: false; status: 401 | 404 }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  const updated = await forStore(storeId, (tx) =>
    tx
      .update(messages)
      .set({ rating: f.rating })
      .where(
        and(
          eq(messages.id, f.messageId),
          eq(messages.storeId, storeId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, "assistant"),
        ),
      )
      .returning({ id: messages.id }),
  );
  return updated.length > 0 ? { ok: true } : { ok: false, status: 404 };
}

/**
 * Logs an add-to-cart against the token's conversation. A retried eventId is a no-op (ON CONFLICT DO NOTHING), still ok.
 * A messageId that isn't an assistant message of this conversation is stored as null. The insert is guarded by the
 * conversation existing, in the same statement, so a deleted conversation is a 404 rather than an FK error. A bad or
 * other-store token → 401.
 */
export async function logCartEvent(storeId: string, token: string, e: CartEvent): Promise<{ ok: true } | { ok: false; status: 401 | 404 }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  return forStore(storeId, async (tx) => {
    const messageId = e.messageId
      ? sql`(select ${messages.id} from ${messages} where ${messages.id} = ${e.messageId} and ${messages.storeId} = ${storeId}
              and ${messages.conversationId} = ${conversationId} and ${messages.role} = 'assistant')`
      : sql`null::uuid`;
    const inserted = await tx.execute(sql`
      insert into ${cartEvents} (store_id, conversation_id, message_id, product_id, variant_id, quantity, event_id)
      select ${storeId}, ${conversationId}, ${messageId}, ${e.productId}, ${e.variantId}, ${e.quantity}, ${e.eventId}
      where exists (select 1 from ${conversations} where ${conversations.storeId} = ${storeId} and ${conversations.id} = ${conversationId})
      on conflict (event_id) do nothing
      returning id`);
    if (inserted.length > 0) return { ok: true as const };
    // Nothing inserted: either a retried eventId (ok) or the conversation is gone (404).
    const [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.storeId, storeId), eq(conversations.id, conversationId)));
    return conv ? { ok: true as const } : { ok: false as const, status: 404 as const };
  });
}
