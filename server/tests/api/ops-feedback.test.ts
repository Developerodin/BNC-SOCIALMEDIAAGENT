import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { newStore } from "../helpers/seed";

// GET /ops/feedback: internal, Basic auth against OPS_SECRET, reads across stores.

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/ops/feedback/route");
let client: typeof import("@/db/client");
let report: typeof import("@/lib/ops/feedback");
let a: string;
let b: string;
let shopA: string;
let shopB: string;

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const get = (auth?: string, qs = "") =>
  route.GET(new Request(`http://localhost/ops/feedback${qs}`, { headers: auth ? { authorization: auth } : {} }));

async function answer(storeId: string, conv: string, o: { rating?: number | null; reason?: string | null; q?: string; a?: string; at?: string; status?: string }) {
  const at = o.at ?? new Date().toISOString();
  await admin`insert into messages (store_id, conversation_id, role, content, created_at) values (${storeId}, ${conv}, 'user', ${o.q ?? "question"}, ${at}::timestamptz - interval '1 second')`;
  await admin`insert into messages (store_id, conversation_id, role, content, rating, feedback_reason, status, created_at)
    values (${storeId}, ${conv}, 'assistant', ${o.a ?? "answer"}, ${o.rating ?? null}, ${o.reason ?? null}, ${o.status ?? "ok"}, ${at}::timestamptz)`;
}
async function conv(storeId: string) {
  const id = randomUUID();
  await admin`insert into conversations (id, store_id, token_hash) values (${id}, ${storeId}, ${randomUUID()})`;
  return id;
}

beforeAll(async () => {
  route = await import("@/app/ops/feedback/route");
  client = await import("@/db/client");
  report = await import("@/lib/ops/feedback");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
afterAll(async () => {
  delete process.env.OPS_SECRET;
  await admin.end();
  await client.sql.end();
});
beforeEach(async () => {
  process.env.OPS_SECRET = "s3cret-ops";
  await admin`delete from stores`; // cascades to messages; each test starts from an empty database
  a = await newStore(admin);
  b = await newStore(admin);
  shopA = (await admin`select shop_domain from stores where id = ${a}`)[0].shop_domain;
  shopB = (await admin`select shop_domain from stores where id = ${b}`)[0].shop_domain;
});

test("OPS_SECRET unset or empty → 404 even with credentials, never open", async () => {
  for (const v of [undefined, ""]) {
    if (v === undefined) delete process.env.OPS_SECRET;
    else process.env.OPS_SECRET = v;
    for (const auth of [undefined, basic("x", ""), basic("x", "s3cret-ops")]) {
      const res = await get(auth);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
    }
  }
});

test("missing, malformed or wrong credentials → 401 with a Basic challenge", async () => {
  for (const auth of [undefined, "Bearer s3cret-ops", "Basic !!!", basic("x", "wrong"), basic("x", "s3cret-op"), basic("x", "s3cret-ops!"), "Basic " + Buffer.from("nocolon").toString("base64")]) {
    const res = await get(auth);
    expect(res.status, String(auth)).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  }
});

test("right password (any user name, even with a colon in it) → 200 HTML, no-store, noindex", async () => {
  const res = await get(basic("anyone", "s3cret-ops"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toContain("noindex");
  process.env.OPS_SECRET = "a:b";
  expect((await get(basic("u", "a:b"))).status).toBe(200);
});

test("counts are right per store and in total, across two stores", async () => {
  const ca = await conv(a);
  const cb = await conv(b);
  await answer(a, ca, { rating: 1 });
  await answer(a, ca, { rating: 1 });
  await answer(a, ca, { rating: -1, reason: "wrong_products" });
  await answer(a, ca, { rating: -1 });
  await answer(a, ca, {});
  await answer(a, ca, { status: "cut_off" }); // unfinished answers are not counted
  await answer(b, cb, { rating: -1, reason: "wrong_products" });
  await answer(b, cb, { rating: -1, reason: "other" });
  await answer(b, cb, { rating: 1 });
  await answer(b, cb, { rating: 1, at: "2020-01-01T00:00:00Z" }); // outside the default range
  const r = await report.feedbackReport(report.parseRange(null, null)!);
  const sa = r.stores.find((s) => s.storeId === a)!;
  const sb = r.stores.find((s) => s.storeId === b)!;
  expect(sa).toMatchObject({ answers: 5, up: 2, down: 2 });
  expect(sa.reasons).toEqual({ wrong_products: 1, wrong_price_stock: 0, misunderstood: 0, unclear: 0, other: 0, none: 1 });
  expect(sb).toMatchObject({ answers: 3, up: 1, down: 2 });
  expect(sb.reasons.wrong_products).toBe(1);
  expect(sb.reasons.other).toBe(1);
  expect(r.total).toMatchObject({ answers: 8, up: 3, down: 4 });
  expect(r.total.reasons).toEqual({ wrong_products: 2, wrong_price_stock: 0, misunderstood: 0, unclear: 0, other: 1, none: 1 });
  expect(r.latest).toHaveLength(4);
  const old = await report.feedbackReport(report.parseRange("2019-12-31", "2020-01-02")!);
  expect(old.total).toMatchObject({ answers: 1, up: 1, down: 0 });
  const html = await (await get(basic("u", "s3cret-ops"))).text();
  expect(html).toContain(shopA);
  expect(html).toContain(shopB);
  expect(html).toContain("50.0%");
});

test("latest thumbs-down: question just before, truncated to 300 chars, newest first, at most 50", async () => {
  const c = await conv(a);
  await answer(a, c, { rating: -1, q: "older question", a: "older answer", at: new Date(Date.now() - 3600_000).toISOString(), reason: "unclear" });
  await answer(a, c, { rating: -1, q: "q".repeat(500), a: "a".repeat(500) });
  const r = await report.feedbackReport(report.parseRange(null, null)!);
  expect(r.latest[0].question).toBe("q".repeat(300) + "…");
  expect(r.latest[0].answer).toBe("a".repeat(300) + "…");
  expect(r.latest[1]).toMatchObject({ question: "older question", answer: "older answer", reason: "unclear", shop: shopA });
  for (let i = 0; i < 55; i++) await answer(a, c, { rating: -1, at: new Date(Date.now() - 10_000 - i * 1000).toISOString() });
  expect((await report.feedbackReport(report.parseRange(null, null)!)).latest).toHaveLength(50);
});

test("shopper text is HTML-escaped, never markup", async () => {
  const c = await conv(a);
  await answer(a, c, { rating: -1, q: `<script>alert(1)</script> "q" & 'x'`, a: `<img src=x onerror=alert(2)>` });
  const html = await (await get(basic("u", "s3cret-ops"))).text();
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &amp; &#39;x&#39;");
  expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
});

test("date range: defaults to 30 days, honours from/to, rejects bad input with 400", async () => {
  const now = new Date("2026-11-25T10:00:00Z");
  const d = report.parseRange(null, null, now)!;
  expect(d.from.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  expect(d.to.toISOString()).toBe("2026-11-26T00:00:00.000Z");
  expect(report.parseRange("2026-02-30", null)).toBeNull();
  expect(report.parseRange("2026-11-02", "2026-11-01")).toBeNull();
  expect(report.parseRange("2020-01-01", "2026-01-01")).toBeNull();
  for (const qs of ["?from=nope", "?to=2026-13-01", "?from=2026-11-02&to=2026-11-01"]) {
    expect((await get(basic("u", "s3cret-ops"), qs)).status).toBe(400);
  }
});
