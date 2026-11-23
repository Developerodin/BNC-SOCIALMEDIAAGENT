import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { authenticateEmbedded } from "@/lib/shopify/session";

export async function GET(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    const [s] = await db.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId));
    return Response.json({ shop, name: s.name });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
