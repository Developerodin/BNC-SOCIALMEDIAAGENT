import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

let storeId: string;
vi.mock("@/lib/shopify/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify/session")>()),
  authenticateEmbedded: vi.fn(async (req: Request) => {
    if (!req.headers.get("authorization")) throw new Response("Unauthorized", { status: 401 });
    return { storeId, shop: "x.myshopify.com" };
  }),
}));

let admin: ReturnType<typeof postgres>;
let route: typeof import("@/app/api/app/sync/route");
let jobs: typeof import("@/lib/jobs");
let client: typeof import("@/db/client");

beforeAll(async () => {
  route = await import("@/app/api/app/sync/route");
  jobs = await import("@/lib/jobs");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${`s-${randomUUID()}.myshopify.com`}) returning id`;
  storeId = s.id;
});
afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

const req = (method: string, auth = true) =>
  new Request("http://x/api/app/sync", { method, headers: auth ? { authorization: "Bearer t" } : {} });

test("POST without a bearer is 401", async () => {
  expect((await route.POST(req("POST", false))).status).toBe(401);
});

test("two POSTs answer 202 and leave one queued job", async () => {
  expect((await route.POST(req("POST"))).status).toBe(202);
  expect((await route.POST(req("POST"))).status).toBe(202);
  const q = await admin`select id from pgboss.job where name = 'store-sync' and singleton_key = ${storeId} and state = 'created'`;
  expect(q.length).toBe(1);
});

test("GET counts only ACTIVE published products", async () => {
  const row = (id: string, status: string, published: boolean) =>
    admin`insert into products (store_id, shopify_id, handle, title, status, published, content, content_hash, shopify_updated_at)
          values (${storeId}, ${id}, ${id}, 't', ${status}, ${published}, 'c', ${id}, now())`;
  await row("1", "ACTIVE", true);
  await row("2", "ACTIVE", false);
  await row("3", "DRAFT", true);
  const body = await (await route.GET(req("GET"))).json();
  expect(body).toEqual({ status: "idle", lastSyncAt: null, itemsRead: 0, productCount: 1 });
});
