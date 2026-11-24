import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { stores } from "@/db/schema";
import { adminGraphql } from "@/lib/shopify/admin";

// `Shop.domains` is deprecated on 2026-10 (no replacement named) but still in the schema.
// ponytail: if Shopify removes it, this whole query fails; drop `domains { host }` and source market domains elsewhere.
const SHOP_INFO = `{ shop { name currencyCode myshopifyDomain primaryDomain { host localization { defaultLocale } } domains { host } } }`;

type ShopInfoData = {
  shop: {
    name: string;
    currencyCode: string;
    myshopifyDomain: string;
    // Docs: localization is null when the domain redirects.
    primaryDomain: { host: string; localization: { defaultLocale: string } | null };
    domains: { host: string }[];
  };
};

export type ShopInfo = { name: string; domains: string[]; primaryLocale: string | null; currencyCode: string };

/**
 * Fetches the shop's name, storefront domains, language (D76) and currency, and saves them. Throws when Shopify fails,
 * leaving the stored values as they were (CORS keeps the last known domains).
 * ponytail: runs only on app load (while name or language is missing) and on each full sync, so a newly added domain
 * can be refused for up to a day, or until the merchant opens the app.
 */
export async function refreshShopInfo(storeId: string, shop: string): Promise<ShopInfo> {
  const { shop: s } = await adminGraphql<ShopInfoData>(storeId, shop, SHOP_INFO);
  const info: ShopInfo = {
    name: s.name,
    domains: [...new Set([s.myshopifyDomain, s.primaryDomain.host, ...s.domains.map((d) => d.host)].map((h) => h.toLowerCase()))],
    primaryLocale: s.primaryDomain.localization?.defaultLocale ?? null,
    currencyCode: s.currencyCode,
  };
  await db.update(stores).set(info).where(eq(stores.id, storeId));
  return info;
}
