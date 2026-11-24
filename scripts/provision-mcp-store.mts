// Creates (or updates) an MCP-only store: a store that has NOT installed AskCart. The chat reads its products from
// Shopify's public UCP endpoints (https://{shop}/api/ucp/mcp) and the merchant pastes our embed tag into their theme.
// Never calls the Admin API, never touches a store that installed the app (mode 'app'): it refuses those.
//
// Usage (from the repo root, with DATABASE_URL and UCP_AGENT_PROFILE_URL set, like scripts/mcp-compare/run.mts):
//   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/provision-mcp-store.mts <x.myshopify.com> \
//     [--name "Store name"] [--domain www.brand.com ...] [--currency EUR] [--locale en] [--query shirt]
// 1. Fetches https://{shop}/ (redirects followed) and prints the final host, whether our embed tag is on the page
//    (<script src="{APP_URL}/embed.js">: a manual check, nothing is verified automatically), the page's locale.
// 2. Asks the store's search_catalog for one product and reads the currency from its price_range (--currency overrides;
//    --query picks the search words, default "a").
// 3. Upserts the stores row: mode 'mcp', a new account (on a new row), name, lowercased domains (myshopify + the host the
//    page landed on + each --domain), settings.embedDomains = those domains (so the hosted chat page is allowed),
//    currency_code, primary_locale. Re-running updates the same row.
// Roll back: set stores.active = false for the row (storeFor then answers 404).
import { eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { stores } from "@/db/schema";
import { SHOP } from "@/lib/chat/cors";
import { MAX_EMBED_DOMAINS, parseHost } from "@/lib/embed-domains";
import { callUcpTool } from "@/lib/shopify/catalog-mcp";
import { moneyOf } from "@/lib/shopify/ucp-live";
import { upsertStore } from "@/lib/stores";
import { appOrigin } from "@/lib/widget-config";
import { fetchPage, pageShop } from "@/lib/website-check";

function arg(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === `--${name}` && process.argv[i + 1] && out.push(process.argv[i + 1]));
  return out;
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const shop = process.argv[2]?.toLowerCase() ?? "";
if (!SHOP.test(shop)) fail("usage: provision-mcp-store.mts <x.myshopify.com> [--name ..] [--domain ..] [--currency ..] [--locale ..] [--query ..]");
const profile = process.env.UCP_AGENT_PROFILE_URL;
if (!profile) fail("UCP_AGENT_PROFILE_URL is not set");

// Never turn an installed store into an mcp one (upsertStore would reactivate it, and an mcp row has no sync).
const [existing] = await db.select({ mode: stores.mode }).from(stores).where(eq(stores.shopDomain, shop));
if (existing?.mode === "app") fail(`${shop} is an installed (mode 'app') store: refusing to touch it`);

// 1. The storefront, by hand: follow up to 3 redirects (myshopify -> the primary domain), every hop through the SSRF-safe fetcher.
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 15_000);
let host = shop;
let path = "/";
let page = await fetchPage(host, path, ctl.signal);
for (let hop = 0; page && page.status >= 300 && page.status < 400 && page.location && hop < 3; hop++) {
  const u = new URL(page.location, `https://${host}${path}`);
  const next = u.protocol === "https:" ? parseHost(u.hostname) : null;
  if (!next) break;
  host = next;
  path = u.pathname + u.search;
  page = await fetchPage(host, path, ctl.signal);
}
clearTimeout(timer);
if (!page) fail(`could not fetch https://${shop}/ (unreachable, refused, or a non-public address)`);
const body = page!.body;
const origin = appOrigin();
console.log(`storefront: https://${host}${path} -> HTTP ${page!.status}`);
console.log(`Shopify.shop on the page: ${pageShop(page!) ?? "(not found)"}${pageShop(page!) === shop ? "" : "  <-- does not match; check by hand"}`);
console.log(`our embed tag on the page: ${origin && body.includes(`${origin}/embed.js`) ? "yes" : "NO (or APP_URL is not set); ask the merchant to paste it"}`);
const locale = arg("locale")[0] ?? /Shopify\.locale\s*=\s*["']([A-Za-z-]+)["']/.exec(body)?.[1] ?? /<html[^>]*\blang=["']([A-Za-z-]+)["']/i.exec(body)?.[1] ?? null;

// 2. Currency: from a real UCP price_range (the store's own presentment currency), unless given.
let currency = arg("currency")[0]?.toUpperCase();
if (!currency) {
  const args = { meta: { "ucp-agent": { profile } }, catalog: { query: arg("query")[0] ?? "a", pagination: { limit: 1 } } };
  const { sc } = await callUcpTool(shop, "search_catalog", args).catch((e) => fail(`search_catalog failed (${e instanceof Error ? e.message : "error"}); pass --currency`));
  const first = (sc?.products as { price_range?: { min?: unknown } }[] | undefined)?.[0];
  currency = moneyOf(first?.price_range?.min)?.currency ?? fail("search_catalog returned no priced product to read the currency from; pass --query or --currency");
}

// 3. The row.
const domains = [...new Set([shop, host, ...arg("domain")].map((d) => parseHost(d)).filter((d): d is string => !!d))].slice(0, MAX_EMBED_DOMAINS);
const { storeId, accountId, created } = await upsertStore(shop);
await db
  .update(stores)
  .set({ mode: "mcp", name: arg("name")[0] ?? shop, domains, primaryLocale: locale, currencyCode: currency, settings: dsql`${stores.settings} || ${JSON.stringify({ embedDomains: domains })}::jsonb`, active: true })
  .where(eq(stores.id, storeId));
console.log(`${created ? "created" : "updated"} store ${storeId} (account ${accountId}): mode mcp, currency ${currency}, locale ${locale ?? "-"}, domains ${domains.join(", ")}`);
await sql.end();
