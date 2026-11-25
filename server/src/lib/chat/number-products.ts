import type { ToolContext } from "./tools";

/**
 * Numbers products for this turn's [[product:<n>]] cards. Products already numbered keep their number; the others are
 * live-checked with the turn's check, added to `ctx.live` and `ctx.allowed`, and numbered after the existing ones.
 * Returns id -> number for the products that can be shown (a product dropped by the live check is left out), or null
 * when this call's live check and the turn's disagree (one live, one fallback), so the new products can't join `ctx.live`.
 * Used by search_products and browse_collection, so both number products the same way.
 */
export async function numberProducts(ids: string[], ctx: ToolContext): Promise<Map<string, string> | null> {
  const numberOf = new Map([...ctx.allowed].map(([n, id]) => [id, n]));
  const fresh = [...new Set(ids)].filter((id) => !numberOf.has(id));
  if (fresh.length) {
    const r = await ctx.check(fresh);
    if (r.ok !== ctx.live.ok) return null;
    for (const id of fresh) {
      const got = r.ok ? r.products.get(id) : r.cards.get(id);
      if (!got) continue; // dropped by the live check (unpublished, gift card, gone)
      if (ctx.live.ok && r.ok) ctx.live.products.set(id, r.products.get(id)!);
      else if (!ctx.live.ok && !r.ok) ctx.live.cards.set(id, r.cards.get(id)!);
      const n = String(ctx.allowed.size + 1);
      ctx.allowed.set(n, id);
      numberOf.set(id, n);
    }
  }
  return new Map(ids.filter((id) => numberOf.has(id)).map((id) => [id, numberOf.get(id)!]));
}
