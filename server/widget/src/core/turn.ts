// One chat turn with its retries (Task 25, D81, Review Focus 5). Every attempt reuses the same requestId, so the server
// either answers once or replays the saved answer; it never answers twice.
//   - a network error, or a stream that ends without `done`: one retry after 1 s; the UI is told to `replace` the partial
//     bubble before the retried stream's first event,
//   - 409 (a turn is running): wait 2 s and retry, up to 30 s in total, then `busy`,
//   - 401/404 with a token: `reset` (the UI drops the token) and resend once without a token,
//   - 413: `too_long`; an `error` event: `unavailable` with the token it carries (`capped` for code daily_cap); anything else: `unavailable`.
// The server's first event is `meta` { conversationToken } (D84): passed on at once, so a Delete chat during the very
// first answer knows which conversation to delete.
import type { Card, WidgetApi } from "../../../src/lib/widget-contract";
import { parseSse } from "./sse";

export type TurnEvent =
  | { kind: "meta"; token: string }
  | { kind: "text"; delta: string }
  | { kind: "card"; card: Card }
  | { kind: "replace" }
  | { kind: "reset" };

export type TurnOutcome =
  | { kind: "done"; token: string; messageId: string | null }
  | { kind: "unavailable"; token: string | null }
  | { kind: "busy" }
  | { kind: "too_long" }
  | { kind: "capped"; token: string | null }
  | { kind: "offline" }
  | { kind: "aborted" };

export type SendArgs = Parameters<WidgetApi["send"]>[0];

const RETRY_MS = 1000;
const BUSY_MS = 2000;
const BUSY_MAX_MS = 30000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSend(
  api: WidgetApi,
  args: SendArgs,
  on: (e: TurnEvent) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<TurnOutcome> {
  const { signal } = args;
  let token = args.token;
  let retried = false;
  let busyMs = 0;
  let shown = false; // a previous attempt put something on screen

  // After the one retry: offline when the browser says so. Otherwise unavailable; a CORS refusal looks exactly like a
  // network error in the browser, so leave a hint for whoever debugs it.
  const failed = (): TurnOutcome => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { kind: "offline" };
    console.warn("AskCart: the chat request failed. If this persists, check that this store's domain is listed in the app.");
    return { kind: "unavailable", token };
  };

  for (;;) {
    if (signal?.aborted) return { kind: "aborted" };
    let res: Response;
    try {
      res = await api.send({ ...args, token });
    } catch {
      if (signal?.aborted) return { kind: "aborted" };
      if (retried) return failed();
      retried = true;
      await wait(RETRY_MS);
      continue;
    }

    if (res.status === 409) {
      if (busyMs >= BUSY_MAX_MS) return { kind: "busy" };
      await wait(BUSY_MS);
      busyMs += BUSY_MS;
      continue;
    }
    if ((res.status === 401 || res.status === 404) && token) {
      token = null;
      on({ kind: "reset" });
      continue;
    }
    if (res.status === 413) return { kind: "too_long" };
    if (!res.ok || !res.body) return { kind: "unavailable", token };

    if (shown) on({ kind: "replace" });
    try {
      for await (const { event, data } of parseSse(res.body)) {
        const d = (data ?? {}) as Record<string, unknown>;
        if (event === "meta") {
          if (typeof d.conversationToken === "string") on({ kind: "meta", token: d.conversationToken });
        } else if (event === "text" && typeof d.delta === "string") {
          shown = true;
          on({ kind: "text", delta: d.delta });
        } else if (event === "product") {
          shown = true;
          on({ kind: "card", card: d as unknown as Card });
        } else if (event === "done" && typeof d.conversationToken === "string") {
          // messageId arrives with Task 22; a replay or an older server may leave it out.
          return { kind: "done", token: d.conversationToken, messageId: typeof d.messageId === "string" ? d.messageId : null };
        } else if (event === "error") {
          const t = typeof d.conversationToken === "string" ? d.conversationToken : token;
          // The store's daily message cap (mcp stores): a rest-until-tomorrow line, not "unavailable" with a Retry.
          return d.code === "daily_cap" ? { kind: "capped", token: t } : { kind: "unavailable", token: t };
        }
      }
    } catch {
      // the stream broke: handled below like a stream that ended without `done`
    }
    if (signal?.aborted) return { kind: "aborted" };
    if (retried) return failed();
    retried = true;
    await wait(RETRY_MS);
  }
}
