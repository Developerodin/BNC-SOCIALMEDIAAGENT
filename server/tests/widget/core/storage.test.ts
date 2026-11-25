// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore, uiState } from "../../../widget/src/core/storage";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("tokenStore", () => {
  it("keeps the token per shop under askcart:<shop>:token", () => {
    tokenStore("a.myshopify.com").set("tok-a");
    expect(localStorage.getItem("askcart:a.myshopify.com:token")).toBe("tok-a");
    expect(tokenStore("a.myshopify.com").get()).toBe("tok-a");
    expect(tokenStore("b.myshopify.com").get()).toBeNull();
    tokenStore("a.myshopify.com").clear();
    expect(tokenStore("a.myshopify.com").get()).toBeNull();
  });

  it("falls back to memory when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    tokenStore("c.myshopify.com").set("tok-c");
    expect(tokenStore("c.myshopify.com").get()).toBe("tok-c");
  });

  it("a cleared token stays cleared when removeItem throws", () => {
    localStorage.setItem("askcart:d.myshopify.com:token", "old");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    tokenStore("d.myshopify.com").clear();
    expect(tokenStore("d.myshopify.com").get()).toBeNull();
  });

  it("works when localStorage itself throws on access", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    tokenStore("e.myshopify.com").set("tok-e");
    expect(tokenStore("e.myshopify.com").get()).toBe("tok-e");
  });
});

describe("uiState", () => {
  it("keeps open and teaserSeen per shop, and the per-visit teaser flag in sessionStorage", () => {
    const ui = uiState("f.myshopify.com");
    expect(ui.open.get()).toBe(false);
    ui.open.set(true);
    ui.teaserSeen.set(true);
    ui.teaserShownThisVisit.set(true);
    expect(uiState("f.myshopify.com").open.get()).toBe(true);
    expect(uiState("f.myshopify.com").teaserSeen.get()).toBe(true);
    expect(sessionStorage.getItem("askcart:f.myshopify.com:teaserShown")).toBe("1");
    // the stored key and JSON shape
    expect(JSON.parse(localStorage.getItem("askcart:f.myshopify.com:ui")!)).toEqual({ open: true, teaserSeen: true });
    expect(uiState("g.myshopify.com").open.get()).toBe(false);
    ui.open.set(false);
    expect(uiState("f.myshopify.com").open.get()).toBe(false);
    expect(uiState("f.myshopify.com").teaserSeen.get()).toBe(true);
  });

  it("reads what the launcher wrote, and survives a corrupt value", () => {
    localStorage.setItem("askcart:h.myshopify.com:ui", JSON.stringify({ open: true }));
    expect(uiState("h.myshopify.com").open.get()).toBe(true);
    localStorage.setItem("askcart:h.myshopify.com:ui", "{not json");
    expect(uiState("h.myshopify.com").open.get()).toBe(false);
    uiState("h.myshopify.com").teaserSeen.set(true);
    expect(uiState("h.myshopify.com").teaserSeen.get()).toBe(true);
  });
});
