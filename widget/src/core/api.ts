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

export function createApi(apiBase: string, shop: string): WidgetApi {
  const href = safeHttpsUrl(apiBase);
  if (!href) throw new Error("AskCart: apiBase must be an https URL");
  const base = new URL(href).origin;
  const q = `?shop=${encodeURIComponent(shop)}`;
  const req = (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = {};
    if (token) headers["X-Conversation-Token"] = token;
    if (rest.body) headers["Content-Type"] = "application/json";
    return fetch(base + path, { ...rest, headers, credentials: "omit" });
  };
  const post = (path: string, token: string, body: unknown, keepalive = false) =>
    req(path + q, { method: "POST", token, body: JSON.stringify(body), keepalive });

  return {
    send({ message, token, requestId, productId, country, pageUrl, signal }) {
      const body: Record<string, unknown> = { shop, message, conversationToken: token, requestId, productId, country, pageUrl: pageUrlOf(pageUrl) };
      for (const k in body) if (body[k] == null) delete body[k]; // null fields are left out
      return req("/api/chat", { method: "POST", body: JSON.stringify(body), signal });
    },

    async history(token) {
      try {
        const res = await req("/api/chat/history" + q, { token });
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

    async faq(productId) {
      try {
        const res = await req(`/api/faq${q}&product=${encodeURIComponent(productId)}`);
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
