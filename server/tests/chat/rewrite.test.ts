import { beforeEach, expect, test, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

import { REWRITE_TIMEOUT_MS, rewriteQuery } from "@/lib/chat/rewrite";

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
      required: ["query", "includeGiftCards", "budget", "sort"],
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
  expect(r).toEqual({ query: "gift card", includeGiftCards: true, budget: null, sort: null, tokens: { input: 51, output: 12 } });
});

test("a timeout returns the message unchanged without gift cards", async () => {
  vi.useFakeTimers();
  try {
    create.mockImplementationOnce(
      (_body: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const p = rewriteQuery({ message: "[email] wants wax", history: [], storeLocale: "en", signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(REWRITE_TIMEOUT_MS);
    expect(await p).toEqual({ query: "[email] wants wax", includeGiftCards: false, budget: null, sort: null, tokens: { input: 0, output: 0 } });
  } finally {
    vi.useRealTimers();
  }
});

test("a 429 returns the message unchanged without gift cards", async () => {
  create.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toEqual({ query: "wax", includeGiftCards: false, budget: null, sort: null, tokens: { input: 0, output: 0 } });
});

test("invalid JSON returns the message unchanged without gift cards (tokens still counted)", async () => {
  create.mockResolvedValueOnce({ output_text: "{not json", usage: { input_tokens: 30, output_tokens: 4 } });
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toEqual({ query: "wax", includeGiftCards: false, budget: null, sort: null, tokens: { input: 30, output: 4 } });
});

test("an empty query means no search is needed: it is kept empty, not treated as a failure", async () => {
  create.mockResolvedValueOnce(ok({ query: "  ", includeGiftCards: false, budget: null, sort: null }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const r = await rewriteQuery({ message: "thanks!", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r.query).toBe("");
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test("JSON of the wrong shape (no query) falls back to the message", async () => {
  create.mockResolvedValueOnce(ok({ includeGiftCards: true }));
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

// --- D87: budget and price order ---

test("the schema has a nullable budget {min, max} and a nullable sort, all required (strict mode)", async () => {
  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false, budget: null, sort: null }));
  await rewriteQuery({ message: "m", history: [], storeLocale: null, storeCurrency: "INR", signal: new AbortController().signal });
  const schema = create.mock.calls[0][0].text.format.schema;
  expect(schema.properties.budget).toEqual({
    anyOf: [
      { type: "null" },
      {
        type: "object",
        properties: { min: { type: ["number", "null"] }, max: { type: ["number", "null"] } },
        required: ["min", "max"],
        additionalProperties: false,
      },
    ],
  });
  expect(schema.properties.sort).toEqual({ anyOf: [{ type: "null" }, { type: "string", enum: ["cheapest", "priciest"] }] });
});

test("the instructions name the store currency, forbid guessing a budget and forbid converting currencies", async () => {
  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false, budget: null, sort: null }));
  await rewriteQuery({ message: "m", history: [], storeLocale: "en", storeCurrency: "INR", signal: new AbortController().signal });
  const instructions: string = create.mock.calls[0][0].instructions;
  expect(instructions).toContain("The store's prices are in INR.");
  expect(instructions).toMatch(/Never guess one/);
  expect(instructions).toMatch(/do not convert/);
  expect(instructions).toMatch(/cheapest/);

  create.mockResolvedValueOnce(ok({ query: "q", includeGiftCards: false, budget: null, sort: null }));
  await rewriteQuery({ message: "m", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(create.mock.calls[1][0].instructions).not.toMatch(/prices are in/);
});

test("a budget and sort are returned; null bounds are dropped and swapped bounds put in order", async () => {
  const signal = new AbortController().signal;
  create.mockResolvedValueOnce(ok({ query: "gift", includeGiftCards: false, budget: { min: null, max: 1000 }, sort: null }));
  expect(await rewriteQuery({ message: "a gift under 1000 rupees", history: [], storeLocale: "en", storeCurrency: "INR", signal })).toMatchObject({
    query: "gift",
    budget: { max: 1000 },
    sort: null,
  });
  create.mockResolvedValueOnce(ok({ query: "board", includeGiftCards: false, budget: { min: 900, max: 500 }, sort: "cheapest" }));
  expect(await rewriteQuery({ message: "m", history: [], storeLocale: "en", signal })).toMatchObject({ budget: { min: 500, max: 900 }, sort: "cheapest" });
  create.mockResolvedValueOnce(ok({ query: "board", includeGiftCards: false, budget: { min: null, max: null }, sort: "bogus" }));
  expect(await rewriteQuery({ message: "m", history: [], storeLocale: "en", signal })).toMatchObject({ budget: null, sort: null });
});

test("output without budget or sort (an older shape) still parses, with both null", async () => {
  create.mockResolvedValueOnce(ok({ query: "wax", includeGiftCards: false }));
  const r = await rewriteQuery({ message: "wax", history: [], storeLocale: "en", signal: new AbortController().signal });
  expect(r).toMatchObject({ query: "wax", budget: null, sort: null });
});

test("the instructions ask for the main product types when the shopper names a room or broad category", async () => {
  create.mockResolvedValueOnce(ok({ query: "lit, table de chevet", includeGiftCards: false }));
  await rewriteQuery({ message: "bedroom", history: [], storeLocale: "fr", signal: new AbortController().signal });
  const instructions: string = create.mock.calls[0][0].instructions;
  expect(instructions).toContain(
    "If the shopper asks for a room, space or broad category rather than a product (for example 'bedroom', 'living room', 'for my office', 'outdoor'), write a query that lists the main product types sold for it (for example for a bedroom: bed, bedside table, wardrobe, chest of drawers, bench), in the store's language. Put the most typical product first.",
  );
});
