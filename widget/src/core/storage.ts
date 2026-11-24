// Per-shop browser storage (Task 25, UD13). localStorage can throw (blocked storage, private modes, quota), so every
// access is wrapped, and a failed write or remove is kept in memory: the chat then works for this page but doesn't persist.
// The memory overlay is per page; another tab's later writes are not seen while an overlay entry exists (acceptable).

type Kind = "localStorage" | "sessionStorage";
const mem: Record<Kind, Map<string, string | null>> = { localStorage: new Map(), sessionStorage: new Map() };

function read(kind: Kind, key: string): string | null {
  const m = mem[kind];
  if (m.has(key)) return m.get(key)!;
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function write(kind: Kind, key: string, value: string | null): void {
  try {
    if (value === null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
    mem[kind].delete(key);
  } catch {
    mem[kind].set(key, value);
  }
}

export type Flag = { get(): boolean; set(on: boolean): void };

function flag(kind: Kind, key: string): Flag {
  return { get: () => read(kind, key) === "1", set: (on) => write(kind, key, on ? "1" : null) };
}

/** The conversation token, under askcart:<shop>:token. It is only ever sent to apiBase, never put in a URL. */
export function tokenStore(shop: string) {
  const key = `askcart:${shop}:token`;
  return {
    get: () => read("localStorage", key),
    set: (token: string) => write("localStorage", key, token),
    clear: () => write("localStorage", key, null),
  };
}

function uiField(key: string, field: "open" | "teaserSeen"): Flag {
  const all = (): Record<string, unknown> => {
    try {
      const v = JSON.parse(read("localStorage", key) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  };
  return { get: () => all()[field] === true, set: (on) => write("localStorage", key, JSON.stringify({ ...all(), [field]: on })) };
}

/**
 * UI state, shared with the launcher (widget/src/launcher/state.ts: same keys and JSON shape, keep them identical):
 * `open` (reopen the panel on the next page, UD13) and `teaserSeen` (C28: never show the teaser again once the chat was
 * opened or the teaser closed), both in askcart:<shop>:ui as JSON { open, teaserSeen }; and `teaserShownThisVisit`
 * (C28: once per visit), "1" in sessionStorage under askcart:<shop>:teaserShown.
 */
export function uiState(shop: string) {
  const key = `askcart:${shop}:ui`;
  return {
    open: uiField(key, "open"),
    teaserSeen: uiField(key, "teaserSeen"),
    teaserShownThisVisit: flag("sessionStorage", `askcart:${shop}:teaserShown`),
  };
}
