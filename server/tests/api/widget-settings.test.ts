import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// The admin API behind the "Chat widget" card: /api/app/widget-settings.

let current: string;
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: current, shop: "x.myshopify.com" };
  }),
}));
vi.mock("@/lib/widget-config", async (orig) => ({
  ...(await orig<typeof import("@/lib/widget-config")>()),
  syncWidgetConfig: vi.fn(async () => {}),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/widget-settings/route");
let client: typeof import("@/db/client");
let sync: ReturnType<typeof vi.fn>;

const call = (method: "GET" | "PUT", body?: unknown, auth = true) =>
  route[method](
    new Request("http://x/api/app/widget-settings", {
      method,
      headers: auth ? { authorization: "Bearer t" } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const stored = async () => (await admin`select settings from stores where id = ${current}`)[0].settings;

beforeAll(async () => {
  route = await import("@/app/api/app/widget-settings/route");
  client = await import("@/db/client");
  sync = (await import("@/lib/widget-config")).syncWidgetConfig as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  current = await newStore(admin);
});
beforeEach(async () => {
  sync.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await admin`update stores set settings = ${admin.json({ stockThreshold: 7, embedDomains: ["a.com"] })}, name = 'Acme', primary_locale = 'en' where id = ${current}`;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("both methods need the embedded session", async () => {
  expect((await call("GET", undefined, false)).status).toBe(401);
  expect((await call("PUT", {}, false)).status).toBe(401);
  expect(sync).not.toHaveBeenCalled();
});

test("GET shows the defaults, flagged as defaults, in the store's language", async () => {
  const body = await (await call("GET")).json();
  expect(body).toMatchObject({ name: "Acme", accent: "#0A0A0A", launcher: { style: "pill", side: "right", scope: "all" }, teaser: { enabled: false } });
  expect(body.welcome).toMatch(/^Hi!/);
  expect(body.suggested).toHaveLength(4);
  expect(body.defaulted).toEqual(expect.arrayContaining(["name", "accent", "welcome", "suggested", "launcher.style", "launcher.scope"]));
  expect(body.defaulted).not.toContain("enabled"); // not a field this card edits
  await admin`update stores set primary_locale = 'de' where id = ${current}`;
  expect((await (await call("GET")).json()).welcome).toMatch(/^Hallo/);
});

test("PUT saves, merges into settings.widget, keeps other settings keys, and syncs the theme widget", async () => {
  await admin`update stores set settings = ${admin.json({ stockThreshold: 7, widget: { enabled: false, accent: "#112233" } })} where id = ${current}`;
  const res = await call("PUT", {
    name: "  Help desk ",
    launcher: { style: "icon", label: "", side: "left", scope: "product" },
    suggested: [" Sizes? "],
    teaser: { enabled: true, text: "Need help?", delaySec: 30 },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ name: "Help desk", accent: "#112233", launcher: { style: "icon", side: "left", scope: "product" }, suggested: ["Sizes?"], teaser: { enabled: true, delaySec: 30 } });
  const s = await stored();
  expect(s.stockThreshold).toBe(7);
  expect(s.widget).toMatchObject({ enabled: false, accent: "#112233", name: "Help desk", launcher: { style: "icon", side: "left", scope: "product" } });
  expect(s.widget.launcher).not.toHaveProperty("label");
  expect(sync).toHaveBeenCalledWith(current, "x.myshopify.com");
});

test("PUT rejects bad values with per-field errors, saves nothing and does not sync", async () => {
  const res = await call("PUT", {
    accent: "red",
    avatarUrl: "https://evil.com/a.png",
    launcher: { style: "big", scope: "everywhere" },
    suggested: ["a", "b", "c", "d", "e"],
    teaser: { delaySec: 500 },
  });
  expect(res.status).toBe(400);
  const { errors } = await res.json();
  expect(Object.keys(errors).sort()).toEqual(["accent", "avatarUrl", "launcher.scope", "launcher.style", "suggested", "teaser.delaySec"]);
  expect(await stored()).toEqual({ stockThreshold: 7, embedDomains: ["a.com"] });
  expect(sync).not.toHaveBeenCalled();
  for (const bad of ["[]", "not json", ""]) expect((await call("PUT", bad)).status).toBe(400);
});

test("PUT: a value equal to the default is not stored; an empty suggested list is", async () => {
  const defaults = await (await call("GET")).json();
  await call("PUT", { welcome: defaults.welcome, suggested: defaults.suggested, accent: "#0A0A0A" });
  expect((await stored()).widget).toEqual({}); // still follows the localized defaults
  await call("PUT", { suggested: [] });
  expect((await stored()).widget).toEqual({ suggested: [] });
  expect((await (await call("GET")).json()).suggested).toEqual([]);
});

test("PUT reset clears the card's fields but not other widget or settings keys", async () => {
  await admin`update stores set settings = ${admin.json({ stockThreshold: 7, widget: { enabled: false, name: "X", launcher: { side: "left" }, suggested: [] } })} where id = ${current}`;
  const res = await call("PUT", { reset: true });
  expect(res.status).toBe(200);
  expect((await res.json()).defaulted).toEqual(expect.arrayContaining(["name", "suggested"]));
  expect(await stored()).toEqual({ stockThreshold: 7, widget: { enabled: false } });
  expect(sync).toHaveBeenCalledTimes(1);
});

test("PUT over the body cap is a 413", async () => {
  expect((await call("PUT", { welcome: "x".repeat(9000) })).status).toBe(413);
});
