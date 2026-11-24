import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { embedDomains, MAX_EMBED_DOMAINS, normalizeHost } from "@/lib/embed-domains";
import { readSmallJson, withStore } from "@/lib/admin-route";

// The sites allowed to embed the store's chat (docs/embed.md). GET lists them, POST {host} adds one, DELETE {host}
// removes one. Each answers with the new list. Stored in stores.settings.embedDomains; the row is locked while it is
// read and written so two adds at once can't lose one.

const MAX_BODY = 1024;

/** The `host` field of a small JSON body, normalized; or an error Response (413 is thrown by readSmallJson). */
async function hostOf(req: Request): Promise<string | Response> {
  const host = ((await readSmallJson(req, MAX_BODY)) as { host?: unknown } | undefined)?.host;
  const norm = typeof host === "string" ? normalizeHost(host) : null;
  return norm ?? Response.json({ error: "invalid_host" }, { status: 400 });
}

/** Applies `change` to the list under a row lock; `change` returns an error Response to refuse. */
async function update(storeId: string, change: (list: string[]) => string[] | Response): Promise<Response> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).for("update");
    const next = change(embedDomains(s?.settings));
    if (next instanceof Response) return next;
    const settings = { ...(s.settings as Record<string, unknown>), embedDomains: next };
    await tx.update(stores).set({ settings }).where(eq(stores.id, storeId));
    return Response.json({ domains: next });
  });
}

export function GET(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const [s] = await db.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId));
    return Response.json({ domains: embedDomains(s?.settings) });
  });
}

export function POST(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const host = await hostOf(req);
    if (host instanceof Response) return host;
    return update(storeId, (list) => {
      if (list.includes(host)) return list;
      if (list.length >= MAX_EMBED_DOMAINS) return Response.json({ error: "too_many", max: MAX_EMBED_DOMAINS }, { status: 409 });
      return [...list, host];
    });
  });
}

export function DELETE(req: Request) {
  return withStore(req, async ({ storeId }) => {
    const host = await hostOf(req);
    if (host instanceof Response) return host;
    return update(storeId, (list) => list.filter((h) => h !== host));
  });
}
