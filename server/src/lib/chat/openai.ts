import type { ReasoningEffort } from "openai/resources/shared";
import OpenAI from "openai";

// One client per process, created on first use so importing this file needs no key.
// maxRetries: 0 (as in embeddings.ts): the chat code owns its retries and timeouts.
let client: OpenAI | null = null;
export function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  return client;
}

// Model names come from the environment (OPENAI_MODEL_SMALL / OPENAI_MODEL_LARGE), read per call.
export function chatModel(size: "small" | "large"): string {
  const name = size === "small" ? process.env.OPENAI_MODEL_SMALL : process.env.OPENAI_MODEL_LARGE;
  if (!name) throw new Error(`OPENAI_MODEL_${size.toUpperCase()} is not set`);
  return name;
}

/**
 * Reasoning effort per model size. Chat needs a fast first word, so the small model doesn't reason and the
 * large one reasons lightly. OPENAI_REASONING_SMALL / _LARGE override it (gpt-6.2-sol rejects "none").
 */
export function chatReasoning(size: "small" | "large"): { effort: ReasoningEffort } {
  const env = size === "small" ? process.env.OPENAI_REASONING_SMALL : process.env.OPENAI_REASONING_LARGE;
  return { effort: (env || (size === "small" ? "none" : "low")) as ReasoningEffort };
}

// An AbortSignal that fires after `ms` or when `parent` aborts, whichever is first.
// Uses setTimeout (not AbortSignal.timeout) so fake timers work in tests. Call clear() when done.
export function deadline(ms: number, parent?: AbortSignal): { signal: AbortSignal; expired: () => boolean; clear: () => void } {
  const ac = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    ac.abort();
  }, ms);
  const onParent = () => ac.abort();
  if (parent?.aborted) ac.abort();
  else parent?.addEventListener("abort", onParent, { once: true });
  return {
    signal: ac.signal,
    expired: () => expired,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

// HTTP status of an OpenAI error, if it has one (APIError.status); undefined for network errors.
export function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}
