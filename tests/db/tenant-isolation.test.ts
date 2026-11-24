import { beforeAll, afterAll, expect, test } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

let admin: ReturnType<typeof postgres>;
let mod: typeof import("@/db/client");
let schema: typeof import("@/db/schema");
const A = randomUUID();
const B = randomUUID();

beforeAll(async () => {
  process.env.DB_POOL_MAX = "1"; // one pooled connection: proves set_config doesn't leak
  mod = await import("@/db/client");
  schema = await import("@/db/schema");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  for (const [id, domain] of [[A, "a.myshopify.com"], [B, "b.myshopify.com"]]) {
    const [acc] = await admin`insert into accounts default values returning id`;
    await admin`insert into stores (id, account_id, shop_domain) values (${id}, ${acc.id}, ${domain})`;
    await admin`insert into store_tokens (store_id, access_token_enc, key_id) values (${id}, 'enc', 'k1')`;
  }
});

afterAll(async () => {
  await admin.end();
  await mod.sql.end();
});

test("forStore returns only that store's rows", async () => {
  const rows = await mod.forStore(A, (tx) => tx.select().from(schema.storeTokens));
  expect(rows.map((r) => r.storeId)).toEqual([A]);
});

test("raw db outside forStore sees 0 rows, before and after a forStore call", async () => {
  expect(await mod.db.select().from(schema.storeTokens)).toHaveLength(0);
  await mod.forStore(B, (tx) => tx.select().from(schema.storeTokens));
  expect(await mod.db.select().from(schema.storeTokens)).toHaveLength(0);
});

test("every table with a store_id column has RLS enabled and forced", async () => {
  const rows = await admin`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'r' and exists (
      select 1 from information_schema.columns col
      where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'store_id')`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.relrowsecurity, r.relname).toBe(true);
    expect(r.relforcerowsecurity, r.relname).toBe(true);
  }
});

test("store A reads none of store B's conversations or messages", async () => {
  for (const [id, n] of [[A, "a"], [B, "b"]]) {
    const [c] = await admin`insert into conversations (store_id, token_hash) values (${id}, ${`hash-${n}`}) returning id`;
    await admin`insert into messages (store_id, conversation_id, role, content) values (${id}, ${c.id}, 'user', ${`hi from ${n}`})`;
  }
  const convs = await mod.forStore(A, (tx) => tx.select().from(schema.conversations));
  const msgs = await mod.forStore(A, (tx) => tx.select().from(schema.messages));
  expect(convs.map((c) => c.storeId)).toEqual([A]);
  expect(msgs.map((m) => m.content)).toEqual(["hi from a"]);
  expect(await mod.db.select().from(schema.messages)).toHaveLength(0);
});

test("conversations and messages are covered by the RLS check", async () => {
  const rows = await admin`
    select relname from pg_class where relname in ('conversations', 'messages') and relrowsecurity and relforcerowsecurity`;
  expect(rows.map((r) => r.relname).sort()).toEqual(["conversations", "messages"]);
});

test("a message's store_id must match its conversation's store_id", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-fk') returning id`;
  // Admin connection: RLS can't hide the FK error.
  await expect(
    admin`insert into messages (store_id, conversation_id, role, content) values (${B}, ${c.id}, 'user', 'cross-store')`,
  ).rejects.toThrow(/messages_store_id_conversation_id_conversations_store_id_id_fk/);
});
