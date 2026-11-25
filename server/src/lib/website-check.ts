import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import { parseHost as normalizeHost } from "@/lib/embed-domains";

// "Connect your website" (admin home): tells a merchant how to add the chat to the address they typed. The server fetches
// a URL the merchant chose, so everything here is about not becoming an SSRF proxy into our own network.

export type WebsiteKind = "shopify_store" | "shopify_other_store" | "other";
export type WebsiteCheck = { kind: WebsiteKind; host: string; reachable: boolean };

// One host normaliser for the whole app lives in embed-domains.ts, so this check and the allow-list can't disagree.
export { normalizeHost };

// Addresses a public website never lives on. Mapped (::ffff:), NAT64 and 6to4 v6 forms are blocked whole because they
// can smuggle a private v4 address past a v6 check.
// Two lists: Node checks a v4 address against v6 rules too (as if mapped), so the ::ffff:0:0/96 rule would block all of v4.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked6.addSubnet(net, bits, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? !blocked4.check(ip, "ipv4") : v === 6 ? !blocked6.check(ip, "ipv6") : false;
}

// The per-request timeout below is an IDLE timeout (any byte resets it) and lookup() has none, so a server dripping a
// byte every few seconds could hold us for days. This deadline bounds the whole check, DNS and every hop included.
export const DEADLINE_MS = 9000;
const IDLE_TIMEOUT_MS = 4000;
const MAX_BYTES = 200 * 1024;
const MAX_REDIRECTS = 2;

export type Page = { status: number; headers: Record<string, string | string[] | undefined>; body: string; location: string | null };

/**
 * One vetted GET. We resolve the name ourselves, refuse unless EVERY address is public, then connect to that IP with
 * the hostname kept for TLS (servername) and the Host header. The socket never re-resolves, so DNS rebinding between
 * the check and the connect can't redirect us inward. Never throws: null means unreachable or refused.
 */
export async function fetchPage(host: string, path: string, signal: AbortSignal): Promise<Page | null> {
  let address: string;
  try {
    const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
    aborted.catch(() => {}); // only awaited through the race below
    const all = await Promise.race([lookup(host, { all: true }), aborted]);
    if (!all.length || !all.every((a) => isPublicAddress(a.address))) return null;
    address = all[0].address;
  } catch {
    return null;
  }
  if (signal.aborted) return null;
  return new Promise<Page | null>((resolve) => {
    const onAbort = () => {
      req.destroy();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const req = request(
      {
        host: address, servername: host, method: "GET", path, timeout: IDLE_TIMEOUT_MS, agent: false,
        headers: { Host: host, "User-Agent": "AskCartSiteCheck/1.0", Accept: "text/html" }, // no cookies, no credentials
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), location });
        };
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_BYTES) {
            res.destroy();
            done();
          }
        });
        res.on("end", done);
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * The store a page says it is (`Shopify.shop = "x.myshopify.com"`), or null. Only this names a store. Shopify headers and
 * cdn.shopify.com also appear on headless/Hydrogen sites, Buy Buttons and Shopify-hosted images, so they prove nothing
 * about whose storefront it is and must not decide "another store".
 */
export function pageShop(p: Page): string | null {
  return /Shopify\.shop\s*=\s*["']([^"']+)["']/.exec(p.body)?.[1]?.toLowerCase() ?? null;
}

/**
 * Is this address our store, another Shopify store, or something else? `domains` is the store's own hosts (stores.domains,
 * lowercased), checked first so a Shopify store never costs a network call. Redirects (brand.com -> www.brand.com) are
 * followed up to twice, each hop re-vetted by fetchPage and only to https hosts that pass normalizeHost.
 * The page content is parsed and dropped, never logged.
 */
export async function checkWebsite(host: string, shop: string, domains: string[]): Promise<WebsiteCheck> {
  if (domains.includes(host)) return { kind: "shopify_store", host, reachable: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEADLINE_MS);
  try {
    let current = host;
    let path = "/";
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const page = await fetchPage(current, path, ctl.signal);
      if (!page) return { kind: "other", host, reachable: false };
      if (page.status >= 300 && page.status < 400 && page.location && hop < MAX_REDIRECTS) {
        let next: string | null = null;
        let nextPath = "/";
        try {
          const u = new URL(page.location, `https://${current}${path}`);
          next = u.protocol === "https:" ? normalizeHost(u.origin) : null;
          nextPath = u.pathname + u.search; // the target's own path: many sites redirect / to /en or /home
        } catch {
          // an unparsable Location: judge this page as it is
        }
        if (next) {
          if (domains.includes(next)) return { kind: "shopify_store", host, reachable: true };
          current = next;
          path = nextPath;
          continue;
        }
      }
      const found = pageShop(page);
      if (!found) return { kind: "other", host, reachable: true };
      return { kind: found === shop ? "shopify_store" : "shopify_other_store", host, reachable: true };
    }
    return { kind: "other", host, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shopify's app-embed deep link into the theme editor: <app api key>/<block file name without .liquid>
 * (extensions/askcart/blocks/askcart-embed.liquid). Null when the API key isn't set. Built on the server so the client
 * never sees env; the admin opens it with target _top.
 */
export function themeEditorLink(shop: string): string | null {
  const key = process.env.SHOPIFY_API_KEY;
  return key ? `https://${shop}/admin/themes/current/editor?context=apps&template=index&activateAppId=${key}/askcart-embed` : null;
}
