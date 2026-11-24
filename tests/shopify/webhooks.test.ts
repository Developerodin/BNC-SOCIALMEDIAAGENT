import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { createHmac, randomUUID } from "node:crypto";

let admin: ReturnType<typeof postgres>;
let webhooks: typeof import("@/lib/shopify/webhooks");
let jobs: typeof import("@/lib/jobs");
let tokens: typeof import("@/lib/shopify/tokens");
let client: typeof import("@/db/client");

beforeAll(async () => {
  webhooks = await import("@/lib/shopify/webhooks");
  jobs = await import("@/lib/jobs");
  tokens = await import("@/lib/shopify/tokens");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

function webhook(topic: string, shop: string, id = randomUUID(), secret = process.env.SHOPIFY_API_SECRET!, payload: object = {}) {
  const body = JSON.stringify({ shop_domain: shop, ...payload });
  return new Request("https://test.example.com/api/webhooks/shopify", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-api-version": "2026-10",
      "x-shopify-webhook-id": id,
    },
  });
}

async function installedStore(shop: string) {
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${shop}) returning id`;
  await tokens.saveTokens(s.id, { accessToken: "t", accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
  return s.id as string;
}

test("a bad HMAC gives 401", async () => {
  const res = await webhooks.handleWebhook(webhook("app/uninstalled", "x.myshopify.com", randomUUID(), "wrong"));
  expect(res.status).toBe(401);
});

test("app/uninstalled deactivates the store, clears the widget config hash and leaves no token row", async () => {
  const id = await installedStore("u.myshopify.com");
  await admin`update stores set widget_config_hash = 'h' where id = ${id}`;
  const res = await webhooks.handleWebhook(webhook("app/uninstalled", "u.myshopify.com"));
  expect(res.status).toBe(200);
  const [s] = await admin`select active, widget_config_hash from stores where id = ${id}`;
  expect(s.active).toBe(false);
  expect(s.widget_config_hash).toBeNull();
  expect(await admin`select store_id from store_tokens where store_id = ${id}`).toHaveLength(0);
});

test("the same webhook id is processed once", async () => {
  await installedStore("d.myshopify.com");
  const spy = vi.spyOn(webhooks.handlers, "APP_UNINSTALLED");
  const id = randomUUID();
  expect((await webhooks.handleWebhook(webhook("app/uninstalled", "d.myshopify.com", id))).status).toBe(200);
  expect((await webhooks.handleWebhook(webhook("app/uninstalled", "d.myshopify.com", id))).status).toBe(200);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("a handler failure gives 500 and the retry with the same id is processed", async () => {
  const id = await installedStore("f.myshopify.com");
  vi.spyOn(webhooks.handlers, "APP_UNINSTALLED").mockRejectedValueOnce(new Error("boom"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const webhookId = randomUUID();
  expect((await webhooks.handleWebhook(webhook("app/uninstalled", "f.myshopify.com", webhookId))).status).toBe(500);
  const [before] = await admin`select active from stores where id = ${id}`;
  expect(before.active).toBe(true);

  expect((await webhooks.handleWebhook(webhook("app/uninstalled", "f.myshopify.com", webhookId))).status).toBe(200);
  const [after] = await admin`select active from stores where id = ${id}`;
  expect(after.active).toBe(false);
});

test("shop/redact for an unknown shop gives 200", async () => {
  const res = await webhooks.handleWebhook(webhook("shop/redact", "nobody.myshopify.com"));
  expect(res.status).toBe(200);
});

test("shop/redact for a known store enqueues shop-redact and deletes nothing inline", async () => {
  const shop = `r-${randomUUID()}.myshopify.com`;
  const id = await installedStore(shop);
  const res = await webhooks.handleWebhook(webhook("shop/redact", shop));
  expect(res.status).toBe(200);
  expect(await admin`select id from stores where id = ${id}`).toHaveLength(1);
  const queued = await admin`select data from pgboss.job where name = 'shop-redact' and data->>'shopDomain' = ${shop}`;
  expect(queued).toHaveLength(1);
});

test("a valid customers/redact gives 200", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const res = await webhooks.handleWebhook(webhook("customers/redact", "c.myshopify.com"));
  expect(res.status).toBe(200);
});

test("customers/data_request logs the store, request id and owned-conversation count, and no message text", async () => {
  const shop = `dr-${randomUUID()}.myshopify.com`;
  const id = await installedStore(shop);
  const owner = "gid://shopify/Customer/777";
  await admin`insert into conversations (store_id, token_hash, owner_customer_id) values (${id}, ${randomUUID()}, ${owner}), (${id}, ${randomUUID()}, ${owner}), (${id}, ${randomUUID()}, 'gid://shopify/Customer/8'), (${id}, ${randomUUID()}, null)`;
  const [c] = await admin`select id from conversations where store_id = ${id} and owner_customer_id = ${owner} limit 1`;
  await admin`insert into messages (store_id, conversation_id, role, content) values (${id}, ${c.id}, 'user', 'SECRET-CHAT-TEXT')`;
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const res = await webhooks.handleWebhook(
    webhook("customers/data_request", shop, undefined, undefined, { customer: { id: 777, email: "a@b.c" }, data_request: { id: 4242 } }),
  );
  expect(res.status).toBe(200);
  expect(info).toHaveBeenCalledWith("webhook customers/data_request received", { shopDomain: shop, storeId: id, dataRequestId: 4242, ownedConversations: 2 });
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/SECRET-CHAT-TEXT|a@b\.c/);
});

test("customers/data_request for an unknown store or a payload without a customer still gives 200", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  expect((await webhooks.handleWebhook(webhook("customers/data_request", "nobody.myshopify.com", undefined, undefined, { customer: { id: 1 } }))).status).toBe(200);
  expect((await webhooks.handleWebhook(webhook("customers/data_request", "nobody2.myshopify.com"))).status).toBe(200);
});

test("bulk_operations/finish for a known store queues sync-poll", async () => {
  const id = await installedStore(`b-${randomUUID()}.myshopify.com`);
  const [s] = await admin`select shop_domain from stores where id = ${id}`;
  const res = await webhooks.handleWebhook(webhook("bulk_operations/finish", s.shop_domain));
  expect(res.status).toBe(200);
  const queued = await admin`select id from pgboss.job where name = 'sync-poll' and singleton_key = ${id}`;
  expect(queued).toHaveLength(1);
});

test("app/uninstalled on a running store resets its sync", async () => {
  const shop = `run-${randomUUID()}.myshopify.com`;
  const id = await installedStore(shop);
  await admin`update stores set sync_status = 'running', bulk_operation_id = 'gid://shopify/BulkOperation/1' where id = ${id}`;
  expect((await webhooks.handleWebhook(webhook("app/uninstalled", shop))).status).toBe(200);
  const [s] = await admin`select sync_status, bulk_operation_id from stores where id = ${id}`;
  expect(s).toEqual({ sync_status: "idle", bulk_operation_id: null });
});

test("repeated products/update webhooks for one product are debounced to a current and a next-window job", async () => {
  const id = await installedStore(`pu-${randomUUID()}.myshopify.com`);
  const [s] = await admin`select shop_domain from stores where id = ${id}`;
  const gid = "gid://shopify/Product/42";
  for (let i = 0; i < 3; i++) {
    const res = await webhooks.handleWebhook(webhook("products/update", s.shop_domain, randomUUID(), undefined, { admin_graphql_api_id: gid }));
    expect(res.status).toBe(200);
  }
  const queued = await admin`select data from pgboss.job where name = 'product-sync' and data->>'storeId' = ${id}`;
  // pg-boss sendDebounced: first runs now, second takes the next slot (so the last change is re-read), the third is dropped.
  expect(queued).toHaveLength(2);
  expect(queued[0].data).toEqual({ storeId: id, productId: gid });
});

test("products/delete for a product we never stored gives 200 and queues the gid built from id", async () => {
  const id = await installedStore(`pd-${randomUUID()}.myshopify.com`);
  const [s] = await admin`select shop_domain from stores where id = ${id}`;
  const res = await webhooks.handleWebhook(webhook("products/delete", s.shop_domain, randomUUID(), undefined, { id: 7 }));
  expect(res.status).toBe(200);
  const queued = await admin`select data from pgboss.job where name = 'product-sync' and data->>'storeId' = ${id}`;
  expect(queued[0].data.productId).toBe("gid://shopify/Product/7");
});

test("shop/update sets the store name", async () => {
  const id = await installedStore(`su-${randomUUID()}.myshopify.com`);
  const [s] = await admin`select shop_domain from stores where id = ${id}`;
  const res = await webhooks.handleWebhook(webhook("shop/update", s.shop_domain, randomUUID(), undefined, { name: "New name" }));
  expect(res.status).toBe(200);
  const [after] = await admin`select name from stores where id = ${id}`;
  expect(after.name).toBe("New name");
});

test("shop/update sets the store language and currency when the payload carries them, and keeps them otherwise", async () => {
  const id = await installedStore(`sl-${randomUUID()}.myshopify.com`);
  const [s] = await admin`select shop_domain from stores where id = ${id}`;
  const send = (payload: object) => webhooks.handleWebhook(webhook("shop/update", s.shop_domain, randomUUID(), undefined, payload));

  expect((await send({ name: "N", primary_locale: "fr", currency: "EUR" })).status).toBe(200);
  expect((await admin`select primary_locale, currency_code from stores where id = ${id}`)[0]).toEqual({ primary_locale: "fr", currency_code: "EUR" });

  expect((await send({ name: "N2" })).status).toBe(200);
  expect((await admin`select name, primary_locale, currency_code from stores where id = ${id}`)[0])
    .toEqual({ name: "N2", primary_locale: "fr", currency_code: "EUR" });
});
