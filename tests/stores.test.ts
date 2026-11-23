import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";

let admin: ReturnType<typeof postgres>;
let stores: typeof import("@/lib/stores");
let client: typeof import("@/db/client");

beforeAll(async () => {
  stores = await import("@/lib/stores");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

test("two simultaneous first loads create one store and one account", async () => {
  const [x, y] = await Promise.all([stores.upsertStore("a.myshopify.com"), stores.upsertStore("a.myshopify.com")]);
  expect(x.storeId).toBe(y.storeId);
  expect(x.accountId).toBe(y.accountId);
  expect([x.created, y.created].sort()).toEqual([false, true]);
  expect(await admin`select id from stores`).toHaveLength(1);
  expect(await admin`select id from accounts`).toHaveLength(1);
});

test("reinstall reactivates the store and keeps its ids", async () => {
  const first = await stores.upsertStore("b.myshopify.com");
  await admin`update stores set active = false where id = ${first.storeId}`;
  const again = await stores.upsertStore("b.myshopify.com");
  expect(again).toEqual({ storeId: first.storeId, accountId: first.accountId, created: false });
  const [row] = await admin`select active from stores where id = ${first.storeId}`;
  expect(row.active).toBe(true);
  expect(await admin`select id from accounts`).toHaveLength(2);
});
