import { and, desc, eq } from "drizzle-orm";
import { forStore, type Conn } from "@/db/client";
import { conversations, messages } from "@/db/schema";
import { search } from "@/lib/retrieval";
import { fallbackCards, liveCheck, type FallbackCard, type LiveProduct, type LiveVariant, type Stock } from "@/lib/shopify/live-products";
import { answer, ChatUnavailable } from "./answer";
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

/**
 * Verifies or mints the conversation token, masks the message (D41), reads the history (the last 20 messages before this
 * one, oldest first) and saves the user message, in one transaction. A bad or other-store token → 401 (Review Focus 2);
 * a valid token whose conversation is gone (retention, shop/redact) → 404, and the widget starts a new chat.
 */
export async function openTurn(
  store: TurnStore,
  opts: { token?: string; message: string; pageUrl: string | null },
): Promise<{ ok: true; conversationId: string; token: string; history: ChatTurn[]; message: string } | { ok: false; status: 401 | 404 }> {
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

  return forStore(store.id, async (tx) => {
    if (isNew) {
      await tx.insert(conversations).values({ id: conversationId, storeId: store.id, tokenHash: tokenHash(token), pageUrl: opts.pageUrl });
    } else {
      if (!(await conversationExists(tx, store.id, conversationId))) return { ok: false as const, status: 404 as const };
    }
    const rows = await tx
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.storeId, store.id), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    await tx.insert(messages).values({ storeId: store.id, conversationId, role: "user", content: message });
    return { ok: true as const, conversationId, token, history: rows.reverse(), message };
  });
}

async function conversationExists(tx: Conn, storeId: string, conversationId: string): Promise<boolean> {
  const found = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.storeId, storeId), eq(conversations.id, conversationId)));
  return found.length > 0;
}

export type HistoryMessage = { role: "user" | "assistant"; content: string; status: "ok" | "cut_off"; cards: Card[] };

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
      .select({ role: messages.role, content: messages.content, status: messages.status, cards: messages.cards })
      .from(messages)
      .where(and(eq(messages.storeId, storeId), eq(messages.conversationId, conversationId)))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    return { ok: true as const, messages: rows.reverse().map((r) => ({ ...r, cards: (r.cards as Card[] | null) ?? [] })) };
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
 * Runs the turn after openTurn and sends its events: `text`, `product`, then `done`, or `error` on failure. Never throws.
 * `message` and `history` must already be masked (openTurn). `country` is used only when it matches ^[A-Z]{2}$; otherwise
 * the D77 check is skipped (C16 a). When `signal` aborts (the shopper left), the OpenAI request is aborted and what was
 * shown is saved as cut_off (C19); nothing more is sent.
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

  try {
    const rw = await rewriteQuery({ message: t.message, history: t.history, storeLocale: store.primaryLocale, signal });
    const hits = await search(storeId, rw.query, SEARCH_K, { productId: currentProductId, includeGiftCards: rw.includeGiftCards });
    const ids = [...new Set([...hits.map((h) => h.productId), ...(currentProductId ? [currentProductId] : [])])];
    const live = await checkProducts(store, ids, { country, includeGiftCards: rw.includeGiftCards, signal });
    const { input, allowed } = buildInput({ hits, live, currentProductId, history: t.history, message: t.message, threshold });

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
    await forStore(storeId, (tx) =>
      tx.insert(messages).values({
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
      }),
    );
    if (!signal.aborted) t.send("done", { conversationToken: t.token });
  } catch (err) {
    if (signal.aborted) return;
    // ChatUnavailable is already logged by answer(). Never log message text or the token (§7.10).
    if (!(err instanceof ChatUnavailable)) console.error("chat turn failed", { storeId, error: err instanceof Error ? err.name : typeof err });
    t.send("error", { message: UNAVAILABLE, conversationToken: t.token });
  }
}
