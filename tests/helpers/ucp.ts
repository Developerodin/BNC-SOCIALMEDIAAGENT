// UCP catalog fixtures, schema-derived: built by hand from the search_catalog / lookup_catalog outputSchema in the store's
// tools/list reply, NOT recorded from real calls. Re-record in Phase 0 (needs the public agent profile URL) and diff.

type Money = { amount: number; currency: string };
export const money = (amount: number, currency = "USD"): Money => ({ amount, currency });

export const pgid = (id: number | string) => `gid://shopify/Product/${id}`;
export const vgid = (id: number | string) => `gid://shopify/ProductVariant/${id}`;

export function ucpVariant(id: number | string, o: { price?: Money; list?: Money; available?: boolean; options?: [string, string][]; sellingPlan?: boolean; title?: string } = {}) {
  return {
    id: typeof id === "string" && id.startsWith("gid:") ? id : vgid(id),
    title: o.title ?? "Default Title",
    description: { html: "" },
    price: o.price ?? money(2500),
    ...(o.list ? { list_price: o.list } : {}),
    availability: { available: o.available ?? true },
    options: (o.options ?? []).map(([name, label]) => ({ name, label })),
    ...(o.sellingPlan ? { requires: { selling_plan: true } } : {}),
  };
}

export function ucpProduct(
  id: number | string,
  o: { title?: string; variants?: ReturnType<typeof ucpVariant>[]; image?: string | null; url?: string; gift?: boolean; description?: string } = {},
) {
  const variants = o.variants ?? [ucpVariant(Number(id) * 10 + 1)];
  return {
    id: typeof id === "string" && id.startsWith("gid:") ? id : pgid(id),
    handle: `h${id}`,
    title: o.title ?? `Tee ${id}`,
    description: { html: o.description ?? `<p>Soft <b>cotton</b> tee ${id}</p>` },
    url: o.url ?? `https://shop.example.com/products/h${id}`,
    price_range: { min: variants[0]?.price ?? money(0), max: variants[0]?.price ?? money(0) },
    options: [],
    media: o.image === null ? [] : [{ type: "image", url: o.image ?? `https://cdn.shopify.com/s/files/1/${id}.jpg`, alt_text: "" }],
    variants,
    gift_card: o.gift ?? false,
    tags: [],
  };
}

/** A tools/call JSON-RPC reply carrying `products` as structuredContent. */
export const ucpReply = (...products: unknown[]) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: false, structuredContent: { ucp: { version: "x" }, products } } }), { status: 200 });
