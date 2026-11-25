import { beforeEach, expect, test, vi } from "vitest";

// A store_policies (Storefront MCP) failure must never fail the turn: it is a tool result, and the model answers from it.
const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

import { answer, ChatUnavailable, TOOL_TIMEOUT_MS } from "@/lib/chat/answer";

function stream(steps: ({ text: string } | { error: unknown })[], output: unknown[] = []) {
  return async (_body: unknown, { signal }: { signal: AbortSignal }) => {
    if (signal.aborted) throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    return (async function* () {
      for (const s of steps) {
        if ("error" in s) throw s.error;
        yield { type: "response.output_text.delta", delta: s.text };
      }
      yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, output } };
    })();
  };
}
const toolCall = () =>
  stream([], [{ type: "function_call", call_id: "c1", name: "store_policies", arguments: JSON.stringify({ query: "return policy", policy_types: ["refund"] }) }]);
const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const bodies: { input: unknown[]; tool_choice?: string }[] = [];
const record = (impl: (b: never, o: never) => unknown) => (b: { input: unknown[]; tool_choice?: string }, o: never) => {
  bodies.push({ ...b, input: [...b.input] });
  return impl(b as never, o);
};
const defs = [{ type: "function" as const, name: "store_policies", parameters: {}, strict: true }];

function setup(run: () => Promise<string>) {
  const texts: string[] = [];
  const opts = {
    system: "S",
    input: "I",
    allowed: new Map<string, string>(),
    storeId: "store-1",
    signal: new AbortController().signal,
    onText: (t: string) => texts.push(t),
    onProduct: () => {},
    tools: { defs, run },
  };
  return { opts, texts };
}

beforeEach(() => {
  create.mockReset();
  bodies.length = 0;
  process.env.OPENAI_API_KEY = "test";
  process.env.OPENAI_MODEL_SMALL = "small-model";
  process.env.OPENAI_MODEL_LARGE = "large-model";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

test("a tool that never returns is cut off after TOOL_TIMEOUT_MS and becomes an unavailable sentence for the model", async () => {
  vi.useFakeTimers();
  try {
    create.mockImplementationOnce(record(toolCall())).mockImplementationOnce(record(stream([{ text: "I can't check that right now." }])));
    const { opts } = setup(() => new Promise<string>(() => {}));
    const p = answer(opts);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS + 10);
    expect((await p).text).toBe("I can't check that right now.");
    expect((bodies[1].input as { output?: string }[]).at(-1)!.output).toMatch(/can't check that right now/);
  } finally {
    vi.useRealTimers();
  }
});

test("the request that carries the tool results failing is retried once without tools, so the shopper still gets an answer", async () => {
  create
    .mockImplementationOnce(record(toolCall()))
    .mockImplementationOnce(record(stream([{ error: apiError(400) }])))
    .mockImplementationOnce(record(stream([{ text: "I can't check that right now." }])));
  const { opts } = setup(async () => "<store_data>Store policies are unavailable right now.</store_data>");
  expect((await answer(opts)).text).toBe("I can't check that right now.");
  expect(bodies[2].tool_choice).toBe("none");
});

test("when that retry fails too, nothing was shown, so it is ChatUnavailable", async () => {
  create
    .mockImplementationOnce(record(toolCall()))
    .mockImplementationOnce(record(stream([{ error: apiError(400) }])))
    .mockImplementationOnce(record(stream([{ error: apiError(400) }])));
  const { opts } = setup(async () => "x");
  await expect(answer(opts)).rejects.toBeInstanceOf(ChatUnavailable);
});
