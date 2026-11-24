/** Requests allowed per key (one per partner token, or the legacy secret) per window; chat routes pass their own limits. */
export const PARTNER_LIMIT = 60;
const WINDOW_MS = 60_000;
// Above this many keys, expired windows are dropped on the next new key, so per-IP and per-customer keys don't pile up.
const SWEEP_ABOVE = 5_000;

const windows = new Map<string, { start: number; count: number }>();

/**
 * Fixed one-minute window per key (a token id, a hash of the legacy secret, or `web:`/`mobile:` ip and store keys from
 * src/lib/chat/cors.ts). Returns the seconds to wait when over the limit, or 0. `limit` defaults to the partner budget.
 * ponytail: the counts live in this process only, so N instances allow N × the limits and a restart resets them.
 * Fine for one store on one instance; move it to Postgres or Redis with the M10 deployment work.
 */
export function rateLimit(key: string, now = Date.now(), limit = PARTNER_LIMIT): number {
  const w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    if (!w && windows.size >= SWEEP_ABOVE) for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
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

/** Tests only. */
export function rateLimitSize(): number {
  return windows.size;
}
