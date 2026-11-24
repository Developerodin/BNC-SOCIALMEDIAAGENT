import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { newStore } from "../helpers/seed";
import { sha256Hex } from "@/lib/partner/secrets";

// The hosted chat page (GET /chat/<shop>) and the one CORS addition that goes with it: our own https origin
// (SHOPIFY_APP_URL, https://test.example.com in vitest.config.ts) is allowed for any active store. Exercised through
// GET /api/faq, which needs no OpenAI.

let admin: ReturnType<typeof postgres>;
let page: typeof import("@/app/chat/[shop]/route");
let faq: typeof import("@/app/api/faq/route");
let cors: typeof import("@/lib/chat/cors");
let proxy: typeof import("@/proxy");
let client: typeof import("@/db/client");
let rl: typeof import("@/lib/rate-limit");
let shop: string;
let storeId: string;
const OWN = "https://test.example.com";
const SITE = "https://shop-a.example.com";

const chat = (s: string) => page.GET(new Request(`http://localhost/chat/${s}`), { params: Promise.resolve({ shop: s }) });
const faqReq = (h: Record<string, string>, s = shop) =>
  faq.GET(new Request(`http://localhost/api/faq?shop=${s}&product=42`, { headers: h }));

beforeAll(async () => {
  page = await import("@/app/chat/[shop]/route");
  faq = await import("@/app/api/faq/route");
  cors = await import("@/lib/chat/cors");
  proxy = await import("@/proxy");
  client = await import("@/db/client");
  rl = await import("@/lib/rate-limit");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  storeId = await newStore(admin);
  const [s] = await admin`update stores set domains = ${["shop-a.example.com"]}, name = ${'Tom\'s <b>"Shop"</b>'}, primary_locale = 'fr', settings = ${admin.json({ embedDomains: ["blog.example.org"] })} where id = ${storeId} returning shop_domain`;
  shop = s.shop_domain;
});
beforeEach(() => {
  rl.resetRateLimit();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

/** A new active store with these settings and domains; returns its shop domain. */
async function storeWith(settings: object, domains: string[] = []): Promise<string> {
  const id = await newStore(admin);
  const [s] = await admin`update stores set settings = ${admin.json(settings as never)}, domains = ${domains} where id = ${id} returning shop_domain`;
  return s.shop_domain;
}

// --- the page ---

test("an active store gets the chat page with its config and the hosted script", async () => {
  const res = await chat(shop);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain('<script src="/askcart-hosted.js" defer></script>');
  expect(html).toContain('<html lang="fr">');
  const json = html.match(/<script type="application\/json" id="askcart-data">(.*)<\/script>/)![1];
  const data = JSON.parse(json);
  expect(data.config).toMatchObject({ enabled: true, apiBase: OWN });
  expect(data.page).toMatchObject({ shop, locale: "fr", hosted: true });
});

test("store text can't break out of the title or the inline JSON", async () => {
  const html = await (await chat(shop)).text();
  expect(html).toContain("<title>Tom&#39;s &#60;b&#62;&#34;Shop&#34;&#60;/b&#62;</title>");
  const json = html.match(/<script type="application\/json" id="askcart-data">(.*)<\/script>/)![1];
  expect(json).not.toContain("<");
  expect(JSON.parse(json).config.name).toBe('Tom\'s <b>"Shop"</b>');
});

test.each(["evil.com", "a.myshopify.com.evil.com", "UPPER.myshopify.com", "a_b.myshopify.com"])("a malformed shop %s is a 404", async (s) => {
  expect((await chat(s)).status).toBe(404);
});

test("an unknown shop and an inactive store are 404", async () => {
  expect((await chat("nobody-here.myshopify.com")).status).toBe(404);
  const off = await newStore(admin, false);
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${off}`;
  expect((await chat(shop_domain)).status).toBe(404);
});

test("enabled: false in the widget settings is a 404", async () => {
  const id = await newStore(admin);
  const [{ shop_domain }] = await admin`update stores set settings = ${admin.json({ widget: { enabled: false } })} where id = ${id} returning shop_domain`;
  expect((await chat(shop_domain)).status).toBe(404);
});

test("without an https app URL the page says it isn't configured (503)", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  expect((await chat(shop)).status).toBe(503);
});

test("frame-ancestors lists the allowed sites and the store's own domains, nothing else", async () => {
  const csp = (await chat(shop)).headers.get("content-security-policy")!;
  expect(csp).toBe("frame-ancestors https://blog.example.org https://shop-a.example.com; script-src 'self'; object-src 'none'; base-uri 'none'");
});

test("with no allowed site the page is a 404 (embedding is off by default)", async () => {
  expect((await chat(await storeWith({}, ["shop-b.example.com"]))).status).toBe(404);
  expect((await chat(await storeWith({ embedDomains: [] }))).status).toBe(404);
});

test("the proxy leaves /chat/ to the route and keeps every other path unframable", () => {
  const csp = (p: string) => proxy.proxy(new NextRequest(`http://localhost${p}`)).headers.get("content-security-policy");
  expect(csp("/dash")).toBe("frame-ancestors 'none'");
  const matcher = new RegExp("^" + proxy.config.matcher[0] + "$");
  expect(matcher.test(`/chat/${shop}`)).toBe(false);
  expect(matcher.test("/dash")).toBe(true);
});

// --- CORS ---

test("our own origin is allowed for any active store, and echoed back", async () => {
  const res = await faqReq({ origin: OWN });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe(OWN);
  expect(res.headers.get("vary")).toBe("Origin");
});

test("a same-origin GET (no Origin header, Sec-Fetch-Site same-origin) is allowed; cross-site or bare is not", async () => {
  expect((await faqReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })).status).toBe(200);
  expect((await faqReq({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })).status).toBe(403);
  expect((await faqReq({})).status).toBe(403);
});

test("Sec-Fetch-Site is trusted for GET only: the same headers on a POST are refused", () => {
  const h = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  const store = { domains: [], settings: { embedDomains: ["partner.example.com"] } };
  expect(cors.corsFor(new Request("http://x/api/chat", { method: "GET", headers: h }), store)).toEqual({});
  expect(cors.corsFor(new Request("http://x/api/chat", { method: "POST", headers: h }), store)).toBeNull();
});

test("our own origin is refused for an active store with no allowed embedding site, even with domains listed", async () => {
  const empty = await storeWith({}, ["shop-c.example.com"]);
  expect((await faqReq({ origin: OWN }, empty)).status).toBe(403);
  expect((await faqReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, empty)).status).toBe(403);
  expect((await faqReq({ origin: "https://shop-c.example.com" }, empty)).status).toBe(200); // its own site still works
  const none = await newStore(admin);
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${none}`;
  expect((await faqReq({ origin: OWN }, shop_domain)).status).toBe(403);
});

test("Sec-Fetch-Site alone is not enough: Sec-Fetch-Mode must come with it", async () => {
  expect((await faqReq({ "sec-fetch-site": "same-origin" })).status).toBe(403);
});

test("our own origin does not get an unknown or inactive store", async () => {
  expect((await faqReq({ origin: OWN }, "nobody-here.myshopify.com")).status).toBe(404);
});

test("other origins are still refused: look-alikes, http, and a store's own domain on another store", async () => {
  for (const origin of ["https://evil.example.com", "http://test.example.com", "https://test.example.com.evil.com", "https://sub.test.example.com"]) {
    expect((await faqReq({ origin })).status, origin).toBe(403);
  }
  const other = await newStore(admin);
  const [{ shop_domain }] = await admin`select shop_domain from stores where id = ${other}`;
  expect((await faqReq({ origin: SITE }, shop_domain)).status).toBe(403);
});

test("the store's own website still works exactly as before", async () => {
  const res = await faqReq({ origin: SITE });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
});

test("with no https app URL the own-origin path is off (the Sec-Fetch-Site path too)", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "");
  vi.stubEnv("APP_URL", "");
  expect((await faqReq({ origin: OWN })).status).toBe(403);
  expect((await faqReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })).status).toBe(403);
  expect((await faqReq({ origin: SITE })).status).toBe(200);
});

test("the mobile key path is untouched: a wrong key is refused, a valid one works, and it is still rate limited", async () => {
  const key = "ackm_test-key";
  const mobile = await storeWith({});
  await admin`update stores set mobile_key_hash = ${sha256Hex(key)} where shop_domain = ${mobile}`;
  expect((await faqReq({ "x-askcart-app-key": "ackm_wrong" }, mobile)).status).toBe(403);
  // A browser-style header next to the key changes nothing: no Origin, so the key path is taken (embedding is off here).
  expect((await faqReq({ "x-askcart-app-key": key, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, mobile)).status).toBe(200);
  const ip = { "x-askcart-app-key": key, "x-forwarded-for": "9.9.9.9" };
  let last = 200;
  for (let i = 0; i < cors.MOBILE_IP_LIMIT + 1; i++) last = (await faqReq(ip, mobile)).status;
  expect(last).toBe(429);
});

test("preflight: our own origin gets 204 with the origin echoed, a stranger still 403", async () => {
  const pre = (origin: string) => cors.preflight(new Request("http://localhost/api/chat", { method: "OPTIONS", headers: { origin } }));
  const ok = await pre(OWN);
  expect(ok.status).toBe(204);
  expect(ok.headers.get("access-control-allow-origin")).toBe(OWN);
  expect((await pre(SITE)).status).toBe(204); // listed by the store above
  expect((await pre("https://evil.example.com")).status).toBe(403);
});
