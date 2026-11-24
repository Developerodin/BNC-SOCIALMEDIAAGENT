// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../../widget/src/core/api";
import { runSend, type TurnEvent } from "../../../widget/src/core/turn";
import { ev, jsonResponse, sseResponse } from "./helpers";

const SHOP = "a.myshopify.com";
const REQ = "11111111-1111-4111-8111-111111111111";
const CARD = { id: "gid://shopify/Product/1", title: "Mug" };
const fetchMock = vi.fn<typeof fetch>();
let events: TurnEvent[];
let waited: number[];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  events = [];
  waited = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

function run(token: string | null = "tok", signal?: AbortSignal) {
  return runSend(
    createApi("https://app.example.com", SHOP),
    { message: "hi", token, requestId: REQ, productId: null, country: null, pageUrl: "https://a.example/", signal },
    (e) => events.push(e),
    async (ms) => {
      waited.push(ms);
    },
  );
}

describe("runSend", () => {
  it("streams text and cards, then returns the token and message id", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([ev("text", { delta: "Hel" }), ": ping\n\n", ev("text", { delta: "lo" }), ev("product", CARD), ev("done", { conversationToken: "tok2", messageId: "m1" })]),
    );
    expect(await run()).toEqual({ kind: "done", token: "tok2", messageId: "m1" });
    expect(events).toEqual([{ kind: "text", delta: "Hel" }, { kind: "text", delta: "lo" }, { kind: "card", card: CARD }]);
  });

  it("a done without a message id (before Task 22, or a replay) gives a null id", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([ev("text", { delta: "a" }), ev("done", { conversationToken: "tok2" })]));
    expect(await run()).toEqual({ kind: "done", token: "tok2", messageId: null });
  });

  it("Review Focus 5: a stream cut before done is retried once with the same requestId, replacing the partial bubble", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse([ev("text", { delta: "Partial" })], { error: true }))
      .mockResolvedValueOnce(sseResponse([ev("text", { delta: "Full answer" }), ev("done", { conversationToken: "tok", messageId: "m1" })]));
    expect(await run()).toEqual({ kind: "done", token: "tok", messageId: "m1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies().map((b) => b.requestId)).toEqual([REQ, REQ]);
    expect(waited).toEqual([1000]);
    expect(events).toEqual([{ kind: "text", delta: "Partial" }, { kind: "replace" }, { kind: "text", delta: "Full answer" }]);
  });

  it("a stream that closes cleanly without done is retried too, and only once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(sseResponse([ev("text", { delta: "a" })])).mockResolvedValueOnce(sseResponse([ev("text", { delta: "b" })]));
    expect(await run()).toEqual({ kind: "unavailable", token: "tok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a network error is retried once, then reported as offline when the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await run()).toEqual({ kind: "offline" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a fetch TypeError while online (e.g. CORS refused) is unavailable after one retry, with a console hint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await run()).toEqual({ kind: "unavailable", token: "tok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it("409 then 200: waits 2 s, retries with the same id, and the answer arrives", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { error: "turn_in_progress" }))
      .mockResolvedValueOnce(sseResponse([ev("text", { delta: "ok" }), ev("done", { conversationToken: "tok", messageId: "m1" })]));
    expect(await run()).toEqual({ kind: "done", token: "tok", messageId: "m1" });
    expect(waited).toEqual([2000]);
    expect(bodies().map((b) => b.requestId)).toEqual([REQ, REQ]);
    expect(events).toEqual([{ kind: "text", delta: "ok" }]);
  });

  it("409 for over 30 s gives up with busy", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(409, { error: "turn_in_progress" }));
    expect(await run()).toEqual({ kind: "busy" });
    expect(waited.reduce((a, b) => a + b, 0)).toBe(30000);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it.each([404, 401])("%i: resets and resends once without a token", async (status) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(status, {}))
      .mockResolvedValueOnce(sseResponse([ev("text", { delta: "new" }), ev("done", { conversationToken: "fresh", messageId: "m9" })]));
    expect(await run("old")).toEqual({ kind: "done", token: "fresh", messageId: "m9" });
    expect(events[0]).toEqual({ kind: "reset" });
    const [first, second] = bodies();
    expect(first.conversationToken).toBe("old");
    expect(second).not.toHaveProperty("conversationToken");
    expect(second.requestId).toBe(REQ);
  });

  it("a second 404 after the reset is unavailable, not a loop", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, { error: "unknown_shop" }));
    expect(await run("old")).toEqual({ kind: "unavailable", token: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("413 is too_long", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { error: "message_too_long" }));
    expect(await run()).toEqual({ kind: "too_long" });
  });

  it("an error event is unavailable and carries the token it sends", async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([ev("error", { message: "Assistant unavailable right now", conversationToken: "tok3" })]));
    expect(await run(null)).toEqual({ kind: "unavailable", token: "tok3" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an abort stops without a retry", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    expect(await run("tok", ac.signal)).toEqual({ kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
