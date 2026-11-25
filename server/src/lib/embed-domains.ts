// The sites a merchant allows to embed the chat (docs/embed.md), kept in stores.settings.embedDomains (no migration).
// Off by default: with none listed, /chat/<shop> is a 404 and our own origin gets no CORS access to the store, so no
// stranger's site can spend the merchant's OpenAI budget through real visitors' browsers.

export const MAX_EMBED_DOMAINS = 10;

/** The listed hostnames (lowercase). Anything malformed in the stored JSON is ignored, never thrown. */
export function embedDomains(settings: unknown): string[] {
  const v = (settings as { embedDomains?: unknown } | null)?.embedDomains;
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === "string" && normalizeHost(h) === h) : [];
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
// Names that only resolve on a private network or the visitor's own machine.
const PRIVATE_TLDS = new Set(["localhost", "local", "internal", "lan", "home", "corp", "localdomain", "intranet", "test", "invalid", "example"]);

/**
 * "Brand.com", "https://www.brand.com/path?x" -> "www.brand.com"; null for anything that isn't a plain public hostname.
 * The one host normaliser: the website check and the allow-list both use it. Needs a dot and a letter-first TLD, which
 * rejects localhost, bare names and every IP form (URL() turns 0x7f.1 or 2130706433 into dotted numbers, whose last label
 * starts with a digit), plus private-network names. Userinfo and explicit ports are refused, not stripped.
 */
export function parseHost(input: unknown): string | null {
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
  if (host.length > 253 || !HOST_RE.test(host) || PRIVATE_TLDS.has(host.slice(host.lastIndexOf(".") + 1))) return null;
  return host;
}

/**
 * A bare public hostname, lowercased, or null: parseHost, but the input must BE the host (no scheme, path, port or trailing
 * dot). It ends up in a CSP `frame-ancestors https://<host>`, so nothing else may pass.
 */
export function normalizeHost(input: string): string | null {
  const h = input.trim().toLowerCase();
  return parseHost(h) === h ? h : null;
}
