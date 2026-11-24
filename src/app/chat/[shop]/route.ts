import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { appOrigin, buildWidgetConfig } from "@/lib/widget-config";
import type { PageContext } from "@/lib/widget-contract";

// GET /chat/<shop>: the store's chat as a full page, for a plain link or for the embed's iframe (docs/embed.md). It runs
// the same widget as the storefront (public/askcart-hosted.js, built from widget/src/hosted.ts) with a config built from
// the stores row instead of the app metafield. Unknown shop, inactive store or `enabled: false` is a 404.
// Framing: src/proxy.ts lets any site frame this path. The chat has no action that harms the visitor (no login, no payment;
// "Delete chat" removes only the visitor's own conversation), so clickjacking can at most trick one click on that.
// Same rule as src/lib/chat/cors.ts for `shop`.
const SHOP = /^[a-z0-9-]+\.myshopify\.com$/;

const NOT_FOUND = { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } };

/** JSON for an inline <script type="application/json">: `<` and the JS line separators can't end the tag or the script. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET(_req: Request, ctx: { params: Promise<{ shop: string }> }) {
  const { shop } = await ctx.params;
  if (!SHOP.test(shop)) return new Response("Unknown store", NOT_FOUND);
  const [store] = await db
    .select({ active: stores.active, name: stores.name, settings: stores.settings, primaryLocale: stores.primaryLocale, currencyCode: stores.currencyCode })
    .from(stores)
    .where(eq(stores.shopDomain, shop));
  if (!store?.active) return new Response("Unknown store", NOT_FOUND);

  const apiBase = appOrigin();
  if (!apiBase) return new Response("Chat is not configured", { status: 503, headers: NOT_FOUND.headers });
  const config = buildWidgetConfig(store, apiBase);
  if (!config.enabled) return new Response("This chat is turned off", NOT_FOUND);

  const page: PageContext = {
    shop,
    locale: store.primaryLocale ?? "en",
    country: null,
    currency: store.currencyCode,
    productId: null,
    cartAddUrl: "", // unused: `hosted` sends Add to cart to the store's product page
    cartUrl: "",
    privacyUrl: null,
    designMode: false,
    hosted: true,
  };
  const html = `<!doctype html>
<html lang="${escapeHtml(page.locale.slice(0, 2))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name)}</title>
<style>html,body{margin:0;height:100%;background:#fff;font-family:system-ui,sans-serif}</style>
</head>
<body>
<script type="application/json" id="askcart-data">${safeJson({ config, page })}</script>
<script src="/askcart-hosted.js" defer></script>
</body>
</html>`;
  // no-store: a settings change (or turning the chat off) shows on the next load.
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
