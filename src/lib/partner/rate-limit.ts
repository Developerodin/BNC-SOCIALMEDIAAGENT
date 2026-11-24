/** Requests allowed per key (one per token, or the legacy secret) per window. */
export const PARTNER_LIMIT = 60;
const WINDOW_MS = 60_000;

const windows = new Map<string, { start: number; count: number }>();

/**
 * Fixed one-minute window per key (a token id, or a hash of the legacy secret). Returns the seconds to wait when over the limit, or 0.
 * `limit` defaults to the partner budget; the mobile app key path (src/lib/chat/cors.ts) passes its own, under `mobile:` keys.
 * ponytail: the counts live in this process only, so N instances allow N × 60 per minute and a restart resets them.
 * Fine for one partner on one instance; move it to Postgres or Redis with the M10 deployment work.
 */
export function rateLimit(key: string, now = Date.now(), limit = PARTNER_LIMIT): number {
  const w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    windows.set(key, { start: now, count: 1 });
    return 0;
  }
  if (w.count >= limit) return Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  w.count++;
  return 0;
}

/** Tests only. */
export function resetRateLimit(): void {
  windows.clear();
}
