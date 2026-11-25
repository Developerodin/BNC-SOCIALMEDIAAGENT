// What Shopify last said about a store's Admin API cost bucket (`extensions.cost.throttleStatus`: points available, and
// points restored per second), so background work (the product-sync worker) can wait for it to refill instead of spending
// its retries on THROTTLED errors. The chat's live check draws from the same bucket.
// ponytail: per process, one entry per store, from the last response seen. With several instances each knows only its own
// calls; the wait is a hint, a throttled read still fails normally and pg-boss retries it.

type Status = { available: number; rate: number; at: number };
const last = new Map<string, Status>();

const DEFAULT_RESTORE_RATE = 50; // points per second for a standard plan

/** Records the throttle status of a response (or of a THROTTLED error: `available: 0`). Ignores a response without one. */
export function recordThrottle(storeId: string, cost: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } | undefined, now = Date.now()): void {
  const t = cost?.throttleStatus;
  if (typeof t?.currentlyAvailable !== "number") return;
  last.set(storeId, { available: t.currentlyAvailable, rate: t.restoreRate && t.restoreRate > 0 ? t.restoreRate : DEFAULT_RESTORE_RATE, at: now });
}

/** Records that the store's last call was THROTTLED, so the bucket is taken as empty from now. */
export function recordThrottled(storeId: string, now = Date.now()): void {
  last.set(storeId, { available: 0, rate: last.get(storeId)?.rate ?? DEFAULT_RESTORE_RATE, at: now });
}

/** Milliseconds until the bucket is estimated to hold `floor` points again (0 when it already does, or nothing is known). */
export function throttleWaitMs(storeId: string, floor: number, now = Date.now()): number {
  const s = last.get(storeId);
  if (!s) return 0;
  const have = s.available + (s.rate * (now - s.at)) / 1000;
  return have >= floor ? 0 : Math.ceil(((floor - have) / s.rate) * 1000);
}

/** Tests only. */
export function resetThrottle(): void {
  last.clear();
}
