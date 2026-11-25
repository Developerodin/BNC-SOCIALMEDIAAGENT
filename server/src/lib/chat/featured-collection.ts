// D95: finds the store's "best sellers" or "sale" collection by its title or handle, in the widget's six languages
// (EN, FR, DE, ES, IT, NL). Accents are folded and only whole words match, so "Sale" is not found inside "Wholesale".
// Earlier phrases in a list win over later ones; a tie goes to the shorter title.
// ponytail: a store that names the collection some other way ("Our favourites") is not found; the tool then says so.

export type FeaturedKind = "best_sellers" | "sale";

const PHRASES: Record<FeaturedKind, string[]> = {
  best_sellers: [
    "best sellers", "best seller", "bestsellers", "bestseller", "best selling", "top sellers",
    "meilleures ventes", "meilleure vente", "top ventes", "top vente", "les plus vendus", "plus vendus", "plus vendu", // FR
    "meistverkauft", "meist verkauft", "beliebteste", // DE
    "mas vendidos", "mas vendido", "mejores ventas", // ES
    "piu venduti", "piu venduto", "i piu venduti", // IT
    "meest verkocht", "best verkocht", "meest gekocht", "topverkopers", // NL
  ],
  sale: [
    "sale", "black friday", "cyber monday", "clearance", "deals", "special offers", "offers",
    "soldes", "solde", "promotions", "promotion", "promos", "promo", "offres speciales", "offres", "offre", "destockage", "bons plans", // FR
    "angebote", "sonderangebote", "angebot", "ausverkauf", "rabatt", "schnappchen", // DE
    "rebajas", "ofertas", "oferta", "liquidacion", "promociones", // ES
    "saldi", "offerte", "offerta", "sconti", "promozioni", // IT
    "uitverkoop", "aanbiedingen", "aanbieding", "korting", "acties", "opruiming", // NL
  ],
};

/** Lowercase words without accents ("Meilleures-Ventes" and "meilleures ventes" are the same). */
const words = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const hasPhrase = (text: string[], phrase: string[]) => {
  for (let i = 0; i + phrase.length <= text.length; i++) if (phrase.every((w, j) => text[i + j] === w)) return true;
  return false;
};

/** The collection that is the store's best-sellers or sale collection, or undefined. */
export function featuredCollection<T extends { title: string; handle?: string }>(kind: FeaturedKind, collections: T[]): T | undefined {
  const phrases = PHRASES[kind].map(words);
  let best: { c: T; rank: number; len: number } | undefined;
  for (const c of collections) {
    const title = words(c.title);
    const handle = words(c.handle ?? "");
    const rank = phrases.findIndex((p) => hasPhrase(title, p) || hasPhrase(handle, p));
    if (rank < 0) continue;
    const len = title.join(" ").length;
    if (!best || rank < best.rank || (rank === best.rank && len < best.len)) best = { c, rank, len };
  }
  return best?.c;
}
