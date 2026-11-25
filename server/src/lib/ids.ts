/** A numeric product id or a Product GID becomes a GID; anything else (or nothing) is undefined. */
export function productGid(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
  return /^gid:\/\/shopify\/Product\/\d+$/.test(raw) ? raw : undefined;
}
