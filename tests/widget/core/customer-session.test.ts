// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../../widget/src/core/api";
import { jsonResponse } from "./helpers";

const BASE = "https://app.example.com";
const SHOP = "a.myshopify.com";
const fetchMock = vi.fn<typeof fetch>();
const session = (n: number, ttl = 3_600_000) => jsonResponse(200, { sessionToken: `s${n}`, expiresAt: Date.now() + ttl });
const hdr = (i: number) => new Headers((fetchMock.mock.calls[i][1] as RequestInit).headers);
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("customer session (logged-in storefront shopper)", () => {
  it("a guest never asks for a session and sends no customer header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [] }));
    const api = createApi(BASE, SHOP);
    await api.history("t");
    expect(await api.latest()).toBeNull();
    expect(urls()).toEqual([`${BASE}/api/chat/history?shop=${SHOP}`]);
    expect(hdr(0).has("X-AskCart-Customer")).toBe(false);
  });

  it("fetches the session once from the storefront proxy and sends it on chat routes, not on faq", async () => {
    fetchMock.mockImplementation(async (u) => (String(u) === "/apps/askcart/session" ? session(1) : jsonResponse(200, { messages: [], items: [] })));
    const api = createApi(BASE, SHOP, { customer: true });
    await api.history("t");
    await api.rate("t", "m", 1);
    await api.faq("42");
    expect(urls().filter((u) => u.startsWith("/apps/"))).toHaveLength(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("same-origin");
    expect(hdr(1).get("X-AskCart-Customer")).toBe("s1");
    expect(hdr(2).get("X-AskCart-Customer")).toBe("s1");
    expect(hdr(3).has("X-AskCart-Customer")).toBe(false);
  });

  it("refreshes an expired session before the next request", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (u) => (String(u) === "/apps/askcart/session" ? session(++n, n === 1 ? 10_000 : 3_600_000) : jsonResponse(200, { messages: [] })));
    const api = createApi(BASE, SHOP, { customer: true });
    await api.history("t"); // s1 lives 10 s: inside the 30 s slack, so the next call refreshes
    await api.history("t");
    expect(hdr(3).get("X-AskCart-Customer")).toBe("s2");
  });

  it("on 401 invalid_session gets a new session and repeats the request once", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (u, init) => {
      if (String(u) === "/apps/askcart/session") return session(++n);
      return new Headers(init?.headers).get("X-AskCart-Customer") === "s2" ? jsonResponse(200, { messages: [] }) : jsonResponse(401, { error: "invalid_session" });
    });
    expect(await createApi(BASE, SHOP, { customer: true }).history("t")).toEqual([]);
    expect(urls().filter((u) => u.includes("/history"))).toHaveLength(2);
  });

  it("a 401 that is not about the session is left alone (dead conversation token)", async () => {
    fetchMock.mockImplementation(async (u) => (String(u) === "/apps/askcart/session" ? session(1) : jsonResponse(401, { error: "invalid_token" })));
    expect(await createApi(BASE, SHOP, { customer: true }).history("t")).toBe("reset");
    expect(urls().filter((u) => u.includes("/history"))).toHaveLength(1);
  });

  it("a failed session fetch means the request goes out as a guest, and is not retried for a minute", async () => {
    fetchMock.mockImplementation(async (u) => (String(u) === "/apps/askcart/session" ? jsonResponse(401, { error: "not_logged_in" }) : jsonResponse(200, { messages: [] })));
    const api = createApi(BASE, SHOP, { customer: true });
    await api.history("t");
    await api.history("t");
    expect(urls().filter((u) => u.startsWith("/apps/"))).toHaveLength(1);
    expect(hdr(1).has("X-AskCart-Customer")).toBe(false);
  });

  it("latest: returns the newest conversation's token (limit 1), or null", async () => {
    fetchMock.mockImplementation(async (u) =>
      String(u) === "/apps/askcart/session" ? session(1) : jsonResponse(200, { conversations: [{ id: "x", conversationToken: "tok-1" }], nextCursor: null }),
    );
    const api = createApi(BASE, SHOP, { customer: true });
    expect(await api.latest()).toBe("tok-1");
    expect(urls()[1]).toBe(`${BASE}/api/chat/conversations?shop=${SHOP}&limit=1`);
    fetchMock.mockImplementation(async (u) => (String(u) === "/apps/askcart/session" ? session(2) : jsonResponse(200, { conversations: [] })));
    expect(await createApi(BASE, SHOP, { customer: true }).latest()).toBeNull();
  });
});
