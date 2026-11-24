// Guards for the MCP-only data path (stores.mode = 'mcp'): the per-turn time budget for catalog calls and a circuit
// breaker that honours Shopify's Retry-After by NOT calling (a turn never sleeps). All state is in memory and bounded.
// ponytail: per instance, like rate-limit.ts; N instances each learn about a 429 separately. Upgrade path: a shared store.

/** Total time one turn may spend waiting on catalog calls (search, lookup). TURN_LOCK in turn.ts is derived from it. */
export const MCP_BUDGET_MS = 5000;

const DEFAULT_COOLDOWN_MS = 10_000; // a 429 without a usable Retry-After
const MAX_COOLDOWN_MS = 60_000; // a hostile or buggy Retry-After can't switch a store off for long
const GLOBAL_FAILURES = 5; // consecutive failures, across stores, that open the global breaker
const GLOBAL_COOLDOWN_MS = 30_000;
const MAX_STORES = 500;

const storeUntil = new Map<string, number>();
let globalUntil = 0;
let failures = 0;

/** True while calling this store's catalog would only hit a limit or an outage we already know about. */
export function breakerOpen(shop: string, now = Date.now()): boolean {
  return now < globalUntil || now < (storeUntil.get(shop) ?? 0);
}

/** `retryAfter` is the Retry-After header in seconds, when Shopify sent a usable one. */
export type UcpOutcome = { kind: "ok" } | { kind: "rate_limited"; retryAfter?: number } | { kind: "failure" };

export function recordUcp(shop: string, o: UcpOutcome, now = Date.now()): void {
  if (o.kind === "ok") {
    failures = 0;
    return;
  }
  failures++;
  const wait = o.kind === "rate_limited" ? Math.min(MAX_COOLDOWN_MS, (o.retryAfter ?? 0) * 1000 || DEFAULT_COOLDOWN_MS) : 0;
  if (wait) {
    if (storeUntil.size >= MAX_STORES && !storeUntil.has(shop)) {
      for (const [k, v] of storeUntil) if (v <= now) storeUntil.delete(k);
      // Still full of live cooldowns: drop the oldest entry (a Map keeps insertion order) rather than grow.
      if (storeUntil.size >= MAX_STORES) storeUntil.delete(storeUntil.keys().next().value!);
    }
    storeUntil.set(shop, now + wait);
  }
  if (failures >= GLOBAL_FAILURES) {
    globalUntil = now + Math.max(GLOBAL_COOLDOWN_MS, wait);
    failures = 0;
  }
}

/** Tests only. */
export function resetUcpGuard(): void {
  storeUntil.clear();
  globalUntil = 0;
  failures = 0;
}

/** Tests only. */
export function ucpGuardSize(): number {
  return storeUntil.size;
}
