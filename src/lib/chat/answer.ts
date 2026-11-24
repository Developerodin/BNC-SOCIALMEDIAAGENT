import type { ResponseInput } from "openai/resources/responses/responses";
import { MAX_ANSWER_TOKENS } from "./limits";
import { createMarkerParser } from "./markers";
import { chatModel, errorStatus, openai } from "./openai";

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

type Outcome =
  | { kind: "done"; usage?: { input_tokens: number; output_tokens: number }; incomplete: boolean }
  | { kind: "escalate" }
  | { kind: "user" | "first_token" | "total" }
  | { kind: "error"; err: unknown };

// Streams one answer: small model first, the large one when the small model opens with [[escalate]] (D34).
// Text goes to onText with markers stripped; products go to onProduct, only from `allowed` (D36).
// `largeSystem` lets the caller drop the escalation rule for the large model (Task 17, rule 7).
// ponytail: an escalated small call is aborted before its usage arrives, so its tokens are not counted
// (a few tokens). Count them from the input size in M10 if the escalation rate makes it matter.
export async function answer(opts: {
  system: string;
  largeSystem?: string;
  input: string | ResponseInput;
  allowed: Map<string, string>;
  storeId: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  onProduct: (gid: string) => void;
  timeouts?: { firstTokenMs?: number; totalMs?: number };
}): Promise<AnswerResult> {
  const firstTokenMs = opts.timeouts?.firstTokenMs ?? FIRST_TOKEN_MS;
  const totalMs = opts.timeouts?.totalMs ?? TOTAL_MS;
  const endAt = Date.now() + totalMs;

  const parser = createMarkerParser(opts.allowed);
  const tokens: Tokens = { input: 0, output: 0 };
  let text = "";
  let delivered = false; // anything (text or a product) has reached the shopper
  let model: "small" | "large" = "small";

  const deliver = (chunk: { text: string; products: string[] }) => {
    const t = text ? chunk.text : chunk.text.trimStart();
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
    try {
      const events = await openai().responses.create(
        {
          model: chatModel(size),
          instructions: size === "large" ? (opts.largeSystem ?? opts.system) : opts.system,
          input: opts.input,
          stream: true,
          store: false,
          max_output_tokens: MAX_ANSWER_TOKENS,
        },
        { signal: ac.signal },
      );
      for await (const ev of events) {
        if (ev.type === "response.output_text.delta") {
          clearTimeout(firstTimer);
          firstTimer = undefined;
          if (!onDelta(ev.delta)) {
            stop("escalate");
            break;
          }
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          usage = ev.response.usage ?? undefined;
          incomplete = ev.type === "response.incomplete";
        } else if (ev.type === "response.failed") {
          throw new Error(`response failed: ${ev.response.error?.code ?? "unknown"}`);
        }
      }
      // The SDK ends the iteration quietly when its request is aborted, so check why we stopped.
      if (reason) return { kind: reason };
      return { kind: "done", usage, incomplete };
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
  const small = await streamWithRetry(
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
  // A leading [[escalate]] from the large model is stripped by the marker parser like any other marker.
  const large = await streamWithRetry(
    "large",
    (d) => {
      deliver(parser.push(d));
      return true;
    },
    () => {},
  );
  return finish(large);
}
