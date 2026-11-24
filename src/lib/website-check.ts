import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";

// "Connect your website" (admin home): tells a merchant how to add the chat to the address they typed. The server fetches
// a URL the merchant chose, so everything here is about not becoming an SSRF proxy into our own network.

export type WebsiteKind = "shopify_store" | "shopify_other_store" | "other";
export type WebsiteCheck = { kind: WebsiteKind; host: string; reachable: boolean };

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/**
 * "Brand.com", "https://www.brand.com/path?x" -> "www.brand.com"; null for anything that isn't a plain public hostname.
 * Needs a dot and a letter-first TLD, which rejects localhost, bare names and every IP form (URL() turns 0x7f.1 or 2130706433
 * into dotted numbers, whose last label starts with a digit). Userinfo and explicit ports are refused, not stripped.
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 2048) return null;
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return host.length <= 253 && HOST_RE.test(host) ? host : null;
}

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
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked6.addSubnet(net, bits, "ipv6");

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? !blocked4.check(ip, "ipv4") : v === 6 ? !blocked6.check(ip, "ipv6") : false;
}

const TIMEOUT_MS = 4000;
const MAX_BYTES = 200 * 1024;
const MAX_REDIRECTS = 2;

type Page = { status: number; headers: Record<string, string | string[] | undefined>; body: string; location: string | null };

/**
 * One vetted GET. We resolve the name ourselves, refuse unless EVERY address is public, then connect to that IP with
 * the hostname kept for TLS (servername) and the Host header. The socket never re-resolves, so DNS rebinding between
 * the check and the connect can't redirect us inward. Never throws: null means unreachable or refused.
 */
async function fetchPage(host: string): Promise<Page | null> {
  let address: string;
  try {
    const all = await lookup(host, { all: true });
    if (!all.length || !all.every((a) => isPublicAddress(a.address))) return null;
    address = all[0].address;
  } catch {
    return null;
  }
  return new Promise<Page | null>((resolve) => {
    const req = request(
      {
        host: address, servername: host, method: "GET", path: "/", timeout: TIMEOUT_MS, agent: false,
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

function shopifyShop(p: Page): { shopify: boolean; shop: string | null } {
  const h = p.headers;
  const poweredBy = String(h["powered-by"] ?? "");
  const shop = /Shopify\.shop\s*=\s*["']([^"']+)["']/.exec(p.body)?.[1]?.toLowerCase() ?? null;
  const shopify = !!(h["x-shopid"] || h["x-shopify-stage"] || /shopify/i.test(poweredBy) || p.body.includes("cdn.shopify.com") || shop);
  return { shopify, shop };
}

/**
 * Is this address our store, another Shopify store, or something else? `domains` is the store's own hosts (stores.domains,
 * lowercased), checked first so a Shopify store never costs a network call. Redirects (brand.com -> www.brand.com) are
 * followed up to twice, each hop re-vetted by fetchPage and only to https hosts that pass normalizeHost.
 * The page content is parsed and dropped, never logged.
 */
export async function checkWebsite(host: string, shop: string, domains: string[]): Promise<WebsiteCheck> {
  if (domains.includes(host)) return { kind: "shopify_store", host, reachable: true };
  let current = host;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const page = await fetchPage(current);
    if (!page) return { kind: "other", host, reachable: false };
    if (page.status >= 300 && page.status < 400 && page.location && hop < MAX_REDIRECTS) {
      let next: string | null = null;
      try {
        const u = new URL(page.location, `https://${current}/`);
        next = u.protocol === "https:" ? normalizeHost(u.origin) : null;
      } catch {
        // an unparsable Location: judge this page as it is
      }
      if (next) {
        if (domains.includes(next)) return { kind: "shopify_store", host, reachable: true };
        current = next;
        continue;
      }
    }
    const found = shopifyShop(page);
    if (!found.shopify) return { kind: "other", host, reachable: true };
    // Shopify, and it says which store: that decides. If it doesn't say, our domains list (checked above) didn't have it.
    return { kind: found.shop === shop ? "shopify_store" : "shopify_other_store", host, reachable: true };
  }
  return { kind: "other", host, reachable: false };
}
