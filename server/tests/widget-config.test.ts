import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "./helpers/seed";

vi.mock("@/lib/shopify/admin", () => ({ adminGraphql: vi.fn() }));

let admin: ReturnType<typeof postgres>;
let wc: typeof import("@/lib/widget-config");
let client: typeof import("@/db/client");
let gql: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  wc = await import("@/lib/widget-config");
  client = await import("@/db/client");
  gql = (await import("@/lib/shopify/admin")).adminGraphql as unknown as ReturnType<typeof vi.fn>;
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

beforeEach(() => {
  gql.mockReset();
  vi.unstubAllEnvs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const API = "https://app.example.com";

test("buildWidgetConfig fills every default from empty settings", () => {
  expect(wc.buildWidgetConfig({ settings: {}, name: "Acme" }, API)).toEqual({
    v: 1,
    enabled: true,
    apiBase: API,
    name: "Acme",
    accent: "#0A0A0A",
    avatarUrl: null,
    launcher: { style: "pill", label: null, side: "right", offset: 20, scope: "all" },
    welcome: "Hi! I can help you find products, compare options and answer questions about orders and shipping.",
    suggested: ["What's popular right now?", "Help me find a gift", "What's your return policy?", "Do you ship to my country?"],
    teaser: { enabled: false, text: null, delaySec: 8 },
    stockThreshold: 5,
    retentionDays: 30,
  });
});

test("default welcome and questions follow the store's locale; unknown locales and null get English", () => {
  const of = (primaryLocale: string | null) => wc.buildWidgetConfig({ settings: {}, name: "Acme", primaryLocale }, API);
  expect(of("fr-CA").welcome).toMatch(/^Bonjour/);
  expect(of("DE").suggested[0]).toBe("Was ist gerade beliebt?");
  for (const l of ["es", "it", "nl"]) expect(of(l).suggested).toHaveLength(4);
  expect(of("ja").welcome).toMatch(/^Hi!/);
  expect(of(null).welcome).toMatch(/^Hi!/);
});

test("suggested: absent gets the defaults, an explicit empty list stays empty, merchant text is never localized", () => {
  const fr = (widget: object) => wc.buildWidgetConfig({ settings: { widget }, name: "Acme", primaryLocale: "fr" }, API);
  expect(fr({}).suggested).toHaveLength(4);
  expect(fr({ suggested: [] }).suggested).toEqual([]);
  expect(fr({ suggested: ["Sizes?"], welcome: "Hello" })).toMatchObject({ suggested: ["Sizes?"], welcome: "Hello" });
  const r = wc.resolveWidgetConfig({ settings: { widget: { suggested: [], welcome: "Hello" } }, name: "Acme" }, API);
  expect(r.defaulted).not.toContain("suggested");
  expect(r.defaulted).not.toContain("welcome");
  expect(r.defaulted).toContain("accent");
});

test("buildWidgetConfig keeps valid merchant values", () => {
  const settings = {
    stockThreshold: 3,
    retentionDays: 90,
    widget: {
      enabled: false,
      name: "Help",
      accent: "#ff00AA",
      avatarUrl: "https://cdn.shopify.com/s/files/1/logo.png",
      launcher: { style: "icon", label: "Ask", side: "left", offset: 120, scope: "product" },
      welcome: "Hi there",
      suggested: ["Sizes?", "Shipping?"],
      teaser: { enabled: true, text: "Need help?", delaySec: 30 },
    },
  };
  expect(wc.buildWidgetConfig({ settings, name: "Acme" }, API)).toEqual({
    v: 1,
    enabled: false,
    apiBase: API,
    name: "Help",
    accent: "#ff00AA",
    avatarUrl: "https://cdn.shopify.com/s/files/1/logo.png",
    launcher: { style: "icon", label: "Ask", side: "left", offset: 120, scope: "product" },
    welcome: "Hi there",
    suggested: ["Sizes?", "Shipping?"],
    teaser: { enabled: true, text: "Need help?", delaySec: 30 },
    stockThreshold: 3,
    retentionDays: 90,
  });
});

test("buildWidgetConfig replaces each bad value with its default, logs it, and never throws", () => {
  const settings = {
    retentionDays: 7,
    widget: {
      enabled: "yes",
      name: "x".repeat(41),
      accent: "red",
      avatarUrl: "https://evil.com/a.png",
      launcher: { style: "big", label: "y".repeat(41), side: "top", offset: 500, scope: "everywhere" },
      welcome: "z".repeat(301),
      suggested: ["ok", 5, "q".repeat(121), "a", "b", "c"],
      teaser: { enabled: 1, text: 42, delaySec: -1 },
    },
  };
  const cfg = wc.buildWidgetConfig({ settings, name: "Acme" }, API);
  expect(cfg).toMatchObject({
    enabled: true,
    name: "Acme",
    accent: "#0A0A0A",
    avatarUrl: null,
    launcher: { style: "pill", label: null, side: "right", offset: 20, scope: "all" },
    welcome: "Hi! I can help you find products, compare options and answer questions about orders and shipping.",
    suggested: ["ok", "a", "b", "c"],
    teaser: { enabled: false, text: null, delaySec: 8 },
    retentionDays: 30,
  });
  expect(console.warn).toHaveBeenCalled();
});

test("launcher.scope: none and product are kept, anything else or missing is all and recorded as defaulted", () => {
  const of = (launcher: unknown) => wc.resolveWidgetConfig({ settings: { widget: { launcher } }, name: "Acme" }, API);
  expect(of({ scope: "none" }).config.launcher.scope).toBe("none");
  expect(of({ scope: "product" }).config.launcher.scope).toBe("product");
  expect(of({ scope: "product" }).defaulted).not.toContain("launcher.scope");
  for (const bad of [undefined, null, "", "everywhere", 1]) {
    const r = of({ scope: bad });
    expect(r.config.launcher.scope).toBe("all");
    expect(r.defaulted).toContain("launcher.scope");
  }
  expect(of({ scope: "everywhere" }).rejected).toContain("launcher.scope");
  expect(of({}).rejected).not.toContain("launcher.scope");
});

test("buildWidgetConfig rejects avatars that only look like the Shopify CDN", () => {
  for (const avatarUrl of ["http://cdn.shopify.com/a.png", "https://cdn.shopify.com.evil.com/a.png", "https://evil.com/https://cdn.shopify.com/"]) {
    expect(wc.buildWidgetConfig({ settings: { widget: { avatarUrl } }, name: "Acme" }, API).avatarUrl).toBeNull();
  }
});

test("buildWidgetConfig survives non-object settings", () => {
  for (const settings of [null, "x", { widget: "x" }, { widget: { launcher: 3, teaser: null } }]) {
    expect(wc.buildWidgetConfig({ settings, name: null }, API)).toMatchObject({ enabled: true, name: "", accent: "#0A0A0A" });
  }
});

test("merchant text with markup is kept as plain text for Liquid to escape (Review Focus 2)", () => {
  const welcome = '"></div><script>alert(1)</script>';
  expect(wc.buildWidgetConfig({ settings: { widget: { welcome } }, name: "Acme" }, API).welcome).toBe(welcome);
});

// --- syncWidgetConfig ---

const INSTALL = { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } };
const SET_OK = { metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/9" }], userErrors: [] } };

async function store() {
  const id = await newStore(admin);
  await admin`update stores set name = 'Acme' where id = ${id}`;
  return id;
}

test("syncWidgetConfig writes the config to the app installation metafield and saves the hash", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", API);
  const id = await store();
  gql.mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);

  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  expect(gql).toHaveBeenCalledTimes(2);
  expect(gql.mock.calls[0][2]).toMatch(/currentAppInstallation\s*\{\s*id\s*\}/);
  const [input] = gql.mock.calls[1][3].metafields;
  expect(input).toMatchObject({ ownerId: "gid://shopify/AppInstallation/1", namespace: "askcart", key: "widget", type: "json" });
  expect(JSON.parse(input.value)).toMatchObject({ v: 1, enabled: true, apiBase: API, name: "Acme" });
  const [s] = await admin`select widget_config_hash from stores where id = ${id}`;
  expect(s.widget_config_hash).toMatch(/^[0-9a-f]{64}$/);
});

test("an unchanged config makes no Admin call", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", API);
  const id = await store();
  gql.mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);
  await wc.syncWidgetConfig(id, "acme.myshopify.com");
  gql.mockReset();

  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  expect(gql).not.toHaveBeenCalled();
});

test("a changed apiBase (a new tunnel) writes again", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", API);
  const id = await store();
  gql.mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);
  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  vi.stubEnv("SHOPIFY_APP_URL", "https://new-tunnel.example.com/");
  gql.mockReset().mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);
  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  expect(gql).toHaveBeenCalledTimes(2);
  expect(JSON.parse(gql.mock.calls[1][3].metafields[0].value).apiBase).toBe("https://new-tunnel.example.com");
});

test("APP_URL (set by shopify app dev) is used when SHOPIFY_APP_URL is empty", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "");
  vi.stubEnv("APP_URL", "https://tunnel.example.com");
  const id = await store();
  gql.mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);

  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  expect(JSON.parse(gql.mock.calls[1][3].metafields[0].value).apiBase).toBe("https://tunnel.example.com");
});

test("a non-https app URL writes nothing", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "http://localhost:3000");
  const id = await store();

  await wc.syncWidgetConfig(id, "acme.myshopify.com");

  expect(gql).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalled();
});

test("userErrors from metafieldsSet are logged, the hash isn't saved, and nothing throws", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", API);
  const id = await store();
  gql.mockResolvedValueOnce(INSTALL).mockResolvedValueOnce({ metafieldsSet: { metafields: [], userErrors: [{ field: ["metafields", "0", "value"], message: "bad" }] } });

  await expect(wc.syncWidgetConfig(id, "acme.myshopify.com")).resolves.toBeUndefined();

  expect(console.error).toHaveBeenCalled();
  const [s] = await admin`select widget_config_hash from stores where id = ${id}`;
  expect(s.widget_config_hash).toBeNull();
});

test("a failed Admin call (throttled, expired token) is logged and retried on the next load", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", API);
  const id = await store();
  gql.mockRejectedValueOnce(new Error("Throttled"));

  await expect(wc.syncWidgetConfig(id, "acme.myshopify.com")).resolves.toBeUndefined();
  const [s] = await admin`select widget_config_hash from stores where id = ${id}`;
  expect(s.widget_config_hash).toBeNull();

  gql.mockReset().mockResolvedValueOnce(INSTALL).mockResolvedValueOnce(SET_OK);
  await wc.syncWidgetConfig(id, "acme.myshopify.com");
  expect(gql).toHaveBeenCalledTimes(2);
});
