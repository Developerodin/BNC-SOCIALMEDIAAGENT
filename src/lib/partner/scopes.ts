// Plan (f): the single list of partner scopes. Read scopes only; write and customer scopes are reserved names that
// are always refused (D73) until a new Shopify scope, a move to grantable and a fresh consent land together.

export const PARTNER_SCOPES = {
  "read:shop": { grantable: true, endpoint: "shop", shopifyScope: null },
  "read:products": { grantable: true, endpoint: "products", shopifyScope: "read_products" },
  "read:orders": { grantable: true, endpoint: "orders", shopifyScope: "read_orders" },
  "write:products": { grantable: false, endpoint: null, shopifyScope: null },
  "write:orders": { grantable: false, endpoint: null, shopifyScope: null },
  "read:customers": { grantable: false, endpoint: null, shopifyScope: null },
} as const;

/** A scope that can be granted today. Reserved names are not part of this type. */
export type PartnerScope = "read:orders" | "read:products" | "read:shop";

/** Grantable scopes in canonical (sorted) order; granted sets are always returned in this order. */
export const GRANTABLE: readonly PartnerScope[] = ["read:orders", "read:products", "read:shop"];

export const RESERVED_SCOPES = (Object.keys(PARTNER_SCOPES) as (keyof typeof PARTNER_SCOPES)[]).filter(
  (s) => !PARTNER_SCOPES[s].grantable,
);

/** The Shopify access scope the approving staff member must hold for each partner scope (null: none). */
export const SHOPIFY_SCOPE_FOR: Record<PartnerScope, string | null> = {
  "read:orders": PARTNER_SCOPES["read:orders"].shopifyScope,
  "read:products": PARTNER_SCOPES["read:products"].shopifyScope,
  "read:shop": PARTNER_SCOPES["read:shop"].shopifyScope,
};

/** The scope each `GET /api/partner/<endpoint>` route requires. */
export const ENDPOINT_SCOPE = { orders: "read:orders", products: "read:products", shop: "read:shop" } as const satisfies Record<
  string,
  PartnerScope
>;

const isGrantable = (s: string): s is PartnerScope => (GRANTABLE as readonly string[]).includes(s);

/**
 * The `scope` param of `/partner/connect`: space-separated, each name grantable and in the client's `allowed`
 * list. Omitted (null/undefined) means every grantable scope the client is allowed. Any unknown, reserved or
 * not-allowed name, a malformed separator, or an empty result is `{ error: "invalid_scope" }` (refused, never
 * silently narrowed). Returns the granted set deduplicated, in canonical order.
 */
export function parseScopeParam(
  s: string | null | undefined,
  allowed: readonly string[],
): PartnerScope[] | { error: "invalid_scope" } {
  const permitted = new Set(allowed.filter(isGrantable));
  let wanted: PartnerScope[];
  if (s == null) {
    wanted = [...permitted];
  } else {
    wanted = [];
    for (const name of s.split(" ")) {
      if (!isGrantable(name) || !permitted.has(name)) return { error: "invalid_scope" };
      wanted.push(name);
    }
  }
  const granted = GRANTABLE.filter((g) => wanted.includes(g));
  return granted.length > 0 ? granted : { error: "invalid_scope" };
}
