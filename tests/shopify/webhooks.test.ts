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

function webhook(topic: string, shop: string, id = randomUUID(), secret = process.env.SHOPIFY_API_SECRET!) {
  const body = JSON.stringify({ shop_domain: shop });
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

test("app/uninstalled deactivates the store and leaves no token row", async () => {
  const id = await installedStore("u.myshopify.com");
  const res = await webhooks.handleWebhook(webhook("app/uninstalled", "u.myshopify.com"));
  expect(res.status).toBe(200);
  const [s] = await admin`select active from stores where id = ${id}`;
  expect(s.active).toBe(false);
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
