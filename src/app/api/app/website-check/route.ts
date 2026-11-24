import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { readSmallJson, withStore } from "@/lib/admin-route";
import { rateLimit } from "@/lib/partner/rate-limit";
import { appOrigin } from "@/lib/widget-config";
import { checkWebsite, normalizeHost, themeEditorLink } from "@/lib/website-check";

// The admin's "Connect your website" card: GET pre-fills the address, POST says how to connect the one typed.
// The fetching and its SSRF guards live in src/lib/website-check.ts.

const CHECKS_PER_MINUTE = 10;
const MAX_BODY = 4096;

async function domainsOf(storeId: string): Promise<string[]> {
  const [s] = await db.select({ domains: stores.domains }).from(stores).where(eq(stores.id, storeId));
  return s?.domains ?? [];
}

export function GET(req: Request) {
  return withStore(req, async ({ storeId }) => {
    // domains is [myshopify, primary, ...others]; a store whose primary is its myshopify address has nothing to suggest.
    const domain = (await domainsOf(storeId)).find((d) => !d.endsWith(".myshopify.com")) ?? null;
    return Response.json({ domain });
  });
}

export function POST(req: Request) {
  return withStore(req, async ({ storeId, shop }) => {
    const wait = rateLimit(`website-check:${storeId}`, Date.now(), CHECKS_PER_MINUTE);
    if (wait) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } });

    const body = (await readSmallJson(req, MAX_BODY)) as { url?: unknown } | undefined;
    const host = normalizeHost(body?.url);
    if (!host) return Response.json({ error: "invalid_url" }, { status: 400 });

    const result = await checkWebsite(host, shop, await domainsOf(storeId));
    const origin = appOrigin();
    return Response.json({
      ...result,
      themeLink: result.kind === "shopify_store" ? themeEditorLink(shop) : null,
      embedSnippet: result.kind === "other" && origin ? `<script src="${origin}/embed.js" data-shop="${shop}" defer></script>` : null,
      chatLink: result.kind === "other" && origin ? `${origin}/chat/${shop}` : null,
    });
  });
}
