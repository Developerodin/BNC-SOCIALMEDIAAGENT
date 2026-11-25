import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { forStore, type Conn } from "@/db/client";
import { cartEvents, conversations, messages, products } from "@/db/schema";
import { productGid } from "@/lib/ids";
import { search, type SearchHit } from "@/lib/retrieval";
import { searchProducts } from "@/lib/search-provider";
import { CATALOG_DEGRADED, catalogLive, newTurnCatalog, type TurnCatalog } from "@/lib/shopify/catalog-turn";
import { MCP_BUDGET_MS } from "@/lib/shopify/ucp-guard";
import { fallbackCards, liveCheck, type FallbackCard, type LiveProduct, type LiveVariant, type Stock } from "@/lib/shopify/live-products";
import { answer, ChatUnavailable } from "./answer";
import { applyBudget } from "./budget";
import { HISTORY_MESSAGES, MCP_DAILY_MESSAGES } from "./limits";
import { maskPII } from "./mask";
import { buildInput, LARGE_SYSTEM_PROMPT, plainText, SYSTEM_PROMPT, sanitizeData, stripProductRefs, type OrderRule, type PromptProducts } from "./prompt";
import { rewriteQuery, type ChatTurn, type Rewrite } from "./rewrite";
import { runTool, toolDefs, type ToolContext } from "./tools";
import type { SseEvent } from "./sse";
import type { CartSummary, StatusStep } from "@/lib/widget-contract";
import { mintToken, tokenHash, verifyToken } from "./token";

// One chat turn (Task 19): openTurn does the DB work before the stream (one forStore), runTurn does
// rewrite → search → liveCheck → answer → save while sending SSE events. No DB transaction is open
// during an OpenAI or Shopify call. `// ponytail:` about 3 short transactions per turn; a pool of 10 is
// fine for the beta (§8b).

export type TurnStore = {
  id: string;
  shopDomain: string;
  name: string | null;
  primaryLocale: string | null;
  currencyCode: string | null;
  settings: unknown;
  /** 'mcp' = no install: products come from Shopify's UCP endpoints, not our tables. Missing means 'app'. */
  mode?: "app" | "mcp";
  /** The store's hosts (stores.domains): an mcp card link must be on one of them. */
  domains?: string[];
};

/** The product event (§7.6). A C11 (b) fallback card has null price, stock, currency and availability, and action "none". */
export type Card = {
  id: string;
  title: string;
  imageUrl: string | null;
  url: string;
  currency: string | null;
  available: boolean | null;
  action: LiveProduct["action"];
  stock: Stock | null;
  price: string | null;
  compareAtPrice: string | null;
  variants: LiveVariant[];
  moreVariants: boolean;
};

const SEARCH_K = 8;
// D87: a budget or "cheapest"/"priciest" question searches wider, so the price filter and sort pick from more than the
// usual 8; only the first PROMPT_PRODUCTS products after them reach the prompt and cards. liveCheck still makes one call:
// its requested cost doesn't grow with the ids (measured on the dev store: 28 points for 0, 9, 17 or 100 ids with
// VARIANT_CAP 50, against Shopify's 1,000 single-query limit).
// `// ponytail:` the actual cost does grow with real products and variants, so a 30-product check on a store with
// many variants spends more of the per-store bucket (2,000 points, 100/s). Upgrade path: a smaller variant cap for
// the price pass, or a per-store live-check cache.
const PRICE_SEARCH_K = 30;
const PROMPT_PRODUCTS = 8;
// The "similar products" icon on a card: at most this many cards, from the SEARCH_K nearest (some may be sold out).
const SIMILAR_PRODUCTS = 3;
const DEFAULT_STOCK_THRESHOLD = 5; // UD10
const UNAVAILABLE = "Assistant unavailable right now"; // §8, C13
const COUNTRY = /^[A-Z]{2}$/;
const DAILY_CAP_MESSAGE = "This assistant has reached its daily limit. Please try again tomorrow.";

/** Shopper messages saved today (UTC) for this store, openTurn's included, against MCP_DAILY_MESSAGES. */
async function mcpOverDailyCap(storeId: string): Promise<boolean> {
  const [r] = await forStore(storeId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.storeId, storeId), eq(messages.role, "user"), sql`${messages.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)),
  );
  return r.n > MCP_DAILY_MESSAGES;
}

// D81: one turn at a time per conversation. openTurn claims the conversation by setting busy_until; runTurn clears it
// before its last event, on every path. A crashed process leaves the claim to expire.
// `// ponytail:` the worst case is the rewrite's 8 s (REWRITE_TIMEOUT_MS) + the catalog budget (MCP_BUDGET_MS, 5 s; an
// installed store's 3 s live check fits inside it) + the answer's 60 s total (TOTAL_MS in answer.ts, tool calls included)
// = 73 s, plus 17 s margin for the saves and SSE. A turn that outlives it can overlap the next one, and its release then
// frees that one early; recompute this whenever one of those timeouts changes.
const TURN_LOCK_S = 8 + MCP_BUDGET_MS / 1000 + 60 + 17;
const TURN_LOCK = sql.raw(`now() + interval '${TURN_LOCK_S} seconds'`);

/**
 * The "similar products" request's product: `raw` must be a product GID (or numeric id) of this store's own table, and
 * published. null otherwise, so a foreign or invented id is refused by the route. An mcp-mode store has no table: the route
 * skips this for it and answers the message as an ordinary one.
 */
export async function similarProduct(storeId: string, raw: string): Promise<{ id: string; title: string } | null> {
  const id = productGid(raw);
  if (!id) return null;
  const [row] = await forStore(storeId, (tx) =>
    tx
      .select({ id: products.shopifyId, title: products.title })
      .from(products)
      .where(and(eq(products.storeId, storeId), eq(products.shopifyId, id), eq(products.published, true))),
  );
  return row ?? null;
}

/**
 * The products already in the shopper's cart, to leave out of a similar-products search. With the browser's live cart
 * (parseCartSummary) its titles are matched to this store's product titles, since the cart summary carries no ids;
 * without one, the products added from this conversation's cards. A hint: a failure leaves nothing excluded.
 * `// ponytail:` two products with the same title are both excluded; a cart title cut at 80 characters is compared cut.
 */
async function inCartProductIds(storeId: string, conversationId: string, cart: CartSummary | null | undefined): Promise<string[]> {
  try {
    return await forStore(storeId, async (tx) => {
      if (cart) {
        const titles = [...new Set(cart.items.map((i) => i.title.trim().toLowerCase()))];
        if (titles.length === 0) return [];
        const rows = await tx
          .select({ id: products.shopifyId })
          .from(products)
          .where(and(eq(products.storeId, storeId), inArray(sql`lower(left(${products.title}, 80))`, titles)));
        return rows.map((r) => r.id);
      }
      const rows = await tx
        .selectDistinct({ id: cartEvents.productId })
        .from(cartEvents)
        .where(and(eq(cartEvents.storeId, storeId), eq(cartEvents.conversationId, conversationId)));
      return rows.map((r) => r.id);
    });
  } catch (e) {
    console.warn("similar: cart lookup failed", { storeId, reason: e instanceof Error ? e.name : "error" });
    return [];
  }
}

/** UD10: the merchant's "Only N left" threshold, settings.stockThreshold, default 5. */
export function stockThreshold(settings: unknown): number {
  const n = (settings as { stockThreshold?: unknown } | null)?.stockThreshold;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_STOCK_THRESHOLD;
}

export type OpenedTurn =
  | { ok: true; replay?: undefined; conversationId: string; token: string; history: ChatTurn[]; message: string; owned: boolean }
  | { ok: true; replay: { id: string; content: string; cards: Card[] }; conversationId: string; token: string }
  | { ok: false; status: 401 | 404 | 409; session?: true };

/**
 * Verifies or mints the conversation token, masks the message (D41), claims the conversation (D81), reads the history (the
 * last 20 messages before this one, oldest first) and saves the user message, in one transaction. A bad or other-store
 * token → 401 (Review Focus 2); a valid token whose conversation is gone (retention, shop/redact) → 404, and the widget
 * starts a new chat; a conversation whose turn is still running → 409.
 *
 * `requestId` (D81) is the client's id for this message. If the conversation already has a user row with it: when the
 * next message after that row is an assistant row, it is returned as `replay` (nothing is claimed or saved); otherwise
 * the earlier attempt failed or is still running, so the turn is claimed (409 if running) and that row is reused.
 * `// ponytail:` "the next message" assumes one turn at a time. If the shopper sent another message after a failed one
 * and then retries the failed one, its new answer lands after the later messages.
 */
export async function openTurn(
  store: TurnStore,
  opts: { token?: string; message: string; pageUrl: string | null; requestId?: string; customer?: string },
): Promise<OpenedTurn> {
  const message = maskPII(opts.message);
  let conversationId: string;
  let token: string;
  if (opts.token === undefined) {
    ({ conversationId, token } = mintToken(store.id));
  } else {
    const id = verifyToken(store.id, opts.token);
    if (!id) return { ok: false, status: 401 };
    conversationId = id;
    token = opts.token;
  }
  const isNew = opts.token === undefined;

  return forStore(store.id, async (tx): Promise<OpenedTurn> => {
    const inConversation = and(eq(messages.storeId, store.id), eq(messages.conversationId, conversationId));
    let earlier: { id: string; content: string } | undefined;
    // Whether the verified customer of this request owns the conversation (order details may only be saved into one that does).
    let owned = isNew && opts.customer !== undefined;
    if (isNew) {
      await tx
        .insert(conversations)
        .values({
          id: conversationId,
          storeId: store.id,
          tokenHash: tokenHash(token),
          pageUrl: opts.pageUrl,
          ownerCustomerId: opts.customer ?? null,
          busyUntil: TURN_LOCK,
        });
    } else {
      const { denied, owner } = await ownerCheck(tx, store.id, conversationId, opts.customer);
      if (denied) return denied;
      owned = owner !== null && owner === opts.customer;
      if (opts.requestId) {
        [earlier] = await tx
          .select({ id: messages.id, content: messages.content })
          .from(messages)
          .where(and(inConversation, eq(messages.role, "user"), eq(messages.requestId, opts.requestId)));
        if (earlier) {
          const [next] = await tx
            .select({ id: messages.id, role: messages.role, content: messages.content, cards: messages.cards })
            .from(messages)
            .where(and(inConversation, gt(messages.createdAt, createdAtOf(earlier.id))))
            .orderBy(asc(messages.createdAt))
            .limit(1);
          if (next?.role === "assistant") {
            return { ok: true, replay: { id: next.id, content: next.content, cards: (next.cards as Card[] | null) ?? [] }, conversationId, token };
          }
        }
      }
      if (!(await claim(tx, store.id, conversationId))) {
        return { ok: false, status: (await conversationExists(tx, store.id, conversationId)) ? 409 : 404 };
      }
    }
    const rows = await tx
      .select({ role: messages.role, content: messages.content, cards: messages.cards })
      .from(messages)
      .where(earlier ? and(inConversation, lt(messages.createdAt, createdAtOf(earlier.id))) : inConversation)
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    const history = rows.reverse().map(historyTurn);
    if (earlier) return { ok: true, conversationId, token, history, message: earlier.content, owned };
    await tx.insert(messages).values({ storeId: store.id, conversationId, role: "user", content: message, requestId: opts.requestId });
    return { ok: true, conversationId, token, history, message, owned };
  });
}

/**
 * A history row as the model and the rewrite see it. The saved text has its [[product:n]] markers stripped, so "the second
 * one" or "that one" would point at nothing: an answer's card titles, in the order shown, are added after its text.
 */
function historyTurn(r: { role: "user" | "assistant"; content: string; cards: unknown }): ChatTurn {
  const titles = r.role === "assistant" && Array.isArray(r.cards) ? (r.cards as Card[]).map((c, i) => `${i + 1}. ${cartTitle(c.title)}`) : [];
  return { role: r.role, content: titles.length ? `${r.content}\n(Product cards shown with this answer, in order: ${titles.join("; ")})` : r.content };
}

/** Why an owned conversation refuses a request: no/expired session (401, the client re-authenticates) or another customer's (404). */
export type OwnerDenied = { ok: false; status: 401 | 404; session?: true };

/**
 * Customer identity: a conversation with an owner needs a valid session for that same customer, whatever the route, so
 * holding its token alone isn't enough. No session → 401 invalid_session; another customer's → 404, the same as a conversation
 * that is gone, so ownership isn't revealed. Unowned (guest) conversations pass for everyone, as before: a session used on one
 * leaves it unowned (by design: no adopting a guest chat that someone else may hold the token of).
 */
export async function ownerDenied(tx: Conn, storeId: string, conversationId: string, customer: string | undefined): Promise<OwnerDenied | null> {
  return (await ownerCheck(tx, storeId, conversationId, customer)).denied;
}

/** ownerDenied's answer plus the conversation's owner (null: unowned or gone), for openTurn's "does this customer own it". */
async function ownerCheck(tx: Conn, storeId: string, conversationId: string, customer: string | undefined): Promise<{ denied: OwnerDenied | null; owner: string | null }> {
  const [c] = await tx
    .select({ owner: conversations.ownerCustomerId })
    .from(conversations)
    .where(and(eq(conversations.storeId, storeId), eq(conversations.id, conversationId)));
  const owner = c?.owner ?? null;
  if (!owner) return { denied: null, owner };
  if (customer === undefined) return { denied: { ok: false, status: 401, session: true }, owner };
  return { denied: owner === customer ? null : { ok: false, status: 404 }, owner };
}

/** A message's created_at, compared in SQL: a JS Date would drop Postgres' microseconds. */
function createdAtOf(messageId: string): SQL {
  return sql`(select m.created_at from messages m where m.id = ${messageId})`;
}

/** D81: claims the conversation unless another turn holds it. The row lock makes a concurrent claim wait, then see it taken. */
async function claim(tx: Conn, storeId: string, conversationId: string): Promise<boolean> {
  const claimed = await tx
    .update(conversations)
    .set({ busyUntil: TURN_LOCK })
    .where(
      and(
        eq(conversations.storeId, storeId),
        eq(conversations.id, conversationId),
        or(isNull(conversations.busyUntil), lt(conversations.busyUntil, sql`now()`)),
      ),
    )
    .returning({ id: conversations.id });
  return claimed.length > 0;
}

function releaseIn(tx: Conn, storeId: string, conversationId: string) {
  return tx
    .update(conversations)
    .set({ busyUntil: null })
    .where(and(eq(conversations.storeId, storeId), eq(conversations.id, conversationId)));
}

/** Never throws: if the release fails, the claim expires on its own (TURN_LOCK). */
async function release(storeId: string, conversationId: string): Promise<void> {
  try {
    await forStore(storeId, (tx) => releaseIn(tx, storeId, conversationId));
  } catch (err) {
    console.error("chat turn release failed", { storeId, error: err instanceof Error ? err.name : typeof err });
  }
}

async function conversationExists(tx: Conn, storeId: string, conversationId: string): Promise<boolean> {
  const found = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.storeId, storeId), eq(conversations.id, conversationId)));
  return found.length > 0;
}

/** Task 22: `id` lets the widget rate an answer (UD14); `rating` is the saved thumbs, null when unrated. */
export type HistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "ok" | "cut_off";
  cards: Card[];
  rating: -1 | 1 | null;
  /** Assistant rows only, when something was added to the cart from this answer's cards (oldest first). */
  cartAdds?: { title: string }[];
};

const MAX_CART_TITLE = 80;
const MAX_CART_ADDED = 10;
const cartTitle = (t: string) => sanitizeData(t).replace(/\s+/g, " ").trim().slice(0, MAX_CART_TITLE);

const MAX_CART_LINES = 20;
const MAX_CART_MONEY = 40;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

// A price or total as a shopper's cart shows it: an optional currency symbol or code, digits with separators, an optional
// symbol or code after ("€19.99", "Rs. 1,299.00", "CHF 1’299.00", "1.299,00 €"). Anything else ("free with code X") is not money.
const MONEY = /^(?=.*\d)[\p{Sc}A-Za-z.]{0,5}[\s ]?[\d.,\s '’]{1,20}[\s ]?[\p{Sc}A-Za-z.]{0,5}$/u;
const isMoney = (v: unknown): v is string => isStr(v, MAX_CART_MONEY) && MONEY.test(v.trim());

/**
 * The request's optional `cart` (widget-contract CartSummary): a hint from the shopper's browser, never an error. The
 * total must be a money amount (else the whole cart is ignored, null). Lines are kept or cut one by one: a line with
 * a non-money price, an empty title or a bad quantity is dropped; a title over 80 characters is clipped, a quantity over
 * 999 is clamped to 999, a bad variant is left off, and only the first 20 lines are kept (the total stays the cart's).
 */
export function parseCartSummary(v: unknown): CartSummary | null {
  if (!v || typeof v !== "object") return null;
  const { items, total } = v as { items?: unknown; total?: unknown };
  if (!Array.isArray(items) || !isMoney(total)) return null;
  const out: CartSummary["items"] = [];
  let skipped = 0;
  for (const i of items.slice(0, 100)) {
    if (out.length >= MAX_CART_LINES) break;
    const { title, variant, quantity, price } = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || !isMoney(price) || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      skipped++;
      continue;
    }
    out.push({
      title: title.slice(0, MAX_CART_TITLE),
      ...(isStr(variant, MAX_CART_TITLE) && variant.trim() ? { variant } : {}),
      quantity: Math.min(quantity, 999),
      price,
    });
  }
  // Counts only, never the cart's text.
  if (skipped) console.warn("cart summary lines skipped", { skipped, kept: out.length });
  return out.length ? { items: out, total } : null;
}

/** The titles of the products added to the cart from this conversation's cards, most recent first, each product once (at most 10). */
async function cartAddedTitles(storeId: string, conversationId: string): Promise<string[]> {
  const at = sql`max(${cartEvents.createdAt})`;
  const rows = await forStore(storeId, (tx) =>
    tx
      .select({ title: products.title })
      .from(cartEvents)
      .innerJoin(products, and(eq(products.storeId, cartEvents.storeId), eq(products.shopifyId, cartEvents.productId)))
      .where(and(eq(cartEvents.storeId, storeId), eq(cartEvents.conversationId, conversationId)))
      .groupBy(products.storeId, products.shopifyId, products.title)
      .orderBy(desc(at))
      .limit(MAX_CART_ADDED),
  );
  return rows.map((r) => cartTitle(r.title)).filter(Boolean);
}

/**
 * GET /api/chat/history (Task 20, UD13): the conversation's last 20 messages, oldest first, already masked (D41).
 * Same token rules as openTurn: a bad or other-store token → 401, a conversation that is gone → 404.
 * C15 (b): the cards are the snapshot saved with the answer, exactly as the shopper saw them; user rows have none ([]).
 * `// ponytail:` no live re-check, so a reopened card can show a stale price or stock until the shopper asks again
 * (the cart still charges Shopify's real price at checkout). C15 (a) would run liveCheck here.
 */
export async function readHistory(
  storeId: string,
  token: string,
  customer?: string,
): Promise<{ ok: true; messages: HistoryMessage[] } | { ok: false; status: 401 | 404; session?: true }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  return forStore(storeId, async (tx) => {
    if (!(await conversationExists(tx, storeId, conversationId))) return { ok: false as const, status: 404 as const };
    const denied = await ownerDenied(tx, storeId, conversationId, customer);
    if (denied) return denied;
    const rows = await tx
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        status: messages.status,
        cards: messages.cards,
        rating: messages.rating,
      })
      .from(messages)
      .where(and(eq(messages.storeId, storeId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    const adds = await tx
      .select({ messageId: cartEvents.messageId, title: products.title })
      .from(cartEvents)
      .innerJoin(products, and(eq(products.storeId, cartEvents.storeId), eq(products.shopifyId, cartEvents.productId)))
      .where(and(eq(cartEvents.storeId, storeId), eq(cartEvents.conversationId, conversationId), inArray(cartEvents.messageId, rows.map((r) => r.id))))
      .orderBy(asc(cartEvents.createdAt));
    const addsOf = (id: string) => adds.filter((a) => a.messageId === id).map((a) => ({ title: cartTitle(a.title) }));
    return {
      ok: true as const,
      messages: rows.reverse().map((r) => {
        const cartAdds = r.role === "assistant" ? addsOf(r.id) : [];
        return { ...r, cards: (r.cards as Card[] | null) ?? [], ...(cartAdds.length ? { cartAdds } : {}) };
      }),
    };
  });
}

/**
 * DELETE /api/chat/conversation (D84, "Clear chat"): deletes the conversation; its messages go with it through the composite
 * FK's cascade. Same token rules as readHistory: a bad or other-store token → 401. A conversation already gone → ok
 * (idempotent). A conversation whose turn is running (busy_until in the future, D81) → 409 and nothing is deleted, so a
 * streaming turn never saves its answer into a deleted conversation. The delete and a concurrent claim lock the same row,
 * so one waits for the other and then sees its result: either the delete skips the now-busy row (409), or the claim finds
 * no row and openTurn answers 404.
 */
export async function deleteConversation(
  storeId: string,
  token: string,
  customer?: string,
): Promise<{ ok: true } | { ok: false; status: 401 | 404 | 409; session?: true }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  return forStore(storeId, async (tx) => {
    const denied = await ownerDenied(tx, storeId, conversationId, customer);
    if (denied) return denied;
    const deleted = await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.storeId, storeId),
          eq(conversations.id, conversationId),
          or(isNull(conversations.busyUntil), lt(conversations.busyUntil, sql`now()`)),
        ),
      )
      .returning({ id: conversations.id });
    if (deleted.length > 0 || !(await conversationExists(tx, storeId, conversationId))) return { ok: true as const };
    return { ok: false as const, status: 409 as const };
  });
}

/** C14 / UD10: a count is shown only below the threshold, so the card and the model's LIVE line agree. */
function capStock(s: Stock, threshold: number): Stock {
  return s.kind === "count" && s.n >= threshold ? { kind: "in_stock" } : s;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The available variant the conversation is about: every option value of exactly one variant appears in `hint` (the shopper's
 * message and the answer so far), as whole words. null when none or several fit, or the product has one variant.
 */
/** Sizes written 160x200, 160 x 200 cm or 160×200 cm are the same words for matching. */
const normalized = (s: string) => s.toLowerCase().replace(/(\d)\s*[x×*]\s*(?=\d)/g, "$1x").replace(/\s*\bcm\b/g, "");

function discussedVariant(p: LiveProduct, hint: string): LiveVariant | null {
  if (p.variants.length < 2 || !hint) return null;
  const text = normalized(hint);
  const named = (v: LiveVariant) =>
    v.options.length > 0 &&
    v.options.every((o) => {
      const value = normalized(o.value.trim());
      return value.length > 1 && o.value !== "Default Title" && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, "u").test(text);
    });
  const hit = p.variants.filter((v) => v.available && named(v));
  return hit.length === 1 ? hit[0] : null;
}

/**
 * The card's headline price and stock come from its first available variant (or the first variant when sold out), and the
 * widget starts its pickers on that variant. When the conversation is about one variant (`hint`), that variant leads instead,
 * so the price shown is the one discussed.
 * `// ponytail:` this moves the variant to the front of the card's variants, so the picker lists its option values in a new
 * order; a "from X" label or a lead-variant field in the card needs the widget to know about it.
 */
function liveCard(p: LiveProduct, threshold: number, hint = ""): Card {
  const pick = discussedVariant(p, hint);
  const variants = pick ? [pick, ...p.variants.filter((v) => v !== pick)] : p.variants;
  const lead = variants.find((v) => v.available) ?? variants[0];
  return {
    id: p.id,
    title: p.title,
    imageUrl: p.imageUrl,
    url: p.url,
    currency: p.currency,
    available: p.available,
    action: p.action,
    stock: lead ? capStock(lead.stock, threshold) : { kind: "sold_out" },
    price: lead?.price ?? null,
    compareAtPrice: lead?.compareAtPrice ?? null,
    variants: variants.map((v) => ({ ...v, stock: capStock(v.stock, threshold) })),
    moreVariants: p.moreVariants,
  };
}

/** More than 3 product cards only when the shopper asked for more: a number from 4 to 12 (not a size, price or head count), or "all"/"more". */
const MAX_CARDS = 3;
const WANTS_MORE =
  /(?<![\d.,x×*])\b(?:[4-9]|1[0-2])\b(?!\s*(?:[x×*,.]\d|[x×*]|€|\$|£|cm|mm|m\b|kg|%|eur|euros?|dollars?|pers|people|persons|personnes|places|seats|ans|years|h\b))|\b(?:all|every|everything|more|tous|toutes|tout|plus|alle|mehr|todos|todas|tutti)\b/i;

function fallbackCard(c: FallbackCard): Card {
  return {
    ...c,
    currency: null,
    available: null,
    action: "none",
    stock: null,
    price: null,
    compareAtPrice: null,
    variants: [],
    moreVariants: false,
  };
}

/** The hits of the first `n` products (in hit order) still in `live`, so a wide price search sends the prompt ~8. */
function topProducts(hits: SearchHit[], live: PromptProducts, n: number): SearchHit[] {
  const known = live.ok ? live.products : live.cards;
  const keep = new Set<string>();
  for (const h of hits) {
    if (keep.size >= n) break;
    if (known.has(h.productId)) keep.add(h.productId);
  }
  return hits.filter((h) => keep.has(h.productId));
}

/** The live check, or C11 (b) fallback cards when it fails. A store with no known currency never shows a price either. */
async function checkProducts(
  store: TurnStore,
  ids: string[],
  opts: { country?: string; includeGiftCards: boolean; signal: AbortSignal; catalog?: TurnCatalog; variantCap?: number },
): Promise<PromptProducts> {
  // An mcp store has no table to fall back on, so this comes BEFORE the currency gate (an mcp row's prices are Shopify's
  // own, in the currency the payload names) and never returns fallback cards. Products Shopify couldn't give are absent.
  if (opts.catalog) return { ok: true, products: await catalogLive(opts.catalog, ids, opts) };
  if (store.currencyCode) {
    const r = await liveCheck(store.id, store.shopDomain, ids, { ...opts, currency: store.currencyCode });
    if (r.ok) return r;
    console.warn("chat live check failed", { storeId: store.id, reason: r.reason });
  } else {
    console.warn("chat live check skipped", { storeId: store.id, reason: "no_currency" });
  }
  return { ok: false, cards: await fallbackCards(store.id, ids, { includeGiftCards: opts.includeGiftCards }) };
}

// The status line's step for each tool the model can call (an unknown tool reads as searching).
const TOOL_STEP: Record<string, StatusStep> = {
  store_policies: "policies",
  browse_collection: "collection",
  order_status: "orders",
  search_products: "searching",
  store_overview: "searching",
  product_details: "checking",
  refresh_product: "checking",
};

/**
 * Runs the turn after openTurn and sends its events: `text`, `product`, then `done` ({ conversationToken, messageId }, the
 * saved assistant row's id), or `error` on failure. Never throws.
 * `message` and `history` must already be masked (openTurn). `country` is used only when it matches ^[A-Z]{2}$; otherwise
 * the D77 check is skipped (C16 a). When `signal` aborts (the shopper left), the OpenAI request is aborted and what was
 * shown is saved as cut_off (C19); nothing more is sent. On every path the conversation is released (D81) before the last
 * event, so the shopper's next message isn't refused.
 */
export async function runTurn(t: {
  store: TurnStore;
  conversationId: string;
  token: string;
  history: ChatTurn[];
  message: string;
  productId?: string;
  /** The "similar products" icon: a product of this store (route.ts similarProduct). The search is seeded by its embedding instead of the rewritten message, and the rewrite call is skipped. */
  similar?: { id: string; title: string };
  country?: string;
  /** The shopper's page currency (ISO 4217) when the widget sent one; a product priced in another currency gets no price in its LIVE line (C26). */
  currency?: string;
  /** The shopper's whole current cart from their browser or app (route.ts parseCartSummary). A prompt line only: never saved. */
  cart?: CartSummary | null;
  /** The verified customer GID of the signed session (route.ts customerOf); absent for a guest. */
  customer?: string;
  /** From openTurn: the verified customer owns this conversation. Order details are only offered and saved then. */
  owned?: boolean;
  signal: AbortSignal;
  send: (event: SseEvent, data: unknown) => void;
  /** Optional live status (SSE `status`); never the same step twice in a row. */
  onStatus?: (step: StatusStep) => void;
}): Promise<void> {
  const { store, signal } = t;
  const storeId = store.id;
  const threshold = stockThreshold(store.settings);
  // A similar-products turn is about the card's product, not the page's: the viewing product would show its own card first.
  const currentProductId = t.similar ? undefined : productGid(t.productId);
  const country = t.country && COUNTRY.test(t.country) ? t.country : undefined;
  const name = store.name ?? store.shopDomain;
  let released = false;
  let lastStep: StatusStep | undefined;
  const status = (step: StatusStep) => {
    if (step === lastStep) return;
    lastStep = step;
    t.onStatus?.(step);
  };
  // Per-turn payload map for an mcp store (catalog-turn.ts); undefined for installed stores, whose path is unchanged.
  const catalog = store.mode === "mcp" ? newTurnCatalog(store, country) : undefined;

  try {
    // Hard daily cap for mcp stores: openTurn has already saved this message, so over the cap means the count exceeds it.
    if (catalog && (await mcpOverDailyCap(storeId))) {
      await release(storeId, t.conversationId);
      released = true;
      // `code` lets the widget show its translated "resting until tomorrow" line instead of the generic one.
      t.send("error", { message: DAILY_CAP_MESSAGE, code: "daily_cap", conversationToken: t.token });
      return;
    }
    status("understanding");
    // A shopper can type "[[product:2]]" or "product:2" themselves, which would steer which product a card shows.
    const message = stripProductRefs(t.message);
    const history = t.history.map((h) => (h.role === "user" ? { ...h, content: stripProductRefs(h.content) } : h));
    const rw: Rewrite = t.similar
      ? { query: "", includeGiftCards: false, budget: null, sort: null, tokens: { input: 0, output: 0 } }
      : await rewriteQuery({
          message,
          history,
          storeLocale: store.primaryLocale,
          storeCurrency: store.currencyCode,
          signal,
        });
    // D89: the store's search provider (ours by default, or Shopify's Catalog MCP).
    const wide = !!rw.budget || !!rw.sort;
    status("searching");
    // An empty query means the message needs no product search (thanks, a store question): nothing is searched.
    const found = t.similar
      ? await search(storeId, "", SEARCH_K, {
          similarTo: t.similar.id,
          exclude: await inCartProductIds(storeId, t.conversationId, t.cart),
          includeGiftCards: false,
          signal,
        })
      : rw.query.trim()
      ? await searchProducts(store, rw.query, wide ? PRICE_SEARCH_K : SEARCH_K, {
          productId: currentProductId,
          includeGiftCards: rw.includeGiftCards,
          signal,
          catalog,
        })
      : [];
    const ids = [...new Set([...found.map((h) => h.productId), ...(currentProductId ? [currentProductId] : [])])];
    status("checking");
    const checked = await checkProducts(store, ids, { country, includeGiftCards: rw.includeGiftCards, signal, catalog });
    // D87: drop products outside the budget and order by price, by the live price (never the index's).
    // A Catalog MCP search scores by rank (1 - i/30), so "within 0.06 of the top" would be two products there.
    const priced = applyBudget({ hits: found, live: checked, budget: rw.budget, sort: rw.sort, currency: store.currencyCode, shopperCurrency: t.currency, ...(catalog ? { margin: 0.2 } : {}) });
    const { live } = priced;
    // Shopify gave no answer at all: say so, so the model never turns an outage into "we don't carry that".
    const noSearch = t.similar || rw.query.trim() ? undefined : "No product search was run for this message: it does not need one.";
    const baseNote = [catalog?.degraded ? CATALOG_DEGRADED : undefined, noSearch, priced.note].filter(Boolean).join(" ") || undefined;
    // Similar products: sold-out ones are skipped (the live check is what says so), then the nearest three.
    const hits = t.similar
      ? topProducts(priced.hits.filter((h) => !live.ok || live.products.get(h.productId)?.available !== false), live, SIMILAR_PRODUCTS)
      : wide
        ? topProducts(priced.hits, live, PROMPT_PRODUCTS)
        : priced.hits;
    // The title is merchant text: buildInput sanitizes the note.
    const note = t.similar
      ? [
          hits.length
            ? `The shopper asked for products similar to "${t.similar.title}". The products below are the nearest matches; that product and anything already in their cart are left out. Recommend them with their cards.`
            : `The shopper asked for products similar to "${t.similar.title}". No other available product is close to it.`,
          baseNote,
        ]
          .filter(Boolean)
          .join(" ")
      : baseNote;
    const cartAdded = catalog
      ? []
      : await cartAddedTitles(storeId, t.conversationId).catch((e) => {
          // A hint: never fails the turn. The store and the error kind only.
          console.warn("cart added titles failed", { storeId, reason: (e as { code?: string } | null)?.code ?? (e instanceof Error ? e.name : "error") });
          return [];
        });
    const { input, allowed } = buildInput({ hits, live, currentProductId, history, message, threshold, shopperCurrency: t.currency, note, cartAdded, cart: t.cart });

    const cards: Card[] = [];
    let shown = ""; // the answer text so far: which variant is being discussed
    // The MCP tools (tools.ts) add the products they find to `live` and `allowed`, so onProduct below finds them too.
    const toolCtx: ToolContext = {
      store,
      live,
      allowed,
      threshold,
      shopperCurrency: t.currency,
      includeGiftCards: rw.includeGiftCards,
      signal,
      check: (ids, o) => checkProducts(store, ids, { country, includeGiftCards: rw.includeGiftCards, signal, catalog, ...o }),
      catalog,
      customer: t.customer,
      budget: wide ? { budget: rw.budget, sort: rw.sort, currency: store.currencyCode } : undefined,
    };
    // The Admin tools (admin-tools.ts) and order lookups need an installed store's token, so an mcp store gets neither.
    const admin = store.mode !== "mcp";
    // order_status only in a conversation the verified customer owns: its answer is saved in the chat, and an unowned
    // (guest-started) chat can be opened by anyone holding its token. Otherwise the prompt says what to do instead.
    const orders = admin && !!t.customer && !!t.owned;
    const orderRule: OrderRule | undefined = !admin || orders ? undefined : t.customer ? "new_chat" : "sign_in";
    const defs = toolDefs({ admin, orders });
    const result = await answer({
      system: SYSTEM_PROMPT(name, orderRule),
      largeSystem: LARGE_SYSTEM_PROMPT(name, orderRule),
      input,
      // A budget or price-order question keeps search_products: its results get the same budget and price order (the tool
      // context carries them, tools.ts), and a question about several product types needs more than one search.
      tools: { defs, run: (toolName, args) => (status(TOOL_STEP[toolName] ?? "searching"), runTool(toolName, args, toolCtx)) },
      allowed,
      storeId,
      signal,
      titleOf: (id) => (live.ok ? live.products.get(id)?.title : live.cards.get(id)?.title),
      onText: (delta) => {
        shown += delta;
        status("writing");
        t.send("text", { delta });
      },
      onProduct: (id) => {
        // At most 3 cards unless the shopper asked for more; the text still names the others.
        if (cards.length >= MAX_CARDS && !WANTS_MORE.test(message)) return;
        // `allowed` holds only products in `live`, so the lookup always succeeds.
        const card = live.ok ? liveCard(live.products.get(id)!, threshold, `${message}\n${shown}`) : fallbackCard(live.cards.get(id)!);
        cards.push(card);
        t.send("product", card);
      },
    });

    if (signal.aborted) console.info("chat answer aborted: client left", { storeId });
    // C19: a cut-off answer is saved as shown; if nothing was shown there is nothing to save.
    if (result.status === "cut_off" && !result.text && cards.length === 0) return;
    const messageId = await forStore(storeId, async (tx) => {
      const [saved] = await tx
        .insert(messages)
        .values({
          storeId,
          conversationId: t.conversationId,
          role: "assistant",
          content: result.text,
          productIds: cards.map((c) => c.id),
          cards,
          model: result.model,
          status: result.status,
          inputTokens: rw.tokens.input + result.tokens.input,
          outputTokens: rw.tokens.output + result.tokens.output,
        })
        .returning({ id: messages.id });
      await releaseIn(tx, storeId, t.conversationId);
      return saved.id;
    });
    released = true;
    // Task 22: the saved answer's id, so the widget can show thumbs under it (UD14).
    if (!signal.aborted) t.send("done", { conversationToken: t.token, messageId });
  } catch (err) {
    if (signal.aborted) return;
    // ChatUnavailable is already logged by answer(). Never log message text or the token (§7.10).
    if (!(err instanceof ChatUnavailable)) console.error("chat turn failed", { storeId, error: err instanceof Error ? err.name : typeof err });
    await release(storeId, t.conversationId);
    released = true;
    t.send("error", { message: UNAVAILABLE, conversationToken: t.token });
  } finally {
    if (!released) await release(storeId, t.conversationId);
  }
}
