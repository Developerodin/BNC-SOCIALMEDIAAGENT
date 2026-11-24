// The sites a merchant allows to embed the chat (docs/embed.md), kept in stores.settings.embedDomains (no migration).
// Off by default: with none listed, /chat/<shop> is a 404 and our own origin gets no CORS access to the store, so no
// stranger's site can spend the merchant's OpenAI budget through real visitors' browsers.

export const MAX_EMBED_DOMAINS = 10;

/** The listed hostnames (lowercase). Anything malformed in the stored JSON is ignored, never thrown. */
export function embedDomains(settings: unknown): string[] {
  const v = (settings as { embedDomains?: unknown } | null)?.embedDomains;
  return Array.isArray(v) ? v.filter((h): h is string => typeof h === "string" && normalizeHost(h) === h) : [];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Names that only resolve on a private network or the visitor's own machine.
const PRIVATE_TLDS = new Set(["localhost", "local", "internal", "lan", "home", "corp", "localdomain", "intranet", "test", "invalid", "example"]);

/**
 * A plain public hostname, lowercased, or null: no scheme, port, path, userinfo, wildcard, IP address, or private-network
 * name. It ends up in a CSP `frame-ancestors https://<host>`, so nothing else may pass.
 */
export function normalizeHost(input: string): string | null {
  const h = input.trim().toLowerCase();
  if (h.length === 0 || h.length > 253) return null;
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*$/.test(tld) || PRIVATE_TLDS.has(tld)) return null; // a numeric last label is an IP address
  return h;
}
