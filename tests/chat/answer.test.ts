import { beforeEach, expect, test, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

import { answer, ChatUnavailable } from "@/lib/chat/answer";

// A fake Responses stream. Like the SDK, aborting mid-iteration ends the iteration quietly,
// and aborting before the stream starts rejects.
type Step = string | { error: unknown } | { hang: true };
const signals: AbortSignal[] = [];
function stream(steps: Step[], usage = { input_tokens: 100, output_tokens: 20 }) {
  return async (_body: unknown, { signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    if (signal.aborted) throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    return (async function* () {
      for (const s of steps) {
        if (signal.aborted) return;
        if (typeof s === "string") {
          yield { type: "response.output_text.delta", delta: s };
          await Promise.resolve();
        } else if ("error" in s) throw s.error;
        else await new Promise((res) => signal.addEventListener("abort", res, { once: true }));
      }
      if (signal.aborted) return;
      yield { type: "response.completed", response: { usage } };
    })();
  };
}
const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

const allowed = new Map([
  ["1", "gid://shopify/Product/101"],
  ["2", "gid://shopify/Product/102"],
]);

function setup(extra: Partial<Parameters<typeof answer>[0]> = {}) {
  const texts: string[] = [];
  const products: string[] = [];
  const ac = new AbortController();
  const opts = {
    system: "SYSTEM",
    input: "INPUT",
    allowed,
    storeId: "store-1",
    signal: ac.signal,
    onText: (t: string) => texts.push(t),
    onProduct: (g: string) => products.push(g),
    ...extra,
  };
  return { opts, texts, products, ac };
}

beforeEach(() => {
  create.mockReset();
  signals.length = 0;
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

test("a plain answer streams the small model with store: false and max_output_tokens 1000", async () => {
  create.mockImplementationOnce(stream(["Hello ", "there"]));
  const { opts, texts } = setup();
  const r = await answer(opts);
  expect(r).toEqual({ model: "small", text: "Hello there", status: "ok", tokens: { input: 100, output: 20 } });
  expect(texts.join("")).toBe("Hello there");
  expect(create.mock.calls[0][0]).toMatchObject({
    model: "small-model",
    instructions: "SYSTEM",
    input: "INPUT",
    stream: true,
    store: false,
    max_output_tokens: 1000,
  });
});

test("[[escalate]] split across deltas: no small-model text, small aborted, large answers", async () => {
  create
    .mockImplementationOnce(stream(["[[esc", "alate]] let me", " think", { hang: true }]))
    .mockImplementationOnce(stream(["Here ", "[[product:1]]", " it is"], { input_tokens: 200, output_tokens: 30 }));
  const { opts, texts, products } = setup({ largeSystem: "SYSTEM-LARGE" });
  const r = await answer(opts);
  expect(texts.join("")).toBe("Here  it is");
  expect(texts.join("")).not.toMatch(/think|escalate/);
  expect(signals[0].aborted).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toMatchObject({ model: "large-model", instructions: "SYSTEM-LARGE", input: "INPUT", store: false });
  expect(products).toEqual(["gid://shopify/Product/101"]);
  // the aborted small call reports no usage, so only the large call's tokens are counted
  expect(r).toEqual({ model: "large", text: "Here  it is", status: "ok", tokens: { input: 200, output: 30 } });
  expect(console.info).toHaveBeenCalledWith("chat escalated", { storeId: "store-1" });
});

test("a leading space before [[escalate]] still escalates", async () => {
  create.mockImplementationOnce(stream(["  ", "[[escalate]]"])).mockImplementationOnce(stream(["Ok"]));
  const { opts } = setup();
  expect((await answer(opts)).model).toBe("large");
});

test("[[product:1]] at the start is not escalation and the product is emitted", async () => {
  create.mockImplementationOnce(stream(["[[product:1]]", " is great"]));
  const { opts, texts, products } = setup();
  const r = await answer(opts);
  expect(create).toHaveBeenCalledTimes(1);
  expect(r.model).toBe("small");
  expect(texts.join("")).toBe("is great");
  expect(products).toEqual(["gid://shopify/Product/101"]);
});

test("large-model output starting with [[escalate]] has the marker stripped, not obeyed", async () => {
  create.mockImplementationOnce(stream(["[[escalate]]"])).mockImplementationOnce(stream(["[[escalate]] Sure", " thing"]));
  const { opts, texts } = setup();
  const r = await answer(opts);
  expect(create).toHaveBeenCalledTimes(2);
  expect(r.text).toBe("Sure thing");
  expect(texts.join("")).toBe("Sure thing");
});

test("no first token within the first-token timeout throws ChatUnavailable", async () => {
  create.mockImplementationOnce(stream([{ hang: true }]));
  const { opts } = setup({ timeouts: { firstTokenMs: 30 } });
  await expect(answer(opts)).rejects.toBeInstanceOf(ChatUnavailable);
  expect(signals[0].aborted).toBe(true);
});

test("a 429 followed by success retries exactly once", async () => {
  create.mockRejectedValueOnce(apiError(429)).mockImplementationOnce(stream(["Hi"]));
  const { opts } = setup();
  const t0 = Date.now();
  const r = await answer(opts);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  expect(create).toHaveBeenCalledTimes(2);
  expect(r).toMatchObject({ status: "ok", text: "Hi", model: "small" });
});

test("a 5xx twice before the first token throws ChatUnavailable after one retry", async () => {
  create.mockRejectedValueOnce(apiError(503)).mockRejectedValueOnce(apiError(500));
  const { opts } = setup();
  await expect(answer(opts)).rejects.toBeInstanceOf(ChatUnavailable);
  expect(create).toHaveBeenCalledTimes(2);
});

test("a 400 before the first token is not retried", async () => {
  create.mockRejectedValueOnce(apiError(400));
  const { opts } = setup();
  await expect(answer(opts)).rejects.toBeInstanceOf(ChatUnavailable);
  expect(create).toHaveBeenCalledTimes(1);
});

test("an error mid-stream stops with cut_off and the text so far, without a retry", async () => {
  create.mockImplementationOnce(stream(["Hello ", "there", { error: apiError(500) }]));
  const { opts, texts } = setup();
  const r = await answer(opts);
  expect(r).toMatchObject({ status: "cut_off", text: "Hello there", model: "small" });
  expect(texts.join("")).toBe("Hello there");
  expect(create).toHaveBeenCalledTimes(1);
});

test("the total timeout after the first token gives cut_off", async () => {
  create.mockImplementationOnce(stream(["Hello", { hang: true }]));
  const { opts } = setup({ timeouts: { totalMs: 50 } });
  const r = await answer(opts);
  expect(r).toMatchObject({ status: "cut_off", text: "Hello" });
  expect(signals[0].aborted).toBe(true);
});

test("aborting the shopper's signal aborts the request and returns cut_off", async () => {
  create.mockImplementationOnce(stream(["Hi", " there", { hang: true }]));
  const { opts, ac } = setup();
  const p = answer({ ...opts, onText: (t) => (opts.onText(t), t === " there" && ac.abort()) });
  const r = await p;
  expect(signals[0].aborted).toBe(true);
  expect(r).toMatchObject({ status: "cut_off", text: "Hi there" });
});

test("a signal already aborted makes no OpenAI call", async () => {
  const { opts, ac } = setup();
  ac.abort();
  expect(await answer(opts)).toMatchObject({ status: "cut_off", text: "" });
  expect(create).not.toHaveBeenCalled();
});
