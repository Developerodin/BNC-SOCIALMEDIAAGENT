import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";

// The admin's "Connect your website" check. DNS and https are mocked, so no test touches the network.

let embeddedStore: string;
const embeddedShop = "mine.myshopify.com";
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: embeddedStore, shop: embeddedShop };
  }),
}));

type Reply = { status?: number; headers?: Record<string, string>; body?: string; drip?: boolean };
const dnsAnswers = new Map<string, string[]>();
const replies = new Map<string, Reply | "error">();
const lookup = vi.fn(async (host: string) => {
  if (host === "slowdns.com") return new Promise<never>(() => {}); // never answers
  const a = dnsAnswers.get(host);
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
});
vi.mock("node:dns/promises", () => ({ lookup: (h: string) => lookup(h) }));
const connects: { host: string; servername: string; hostHeader: string; path: string }[] = [];
let destroyed = 0;
vi.mock("node:https", () => ({
  request: (opts: { host: string; servername: string; path: string; headers: Record<string, string> }, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    let drip: ReturnType<typeof setInterval> | undefined;
    req.destroy = () => {
      destroyed++;
      clearInterval(drip);
    };
    req.end = () => {
      connects.push({ host: opts.host, servername: opts.servername, hostHeader: opts.headers.Host, path: opts.path });
      const r = replies.get(opts.servername);
      if (!r || r === "error") return void queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED")));
      const res = Object.assign(new EventEmitter(), { statusCode: r.status ?? 200, headers: r.headers ?? {}, destroy() {} });
      cb(res);
      if (r.drip) {
        // A hostile server: one byte every 3 s, never finishing. Each byte would reset an idle timeout.
        drip = setInterval(() => res.emit("data", Buffer.from("x")), 3000);
        return;
      }
      queueMicrotask(() => {
        res.emit("data", Buffer.from(r.body ?? ""));
        res.emit("end");
      });
    };
    return req;
  },
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/website-check/route");
let lib: typeof import("@/lib/website-check");
let rl: typeof import("@/lib/partner/rate-limit");
let client: typeof import("@/db/client");
let store: string;

const post = (url: unknown, auth = true) =>
  route.POST(new Request("http://x/api/app/website-check", { method: "POST", body: JSON.stringify({ url }), headers: auth ? { authorization: "Bearer t" } : {} }));
const get = (auth = true) => route.GET(new Request("http://x/api/app/website-check", { headers: auth ? { authorization: "Bearer t" } : {} }));

beforeAll(async () => {
  process.env.SHOPIFY_API_KEY = "key123";
  process.env.SHOPIFY_APP_URL = "https://app.askcart.test";
  route = await import("@/app/api/app/website-check/route");
  lib = await import("@/lib/website-check");
  rl = await import("@/lib/partner/rate-limit");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  store = await newStore(admin);
  await admin`update stores set domains = ${["mine.myshopify.com", "brand.com", "www.brand.com"]} where id = ${store}`;
  embeddedStore = store;
});
beforeEach(() => {
  rl.resetRateLimit();
  dnsAnswers.clear();
  replies.clear();
  connects.length = 0;
  lookup.mockClear();
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("needs the embedded session", async () => {
  expect((await post("brand.com", false)).status).toBe(401);
  expect((await get(false)).status).toBe(401);
});

test("GET suggests the first domain that isn't the myshopify one", async () => {
  expect(await (await get()).json()).toEqual({ domain: "brand.com" });
});

test("normalises to a lowercase hostname", () => {
  expect(lib.normalizeHost("Brand.com")).toBe("brand.com");
  expect(lib.normalizeHost("  https://WWW.Brand.com/path?x=1#y ")).toBe("www.brand.com");
  expect(lib.normalizeHost("http://brand.com/")).toBe("brand.com");
  expect(lib.normalizeHost("https://xn--bcher-kva.com/")).toBe("xn--bcher-kva.com");
});

test.each([
  "", "localhost", "http://localhost/", "127.0.0.1", "https://10.0.0.1/", "[::1]", "https://[::1]/", "2130706433", "0x7f.1",
  "brand.com:8443", "https://brand.com:444/", "https://user:pw@brand.com/", "ftp://brand.com", "file:///etc/passwd", "javascript:alert(1)",
  "foo.local", "db.internal", "x.localhost", "brand", "a b.com", "-brand.com", "brand.123", ".com",
  "shop.lan", "a.corp", "a.home", "a.test", "a.example", "a.invalid", "a.intranet", "a.localdomain", // the same list the allow-list refuses
])("rejects %j with 400", async (input) => {
  expect((await post(input)).status).toBe(400);
  expect(lookup).not.toHaveBeenCalled();
});

test("rejects a missing or non-string url", async () => {
  expect((await post(undefined)).status).toBe(400);
  expect((await post(42)).status).toBe(400);
});

test("a host in stores.domains answers with no network", async () => {
  const body = await (await post("https://WWW.brand.com/x")).json();
  expect(body).toMatchObject({ kind: "shopify_store", host: "www.brand.com", reachable: true });
  expect(body.themeLink).toBe("https://mine.myshopify.com/admin/themes/current/editor?context=apps&template=index&activateAppId=key123/askcart-embed");
  expect(body.embedSnippet).toBeNull();
  expect(lookup).not.toHaveBeenCalled();
  expect(connects).toEqual([]);
});

test.each(["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "198.18.0.1",
  "::1", "::", "::10.0.0.1", "::a00:1", "64:ff9b:1::a00:1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::1"])(
  "refuses %s without connecting",
  async (ip) => {
    expect(lib.isPublicAddress(ip)).toBe(false);
    dnsAnswers.set("evil.com", [ip]);
    replies.set("evil.com", { body: "cdn.shopify.com" });
    const body = await (await post("evil.com")).json();
    expect(body).toMatchObject({ kind: "other", reachable: false });
    expect(connects).toEqual([]);
  },
);

test("one private answer among public ones refuses the host", async () => {
  dnsAnswers.set("mixed.com", ["93.184.216.34", "10.0.0.1"]);
  replies.set("mixed.com", {});
  expect((await (await post("mixed.com")).json()).reachable).toBe(false);
  expect(connects).toEqual([]);
});

test("public addresses pass", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) expect(lib.isPublicAddress(ip)).toBe(true);
});

test("connects to the vetted IP, keeping the hostname for TLS and Host", async () => {
  dnsAnswers.set("plain.com", ["93.184.216.34"]);
  replies.set("plain.com", { body: "<html>hello</html>" });
  await post("plain.com");
  expect(connects).toEqual([{ host: "93.184.216.34", servername: "plain.com", hostHeader: "plain.com", path: "/" }]);
});

test("a non-Shopify site gets the embed line and the chat link", async () => {
  dnsAnswers.set("plain.com", ["93.184.216.34"]);
  replies.set("plain.com", { body: "<html>hello</html>" });
  const body = await (await post("plain.com")).json();
  expect(body).toMatchObject({ kind: "other", host: "plain.com", reachable: true, themeLink: null });
  expect(body.embedSnippet).toBe('<script src="https://app.askcart.test/embed.js" data-shop="mine.myshopify.com" defer></script>');
  expect(body.chatLink).toBe("https://app.askcart.test/chat/mine.myshopify.com");
});

test("only a parsed Shopify.shop names a store; headers or cdn.shopify.com alone are just other", async () => {
  dnsAnswers.set("a.com", ["93.184.216.34"]);
  dnsAnswers.set("b.com", ["93.184.216.35"]);
  dnsAnswers.set("c.com", ["93.184.216.36"]);
  dnsAnswers.set("d.com", ["93.184.216.37"]);
  replies.set("a.com", { headers: { "x-shopid": "1" }, body: 'Shopify.shop = "other.myshopify.com";' });
  replies.set("b.com", { headers: { "powered-by": "Shopify" } });
  replies.set("c.com", { body: '<script src="https://cdn.shopify.com/s/x.js"></script> Shopify.shop = "MINE.myshopify.com"' });
  replies.set("d.com", { headers: { "x-shopify-stage": "production" }, body: '<img src="https://cdn.shopify.com/s/y.png">' });
  const kind = async (u: string) => (await (await post(u)).json()).kind;
  expect(await kind("a.com")).toBe("shopify_other_store");
  expect(await kind("b.com")).toBe("other");
  expect(await kind("c.com")).toBe("shopify_store");
  expect(await kind("d.com")).toBe("other");
});

test("redirects are followed twice at most, each hop vetted; one into a private address stops", async () => {
  dnsAnswers.set("go.com", ["93.184.216.34"]);
  replies.set("go.com", { status: 301, headers: { location: "https://www.go.com/" } });
  dnsAnswers.set("www.go.com", ["93.184.216.35"]);
  replies.set("www.go.com", { headers: { "x-shopid": "9" }, body: 'Shopify.shop = "other.myshopify.com"' });
  expect((await (await post("go.com")).json()).kind).toBe("shopify_other_store");

  dnsAnswers.set("trap.com", ["93.184.216.36"]);
  replies.set("trap.com", { status: 302, headers: { location: "https://inner.example.org/" } });
  dnsAnswers.set("inner.example.org", ["10.0.0.9"]);
  connects.length = 0;
  expect(await (await post("trap.com")).json()).toMatchObject({ kind: "other", reachable: false });
  expect(connects.map((c) => c.servername)).toEqual(["trap.com"]);

  replies.set("trap.com", { status: 302, headers: { location: "http://192.168.0.1/" } }); // not https / not a hostname
  expect((await (await post("trap.com")).json()).reachable).toBe(true);
});

test("a redirect into one of the store's own domains is our store, without fetching it", async () => {
  dnsAnswers.set("short.com", ["93.184.216.34"]);
  replies.set("short.com", { status: 301, headers: { location: "https://brand.com/" } });
  expect((await (await post("short.com")).json()).kind).toBe("shopify_store");
  expect(connects.length).toBe(1);
});

test("unreachable (DNS failure or connection error) is other with reachable false, still with both options", async () => {
  const dnsFail = await (await post("nowhere.com")).json();
  expect(dnsFail).toMatchObject({ kind: "other", reachable: false });
  dnsAnswers.set("down.com", ["93.184.216.34"]);
  replies.set("down.com", "error");
  const down = await (await post("down.com")).json();
  expect(down).toMatchObject({ kind: "other", reachable: false });
  expect(down.embedSnippet).toContain("/embed.js");
  expect(down.chatLink).toContain("/chat/");
});

test("10 checks a minute per store, then 429 with Retry-After; another store is unaffected", async () => {
  for (let i = 0; i < 10; i++) expect((await post("brand.com")).status).toBe(200);
  const over = await post("brand.com");
  expect(over.status).toBe(429);
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  embeddedStore = await newStore(admin);
  expect((await post("brand.com")).status).toBe(200);
  embeddedStore = store;
});

test("a redirect's path and query are carried to the next hop", async () => {
  dnsAnswers.set("p.com", ["93.184.216.34"]);
  replies.set("p.com", { status: 302, headers: { location: "/en/home?x=1" } });
  await post("p.com");
  expect(connects.map((c) => c.path)).toEqual(["/", "/en/home?x=1", "/en/home?x=1"]); // the mock keeps redirecting: 1 fetch + 2 redirects, then it stops
});

test("a server dripping bytes is cut off at the overall deadline, and so is a DNS lookup that never answers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  try {
    dnsAnswers.set("drip.com", ["93.184.216.34"]);
    replies.set("drip.com", { drip: true });
    // Straight at the library: the route's DB calls don't belong under fake timers.
    const pending = lib.checkWebsite("drip.com", embeddedShop, []);
    await vi.advanceTimersByTimeAsync(lib.DEADLINE_MS + 100);
    expect(await pending).toMatchObject({ kind: "other", reachable: false });
    expect(destroyed).toBeGreaterThan(0);

    const slow = lib.checkWebsite("slowdns.com", embeddedShop, []);
    await vi.advanceTimersByTimeAsync(lib.DEADLINE_MS + 100);
    expect(await slow).toMatchObject({ kind: "other", reachable: false });
    expect(connects.length).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("without SHOPIFY_API_KEY there is no theme link", async () => {
  const key = process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_KEY;
  try {
    expect(await (await post("brand.com")).json()).toMatchObject({ kind: "shopify_store", themeLink: null });
  } finally {
    process.env.SHOPIFY_API_KEY = key;
  }
});

test("a body over 4 KB is refused with 413 body_too_large, whether declared or streamed", async () => {
  const big = await post("brand.com" + " ".repeat(5000));
  expect(big.status).toBe(413);
  expect(await big.json()).toEqual({ error: "body_too_large" });
  const res = await route.POST(
    new Request("http://x/api/app/website-check", {
      method: "POST",
      body: JSON.stringify({ url: "brand.com" }),
      headers: { authorization: "Bearer t", "content-length": "99999" },
    }),
  );
  expect(res.status).toBe(413);
});
