// The launcher's slice of the widget's UI state. Storage can throw (blocked storage, private modes), so every access
// is wrapped and the launcher then simply behaves as on a first visit.
// ponytail: Task 25's core/storage.ts `uiState(shop)` owns the same `askcart:<shop>:ui` key. Once it lands, switch the
// launcher to it if the 4 KB budget allows, so there is one reader/writer. The key and JSON shape must stay identical.
type Ui = { open?: boolean; teaserSeen?: boolean };

const key = (shop: string) => `askcart:${shop}:ui`;

export function readUi(shop: string): Ui {
  try {
    const v = JSON.parse(localStorage.getItem(key(shop)) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function writeUi(shop: string, patch: Ui): void {
  try {
    localStorage.setItem(key(shop), JSON.stringify({ ...readUi(shop), ...patch }));
  } catch {
    // memory only: the teaser may show again on the next page, which is harmless
  }
}

/** C28 "once per visit": sessionStorage lasts for the tab's visit. `mark` records that the teaser was shown. */
export function teaserShownThisVisit(shop: string, mark: boolean): boolean {
  const k = `askcart:${shop}:teaserShown`; // same key as Task 25's uiState().teaserShownThisVisit
  try {
    if (mark) sessionStorage.setItem(k, "1");
    return sessionStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}
