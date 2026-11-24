import { sql } from "drizzle-orm";
import { forStore } from "@/db/client";
import { preflight, storeFor } from "@/lib/chat/cors";
import { customerOf } from "@/lib/chat/customer";
import { tokenFor, UUID } from "@/lib/chat/token";

// GET /api/chat/conversations?shop=…[&limit=…][&cursor=…]: the signed-in customer's conversations, latest first, each with its
// conversation token so the client opens it through the existing history / chat endpoints. The customer comes only from the
// session header. Without one there is nothing to list: 401 (guests keep their single local token). Title = the first user
// message cut to TITLE_CHARS (already masked, D41). Keyset pagination on (created_at, id); `cursor` is the last id returned.
// `// ponytail:` ordered by creation, not last activity (no updated_at column); add one if "recently used first" is wanted.

const TITLE_CHARS = 80;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function OPTIONS(req: Request) {
  return preflight(req, { methods: "GET, OPTIONS", headers: "X-AskCart-Customer" });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const found = await storeFor(req, url.searchParams.get("shop"));
  if (found instanceof Response) return found;
  const headers = { ...found.cors, "Cache-Control": "no-store" };
  const storeId = found.store.id;

  const who = customerOf(req, storeId);
  if (!who.ok || !who.customer) return Response.json({ error: "invalid_session" }, { status: 401, headers });
  const customer = who.customer;

  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !UUID.test(cursor)) return Response.json({ error: "invalid_cursor" }, { status: 400, headers });

  // The cursor row must be this customer's, or it would leak another customer's ordering (an unknown one just starts empty).
  const after = cursor
    ? sql`and (c.created_at, c.id) < (select created_at, id from conversations where id = ${cursor} and store_id = ${storeId} and owner_customer_id = ${customer})`
    : sql``;
  const rows = await forStore(storeId, (tx) =>
    tx.execute<{ id: string; created_at: Date; title: string | null }>(sql`
      select c.id, c.created_at,
        (select left(m.content, ${TITLE_CHARS + 1}) from messages m
          where m.store_id = c.store_id and m.conversation_id = c.id and m.role = 'user'
          order by m.created_at asc limit 1) as title
      from conversations c
      where c.store_id = ${storeId} and c.owner_customer_id = ${customer} ${after}
      order by c.created_at desc, c.id desc
      limit ${limit + 1}`),
  );
  const page = [...rows].slice(0, limit);
  return Response.json(
    {
      conversations: page.map((r) => ({
        id: r.id,
        title: r.title === null ? null : r.title.length > TITLE_CHARS ? `${r.title.slice(0, TITLE_CHARS)}…` : r.title,
        createdAt: new Date(r.created_at).toISOString(),
        conversationToken: tokenFor(storeId, r.id),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    },
    { headers },
  );
}
