import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { withStore } from "@/lib/admin-route";
import { newMobileKey } from "@/lib/chat/mobile-key";

// The admin's "Mobile app key" card (docs/mobile-api.md). GET shows which key is active (prefix and date, never the
// key), POST creates one and returns it once (replacing any old key at once), DELETE revokes it.

export function GET(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const [s] = await db
      .select({ prefix: stores.mobileKeyPrefix, createdAt: stores.mobileKeyCreatedAt })
      .from(stores)
      .where(eq(stores.id, storeId));
    return Response.json(s?.prefix ? s : { prefix: null, createdAt: null });
  });
}

export function POST(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const { key, hash, prefix } = newMobileKey();
    const [s] = await db
      .update(stores)
      .set({ mobileKeyHash: hash, mobileKeyPrefix: prefix, mobileKeyCreatedAt: new Date() })
      .where(eq(stores.id, storeId))
      .returning({ createdAt: stores.mobileKeyCreatedAt });
    // The only response that ever carries the key; no-store so nothing between keeps a copy.
    return Response.json({ key, prefix, createdAt: s.createdAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
  });
}

export function DELETE(req: Request) {
  return withStore(req, async ({ storeId }) => {
    await db
      .update(stores)
      .set({ mobileKeyHash: null, mobileKeyPrefix: null, mobileKeyCreatedAt: null })
      .where(eq(stores.id, storeId));
    return new Response(null, { status: 204 });
  });
}
