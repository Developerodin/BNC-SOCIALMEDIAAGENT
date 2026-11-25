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

// --- Task 22: ratings, cart events, FAQs ---

test("cart_events and faqs are covered by the RLS check", async () => {
  const rows = await admin`
    select relname from pg_class where relname in ('cart_events', 'faqs') and relrowsecurity and relforcerowsecurity`;
  expect(rows.map((r) => r.relname).sort()).toEqual(["cart_events", "faqs"]);
});

test("store A reads none of store B's FAQs or cart events", async () => {
  for (const [id, n] of [[A, "a"], [B, "b"]]) {
    const [c] = await admin`insert into conversations (store_id, token_hash) values (${id}, ${`hash-ce-${n}`}) returning id`;
    await admin`
      insert into cart_events (store_id, conversation_id, product_id, variant_id, quantity, event_id)
      values (${id}, ${c.id}, 'gid://shopify/Product/1', ${`${n === "a" ? 11 : 22}`}, 1, ${randomUUID()})`;
    await admin`
      insert into faqs (store_id, product_id, question, answer)
      values (${id}, 'gid://shopify/Product/1', ${`q ${n}`}, ${`a ${n}`})`;
  }
  const events = await mod.forStore(A, (tx) => tx.select().from(schema.cartEvents));
  const faqs = await mod.forStore(A, (tx) => tx.select().from(schema.faqs));
  expect(events.map((e) => e.variantId)).toEqual(["11"]);
  expect(faqs.map((f) => f.question)).toEqual(["q a"]);
  expect(await mod.db.select().from(schema.cartEvents)).toHaveLength(0);
  expect(await mod.db.select().from(schema.faqs)).toHaveLength(0);
});

test("app_user can write FAQs and cart events for its own store only", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-ce-own') returning id`;
  await mod.forStore(A, async (tx) => {
    await tx.insert(schema.faqs).values({ storeId: A, productId: "gid://shopify/Product/2", question: "own?", answer: "yes" });
    await tx.insert(schema.cartEvents).values({ storeId: A, conversationId: c.id, productId: "gid://shopify/Product/2", variantId: "21", quantity: 2, eventId: randomUUID() });
  });
  await expect(
    mod.forStore(A, (tx) => tx.insert(schema.faqs).values({ storeId: B, productId: "gid://shopify/Product/2", question: "theirs?", answer: "no" })),
  ).rejects.toThrow();
});

test("a cart event's store_id must match its conversation's store_id", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-ce-fk') returning id`;
  await expect(
    admin`insert into cart_events (store_id, conversation_id, product_id, variant_id, quantity, event_id)
          values (${B}, ${c.id}, 'gid://shopify/Product/1', '11', 1, ${randomUUID()})`,
  ).rejects.toThrow(/cart_events_conversation_fk/);
});

test("the same cart event_id can't be stored twice", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-ce-dup') returning id`;
  const eventId = randomUUID();
  const insert = () => admin`
    insert into cart_events (store_id, conversation_id, product_id, variant_id, quantity, event_id)
    values (${A}, ${c.id}, 'gid://shopify/Product/1', '11', 1, ${eventId})`;
  await insert();
  await expect(insert()).rejects.toThrow(/cart_events_event_id_unique/);
});

test("deleting a conversation deletes its cart events", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-ce-del') returning id`;
  await admin`
    insert into cart_events (store_id, conversation_id, product_id, variant_id, quantity, event_id)
    values (${A}, ${c.id}, 'gid://shopify/Product/1', '11', 1, ${randomUUID()})`;
  await admin`delete from conversations where id = ${c.id}`;
  expect(await admin`select 1 from cart_events where conversation_id = ${c.id}`).toHaveLength(0);
});

test("a rating other than -1, 1 or null fails the check (UD14)", async () => {
  const [c] = await admin`insert into conversations (store_id, token_hash) values (${A}, 'hash-rating') returning id`;
  const [m] = await admin`
    insert into messages (store_id, conversation_id, role, content) values (${A}, ${c.id}, 'assistant', 'rated') returning id`;
  for (const ok of [1, -1, null]) await admin`update messages set rating = ${ok} where id = ${m.id}`;
  for (const bad of [2, 0]) {
    await expect(admin`update messages set rating = ${bad} where id = ${m.id}`).rejects.toThrow(/messages_rating_chk/);
  }
});

test("an FAQ question over 300 or an answer over 2,000 characters fails the check", async () => {
  const insert = (q: string, a: string) =>
    admin`insert into faqs (store_id, product_id, question, answer) values (${A}, 'gid://shopify/Product/3', ${q}, ${a})`;
  await insert("q".repeat(300), "a".repeat(2000));
  await expect(insert("q".repeat(301), "a")).rejects.toThrow(/faqs_question_len_chk/);
  await expect(insert("q", "a".repeat(2001))).rejects.toThrow(/faqs_answer_len_chk/);
});

test("product_questions is covered by the RLS check, and a store reads and writes only its own rows", async () => {
  const rows = await admin`select relname from pg_class where relname = 'product_questions' and relrowsecurity and relforcerowsecurity`;
  expect(rows).toHaveLength(1);
  for (const [id, n] of [[A, "a"], [B, "b"]]) {
    await admin`insert into product_questions (store_id, shopify_id, locale, content_hash, questions)
                values (${id}, 'gid://shopify/Product/1', 'en', 'h', ${admin.json([`q ${n}?`])})`;
  }
  const own = await mod.forStore(A, (tx) => tx.select().from(schema.productQuestions));
  expect(own.map((r) => r.questions)).toEqual([["q a?"]]);
  expect(await mod.db.select().from(schema.productQuestions)).toHaveLength(0);
  await mod.forStore(A, (tx) => tx.insert(schema.productQuestions).values({ storeId: A, shopifyId: "gid://shopify/Product/2", locale: "en", contentHash: "h", questions: ["own?"] }));
  await expect(
    mod.forStore(A, (tx) => tx.insert(schema.productQuestions).values({ storeId: B, shopifyId: "gid://shopify/Product/2", locale: "en", contentHash: "h", questions: ["theirs?"] })),
  ).rejects.toThrow();
});
