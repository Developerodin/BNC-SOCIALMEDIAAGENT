import { beforeEach, expect, test, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

import { rewriteQuery } from "@/lib/chat/rewrite";

function ok(json: unknown, usage = { input_tokens: 40, output_tokens: 9 }) {
  return { output_text: JSON.stringify(json), usage };
}

beforeEach(() => {
  create.mockReset();
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const history = [
  { role: "user" as const, content: "Do you have ski wax?" },
  { role: "assistant" as const, content: "Yes, two kinds." },
];

test("request uses the small model, store: false, a strict schema and the store locale", async () => {
  create.mockResolvedValueOnce(ok({ query: "fart de ski", includeGiftCards: false }));
  await rewriteQuery({ message: "the cheaper one?", history, storeLocale: "fr", signal: new AbortController().signal });
  expect(create).toHaveBeenCalledTimes(1);
  const [body, opts] = create.mock.calls[0];
  expect(body.model).toBe("small-model");
  expect(body.store).toBe(false);
  expect(body.text.format).toMatchObject({
    type: "json_schema",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["query", "includeGiftCards"],
      properties: { query: { type: "string" }, includeGiftCards: { type: "boolean" } },
    },
  });
  expect(body.instructions).toContain('"fr"');
  expect(body.instructions).toMatch(/store language/);
  expect(opts.signal).toBeInstanceOf(AbortSignal);
  // the history and the latest message are sent, latest last
  expect(JSON.stringify(body.input)).toContain("Do you have ski wax?");
  expect(body.input.at(-1)).toMatchObject({ role: "user", content: "the cheaper one?" });
});

test("only the last 6 history messages are sent", async () => {
  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false }));
  const long = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
  await rewriteQuery({ message: "now", history: long, storeLocale: null, signal: new AbortController().signal });
  const input = create.mock.calls[0][0].input as { content: string }[];
  expect(input.map((m) => m.content)).toEqual(["m4", "m5", "m6", "m7", "m8", "m9", "now"]);
});

test("returns the parsed result with its token usage", async () => {
  create.mockResolvedValueOnce(ok({ query: "gift card", includeGiftCards: true }, { input_tokens: 51, output_tokens: 12 }));
  const r = await rewriteQuery({ message: "a voucher please", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toEqual({ query: "gift card", includeGiftCards: true, tokens: { input: 51, output: 12 } });
});

test("a timeout returns the message unchanged without gift cards", async () => {
  vi.useFakeTimers();
  try {
    create.mockImplementationOnce(
      (_body: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const p = rewriteQuery({ message: "[email] wants wax", history: [], storeLocale: "en", signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ query: "[email] wants wax", includeGiftCards: false, tokens: { input: 0, output: 0 } });
  } finally {
    vi.useRealTimers();
  }
});

test("a 429 returns the message unchanged without gift cards", async () => {
  create.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toEqual({ query: "wax", includeGiftCards: false, tokens: { input: 0, output: 0 } });
});

test("invalid JSON returns the message unchanged without gift cards (tokens still counted)", async () => {
  create.mockResolvedValueOnce({ output_text: "{not json", usage: { input_tokens: 30, output_tokens: 4 } });
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toEqual({ query: "wax", includeGiftCards: false, tokens: { input: 30, output: 4 } });
});

test("JSON of the wrong shape (empty query) falls back too", async () => {
  create.mockResolvedValueOnce(ok({ query: "  ", includeGiftCards: true }));
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r.query).toBe("wax");
  expect(r.includeGiftCards).toBe(false);
});

test("storeLocale: null sends no translation instruction", async () => {
  create.mockResolvedValueOnce(ok({ query: "wax", includeGiftCards: false }));
  await rewriteQuery({ message: "wax", history: [], storeLocale: null, signal: new AbortController().signal });
  const instructions: string = create.mock.calls[0][0].instructions;
  expect(instructions).not.toMatch(/store language|translat|language with code/i);
  expect(instructions).toMatch(/gift card/i);
});

test("the shopper's abort signal aborts the rewrite call", async () => {
  create.mockImplementationOnce(
    (_body: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const ac = new AbortController();
  const p = rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: ac.signal });
  ac.abort();
  expect((await p).query).toBe("wax");
});

test("the rewrite asks the small model for no reasoning, overridable by OPENAI_REASONING_SMALL", async () => {
  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false }));
  await rewriteQuery({ message: "m", history: [], storeLocale: null, signal: new AbortController().signal });
  expect(create.mock.calls[0][0]).toMatchObject({ reasoning: { effort: "none" } });

  process.env.OPENAI_REASONING_SMALL = "low";
  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false }));
  await rewriteQuery({ message: "m", history: [], storeLocale: null, signal: new AbortController().signal });
  expect(create.mock.calls[1][0]).toMatchObject({ reasoning: { effort: "low" } });
  delete process.env.OPENAI_REASONING_SMALL;
});
