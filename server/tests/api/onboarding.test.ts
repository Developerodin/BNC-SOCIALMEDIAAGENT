import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// The admin home's setup guide state (stores.settings.onboarding).

let embeddedStore: string;
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: embeddedStore, shop: "x.myshopify.com" };
  }),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/onboarding/route");
let client: typeof import("@/db/client");
let store: string;

const req = (method: string, body?: unknown, auth = true) =>
  new Request("http://x/api/app/onboarding", {
    method,
    headers: auth ? { authorization: "Bearer t" } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  route = await import("@/app/api/app/onboarding/route");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  store = await newStore(admin);
  embeddedStore = store;
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("needs the embedded session", async () => {
  expect((await route.GET(req("GET", undefined, false))).status).toBe(401);
  expect((await route.POST(req("POST", { action: "dismiss" }, false))).status).toBe(401);
});

test("GET starts with nothing done and the theme link built from the API key", async () => {
  vi.stubEnv("SHOPIFY_API_KEY", "key123");
  const body = await (await route.GET(req("GET"))).json();
  expect(body).toEqual({
    chatConfirmed: false,
    dismissed: false,
    themeLink: "https://x.myshopify.com/admin/themes/current/editor?context=apps&template=index&activateAppId=key123/askcart-embed",
    productBlockLink: "https://x.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=key123/askcart-ask-ai&target=newAppsSection",
  });
});

test("themeLink is null when the API key is unset", async () => {
  vi.stubEnv("SHOPIFY_API_KEY", "");
  const body = await (await route.GET(req("GET"))).json();
  expect(body.themeLink).toBeNull();
  expect(body.productBlockLink).toBeNull();
});

test("confirm and dismiss persist without clobbering other settings keys", async () => {
  await admin`update stores set settings = ${admin.json({ embedDomains: ["a.example.com"], searchProvider: "x" })} where id = ${store}`;

  expect(await (await route.POST(req("POST", { action: "confirm_chat" }))).json()).toEqual({ chatConfirmed: true, dismissed: false });
  expect(await (await route.POST(req("POST", { action: "dismiss" }))).json()).toEqual({ chatConfirmed: true, dismissed: true });
  const [{ settings: first }] = await admin`select settings from stores where id = ${store}`;
  expect(first.embedDomains).toEqual(["a.example.com"]);
  expect(first.searchProvider).toBe("x");

  // A repeat keeps the first timestamp.
  await route.POST(req("POST", { action: "confirm_chat" }));
  const [{ settings: again }] = await admin`select settings from stores where id = ${store}`;
  expect(again.onboarding.chatConfirmedAt).toBe(first.onboarding.chatConfirmedAt);

  expect(await (await route.GET(req("GET"))).json()).toMatchObject({ chatConfirmed: true, dismissed: true });
});

test("an unknown action, a missing one or a bad body is a 400; an oversized body is 413", async () => {
  for (const body of [{ action: "nope" }, { action: "__proto__" }, {}, "not json"]) {
    expect((await route.POST(req("POST", body))).status).toBe(400);
  }
  expect((await route.POST(req("POST", { action: "x".repeat(500) }))).status).toBe(413);
});
