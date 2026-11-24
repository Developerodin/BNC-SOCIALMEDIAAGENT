import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { forStore, type Conn } from "@/db/client";
import { conversations, messages } from "@/db/schema";
import { searchProducts } from "@/lib/search-provider";
import { fallbackCards, liveCheck, type FallbackCard, type LiveProduct, type LiveVariant, type Stock } from "@/lib/shopify/live-products";
import { answer, ChatUnavailable } from "./answer";
import { applyBudget } from "./budget";
import { HISTORY_MESSAGES } from "./limits";
import { maskPII } from "./mask";
import { buildInput, LARGE_SYSTEM_PROMPT, SYSTEM_PROMPT, type PromptProducts } from "./prompt";
import { rewriteQuery, type ChatTurn } from "./rewrite";
import type { SseEvent } from "./sse";
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
const DEFAULT_STOCK_THRESHOLD = 5; // UD10
const UNAVAILABLE = "Assistant unavailable right now"; // §8, C13
const COUNTRY = /^[A-Z]{2}$/;

// D81: one turn at a time per conversation. openTurn claims the conversation by setting busy_until; runTurn clears it
// before its last event, on every path. A crashed process leaves the claim to expire.
// `// ponytail:` 90 s = the answer's 60 s total budget + the 5 s rewrite + search and the live check, with margin. A turn
// that outlives it can overlap the next one, and its release then frees that one early; raise this with the timeouts.
const TURN_LOCK = sql`now() + interval '90 seconds'`;

/** UD10: the merchant's "Only N left" threshold, settings.stockThreshold, default 5. */
export function stockThreshold(settings: unknown): number {
  const n = (settings as { stockThreshold?: unknown } | null)?.stockThreshold;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : DEFAULT_STOCK_THRESHOLD;
}

/** A numeric id or a Product GID becomes a GID; anything else is ignored. */
function productGid(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;
  return /^gid:\/\/shopify\/Product\/\d+$/.test(raw) ? raw : undefined;
}

export type OpenedTurn =
  | { ok: true; replay?: undefined; conversationId: string; token: string; history: ChatTurn[]; message: string }
  | { ok: true; replay: { id: string; content: string; cards: Card[] }; conversationId: string; token: string }
  | { ok: false; status: 401 | 404 | 409 };

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
  opts: { token?: string; message: string; pageUrl: string | null; requestId?: string },
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
    if (isNew) {
      await tx
        .insert(conversations)
        .values({ id: conversationId, storeId: store.id, tokenHash: tokenHash(token), pageUrl: opts.pageUrl, busyUntil: TURN_LOCK });
    } else {
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
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(earlier ? and(inConversation, lt(messages.createdAt, createdAtOf(earlier.id))) : inConversation)
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    if (earlier) return { ok: true, conversationId, token, history: rows.reverse(), message: earlier.content };
    await tx.insert(messages).values({ storeId: store.id, conversationId, role: "user", content: message, requestId: opts.requestId });
    return { ok: true, conversationId, token, history: rows.reverse(), message };
  });
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
};

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
): Promise<{ ok: true; messages: HistoryMessage[] } | { ok: false; status: 401 | 404 }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  return forStore(storeId, async (tx) => {
    if (!(await conversationExists(tx, storeId, conversationId))) return { ok: false as const, status: 404 as const };
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
    return { ok: true as const, messages: rows.reverse().map((r) => ({ ...r, cards: (r.cards as Card[] | null) ?? [] })) };
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
export async function deleteConversation(storeId: string, token: string): Promise<{ ok: true } | { ok: false; status: 401 | 409 }> {
  const conversationId = verifyToken(storeId, token);
  if (!conversationId) return { ok: false, status: 401 };
  return forStore(storeId, async (tx) => {
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

/** The card's headline price and stock come from its first available variant (or the first variant when sold out). */
function liveCard(p: LiveProduct, threshold: number): Card {
  const lead = p.variants.find((v) => v.available) ?? p.variants[0];
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
    variants: p.variants.map((v) => ({ ...v, stock: capStock(v.stock, threshold) })),
    moreVariants: p.moreVariants,
  };
}

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

/** The live check, or C11 (b) fallback cards when it fails. A store with no known currency never shows a price either. */
async function checkProducts(
  store: TurnStore,
  ids: string[],
  opts: { country?: string; includeGiftCards: boolean; signal: AbortSignal },
): Promise<PromptProducts> {
  if (store.currencyCode) {
    const r = await liveCheck(store.id, store.shopDomain, ids, { ...opts, currency: store.currencyCode });
    if (r.ok) return r;
    console.warn("chat live check failed", { storeId: store.id, reason: r.reason });
  } else {
    console.warn("chat live check skipped", { storeId: store.id, reason: "no_currency" });
  }
  return { ok: false, cards: await fallbackCards(store.id, ids, { includeGiftCards: opts.includeGiftCards }) };
}

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
  country?: string;
  signal: AbortSignal;
  send: (event: SseEvent, data: unknown) => void;
}): Promise<void> {
  const { store, signal } = t;
  const storeId = store.id;
  const threshold = stockThreshold(store.settings);
  const currentProductId = productGid(t.productId);
  const country = t.country && COUNTRY.test(t.country) ? t.country : undefined;
  const name = store.name ?? store.shopDomain;
  let released = false;

  try {
    const rw = await rewriteQuery({
      message: t.message,
      history: t.history,
      storeLocale: store.primaryLocale,
      storeCurrency: store.currencyCode,
      signal,
    });
    // D89: the store's search provider (ours by default, or Shopify's Catalog MCP).
    const found = await searchProducts(store, rw.query, SEARCH_K, { productId: currentProductId, includeGiftCards: rw.includeGiftCards, signal });
    const ids = [...new Set([...found.map((h) => h.productId), ...(currentProductId ? [currentProductId] : [])])];
    const checked = await checkProducts(store, ids, { country, includeGiftCards: rw.includeGiftCards, signal });
    // D87: drop products outside the budget and order by price, by the live price (never the index's).
    const { hits, live, note } = applyBudget({ hits: found, live: checked, budget: rw.budget, sort: rw.sort, currency: store.currencyCode });
    const { input, allowed } = buildInput({ hits, live, currentProductId, history: t.history, message: t.message, threshold, note });

    const cards: Card[] = [];
    const result = await answer({
      system: SYSTEM_PROMPT(name),
      largeSystem: LARGE_SYSTEM_PROMPT(name),
      input,
      allowed,
      storeId,
      signal,
      onText: (delta) => t.send("text", { delta }),
      onProduct: (id) => {
        // `allowed` holds only products in `live`, so the lookup always succeeds.
        const card = live.ok ? liveCard(live.products.get(id)!, threshold) : fallbackCard(live.cards.get(id)!);
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
