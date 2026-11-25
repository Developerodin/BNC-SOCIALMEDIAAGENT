// The widget's client for our storefront routes (Task 25). Every request omits cookies. The conversation token goes in
// the X-Conversation-Token header, or in the JSON body for POST /api/chat, and never in a URL (Review Focus 3).
import type { HistoryItem, WidgetApi } from "../../../src/lib/widget-contract";
import { safeHttpsUrl } from "./format";

/** origin + pathname only: UTM and email parameters stay out (Global Constraints, Privacy). */
export function pageUrlOf(u: string): string {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

function normalize(m: Record<string, unknown>): HistoryItem | null {
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
  return {
    id: typeof m.id === "string" ? m.id : null, // no id before Task 22: shown without thumbs
    role: m.role,
    content: m.content,
    status: m.status === "cut_off" ? "cut_off" : "ok",
    cards: Array.isArray(m.cards) ? m.cards : [],
    rating: m.rating === 1 || m.rating === -1 ? m.rating : null,
  };
}

// The storefront's own App Proxy route (shopify.app.askcart.toml [app_proxy]); only the Shopify theme has it.
const SESSION_URL = "/apps/askcart/session";
const SESSION_SLACK_MS = 30_000; // refresh a little early so a session doesn't lapse mid-request
const SESSION_RETRY_MS = 60_000; // after a failed fetch, don't ask again for a minute

/**
 * `customer`: the shopper is logged in on the Shopify storefront (the embed's page context says so). Only then do we fetch a
 * customer session from the proxy and send it as X-AskCart-Customer; guests make no extra request and send no extra header.
 */
export function createApi(apiBase: string, shop: string, opts: { customer?: boolean } = {}): WidgetApi {
  const href = safeHttpsUrl(apiBase);
  if (!href) throw new Error("AskCart: apiBase must be an https URL");
  const base = new URL(href).origin;
  const q = `?shop=${encodeURIComponent(shop)}`;
  // The session lives in memory only. In-flight fetches are shared, so a burst of requests asks the proxy once.
  let session: { token: string; exp: number } | null = null;
  let pending: Promise<string | null> | null = null;
  let retryAt = 0;
  const sessionToken = (force = false): Promise<string | null> => {
    if (!opts.customer) return Promise.resolve(null);
    if (!force && session && session.exp - SESSION_SLACK_MS > Date.now()) return Promise.resolve(session.token);
    if (!force && Date.now() < retryAt) return Promise.resolve(null);
    pending ??= (async () => {
      try {
        const res = await fetch(SESSION_URL, { credentials: "same-origin" });
        const j = res.ok ? ((await res.json()) as { sessionToken?: unknown; expiresAt?: unknown }) : null;
        if (j && typeof j.sessionToken === "string" && typeof j.expiresAt === "number") {
          session = { token: j.sessionToken, exp: j.expiresAt };
          return session.token;
        }
      } catch {}
      session = null;
      retryAt = Date.now() + SESSION_RETRY_MS;
      return null;
    })().finally(() => (pending = null));
    return pending;
  };
  // `customer: false` for routes that don't take the header (faq).
  const req = (path: string, init: RequestInit & { token?: string; customer?: boolean } = {}): Promise<Response> => {
    const { token, customer = true, ...rest } = init;
    const go = (cs: string | null) => {
      const headers: Record<string, string> = {};
      if (token) headers["X-Conversation-Token"] = token;
      if (cs) headers["X-AskCart-Customer"] = cs;
      if (rest.body) headers["Content-Type"] = "application/json";
      return fetch(base + path, { ...rest, headers, credentials: "omit" });
    };
    if (!customer || !opts.customer) return go(null); // guests: fetch at once, as before
    return (async () => {
      const cs = await sessionToken();
      const res = await go(cs);
      if (!cs || res.status !== 401) return res;
      // An expired or rejected session: get a new one and repeat the request once.
      const err = await res.clone().json().catch(() => null);
      if (err?.error !== "invalid_session") return res;
      const fresh = await sessionToken(true);
      return fresh ? go(fresh) : res;
    })();
  };
  const post = (path: string, token: string, body: unknown, keepalive = false) =>
    req(path + q, { method: "POST", token, body: JSON.stringify(body), keepalive });

  return {
    send({ message, token, requestId, productId, country, currency, pageUrl, cart, signal }) {
      const body: Record<string, unknown> = { shop, message, conversationToken: token, requestId, productId, country, currency, pageUrl: pageUrlOf(pageUrl), cart };
      for (const k in body) if (body[k] == null) delete body[k]; // null fields are left out
      return req("/api/chat", { method: "POST", body: JSON.stringify(body), signal });
    },

    async history(token) {
      try {
        const res = await req("/api/chat/history" + q, { token });
        // invalid_session means the chat is the shopper's own but we couldn't get them a session right now (proxy 429,
        // network, back-off): a transient failure, so keep the token instead of wiping their chat.
        if (res.status === 401 && (await res.clone().json().catch(() => null))?.error === "invalid_session") return null;
        if (res.status === 401 || res.status === 404) return "reset";
        if (!res.ok) return null;
        const { messages } = (await res.json()) as { messages?: unknown };
        if (!Array.isArray(messages)) return null;
        return messages.map(normalize).filter((m): m is HistoryItem => m !== null);
      } catch {
        return null;
      }
    },

    async deleteConversation(token) {
      try {
        const res = await req("/api/chat/conversation" + q, { method: "DELETE", token });
        return res.ok || res.status === 401 || res.status === 404;
      } catch {
        return false;
      }
    },

    async rate(token, messageId, rating) {
      try {
        return (await post("/api/chat/feedback", token, { messageId, rating })).ok;
      } catch {
        return false;
      }
    },

    async logCartAdd(token, event) {
      // Best effort: keepalive so a navigation to the cart right after doesn't drop it.
      try {
        await post("/api/chat/cart-event", token, event, true);
      } catch {}
    },

    async latest() {
      if (!(await sessionToken())) return null; // guests: no request
      try {
        const res = await req("/api/chat/conversations" + q + "&limit=1");
        if (!res.ok) return null;
        const { conversations } = (await res.json()) as { conversations?: { conversationToken?: unknown }[] };
        const t = conversations?.[0]?.conversationToken;
        return typeof t === "string" ? t : null;
      } catch {
        return null;
      }
    },

    async faq(productId) {
      try {
        const res = await req(`/api/faq${q}&product=${encodeURIComponent(productId)}`, { customer: false });
        if (!res.ok) return [];
        const { items } = (await res.json()) as { items?: unknown };
        if (!Array.isArray(items)) return [];
        return items.filter(
          (i): i is { question: string; answer: string } => typeof i?.question === "string" && typeof i?.answer === "string",
        ).map(({ question, answer }) => ({ question, answer }));
      } catch {
        return [];
      }
    },
  };
}
