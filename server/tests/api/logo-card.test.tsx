// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AppHome from "@/app/(embedded)/app/page";

// The "Chat widget" card shows a Logo setting (upload, preview, remove) where the Avatar URL field used to be.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { shopify?: unknown }).shopify = { idToken: async () => "t" };

const widget = (avatarUrl: string | null) => ({
  name: "Acme", accent: "#0A0A0A", avatarUrl, welcome: null, suggested: [], defaulted: [],
  launcher: { style: "pill", label: null, side: "right", scope: "all" },
  teaser: { enabled: false, text: null, delaySec: 5 },
});

let root: Root | null = null;
async function mount(avatarUrl: string | null) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body = url.includes("widget-settings") ? widget(avatarUrl) : url.includes("/me") ? { name: "Acme" } : url.includes("onboarding") ? { productBlockLink: null } : {};
    return Response.json(body);
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<AppHome />));
  await act(async () => {});
  return el;
}
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("with no logo: an Upload logo button, the help text, no preview and no Remove", async () => {
  const el = await mount(null);
  const text = el.textContent ?? "";
  expect(text).toContain("Logo");
  expect(text).toContain("Upload logo");
  expect(text).toContain("PNG, JPG or WebP, up to 2 MB. Leave empty to use your logo from Settings → Brand.");
  expect(text).not.toContain("Avatar URL");
  expect(el.querySelector('img[alt="Your chat logo"]')).toBeNull();
  expect([...el.querySelectorAll("s-button")].some((b) => b.textContent === "Remove")).toBe(false);
});

test("with a logo: a preview and a Remove button that clears it", async () => {
  const el = await mount("https://cdn.shopify.com/s/files/1/0001/logo.png");
  expect(el.querySelector('img[alt="Your chat logo"]')?.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/1/0001/logo.png");
  const remove = [...el.querySelectorAll("s-button")].find((b) => b.textContent === "Remove")!;
  await act(async () => remove.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(el.querySelector('img[alt="Your chat logo"]')).toBeNull();
});
