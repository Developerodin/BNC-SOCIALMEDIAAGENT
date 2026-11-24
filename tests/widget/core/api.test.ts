// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../../widget/src/core/api";
import { jsonResponse } from "./helpers";

const BASE = "https://app.example.com";
const SHOP = "a.myshopify.com";
const TOKEN = "secret-token-123";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const call = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
};

describe("createApi", () => {
  it("refuses a non-https apiBase", () => {
    expect(() => createApi("http://app.example.com", SHOP)).toThrow();
  });

  it("sends a chat turn with the token in the body, no cookies, and pageUrl without the query string", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await createApi(BASE, SHOP).send({
      message: "hi",
      token: TOKEN,
      requestId: "11111111-1111-4111-8111-111111111111",
      productId: "42",
      country: "FR",
      pageUrl: "https://a.example/products/x?utm_source=mail&email=a@b.c#top",
    });
    const { url, init } = call();
    expect(url).toBe(`${BASE}/api/chat`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual({
      shop: SHOP,
      message: "hi",
      conversationToken: TOKEN,
      requestId: "11111111-1111-4111-8111-111111111111",
      productId: "42",
      country: "FR",
      pageUrl: "https://a.example/products/x",
    });
  });

  it("leaves the token and empty fields out of a first message", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await createApi(BASE, SHOP).send({ message: "hi", token: null, requestId: "r", productId: null, country: null, pageUrl: "https://a.example/" });
    expect(JSON.parse(call().init.body as string)).toEqual({ shop: SHOP, message: "hi", requestId: "r", pageUrl: "https://a.example/" });
  });

  it("puts the token in the header for history, delete and rate, never in the URL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { messages: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApi(BASE, SHOP);
    await api.history(TOKEN);
    await api.deleteConversation(TOKEN);
    expect(await api.rate(TOKEN, "m1", 1)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const { url, init, headers } = call(i);
      expect(url).not.toContain(TOKEN);
      expect(headers.get("X-Conversation-Token")).toBe(TOKEN);
      expect(init.credentials).toBe("omit");
    }
    expect(call(0).url).toBe(`${BASE}/api/chat/history?shop=${SHOP}`);
    expect(call(1).init.method).toBe("DELETE");
    expect(call(1).url).toBe(`${BASE}/api/chat/conversation?shop=${SHOP}`);
    expect(call(2).url).toBe(`${BASE}/api/chat/feedback?shop=${SHOP}`);
    expect(JSON.parse(call(2).init.body as string)).toEqual({ messageId: "m1", rating: 1 });
  });

  it("history: normalizes items, tolerates a missing id and rating, and tells a dead token from a failure", async () => {
    const api = createApi(BASE, SHOP);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        messages: [
          { role: "user", content: "hi", status: "ok", cards: [] },
          { id: "m2", role: "assistant", content: "hello", status: "cut_off", cards: null, rating: 1 },
          { role: "system", content: "x" },
        ],
      }),
    );
    expect(await api.history(TOKEN)).toEqual([
      { id: null, role: "user", content: "hi", status: "ok", cards: [], rating: null },
      { id: "m2", role: "assistant", content: "hello", status: "cut_off", cards: [], rating: 1 },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "conversation_not_found" }));
    expect(await api.history(TOKEN)).toBe("reset");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid_token" }));
    expect(await api.history(TOKEN)).toBe("reset");
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    expect(await api.history(TOKEN)).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await api.history(TOKEN)).toBeNull();
  });

  it("delete: 204 and a dead token are done, a running turn (409) is not", async () => {
    const api = createApi(BASE, SHOP);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await api.deleteConversation(TOKEN)).toBe(true);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
    expect(await api.deleteConversation(TOKEN)).toBe(true);
    fetchMock.mockResolvedValueOnce(jsonResponse(409, {}));
    expect(await api.deleteConversation(TOKEN)).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await api.deleteConversation(TOKEN)).toBe(false);
  });

  it("rate: a refused or failed request is false", async () => {
    const api = createApi(BASE, SHOP);
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    expect(await api.rate(TOKEN, "m1", null)).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await api.rate(TOKEN, "m1", -1)).toBe(false);
  });

  it("logs a cart add with keepalive and swallows failures", async () => {
    const api = createApi(BASE, SHOP);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const event = { messageId: null, productId: "gid://shopify/Product/1", variantId: "2", quantity: 1, eventId: "e1" };
    await api.logCartAdd(TOKEN, event);
    const { url, init, headers } = call();
    expect(url).toBe(`${BASE}/api/chat/cart-event?shop=${SHOP}`);
    expect(headers.get("X-Conversation-Token")).toBe(TOKEN);
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(init.body as string)).toEqual(event);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(api.logCartAdd(TOKEN, event)).resolves.toBeUndefined();
  });

  it("faq: returns the items, or nothing on any failure", async () => {
    const api = createApi(BASE, SHOP);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ question: "Q", answer: "A" }, { question: 1 }] }));
    expect(await api.faq("42")).toEqual([{ question: "Q", answer: "A" }]);
    expect(call().url).toBe(`${BASE}/api/faq?shop=${SHOP}&product=42`);
    expect(call().init.credentials).toBe("omit");
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    expect(await api.faq("42")).toEqual([]);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await api.faq("42")).toEqual([]);
  });
});
