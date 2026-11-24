// Query-string checks for the partner routes. Each returns the parsed value or an error string for a 400.

export type OrdersFilter =
  | { mode: "incremental"; updatedSince: string }
  | { mode: "backfill"; createdFrom: string; createdTo: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,1024}$/;

function validDate(s: string): boolean {
  // Round-trips only for a real calendar day (rejects 2026-02-30).
  return DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

/** A Shopify cursor is opaque base64; anything else is a 400, not a Shopify error. */
export function parseCursor(q: URLSearchParams): string | null | { error: string } {
  const c = q.get("cursor");
  if (c === null) return null;
  return CURSOR.test(c) ? c : { error: "invalid_cursor" };
}

/** Exactly one mode: `updatedSince` (incremental) or `createdFrom` + `createdTo` (backfill). */
export function parseOrdersFilter(q: URLSearchParams): OrdersFilter | { error: string } {
  const since = q.get("updatedSince");
  const from = q.get("createdFrom");
  const to = q.get("createdTo");
  if (since !== null && (from !== null || to !== null)) return { error: "one_mode_only" };
  if (since !== null) {
    if (!DATETIME.test(since) || Number.isNaN(Date.parse(since))) return { error: "invalid_updatedSince" };
    return { mode: "incremental", updatedSince: new Date(since).toISOString() };
  }
  if (from === null && to === null) return { error: "mode_required" };
  if (from === null || !validDate(from)) return { error: "invalid_createdFrom" };
  if (to === null || !validDate(to)) return { error: "invalid_createdTo" };
  if (from > to) return { error: "createdFrom_after_createdTo" };
  return { mode: "backfill", createdFrom: from, createdTo: to };
}
