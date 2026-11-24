import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { newStore } from "../helpers/seed";
import { normalizeHost } from "@/lib/embed-domains";

// The admin API for the sites allowed to embed the chat: /api/app/embed-domains.

let current: string;
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId: current, shop: "x.myshopify.com" };
  }),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/embed-domains/route");
let client: typeof import("@/db/client");

const call = (method: "GET" | "POST" | "DELETE", body?: unknown, auth = true) =>
  route[method](
    new Request("http://x/api/app/embed-domains", {
      method,
      headers: auth ? { authorization: "Bearer t" } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const add = (host: unknown) => call("POST", { host });
const list = async () => (await (await call("GET")).json()).domains as string[];

beforeAll(async () => {
  route = await import("@/app/api/app/embed-domains/route");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  current = await newStore(admin);
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("every method needs the embedded session", async () => {
  expect((await call("GET", undefined, false)).status).toBe(401);
  for (const m of ["POST", "DELETE"] as const) expect((await call(m, { host: "a.com" }, false)).status).toBe(401);
});

test("starts empty; add lowercases and dedupes; delete removes; other settings survive", async () => {
  await admin`update stores set settings = ${admin.json({ stockThreshold: 7 })} where id = ${current}`;
  expect(await list()).toEqual([]);
  expect(await (await add("Blog.Example.ORG")).json()).toEqual({ domains: ["blog.example.org"] });
  expect(await (await add("blog.example.org")).json()).toEqual({ domains: ["blog.example.org"] });
  await add("www.shop.co.uk");
  expect(await list()).toEqual(["blog.example.org", "www.shop.co.uk"]);
  expect(await (await call("DELETE", { host: "BLOG.example.org" })).json()).toEqual({ domains: ["www.shop.co.uk"] });
  expect(await (await call("DELETE", { host: "not-there.com" })).json()).toEqual({ domains: ["www.shop.co.uk"] });
  const [{ settings }] = await admin`select settings from stores where id = ${current}`;
  expect(settings.stockThreshold).toBe(7);
});

test.each([
  "localhost", "127.0.0.1", "10.0.0.1", "[::1]", "a.local", "db.internal", "intranet", "shop.lan", "a.corp", "a.home", "a.test", "a.invalid", "a.intranet", "a.localdomain", "a.example", "trailing.com.", "example.com:8080", "user@example.com",
  "https://example.com", "example.com/path", "*.example.com", "-a.example.com", "exa mple.com", "a..com", "", "a.b.123",
])("rejects %j as a host", async (host) => {
  expect((await add(host)).status).toBe(400);
});

test("a missing, non-string or malformed host is a 400", async () => {
  expect((await call("POST", {})).status).toBe(400);
  expect((await add(5)).status).toBe(400);
  expect((await call("POST", "not json")).status).toBe(400);
  expect((await call("DELETE", { host: "localhost" })).status).toBe(400);
});

test("a large body is refused with 413", async () => {
  expect((await add("a".repeat(2000) + ".com")).status).toBe(413);
});

test("at most 10 sites; the 11th is a 409, re-adding one already listed still works", async () => {
  await admin`update stores set settings = '{}' where id = ${current}`;
  for (let i = 0; i < 10; i++) expect((await add(`site${i}.example.com`)).status).toBe(200);
  const over = await add("site10.example.com");
  expect(over.status).toBe(409);
  expect((await over.json()).error).toBe("too_many");
  expect((await add("site3.example.com")).status).toBe(200);
  expect(await list()).toHaveLength(10);
});

test("two adds at once keep both", async () => {
  await admin`update stores set settings = '{}' where id = ${current}`;
  await Promise.all([add("one.example.com"), add("two.example.com")]);
  expect((await list()).sort()).toEqual(["one.example.com", "two.example.com"]);
});

test("normalizeHost accepts ordinary public names", () => {
  expect(normalizeHost(" Shop.Example.com ")).toBe("shop.example.com");
  expect(normalizeHost("xn--bcher-kva.example")).toBeNull(); // the .example TLD is reserved, so refused
  expect(normalizeHost("xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
});
