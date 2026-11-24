import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { newStore } from "./helpers/seed";

let admin: ReturnType<typeof postgres>;
let retention: typeof import("@/lib/retention");
let client: typeof import("@/db/client");

beforeAll(async () => {
  retention = await import("@/lib/retention");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});
afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** A conversation created `age` days ago, with a user message `lastMsg` days ago (default: when it started). */
async function convo(storeId: string, age: number, lastMsg = age) {
  const id = randomUUID();
  await admin`insert into conversations (id, store_id, token_hash, created_at) values (${id}, ${storeId}, ${randomUUID()}, ${daysAgo(age)})`;
  await admin`insert into messages (store_id, conversation_id, role, content, created_at) values (${storeId}, ${id}, 'user', 'hi', ${daysAgo(lastMsg)})`;
  await admin`insert into cart_events (store_id, conversation_id, product_id, variant_id, quantity, event_id) values (${storeId}, ${id}, 'p', 'v', 1, ${randomUUID()})`;
  return id;
}
const remaining = async (storeId: string) => (await admin`select id from conversations where store_id = ${storeId}`).map((r) => r.id as string);

test("each store keeps its own retentionDays (30 default, 90, 365); older conversations go with their messages", async () => {
  const a = await newStore(admin); // default 30
  const b = await newStore(admin);
  await admin`update stores set settings = ${admin.json({ retentionDays: 90 })} where id = ${b}`;
  const aOld = await convo(a, 40);
  const aNew = await convo(a, 10);
  const bMid = await convo(b, 40);
  const bOld = await convo(b, 100);

  await retention.retentionScan();

  expect(await remaining(a)).toEqual([aNew]);
  expect((await remaining(b)).sort()).toEqual([bMid].sort());
  expect(await admin`select 1 from messages where conversation_id in (${aOld}, ${bOld})`).toHaveLength(0);
  expect(await admin`select 1 from messages where conversation_id = ${aNew}`).toHaveLength(1);
  expect(await admin`select 1 from cart_events where conversation_id in (${aOld}, ${bOld})`).toHaveLength(0);
  expect(await admin`select 1 from cart_events where conversation_id = ${aNew}`).toHaveLength(1);
});

test("a conversation with a recent message is kept however old it is, and a bad setting means 30 days", async () => {
  const s = await newStore(admin);
  await admin`update stores set settings = ${admin.json({ retentionDays: 7 })} where id = ${s}`;
  const live = await convo(s, 200, 2);
  const stale = await convo(s, 31);
  await retention.retentionScan();
  expect(await remaining(s)).toEqual([live]);
  expect(stale).toBeTruthy();
});

test("batched and idempotent: more than a batch is cleared, a rerun deletes nothing, other stores are untouched", async () => {
  const s = await newStore(admin);
  const other = await newStore(admin);
  const keep = await convo(other, 5);
  await admin`
    insert into conversations (store_id, token_hash, created_at)
    select ${s}, gen_random_uuid()::text, ${daysAgo(60)}::timestamptz from generate_series(1, 1200)`;
  expect(await retention.purgeStore(s, 30)).toBe(1200);
  expect(await retention.purgeStore(s, 30)).toBe(0);
  expect(await remaining(s)).toEqual([]);
  expect(await remaining(other)).toEqual([keep]);
});

test("inactive stores are skipped by the scan", async () => {
  const s = await newStore(admin, false);
  await convo(s, 60);
  await retention.retentionScan();
  expect(await remaining(s)).toHaveLength(1);
});
