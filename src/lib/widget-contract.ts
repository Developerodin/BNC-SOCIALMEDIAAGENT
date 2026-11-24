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
  launcher: { style: "pill" | "icon"; label: string | null; side: "right" | "left"; offset: number }; // UD1, UD2
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
};

/** The SSE `product` payload. */
export type Card = import("./chat/turn").Card;

export type DoneEvent = { conversationToken: string; messageId: string | null }; // messageId added in Task 22

export type HistoryItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "ok" | "cut_off";
  cards: Card[];
  rating: -1 | 1 | null;
};

/** The client Task 25's `createApi(apiBase, shop)` returns. Every request omits cookies; the token never goes in a URL. */
export type WidgetApi = {
  send(args: {
    message: string;
    token: string | null;
    requestId: string;
    productId: string | null;
    country: string | null;
    pageUrl: string; // origin + pathname only
    signal?: AbortSignal;
  }): Promise<Response>;
  history(token: string): Promise<HistoryItem[] | null>;
  deleteConversation(token: string): Promise<boolean>;
  rate(token: string, messageId: string, rating: -1 | 1 | null): Promise<boolean>;
  logCartAdd(token: string, event: { messageId: string | null; productId: string; variantId: string; quantity: number; eventId: string }): Promise<void>;
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
