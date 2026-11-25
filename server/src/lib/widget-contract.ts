// M5 shared contract: types only. The server and the widget (widget/src, bundled by esbuild) both import it, and
// esbuild strips types, so nothing from the server reaches the storefront bundle.

/** The `app.metafields.askcart.widget` value, written by Task 24 and read by the embed's Liquid and the widget. Public. */
export type WidgetConfig = {
  v: 1;
  enabled: boolean;
  apiBase: string; // https origin of our app, e.g. the tunnel in dev
  name: string; // header title, merchant text (UD7)
  accent: string; // #rrggbb
  avatarUrl: string | null; // https://cdn.shopify.com/... only (UD7b)
  launcher: {
    style: "pill" | "icon" | "tab"; // tab: a small logo tab docked to the screen edge
    label: string | null;
    side: "right" | "left";
    offset: number;
    scope: "all" | "product" | "none"; // where the floating button shows: every page, product pages only, or nowhere (the product block still opens the chat)
  }; // UD1, UD2
  welcome: string | null;
  suggested: string[]; // at most 4
  teaser: { enabled: boolean; text: string | null; delaySec: number }; // UD6
  stockThreshold: number; // UD10, the same value the server uses
  retentionDays: 30 | 90 | 365; // UD16 notice (D41)
};

/** Per page view, captured by the embed's Liquid into `data-page`. */
export type PageContext = {
  shop: string; // shop.permanent_domain, the store key
  locale: string;
  country: string | null;
  currency: string | null;
  productId: string | null; // numeric product id as a string, on product pages only
  cartAddUrl: string;
  cartUrl: string;
  privacyUrl: string | null;
  designMode: boolean;
  /** Whether a customer is logged in on the storefront (a boolean from Liquid, never the id). Absent on the hosted page. */
  loggedIn?: boolean;
  /** The store's Shopify brand logo (Liquid image_url, may be protocol-relative); the chat's logo when no avatar is set. */
  logo?: string | null;
  /** Product pages only: the product being viewed, for the "You're viewing" card. Absent elsewhere and on the hosted page. */
  viewing?: { title: string; image: string | null; price: number | null }; // price: minor units (cents) in `currency`, formatted by the widget
  /** Only on the hosted chat page (/chat/<shop>): there is no storefront cart, so a card opens the product on the store. */
  hosted?: boolean;
  /** Hosted page only: the embedding storefront said it can add to the cart (a hint; the card falls back if nobody answers). */
  bridge?: boolean;
  /** Hosted page only: the store's own https origins, the only parents the cart bridge talks to. */
  parentOrigins?: string[];
};

/** GET /api/chat/product-questions: 0 to 3 AI-written questions a shopper might ask about one product. */
export type ProductQuestionsResponse = { questions: string[] };

/** The SSE `product` payload. */
export type Card = import("./chat/turn").Card;

/**
 * The SSE `meta` payload: the first event of every POST /api/chat stream (new, continued or replayed turn), sent before
 * any text, so the widget has the token even when the stream ends without `done` or `error` (an abort, a dropped connection).
 */
export type MetaEvent = { conversationToken: string };

/**
 * The SSE `status` payload: what the assistant is doing right now, for a live status line while the shopper waits. Optional to
 * show; clients ignore steps they don't know. Never sent on a replayed answer.
 */
export type StatusStep = "understanding" | "searching" | "checking" | "policies" | "collection" | "orders" | "writing";
export type StatusEvent = { step: StatusStep };

export type DoneEvent = { conversationToken: string; messageId: string | null }; // messageId added in Task 22

export type HistoryItem = {
  id: string | null; // null when the server sent none (before Task 22); thumbs need an id
  role: "user" | "assistant";
  content: string;
  status: "ok" | "cut_off";
  cards: Card[];
  rating: -1 | 1 | null;
  cartAdds?: { title: string }[]; // adds made from this answer's cards, for the "added to your cart" note
};

/**
 * The shopper's cart as the client read it (storefront widget: cart.js; a mobile app may send its own). Untrusted text:
 * the server validates it strictly (chat route) and drops it whole when it isn't in this shape. Prices are display strings.
 */
export type CartSummary = {
  items: { title: string; variant?: string; quantity: number; price: string }[]; // at most 20 lines
  total: string;
};

/** The client Task 25's `createApi(apiBase, shop)` returns. Every request omits cookies; the token never goes in a URL. */
export type WidgetApi = {
  send(args: {
    message: string;
    token: string | null;
    requestId: string;
    productId: string | null;
    country: string | null;
    currency?: string | null; // the page currency: a product priced in another one gets no price in the model's LIVE line (C26)
    pageUrl: string; // origin + pathname only
    cart?: CartSummary | null; // the shopper's whole current cart, for "what's in my cart" (storefront only; not saved)
    signal?: AbortSignal;
  }): Promise<Response>;
  /** "reset": the token is dead (401/404), drop it. null: any other failure, keep the token. */
  history(token: string): Promise<HistoryItem[] | "reset" | null>;
  /** true when the conversation is gone (204, or a dead token); false on 409 (a turn is running) or a failure. */
  deleteConversation(token: string): Promise<boolean>;
  rate(token: string, messageId: string, rating: -1 | 1 | null): Promise<boolean>;
  logCartAdd(token: string, event: { messageId: string | null; productId: string; variantId: string; quantity: number; eventId: string }): Promise<void>;
  /** Logged-in storefront shoppers only: the token of their latest conversation (e.g. one started in the mobile app), else null. */
  latest(): Promise<string | null>;
  faq(productId: string): Promise<{ question: string; answer: string }[]>;
};

/** What every widget renderer gets. */
export type WidgetCtx = {
  config: WidgetConfig;
  page: PageContext;
  api: WidgetApi;
  t: (key: string, vars?: Record<string, string | number>) => string; // i18n (Task 25)
  announce: (text: string) => void; // aria-live helper
};

// Widget-internal seams so Wave 3 tasks don't touch each other's files:
export type CardsRenderer = (into: HTMLElement, cards: Card[], ctx: WidgetCtx) => void; // Task 31
export type FeedbackRenderer = (into: HTMLElement, messageId: string, rating: -1 | 1 | null, ctx: WidgetCtx) => void; // Task 32
