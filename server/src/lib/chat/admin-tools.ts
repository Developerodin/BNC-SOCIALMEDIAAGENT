import { and, eq } from "drizzle-orm";
import type { FunctionTool } from "openai/resources/responses/responses";
import { forStore } from "@/db/client";
import { products } from "@/db/schema";
import { buildContent } from "@/lib/products";
import { adminGraphql } from "@/lib/shopify/admin";
import { refreshProduct } from "@/lib/sync";
import { numberProducts } from "./number-products";
import { productBlock, sanitizeData } from "./prompt";
import type { ToolContext } from "./tools";

// Tools that read the store live through the Admin API, offered only for installed stores (mode 'app', so an Admin token
// exists; turn.ts leaves them out for MCP-only stores, and tools.ts refuses them when the turn has a catalog):
// - store_overview: catalog-wide facts (how many products, which collections and types) the 8 products per answer can't give.
// - refresh_product: one product re-read from Shopify, written to our table (the sync's own code) and returned in full.
// - browse_collection: a collection's products, 8 per page, live-checked and numbered like search_products' results.
// Like the other tools, when to call each is in its description (see TOOLS_RULE in prompt.ts). Results are plain text for
// tools.ts to wrap in <store_data>; every merchant string in them is sanitized. Nothing here throws out of the tool loop.

const TIMEOUT_MS = 3000; // like liveCheck
const MAX_RESULT_CHARS = 3900; // each result stays under ~4,000 characters
const OVERVIEW_TTL_MS = 10 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
const MAX_DESCRIPTION_CHARS = 2000;
const PAGE_SIZE = 8;
const MAX_PAGE = 5;
const MAX_LISTED = 50; // collections and product types in the overview

const UNAVAILABLE = "Store information is temporarily unavailable. Answer from <store_data> only, or tell the shopper you can't check right now.";

export const ADMIN_TOOL_DEFS: FunctionTool[] = [
  {
    type: "function",
    name: "store_overview",
    description:
      "Get facts about the whole store, live: how many products it sells, its collections (with product counts) and its product types. Call it for questions about the whole store or catalog: how many products there are, what categories or collections it has, what kinds of products it sells.",
    strict: true,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function",
    name: "refresh_product",
    description:
      "Re-read ONE product of <store_data> from the store right now and get its full details: description, options, specifications (dimensions, material, care and other product fields) and collections. Call it when the shopper asks about a specific detail <store_data> doesn't show, such as dimensions, material or care, or says the information looks outdated. Not for price or stock: those are only in the LIVE lines.",
    strict: true,
    parameters: {
      type: "object",
      properties: { product: { type: "string", description: "The product's number from <store_data>, for example '2' for #2." } },
      required: ["product"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "browse_collection",
    description:
      "List the products of one collection or category of the store, 8 per page, so they can be shown as cards. Call it when the shopper wants to see everything in a category or collection, or asks for more products beyond the ones already shown. If the collection name isn't found, it returns the store's collection names so you can ask which one is meant.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", description: "The collection's title as the shopper said it, e.g. 'summer dresses'." },
        page: { type: "integer", description: "Page number, starting at 1. Use 2, 3, ... for 'show me more'. At most 5." },
      },
      required: ["collection", "page"],
      additionalProperties: false,
    },
  },
];
export const ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set(ADMIN_TOOL_DEFS.map((d) => d.name));

/** Runs one Admin tool; always returns text for the model. */
export async function runAdminTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    if (name === "store_overview") return await storeOverview(ctx);
    if (name === "refresh_product") return await refresh(args.product, ctx);
    return await browse(args.collection, args.page, ctx);
  } catch (e) {
    // No shopper text in the log: only the store, the tool and Shopify's/our own error message.
    console.error("chat admin tool failed", { storeId: ctx.store.id, tool: name, error: e instanceof Error ? e.message : String(e) });
    return UNAVAILABLE;
  }
}

/** Rejects after TIMEOUT_MS or when the request is aborted. The underlying call isn't cancelled (adminGraphql takes no signal); its late result is dropped. */
function withTimeout<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {}); // a late rejection after a timeout must not go unhandled
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([p, limit]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

const gql = <T>(ctx: ToolContext, query: string, variables?: Record<string, unknown>) =>
  withTimeout(adminGraphql<T>(ctx.store.id, ctx.store.shopDomain, query, variables), ctx.signal);

// ---------------------------------------------------------------------------------------------------------------------
// store_overview

// Cost (Admin GraphQL, bucket of 1,000 points, restoring 50/s): productsCount ~1, collections(first: 50) with a nested
// productsCount ~100, productTypes(first: 50) ~50; about 150-200 points per call at worst, so one call per store per 10 minutes.
// "published_status:published" is the Online Store; draft and archived products are not counted. Collection.productsCount
// counts every product in the collection, including ones not for sale, so a collection's count can be a little high.
const OVERVIEW = `query StoreOverview {
  productsCount(query: "status:active published_status:published") { count precision }
  collections(first: ${MAX_LISTED}, sortKey: TITLE, query: "published_status:published") {
    pageInfo { hasNextPage }
    nodes { id title productsCount { count } }
  }
  productTypes(first: ${MAX_LISTED}) { pageInfo { hasNextPage } nodes }
}`;

type Overview = {
  total: number;
  atLeast: boolean;
  collections: { id: string; title: string; count: number }[];
  moreCollections: boolean;
  types: string[];
  moreTypes: boolean;
};

// ponytail: per process and per store. With several server instances each keeps its own copy (so up to N calls per 10
// minutes), and a restart empties it. Upgrade path: a short-TTL row in Postgres, or Redis, if the Admin cost shows up.
const overviews = new Map<string, { at: number; value: Overview }>();

/** The store's overview, from the 10-minute cache or the Admin API. Throws when the API fails (runAdminTool turns that into "unavailable"). */
async function overviewOf(ctx: ToolContext): Promise<Overview> {
  const hit = overviews.get(ctx.store.id);
  const now = Date.now();
  if (hit && now - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const d = await gql<{
    productsCount: { count: number; precision: string };
    collections: { pageInfo: { hasNextPage: boolean }; nodes: { id: string; title: string; productsCount: { count: number } }[] };
    productTypes: { pageInfo: { hasNextPage: boolean }; nodes: string[] };
  }>(ctx, OVERVIEW);
  const value: Overview = {
    total: d.productsCount.count,
    atLeast: d.productsCount.precision === "AT_LEAST",
    collections: d.collections.nodes.map((c) => ({ id: c.id, title: c.title, count: c.productsCount.count })),
    moreCollections: d.collections.pageInfo.hasNextPage,
    types: d.productTypes.nodes.filter(Boolean),
    moreTypes: d.productTypes.pageInfo.hasNextPage,
  };
  for (const [k, v] of overviews) if (now - v.at >= OVERVIEW_TTL_MS) overviews.delete(k);
  overviews.set(ctx.store.id, { at: now, value });
  return value;
}

async function storeOverview(ctx: ToolContext): Promise<string> {
  const o = await overviewOf(ctx);
  const lines = [`Products on sale in the store: ${o.atLeast ? "at least " : ""}${o.total}.`];
  lines.push(
    o.collections.length
      ? `Collections (title, number of products): ${o.collections.map((c) => `${c.title.slice(0, 80)} (${c.count})`).join("; ")}${o.moreCollections ? "; and more not listed" : ""}.`
      : "The store has no collections.",
  );
  lines.push(o.types.length ? `Product types: ${o.types.map((t) => t.slice(0, 80)).join(", ")}${o.moreTypes ? ", and more not listed" : ""}.` : "The store sets no product types.");
  return sanitizeData(lines.join("\n")).slice(0, MAX_RESULT_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------------
// refresh_product

// ponytail: per process, like the overview cache; the limit keeps one shopper (or a loop) from hammering Admin for one
// product. With several instances the real limit is N per minute. Upgrade path: a shared store.
const lastRefresh = new Map<string, number>();

const productNumber = (arg: unknown) => (typeof arg === "number" ? String(arg) : typeof arg === "string" ? arg.trim().replace(/^#/, "") : "");

/**
 * Re-reads the product with this number through the sync's own refreshProduct (fetch with metafields and collections,
 * upsert, queue the re-embed), so our copy and its embeddings catch up too. The model never passes a GID, so it can only
 * refresh a product of this turn's <store_data>. Within a minute of the last refresh it gets the stored copy instead.
 * A product that is no longer active and published is reported as gone, never described.
 */
async function refresh(arg: unknown, ctx: ToolContext): Promise<string> {
  const n = productNumber(arg);
  const id = ctx.allowed.get(n);
  if (!id) return "Unknown product number: use a number from <store_data>.";

  const key = `${ctx.store.id}|${id}`;
  const now = Date.now();
  const last = lastRefresh.get(key);
  if (last !== undefined && now - last < REFRESH_COOLDOWN_MS) {
    const [row] = await forStore(ctx.store.id, (tx) =>
      tx.select({ content: products.content }).from(products).where(and(eq(products.storeId, ctx.store.id), eq(products.shopifyId, id))),
    );
    if (!row) return "Product details are unavailable right now. Answer from <store_data> only.";
    const body = `#${n}\n(This product was refreshed less than a minute ago; this is the stored copy.)\n${row.content}`;
    return sanitizeData(body).slice(0, MAX_RESULT_CHARS);
  }
  for (const [k, t] of lastRefresh) if (now - t >= REFRESH_COOLDOWN_MS) lastRefresh.delete(k);
  lastRefresh.set(key, now);

  let p;
  try {
    p = await withTimeout(refreshProduct(ctx.store.id, id), ctx.signal);
  } catch (e) {
    lastRefresh.delete(key); // nothing was refreshed, so a retry is allowed
    throw e;
  }
  if (p === undefined) {
    lastRefresh.delete(key);
    return UNAVAILABLE;
  }
  if (p === null || p.status !== "ACTIVE" || !p.publishedAt || Date.parse(p.publishedAt) > Date.now()) return "This product is no longer available in the store.";

  // buildContent is what the product's embedding is built from: title, description, type, vendor, tags, collections,
  // options and the readable metafields (dimensions, material, ...; price and app-private fields are left out).
  const content = buildContent({ ...p, description: p.description.slice(0, MAX_DESCRIPTION_CHARS) });
  const body = `#${n} (refreshed just now)\n${content}\nPrice and stock are not given here: they come only from the LIVE lines.`;
  // Sanitize first (it only removes text), then cut.
  return sanitizeData(body).slice(0, MAX_RESULT_CHARS);
}

// ---------------------------------------------------------------------------------------------------------------------
// browse_collection

// Cost: collection.products(first: 8 * page + 1) selecting id and status: about 1 point per product plus 2, so up to ~45
// points for page 5. Admin cursors can't jump to a page, so page N reads the first 8N+1 products and slices; the +1 tells
// whether another page exists. Products that aren't ACTIVE are dropped here (before paging), so pages stay full; the
// live check then drops the rest (not published, no https link, not in our table yet), which can leave a page short.
const COLLECTION_PRODUCTS = `query CollectionProducts($id: ID!, $first: Int!) {
  collection(id: $id) { products(first: $first, sortKey: COLLECTION_DEFAULT) { nodes { id status } } }
}`;

/** The collection whose title best matches what the shopper said (case-insensitive), or undefined. Exact, then title contains the words, then the words contain the title, then every word is in the title; the shortest title wins a tie. */
function bestCollection<T extends { title: string }>(said: string, collections: T[]): T | undefined {
  const q = said.toLowerCase().replace(/\s+/g, " ").trim();
  const words = q.split(" ").filter((w) => w.length > 1);
  let best: { c: T; score: number } | undefined;
  for (const c of collections) {
    const t = c.title.toLowerCase().replace(/\s+/g, " ").trim();
    const score = t === q ? 4 : t.includes(q) ? 3 : q.includes(t) ? 2 : words.length && words.every((w) => t.includes(w)) ? 1 : 0;
    if (score && (!best || score > best.score || (score === best.score && c.title.length < best.c.title.length))) best = { c, score };
  }
  return best?.c;
}

// ponytail: matches only among the first MAX_LISTED collections (alphabetical, from the overview's cache). A store with
// more can't browse the later ones; they get the "not found" list. Upgrade path: fall back to collections(query: "title:...").
async function browse(collectionArg: unknown, pageArg: unknown, ctx: ToolContext): Promise<string> {
  const said = typeof collectionArg === "string" ? collectionArg.slice(0, 200) : "";
  if (!said.trim()) return "Invalid arguments: collection is empty.";
  const asked = Math.floor(Number(pageArg));
  const page = Number.isFinite(asked) && asked >= 1 ? asked : 1;
  if (page > MAX_PAGE) {
    return `Only the first ${MAX_PAGE} pages (${MAX_PAGE * PAGE_SIZE} products) can be listed. Tell the shopper to narrow down by describing what they want, or to open the collection on the store.`;
  }

  const o = await overviewOf(ctx);
  const c = bestCollection(said, o.collections);
  if (!c) {
    const titles = o.collections.map((x) => x.title.slice(0, 80)).join("; ");
    return sanitizeData(`No collection matches that name. The store's collections: ${titles || "none"}${o.moreCollections ? "; and more not listed" : ""}. Ask the shopper which one they mean.`).slice(0, MAX_RESULT_CHARS);
  }

  const d = await gql<{ collection: { products: { nodes: { id: string; status: string }[] } } | null }>(ctx, COLLECTION_PRODUCTS, { id: c.id, first: page * PAGE_SIZE + 1 });
  const active = (d.collection?.products.nodes ?? []).filter((p) => p.status === "ACTIVE").map((p) => p.id);
  const hasMore = active.length > page * PAGE_SIZE;
  const ids = active.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const numberOf = await numberProducts(ids, ctx);
  if (!numberOf) return UNAVAILABLE;
  const blocks = ids.filter((id) => numberOf.has(id)).map((id) => productBlock({ n: numberOf.get(id)!, id, texts: [], live: ctx.live, threshold: ctx.threshold }));

  const more = !hasMore ? "this is the last page" : page === MAX_PAGE ? "more products exist but can't be listed here" : `more on page ${page + 1}`;
  const head = sanitizeData(`Collection "${c.title.slice(0, 80)}" (${c.count} products), page ${page}: ${more}.`);
  if (blocks.length === 0) return `${head}\n${page === 1 ? "No products from it can be shown right now." : "No more products to show."}`;

  // Whole products only: a block that doesn't fit is left out, and the model is told how many.
  let out = head;
  let shown = 0;
  for (const b of blocks) {
    if (out.length + b.length + 2 > MAX_RESULT_CHARS) break;
    out += `\n\n${b}`;
    shown++;
  }
  return shown < blocks.length ? `${out}\n\n(${blocks.length - shown} more products on this page are not listed.)` : out;
}
