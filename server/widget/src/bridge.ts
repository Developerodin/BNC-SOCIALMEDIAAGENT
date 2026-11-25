// Cart bridge, hosted-page side (docs/embed.md). The chat page runs in the embed's iframe and can't reach the store's cart,
// so it asks the embedding page (embed.ts) to add the variant and waits for a reply. Everything here is a request, never
// trust: the parent only answers on a Shopify storefront, and every reply is checked for source, origin and nonce.
import type { CartResult } from "./cart";

export const ACK_TIMEOUT_MS = 2000; // a Shopify page acks at once; silence means "no bridge here"
export const DONE_TIMEOUT_MS = 15000; // after an ack the cart call is running: a slow theme cart gets this long

export type BridgeResult =
  | { kind: "done"; res: CartResult; origin: string }
  | { kind: "unconfirmed"; origin: string } // acked, but no final answer: the add may or may not have happened
  | null; // never acked: not a Shopify page, or an old embed.js

/**
 * Where to post. A message with a targetOrigin that doesn't match is dropped by the browser, so one post can't reach
 * "each allowed origin". The page that framed us is known from `ancestorOrigins` (Chrome, Safari) or `document.referrer`
 * (origin only, cross-site default policy); when it is on the allow-list we post to exactly that origin. Otherwise
 * (Firefox, a stripped referrer) we post once per allowed origin: the browser delivers only to the real parent's origin.
 */
function targets(allowed: string[]): string[] {
  let ref = "";
  try {
    ref = new URL(document.referrer).origin;
  } catch {}
  const anc = (location as { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins?.[0];
  const known = [anc, ref].find((o) => o && allowed.includes(o));
  return known ? [known] : allowed;
}

export function requestAdd(allowed: string[], variantId: string, qty: number): Promise<BridgeResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let ackOrigin = "";
    let timer: ReturnType<typeof setTimeout>;
    const done = (v: BridgeResult) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(v);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; id?: unknown; ok?: unknown; message?: unknown } | null;
      if (e.source !== window.parent || !allowed.includes(e.origin)) return;
      if (!d || typeof d !== "object" || d.id !== id) return;
      if (d.type === "askcart:received") {
        if (ackOrigin) return;
        ackOrigin = e.origin;
        clearTimeout(timer);
        timer = setTimeout(() => done({ kind: "unconfirmed", origin: ackOrigin }), DONE_TIMEOUT_MS);
        return;
      }
      if (d.type !== "askcart:added" || typeof d.ok !== "boolean") return;
      const message = typeof d.message === "string" && d.message.trim() ? d.message.slice(0, 300) : null;
      done({ kind: "done", res: d.ok ? { ok: true } : { ok: false, status: message ? 422 : 0, message }, origin: e.origin });
    };
    timer = setTimeout(() => done(null), ACK_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    for (const origin of targets(allowed)) window.parent.postMessage({ type: "askcart:add", id, variantId, qty }, origin);
  });
}
