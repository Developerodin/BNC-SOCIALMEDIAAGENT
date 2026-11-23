import { afterAll, beforeAll, expect, test } from "vitest";
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
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, 'gone.myshopify.com') returning id`;
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
  await admin`insert into stores (account_id, shop_domain) values (${acc.id}, 'one.myshopify.com')`;
  await admin`insert into stores (account_id, shop_domain) values (${acc.id}, 'two.myshopify.com')`;

  await jobs.shopRedact({ shopDomain: "one.myshopify.com" });

  expect(await admin`select id from stores where account_id = ${acc.id}`).toHaveLength(1);
  expect(await admin`select id from accounts where id = ${acc.id}`).toHaveLength(1);
});
