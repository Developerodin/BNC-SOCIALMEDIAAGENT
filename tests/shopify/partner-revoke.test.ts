import { afterAll, beforeAll, expect, test } from "vitest";
import postgres from "postgres";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

// Task P8: uninstall revokes every partner grant of the store (so every token under them stops); shop/redact deletes them.

let admin: ReturnType<typeof postgres>;
let webhooks: typeof import("@/lib/shopify/webhooks");
let jobs: typeof import("@/lib/jobs");
let stores: typeof import("@/lib/stores");
let client: typeof import("@/db/client");
const CLIENT = `pc_${randomBytes(12).toString("base64url")}`;
const CLIENT2 = `pc_${randomBytes(12).toString("base64url")}`;
const hex = () => randomBytes(32).toString("hex");

beforeAll(async () => {
  webhooks = await import("@/lib/shopify/webhooks");
  jobs = await import("@/lib/jobs");
  stores = await import("@/lib/stores");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  for (const c of [CLIENT, CLIENT2]) {
    await admin`
      insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
      values (${c}, 'Test portal', ${hex()}, ${["https://portal.example/cb"]}, ${["read:shop"]})`;
  }
});

afterAll(async () => {
  // partner_clients and partner_connect_requests aren't in the shared truncate.
  await admin`delete from partner_grants where client_id in (${CLIENT}, ${CLIENT2})`;
  await admin`delete from partner_connect_requests where client_id in (${CLIENT}, ${CLIENT2})`;
  await admin`delete from partner_clients where client_id in (${CLIENT}, ${CLIENT2})`;
  await jobs.boss.stop();
  await admin.end();
  await client.sql.end();
});

function webhook(topic: string, shop: string, id = randomUUID()) {
  const body = JSON.stringify({ shop_domain: shop });
  return new Request("https://test.example.com/api/webhooks/shopify", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(body).digest("base64"),
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-api-version": "2026-10",
      "x-shopify-webhook-id": id,
    },
  });
}

async function newRequest(shop: string, status: string, clientId = CLIENT): Promise<string> {
  const [r] = await admin`
    insert into partner_connect_requests (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at)
    values (${clientId}, ${shop}, 'https://portal.example/cb', 'st', 'cc', ${["read:shop"]}, ${status}, now() + interval '10 minutes')
    returning id`;
  return r.id;
}

/** A store with two grants (two clients), each with an access and a refresh token, plus one request per status. */
async function connectedStore() {
  const shop = `p-${randomUUID()}.myshopify.com`;
  const [acc] = await admin`insert into accounts default values returning id`;
  const [s] = await admin`insert into stores (account_id, shop_domain) values (${acc.id}, ${shop}) returning id`;
  const grants: string[] = [];
  for (const c of [CLIENT, CLIENT2]) {
    const [g] = await admin`
      insert into partner_grants (store_id, shop_domain, client_id, scopes, connect_request_id)
      values (${s.id}, ${shop}, ${c}, ${["read:shop"]}, ${await newRequest(shop, "exchanged", c)}) returning id`;
    grants.push(g.id);
    for (const kind of ["access", "refresh"]) {
      await admin`
        insert into partner_tokens (grant_id, store_id, kind, token_hash, token_prefix)
        values (${g.id}, ${s.id}, ${kind}, ${hex()}, 'ack_abcdefgh')`;
    }
  }
  const requests: Record<string, string> = {};
  for (const st of ["pending", "approved", "denied"]) requests[st] = await newRequest(shop, st);
  return { id: s.id as string, accountId: acc.id as string, shop, grants, requests };
}

const grantsOf = (storeId: string) =>
  admin`select id, revoked_at, revoked_reason from partner_grants where store_id = ${storeId} order by id`;
const statusesOf = async (shop: string) =>
  Object.fromEntries(
    (await admin`select id, status from partner_connect_requests where shop_domain = ${shop}`).map((r) => [r.id, r.status]),
  );

test("uninstall of A revokes every A grant with app_uninstalled, leaves B alone, and expires A's open requests", async () => {
  const a = await connectedStore();
  const b = await connectedStore();
  const res = await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  expect(res.status).toBe(200);

  const ga = await grantsOf(a.id);
  expect(ga).toHaveLength(2);
  for (const g of ga) {
    // The bearer guard (P7) rejects every token whose grant has revoked_at, so this is what stops access and refresh tokens.
    expect(g.revoked_at).not.toBeNull();
    expect(g.revoked_reason).toBe("app_uninstalled");
  }
  for (const g of await grantsOf(b.id)) {
    expect(g.revoked_at).toBeNull();
    expect(g.revoked_reason).toBeNull();
  }

  const sa = await statusesOf(a.shop);
  expect(sa[a.requests.pending]).toBe("expired");
  expect(sa[a.requests.approved]).toBe("expired");
  expect(sa[a.requests.denied]).toBe("denied");
  expect(Object.values(sa).filter((s) => s === "exchanged")).toHaveLength(2);
  const sb = await statusesOf(b.shop);
  expect(sb[b.requests.pending]).toBe("pending");
  expect(sb[b.requests.approved]).toBe("approved");
});

test("a replay of the same uninstall webhook is a no-op", async () => {
  const a = await connectedStore();
  const id = randomUUID();
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop, id));
  const before = await grantsOf(a.id);
  expect((await webhooks.handleWebhook(webhook("app/uninstalled", a.shop, id))).status).toBe(200);
  expect(await grantsOf(a.id)).toEqual(before);
});

test("a second uninstall (new id) keeps the first revocation time", async () => {
  const a = await connectedStore();
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  const before = await grantsOf(a.id);
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  expect(await grantsOf(a.id)).toEqual(before);
});

test("a reinstall doesn't revive the grants", async () => {
  const a = await connectedStore();
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  const r = await stores.upsertStore(a.shop);
  expect(r.storeId).toBe(a.id);
  const [s] = await admin`select active from stores where id = ${a.id}`;
  expect(s.active).toBe(true);
  for (const g of await grantsOf(a.id)) expect(g.revoked_at).not.toBeNull();
});

test("shopRedact deletes A's grants, tokens and connect requests, and none of B's", async () => {
  const a = await connectedStore();
  const b = await connectedStore();
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  await jobs.shopRedact({ shopDomain: a.shop });

  expect(await admin`select id from stores where id = ${a.id}`).toHaveLength(0);
  // ON DELETE CASCADE from stores.
  expect(await admin`select id from partner_grants where store_id = ${a.id}`).toHaveLength(0);
  expect(await admin`select id from partner_tokens where store_id = ${a.id}`).toHaveLength(0);
  expect(await admin`select id from partner_connect_requests where shop_domain = ${a.shop}`).toHaveLength(0);

  expect(await admin`select id from partner_grants where store_id = ${b.id}`).toHaveLength(2);
  expect(await admin`select id from partner_tokens where store_id = ${b.id}`).toHaveLength(4);
  expect(await admin`select id from partner_connect_requests where shop_domain = ${b.shop}`).toHaveLength(5);
});

test("shopRedact keeps a reinstalled store's grants, tokens and requests (D65)", async () => {
  const a = await connectedStore();
  await webhooks.handleWebhook(webhook("app/uninstalled", a.shop));
  await stores.upsertStore(a.shop);
  await jobs.shopRedact({ shopDomain: a.shop });

  expect(await admin`select id from stores where id = ${a.id}`).toHaveLength(1);
  expect(await admin`select id from partner_grants where store_id = ${a.id}`).toHaveLength(2);
  expect(await admin`select id from partner_tokens where store_id = ${a.id}`).toHaveLength(4);
  expect(await admin`select id from partner_connect_requests where shop_domain = ${a.shop}`).toHaveLength(5);
});
