import { beforeEach, expect, test, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(function () {
    return { responses: { create } };
  }),
}));

import { answer, ChatUnavailable, MAX_TOOL_ROUNDS } from "@/lib/chat/answer";

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

test("a second message item in one response is not appended to the first", async () => {
  create.mockImplementationOnce(async () =>
    (async function* () {
      yield { type: "response.output_text.delta", item_id: "m1", delta: "I am an AI. " };
      yield { type: "response.output_text.delta", item_id: "m1", delta: "Need a snowboard?" };
      yield { type: "response.output_text.delta", item_id: "m2", delta: "I am an AI, again." };
      yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } };
    })(),
  );
  const { opts, texts } = setup();
  const r = await answer(opts);
  expect(r.text).toBe("I am an AI. Need a snowboard?");
  expect(texts.join("")).toBe("I am an AI. Need a snowboard?");
});

test("the first message item is shown once it has non-whitespace text; a whitespace-only item before it is passed over and skipped items are counted in the log, never their text", async () => {
  create.mockImplementationOnce(async () =>
    (async function* () {
      yield { type: "response.output_text.delta", item_id: "m0", delta: "\n" };
      yield { type: "response.output_text.delta", item_id: "m1", delta: "The real " };
      yield { type: "response.output_text.delta", item_id: "m1", delta: "answer." };
      yield { type: "response.output_text.delta", item_id: "m2", delta: "secret second text" };
      yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } };
    })(),
  );
  const { opts, texts } = setup();
  expect((await answer(opts)).text).toBe("The real answer.");
  expect(texts.join("")).toBe("The real answer.");
  expect(console.info).toHaveBeenCalledWith("chat answer items skipped", { storeId: "store-1", items: 2, deltas: 2 });
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("secret");
});

test("[[escalate]] split across deltas: no small-model text, small aborted, large answers", async () => {
  create
    .mockImplementationOnce(stream(["[[esc", "alate]] let me", " think", { hang: true }]))
    .mockImplementationOnce(stream(["Here ", "[[product:1]]", " it is"], { input_tokens: 200, output_tokens: 30 }));
  const { opts, texts, products } = setup({ largeSystem: "SYSTEM-LARGE" });
  const r = await answer(opts);
  expect(texts.join("")).toBe("Here it is");
  expect(texts.join("")).not.toMatch(/think|escalate/);
  expect(signals[0].aborted).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toMatchObject({ model: "large-model", instructions: "SYSTEM-LARGE", input: "INPUT", store: false });
  // Low thinking keeps the first word fast: none for the small model, low for the large one (overridable in .env).
  expect(create.mock.calls[0][0]).toMatchObject({ reasoning: { effort: "none" } });
  expect(create.mock.calls[1][0]).toMatchObject({ reasoning: { effort: "low" } });
  expect(products).toEqual(["gid://shopify/Product/101"]);
  // the aborted small call reports no usage, so only the large call's tokens are counted
  expect(r).toEqual({ model: "large", text: "Here it is", status: "ok", tokens: { input: 200, output: 30 } });
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

// Tool loop (tools.ts): a response that ends in function calls runs them and streams again with the results.
function toolCall(name: string, args: object, callId = "call-1", usage = { input_tokens: 50, output_tokens: 5 }) {
  return async (_body: unknown, { signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    const output = [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }];
    return (async function* () {
      yield { type: "response.completed", response: { usage, output } };
    })();
  };
}
/** The request bodies as sent: input is copied at call time, since answer() keeps appending to its input array. */
function sentBodies() {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    wrap: (impl: (b: unknown, o: { signal: AbortSignal }) => unknown) => (b: Record<string, unknown>, o: { signal: AbortSignal }) => {
      bodies.push({ ...b, input: Array.isArray(b.input) ? [...b.input] : b.input });
      return impl(b, o);
    },
  };
}
const tools = (run = vi.fn(async () => "<store_data>RESULT</store_data>")) => ({
  defs: [{ type: "function" as const, name: "store_policies", parameters: {}, strict: true }],
  run,
});

test("without tools, nothing about tools is sent", async () => {
  create.mockImplementationOnce(stream(["Hi"]));
  const { opts } = setup();
  await answer(opts);
  const body = create.mock.calls[0][0];
  expect(body).not.toHaveProperty("tools");
  expect(body).not.toHaveProperty("include");
});

test("a tool call runs the tool, sends calls and results back, and the answer streams after", async () => {
  const sent = sentBodies();
  create
    .mockImplementationOnce(sent.wrap(toolCall("store_policies", { query: "returns?", policy_types: ["refund"] })))
    .mockImplementationOnce(sent.wrap(stream(["You can return ", "within 30 days."])));
  const run = vi.fn(async () => "<store_data>30 days</store_data>");
  const { opts, texts } = setup({ tools: tools(run) });
  const r = await answer(opts);

  expect(run).toHaveBeenCalledWith("store_policies", JSON.stringify({ query: "returns?", policy_types: ["refund"] }));
  expect(texts.join("")).toBe("You can return within 30 days.");
  expect(r).toEqual({ model: "small", text: "You can return within 30 days.", status: "ok", tokens: { input: 150, output: 25 } });
  expect(sent.bodies[0]).toMatchObject({ input: [{ role: "user", content: "INPUT" }], tool_choice: "auto", include: ["reasoning.encrypted_content"] });
  expect(sent.bodies[0].tools).toEqual(tools().defs);
  expect(sent.bodies[1].input).toEqual([
    { role: "user", content: "INPUT" },
    { type: "function_call", call_id: "call-1", name: "store_policies", arguments: JSON.stringify({ query: "returns?", policy_types: ["refund"] }) },
    { type: "function_call_output", call_id: "call-1", output: "<store_data>30 days</store_data>" },
  ]);
});

test("after MAX_TOOL_ROUNDS the model must answer: tool_choice none", async () => {
  const sent = sentBodies();
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) create.mockImplementationOnce(sent.wrap(toolCall("store_policies", { query: "q" }, `c${i}`)));
  create.mockImplementationOnce(sent.wrap(stream(["Done"])));
  const { opts } = setup({ tools: tools() });
  expect((await answer(opts)).text).toBe("Done");
  expect(sent.bodies.map((b) => b.tool_choice)).toEqual([...Array(MAX_TOOL_ROUNDS).fill("auto"), "none"]);
});

test("a throwing tool becomes a sentence for the model, not a failed answer", async () => {
  const sent = sentBodies();
  create.mockImplementationOnce(sent.wrap(toolCall("store_policies", { query: "q" }))).mockImplementationOnce(sent.wrap(stream(["Sorry"])));
  const run = vi.fn(async () => {
    throw new Error("boom");
  });
  const { opts } = setup({ tools: tools(run) });
  expect((await answer(opts)).text).toBe("Sorry");
  expect((sent.bodies[1].input as { output?: string }[]).at(-1)!.output).toMatch(/unavailable right now/);
});

test("tool results are kept when the small model escalates after a tool round", async () => {
  const sent = sentBodies();
  create
    .mockImplementationOnce(sent.wrap(toolCall("store_policies", { query: "q" })))
    .mockImplementationOnce(sent.wrap(stream(["[[escalate]]", { hang: true }])))
    .mockImplementationOnce(sent.wrap(stream(["Large answer"])));
  const { opts } = setup({ tools: tools() });
  const r = await answer(opts);
  expect(r).toMatchObject({ model: "large", text: "Large answer" });
  expect(sent.bodies[2]).toMatchObject({ model: "large-model" });
  expect((sent.bodies[2].input as { type?: string }[]).map((i) => i.type)).toEqual([undefined, "function_call", "function_call_output"]);
});

test("text from a round after tools is separated from the previous round's text, and parallel calls are off", async () => {
  const sent = sentBodies();
  create
    .mockImplementationOnce(
      sent.wrap(async (_b: unknown, { signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        const output = [{ type: "function_call", call_id: "c1", name: "store_policies", arguments: '{"query":"q"}' }];
        return (async function* () {
          yield { type: "response.output_text.delta", delta: "Let me check." };
          yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, output } };
        })();
      }),
    )
    .mockImplementationOnce(sent.wrap(stream(["We accept returns."])));
  const { opts, texts } = setup({ tools: tools() });
  expect((await answer(opts)).text).toBe("Let me check.\n\nWe accept returns.");
  expect(texts.join("")).toBe("Let me check.\n\nWe accept returns.");
  expect(sent.bodies[0].parallel_tool_calls).toBe(false);
});

test("the small model's reasoning items are not sent to the large model on escalation", async () => {
  const sent = sentBodies();
  create
    .mockImplementationOnce(
      sent.wrap(async (_b: unknown, { signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        const output = [
          { type: "reasoning", id: "r1", summary: [], encrypted_content: "SMALL" },
          { type: "function_call", call_id: "c1", name: "store_policies", arguments: '{"query":"q"}' },
        ];
        return (async function* () {
          yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, output } };
        })();
      }),
    )
    .mockImplementationOnce(sent.wrap(stream(["[[escalate]]", { hang: true }])))
    .mockImplementationOnce(sent.wrap(stream(["Large"])));
  const { opts } = setup({ tools: tools() });
  await answer(opts);
  expect((sent.bodies[1].input as { type?: string }[]).some((i) => i.type === "reasoning")).toBe(true);
  expect((sent.bodies[2].input as { type?: string }[]).map((i) => i.type)).toEqual([undefined, "function_call", "function_call_output"]);
});

// A response that says `text` and then asks for a tool.
function sayThenTool(text: string) {
  return async (_b: unknown, { signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    const output = [{ type: "function_call", call_id: "c1", name: "store_policies", arguments: '{"query":"q"}' }];
    return (async function* () {
      yield { type: "response.output_text.delta", delta: text };
      yield { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, output } };
    })();
  };
}

test("[[escalate]] after a tool round still escalates when nothing was shown before it", async () => {
  // The first round's only text is a marker that is stripped, so the small model has "decided" but the shopper saw nothing.
  create
    .mockImplementationOnce(sayThenTool("[[note]]"))
    .mockImplementationOnce(stream(["[[escalate]]", { hang: true }]))
    .mockImplementationOnce(stream(["Large answer"]));
  const { opts, texts } = setup({ tools: tools() });
  const r = await answer(opts);
  expect(r).toMatchObject({ model: "large", text: "Large answer" });
  expect(texts.join("")).toBe("Large answer");
});

test("[[escalate]] in a later round is stripped, not obeyed, once text was shown", async () => {
  create.mockImplementationOnce(sayThenTool("Let me check.")).mockImplementationOnce(stream(["[[escalate]] We accept returns."]));
  const { opts, texts } = setup({ tools: tools() });
  const r = await answer(opts);
  expect(r).toMatchObject({ model: "small", status: "ok" });
  expect(texts.join("")).toBe("Let me check.\n\nWe accept returns.");
});
