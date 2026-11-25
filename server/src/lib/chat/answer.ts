import type { FunctionTool, ResponseFunctionToolCall, ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses";
import { MAX_ANSWER_TOKENS } from "./limits";
import { createMarkerParser } from "./markers";
import { chatModel, chatReasoning, errorStatus, openai } from "./openai";

// OpenAI could not start an answer (§8: "Assistant unavailable right now"). Thrown only before
// anything reached the shopper; after that, failures end the answer with status "cut_off".
export class ChatUnavailable extends Error {
  constructor(reason: string) {
    super(`chat unavailable: ${reason}`);
    this.name = "ChatUnavailable";
  }
}

export type Tokens = { input: number; output: number };
export type AnswerResult = { model: "small" | "large"; text: string; status: "ok" | "cut_off"; tokens: Tokens };

// C13 = (a): 20 s to the first token, 60 s for the whole answer.
const FIRST_TOKEN_MS = 20_000;
const TOTAL_MS = 60_000;
const RETRY_DELAY_MS = 1000;
const ESCALATE = "[[escalate]]";
/** Rounds of tool calls per answer (tools.ts). The request after the last round is sent with tool_choice "none", so the model has to answer. */
export const MAX_TOOL_ROUNDS = 3;
/** One tool call may take this long; a slower one counts as failed, so a hung Shopify call can't use up the answer's time. */
export const TOOL_TIMEOUT_MS = 15_000;
const TOOL_FAILED = "This tool is unavailable right now. Tell the shopper you can't check that right now, and answer from what you already have.";

export type AnswerTools = { defs: FunctionTool[]; run: (name: string, args: string) => Promise<string> };

type Outcome =
  | { kind: "done"; usage?: { input_tokens: number; output_tokens: number }; incomplete: boolean; output: ResponseOutputItem[] }
  | { kind: "escalate" }
  | { kind: "user" | "first_token" | "total" }
  | { kind: "error"; err: unknown };

// Streams one answer: small model first, the large one when the small model opens with [[escalate]] (D34).
// Text goes to onText with markers stripped; products go to onProduct, only from `allowed` (D36).
// `largeSystem` lets the caller drop the escalation rule for the large model (Task 17, rule 7).
// With `tools`, a response that ends in function calls runs them and streams again with their results, up to
// MAX_TOOL_ROUNDS; the conversation so far (tool calls and results included) also goes to the large model on escalation.
// ponytail: an escalated small call is aborted before its usage arrives, so its tokens are not counted
// (a few tokens). Count them from the input size in M10 if the escalation rate makes it matter.
export async function answer(opts: {
  system: string;
  largeSystem?: string;
  input: string | ResponseInput;
  tools?: AnswerTools;
  allowed: Map<string, string>;
  storeId: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  onProduct: (gid: string) => void;
  /** A product's title, for a marker that stands where its name is needed (markers.ts). */
  titleOf?: (gid: string) => string | undefined;
  timeouts?: { firstTokenMs?: number; totalMs?: number };
}): Promise<AnswerResult> {
  const firstTokenMs = opts.timeouts?.firstTokenMs ?? FIRST_TOKEN_MS;
  const totalMs = opts.timeouts?.totalMs ?? TOTAL_MS;
  const endAt = Date.now() + totalMs;

  const parser = createMarkerParser(opts.allowed, opts.titleOf);
  const tokens: Tokens = { input: 0, output: 0 };
  let text = "";
  let delivered = false; // anything (text or a product) has reached the shopper
  let model: "small" | "large" = "small";
  // The request input; tool rounds append the model's output items and the tool results to it.
  const input: ResponseInput = typeof opts.input === "string" ? [{ role: "user", content: opts.input }] : [...opts.input];
  let toolRounds = 0;
  // Set when a new round starts after tools ran, so its text doesn't run into the previous round's ("…policy.We accept").
  let roundBreak = false;

  const deliver = (chunk: { text: string; products: string[] }) => {
    let t = text ? chunk.text : chunk.text.trimStart();
    if (t && roundBreak) {
      roundBreak = false;
      t = t.trimStart();
      if (text && !/\s$/.test(text)) t = "\n\n" + t;
    }
    if (t) {
      text += t;
      delivered = true;
      opts.onText(t);
    }
    for (const gid of chunk.products) {
      delivered = true;
      opts.onProduct(gid);
    }
  };

  // One streamed request. `onDelta` returns false to stop (escalation).
  async function stream(size: "small" | "large", onDelta: (d: string) => boolean): Promise<Outcome> {
    if (opts.signal.aborted) return { kind: "user" };
    const ac = new AbortController();
    let reason: "user" | "first_token" | "total" | "escalate" | null = null;
    const stop = (r: NonNullable<typeof reason>) => {
      reason ??= r;
      ac.abort();
    };
    const onUser = () => stop("user");
    opts.signal.addEventListener("abort", onUser, { once: true });
    const totalTimer = setTimeout(() => stop("total"), Math.max(0, endAt - Date.now()));
    let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => stop("first_token"),
      Math.min(firstTokenMs, Math.max(0, endAt - Date.now())),
    );
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    let incomplete = false;
    let output: ResponseOutputItem[] = [];
    try {
      const events = await openai().responses.create(
        {
          model: chatModel(size),
          reasoning: chatReasoning(size),
          instructions: size === "large" ? (opts.largeSystem ?? opts.system) : opts.system,
          // A plain string when there are no tools, exactly as before tools existed.
          input: opts.tools || typeof opts.input !== "string" ? input : opts.input,
          stream: true,
          store: false,
          max_output_tokens: MAX_ANSWER_TOKENS,
          // store: false keeps nothing at OpenAI, so reasoning items must travel back with the tool results.
          ...(opts.tools
            ? {
                tools: opts.tools.defs,
                tool_choice: toolRounds >= MAX_TOOL_ROUNDS ? ("none" as const) : ("auto" as const),
                // One call per round: several parallel searches would each add products and a live check, unbounded.
                parallel_tool_calls: false,
                include: ["reasoning.encrypted_content" as const],
              }
            : {}),
        },
        { signal: ac.signal },
      );
      // One response can hold several message items; a second one rewrites the first (the "…a snowboard?I'm an AI…" doubled
      // answer), so only the first item's text is shown: the first item that has produced non-whitespace text (a whitespace-only
      // item before it is passed over, not locked on). Deltas without an item id all count as one item. Skipped items are
      // counted and logged after the stream (counts only, never their text), so a real answer lost this way can be measured.
      let firstItem: string | undefined;
      const skipped = new Set<string>();
      let skippedDeltas = 0;
      for await (const ev of events) {
        if (ev.type === "response.output_text.delta") {
          const item = (ev as { item_id?: string }).item_id;
          if (item !== undefined) {
            if (firstItem === undefined) {
              if (!ev.delta.trim()) {
                skipped.add(item);
                skippedDeltas++;
                continue;
              }
              firstItem = item;
              skipped.delete(item);
            }
            if (item !== firstItem) {
              skipped.add(item);
              skippedDeltas++;
              continue;
            }
          }
          clearTimeout(firstTimer);
          firstTimer = undefined;
          if (!onDelta(ev.delta)) {
            stop("escalate");
            break;
          }
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          usage = ev.response.usage ?? undefined;
          incomplete = ev.type === "response.incomplete";
          output = ev.response.output ?? [];
        } else if (ev.type === "response.failed") {
          throw new Error(`response failed: ${ev.response.error?.code ?? "unknown"}`);
        }
      }
      if (skipped.size) console.info("chat answer items skipped", { storeId: opts.storeId, items: skipped.size, deltas: skippedDeltas });
      // The SDK ends the iteration quietly when its request is aborted, so check why we stopped.
      if (reason) return { kind: reason };
      return { kind: "done", usage, incomplete, output };
    } catch (err) {
      if (reason) return { kind: reason };
      return { kind: "error", err };
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(firstTimer);
      opts.signal.removeEventListener("abort", onUser);
    }
  }

  // One retry for a 429/5xx before anything reached the shopper, if the time budget allows.
  async function streamWithRetry(size: "small" | "large", onDelta: (d: string) => boolean, reset: () => void) {
    let out = await stream(size, onDelta);
    if (out.kind !== "error" || delivered) return out;
    const status = errorStatus(out.err);
    const retryable = status === 429 || (status !== undefined && status >= 500);
    if (!retryable || endAt - Date.now() <= RETRY_DELAY_MS) return out;
    console.warn("chat openai retry", { storeId: opts.storeId, status });
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    reset();
    out = await stream(size, onDelta);
    return out;
  }

  // The tool loop: while a finished response asks for tools, run them, append the calls and results, stream again.
  async function streamWithTools(size: "small" | "large", onDelta: (d: string) => boolean, reset: () => void): Promise<Outcome> {
    let out = await streamWithRetry(size, onDelta, reset);
    while (opts.tools && out.kind === "done" && !out.incomplete) {
      const calls = out.output.filter((i): i is ResponseFunctionToolCall => i.type === "function_call");
      if (!calls.length) break;
      tokens.input += out.usage?.input_tokens ?? 0;
      tokens.output += out.usage?.output_tokens ?? 0;
      toolRounds++;
      // Output items (reasoning, text, function calls) are valid input items for the next request.
      input.push(...(out.output as unknown as ResponseInput));
      for (const c of calls) {
        let result: string;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A tool that fails or hangs is a tool result, never a failed answer.
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("TimeoutError")), Math.min(TOOL_TIMEOUT_MS, Math.max(0, endAt - Date.now())));
          });
          result = await Promise.race([opts.tools.run(c.name, c.arguments), timeout]);
        } catch (err) {
          console.warn("chat tool failed", { storeId: opts.storeId, tool: c.name, error: err instanceof Error ? err.name : typeof err });
          result = TOOL_FAILED;
        } finally {
          clearTimeout(timer);
        }
        input.push({ type: "function_call_output", call_id: c.call_id, output: result });
      }
      console.info("chat tools ran", { storeId: opts.storeId, model: size, tools: calls.map((c) => c.name), round: toolRounds });
      if (opts.signal.aborted) return { kind: "user" };
      if (Date.now() >= endAt) return { kind: "total" };
      roundBreak = true;
      // Nothing shown yet (a tool call straight away, or only whitespace): the next round may still open with
      // [[escalate]], so the small model's marker check starts over. Once text was shown, escalating is impossible.
      if (!delivered) reset();
      out = await streamWithRetry(size, onDelta, reset);
      // The request that carries the tool results failed before anything was shown (a refused tool item, a slow first token):
      // one more try that may not call tools, so the shopper still gets an answer from what the turn already holds.
      if ((out.kind === "error" || out.kind === "first_token") && !delivered && !opts.signal.aborted && endAt - Date.now() > 5000) {
        console.warn("chat answer after tools failed, retrying without tools", { storeId: opts.storeId, model: size, reason: out.kind });
        toolRounds = MAX_TOOL_ROUNDS;
        reset();
        out = await stream(size, onDelta);
      }
    }
    return out;
  }

  // Maps a failed outcome to the result: cut_off once the shopper saw something, else ChatUnavailable.
  function finish(out: Outcome): AnswerResult {
    if (out.kind === "done") {
      tokens.input += out.usage?.input_tokens ?? 0;
      tokens.output += out.usage?.output_tokens ?? 0;
      deliver(parser.end());
      return { model, text, status: out.incomplete ? "cut_off" : "ok", tokens };
    }
    if (out.kind === "user") return { model, text, status: "cut_off", tokens };
    const why = out.kind === "error" ? String(errorStatus(out.err) ?? "error") : out.kind;
    if (!delivered) {
      console.warn("chat unavailable", { storeId: opts.storeId, model, reason: why });
      throw new ChatUnavailable(why);
    }
    console.warn("chat answer cut off", { storeId: opts.storeId, model, reason: why });
    return { model, text, status: "cut_off", tokens };
  }

  // Small model: buffer until the trimmed text starts with [[escalate]] or can no longer become it.
  let pending = "";
  let decided = false;
  const small = await streamWithTools(
    "small",
    (d) => {
      if (decided) {
        deliver(parser.push(d));
        return true;
      }
      pending += d;
      const head = pending.trimStart().toLowerCase();
      if (head.startsWith(ESCALATE)) return false;
      if (head === "" || ESCALATE.startsWith(head)) return true;
      decided = true;
      deliver(parser.push(pending));
      pending = "";
      return true;
    },
    () => {
      pending = "";
      decided = false;
    },
  );
  if (small.kind !== "escalate") {
    if (pending) deliver(parser.push(pending)); // the stream ended while still undecided
    return finish(small);
  }

  console.info("chat escalated", { storeId: opts.storeId });
  model = "large";
  // The small model's encrypted reasoning from tool rounds belongs to that model; the large one may refuse it (400).
  for (let i = input.length - 1; i >= 0; i--) if ((input[i] as { type?: string }).type === "reasoning") input.splice(i, 1);
  // A leading [[escalate]] from the large model is stripped by the marker parser like any other marker.
  const large = await streamWithTools(
    "large",
    (d) => {
      deliver(parser.push(d));
      return true;
    },
    () => {},
  );
  return finish(large);
}
