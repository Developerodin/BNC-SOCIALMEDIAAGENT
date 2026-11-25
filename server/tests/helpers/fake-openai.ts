// A fake OpenAI Responses stream for chat tests (same behaviour as the one in tests/chat/answer.test.ts):
// aborting mid-iteration ends the iteration quietly, and aborting before the stream starts rejects.
export type Step = string | { error: unknown } | { hang: true };

export function fakeStream(
  steps: Step[],
  opts: { usage?: { input_tokens: number; output_tokens: number }; incomplete?: boolean; signals?: AbortSignal[]; bodies?: unknown[] } = {},
) {
  const usage = opts.usage ?? { input_tokens: 100, output_tokens: 20 };
  return async (body: unknown, { signal }: { signal: AbortSignal }) => {
    opts.signals?.push(signal);
    opts.bodies?.push(body);
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
      yield { type: opts.incomplete ? "response.incomplete" : "response.completed", response: { usage } };
    })();
  };
}

export const apiError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
