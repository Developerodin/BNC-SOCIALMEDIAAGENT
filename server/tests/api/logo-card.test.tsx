// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AppHome from "@/app/(embedded)/app/page";

// The "Chat widget" card shows a Logo setting (upload, preview, remove) where the Avatar URL field used to be.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const query = vi.fn(async () => ({ granted: ["write_files", "read_files"] as string[] }));
const request = vi.fn(async () => ({ result: "granted-all" as "granted-all" | "declined-all" }));
(globalThis as { shopify?: unknown }).shopify = { idToken: async () => "t", scopes: { query, request } };

const widget = (avatarUrl: string | null) => ({
  name: "Acme", accent: "#0A0A0A", avatarUrl, welcome: null, suggested: [], defaulted: [],
  launcher: { style: "pill", label: null, side: "right", scope: "all" },
  teaser: { enabled: false, text: null, delaySec: 5 },
});

let root: Root | null = null;
async function mount(avatarUrl: string | null, logo: (n: number) => Response = () => Response.json({ url: NEW })) {
  let logoCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/api/app/logo")) return logo(++logoCalls);
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
  query.mockReset().mockImplementation(async () => ({ granted: ["write_files", "read_files"] }));
  request.mockReset().mockImplementation(async () => ({ result: "granted-all" }));
});

const NEW = "https://cdn.shopify.com/s/files/1/0001/new.png";
const SCOPES = ["write_files", "read_files"];
async function pick(el: HTMLElement) {
  const input = el.querySelector('input[type="file"]')!;
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [png], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {});
}
const logoImg = (el: HTMLElement) => el.querySelector('img[alt="Your chat logo"]')?.getAttribute("src");

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

test("scopes already granted: uploads without opening the permission dialog", async () => {
  const el = await mount(null);
  await pick(el);
  expect(request).not.toHaveBeenCalled();
  expect(logoImg(el)).toBe(NEW);
});

test("scopes not granted yet: asks through App Bridge, then uploads once approved", async () => {
  query.mockResolvedValue({ granted: [] });
  const el = await mount(null);
  await pick(el);
  expect(request).toHaveBeenCalledWith(SCOPES);
  expect(logoImg(el)).toBe(NEW);
});

test("scopes not granted and the merchant declines: nothing is uploaded and the card says why", async () => {
  query.mockResolvedValue({ granted: [] });
  request.mockResolvedValue({ result: "declined-all" });
  let calls = 0;
  const el = await mount(null, () => (calls++, Response.json({ url: NEW })));
  await pick(el);
  expect(calls).toBe(0);
  expect(logoImg(el)).toBeUndefined();
  expect(el.textContent).toContain("Allow access to your store's files to upload a logo");
});

test("the route answers missing_scope although the check passed: asks once, retries once", async () => {
  const el = await mount(null, (n) => (n === 1 ? Response.json({ error: "missing_scope" }, { status: 403 }) : Response.json({ url: NEW })));
  await pick(el);
  expect(request).toHaveBeenCalledTimes(1);
  expect(logoImg(el)).toBe(NEW);
});

test("still missing_scope after the request: keeps the reopen-the-app message", async () => {
  let calls = 0;
  const el = await mount(null, () => (calls++, Response.json({ error: "missing_scope" }, { status: 403 })));
  await pick(el);
  expect(calls).toBe(2);
  expect(el.textContent).toContain("Approve the new permission to upload: reopen the app.");
});
