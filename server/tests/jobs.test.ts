import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";

let admin: ReturnType<typeof postgres>;
let jobs: typeof import("@/lib/jobs");
let tokens: typeof import("@/lib/shopify/tokens");
let client: typeof import("@/db/client");

beforeAll(async () => {
  jobs = await import("@/lib/jobs");
  tokens = await import("@/lib/shopify/tokens");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

test("shop-redact removes the store, its tokens and its orphaned account, and is safe to repeat", async () => {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain, active) values (${acc.id}, 'gone.myshopify.com', false) returning id`;
  await tokens.saveTokens(s.id, { accessToken: "t", accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
  const [other] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain) values (${other.id}, 'kept.myshopify.com')`;

  await jobs.shopRedact({ shopDomain: "gone.myshopify.com" });
  await jobs.shopRedact({ shopDomain: "gone.myshopify.com" });

  expect(await admin`select id from stores where id = ${s.id}`).toHaveLength(0);
  expect(await admin`select store_id from store_tokens where store_id = ${s.id}`).toHaveLength(0);
  expect(await admin`select id from accounts where id = ${acc.id}`).toHaveLength(0);
  expect(await admin`select id from stores where shop_domain = 'kept.myshopify.com'`).toHaveLength(1);
  expect(await admin`select id from accounts where id = ${other.id}`).toHaveLength(1);
});

test("shop-redact keeps an account another store still uses", async () => {
  const [acc] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (account_id, shop_domain, active) values (${acc.id}, 'one.myshopify.com', false)`;
  await admin`insert into stores (account_id, shop_domain) values (${acc.id}, 'two.myshopify.com')`;

  await jobs.shopRedact({ shopDomain: "one.myshopify.com" });

  expect(await admin`select id from stores where account_id = ${acc.id}`).toHaveLength(1);
  expect(await admin`select id from accounts where id = ${acc.id}`).toHaveLength(1);
});

test("shop-redact keeps a store that reinstalled before the job ran", async () => {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, 'back.myshopify.com') returning id`;

  await jobs.shopRedact({ shopDomain: "back.myshopify.com" });

  expect(await admin`select id from stores where id = ${s.id}`).toHaveLength(1);
  expect(await admin`select id from accounts where id = ${acc.id}`).toHaveLength(1);
});

test("a product-sync batch runs every job and fails only the one that threw, which pg-boss retries alone", async () => {
  // A throwaway queue with the product-sync worker options, so the real pg-boss settles the batch.
  const queue = `settle-test-${Date.now()}`;
  await jobs.enqueue("store-sync", { storeId: "00000000-0000-0000-0000-000000000000" }, { startAfter: 3600 }); // starts boss
  await jobs.boss.createQueue(queue, { retryLimit: 1, retryDelay: 3600 });
  const ids = await Promise.all(["a", "bad", "c"].map((p) => jobs.boss.send(queue, { p })));
  const ran: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  const worker = await jobs.boss.work<{ p: string }, void, typeof jobs.PRODUCT_SYNC_WORK>(queue, jobs.PRODUCT_SYNC_WORK, (batch) =>
    jobs.settleEach(batch, async ({ p }) => {
      ran.push(p);
      if (p === "bad") throw new Error("boom");
    }),
  );
  const state = async () => Object.fromEntries((await admin`select id, state from pgboss.job where name = ${queue}`).map((r) => [r.id, r.state]));
  await vi.waitFor(async () => expect(Object.values(await state()).filter((s) => s !== "created" && s !== "active")).toHaveLength(3), { timeout: 10_000 });
  await jobs.boss.offWork(queue, { id: worker });

  expect(ran.sort()).toEqual(["a", "bad", "c"]);
  expect(await state()).toEqual({ [ids[0]!]: "completed", [ids[1]!]: "retry", [ids[2]!]: "completed" });
  await admin`delete from pgboss.job where name = ${queue} or (name = 'store-sync' and data->>'storeId' = '00000000-0000-0000-0000-000000000000')`;
});
