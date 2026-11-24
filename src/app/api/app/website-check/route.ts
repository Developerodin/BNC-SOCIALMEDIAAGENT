import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { rateLimit } from "@/lib/partner/rate-limit";
import { authenticateEmbedded } from "@/lib/shopify/session";
import { appOrigin } from "@/lib/widget-config";
import { checkWebsite, normalizeHost } from "@/lib/website-check";

// The admin's "Connect your website" card: GET pre-fills the address, POST says how to connect the one typed.
// The fetching and its SSRF guards live in src/lib/website-check.ts.

const CHECKS_PER_MINUTE = 10;

async function domainsOf(storeId: string): Promise<string[]> {
  const [s] = await db.select({ domains: stores.domains }).from(stores).where(eq(stores.id, storeId));
  return s?.domains ?? [];
}

const MAX_BODY = 4096;

/** The JSON body, reading at most MAX_BODY bytes; null when it's larger, empty or not JSON. */
async function readSmallJson(req: Request): Promise<{ url?: unknown } | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const { storeId } = await authenticateEmbedded(req);
    // domains is [myshopify, primary, ...others]; a store whose primary is its myshopify address has nothing to suggest.
    const domain = (await domainsOf(storeId)).find((d) => !d.endsWith(".myshopify.com")) ?? null;
    return Response.json({ domain });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const { storeId, shop } = await authenticateEmbedded(req);
    const wait = rateLimit(`website-check:${storeId}`, Date.now(), CHECKS_PER_MINUTE);
    if (wait) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } });

    const body = await readSmallJson(req);
    const host = normalizeHost(body?.url);
    if (!host) return Response.json({ error: "invalid_url" }, { status: 400 });

    const result = await checkWebsite(host, shop, await domainsOf(storeId));
    const origin = appOrigin();
    return Response.json({
      ...result,
      // Shopify's app-embed deep link: <app api key>/<block file name without .liquid> (extensions/askcart/blocks/askcart-embed.liquid).
      // Built here so the client never sees env. The page opens it with target _top.
      themeLink:
        result.kind === "shopify_store" && process.env.SHOPIFY_API_KEY
          ? `https://${shop}/admin/themes/current/editor?context=apps&template=index&activateAppId=${process.env.SHOPIFY_API_KEY}/askcart-embed`
          : null,
      embedSnippet: result.kind === "other" && origin ? `<script src="${origin}/embed.js" data-shop="${shop}" defer></script>` : null,
      chatLink: result.kind === "other" && origin ? `${origin}/chat/${shop}` : null,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
