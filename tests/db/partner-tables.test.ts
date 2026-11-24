import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomBytes, randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";

// Task P1: portal clients, connect requests, grants and tokens.

let admin: ReturnType<typeof postgres>;
let mod: typeof import("@/db/client");
let schema: typeof import("@/db/schema");
let partnerDb: typeof import("@/lib/partner/db");
const A = randomUUID();
const B = randomUUID();
const CLIENT = `pc_${randomBytes(12).toString("base64url")}`;
const hex = () => randomBytes(32).toString("hex");
const hashA = hex();
const hashB = hex();
const hashB2 = hex();
let grantA: string;
let grantB: string;
const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));

async function newRequest(shop: string, codeHash: string | null = null): Promise<string> {
  const [r] = await admin`
    insert into partner_connect_requests (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at, code_hash)
    values (${CLIENT}, ${shop}, 'https://portal.example/cb', 'st', 'cc', ${["read:shop"]}, 'pending', now() + interval '10 minutes', ${codeHash})
    returning id`;
  return r.id;
}

async function newGrant(storeId: string, shop: string, requestId: string | null = null): Promise<string> {
  const [g] = await admin`
    insert into partner_grants (store_id, shop_domain, client_id, scopes, connect_request_id)
    values (${storeId}, ${shop}, ${CLIENT}, ${["read:shop"]}, ${requestId}) returning id`;
  return g.id;
}

async function newToken(grantId: string, storeId: string, hash: string, kind = "access") {
  await admin`
    insert into partner_tokens (grant_id, store_id, kind, token_hash, token_prefix)
    values (${grantId}, ${storeId}, ${kind}, ${hash}, 'ack_abcdefgh')`;
}

beforeAll(async () => {
  process.env.DB_POOL_MAX = "1"; // one pooled connection: proves the settings don't leak
  mod = await import("@/db/client");
  schema = await import("@/db/schema");
  partnerDb = await import("@/lib/partner/db");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  for (const [id, domain] of [[A, "pa.myshopify.com"], [B, "pb.myshopify.com"]]) {
    const [acc] = await admin`insert into accounts default values returning id`;
    await admin`insert into stores (id, account_id, shop_domain) values (${id}, ${acc.id}, ${domain})`;
  }
  await admin`
    insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
    values (${CLIENT}, 'Test portal', ${hex()}, ${["https://portal.example/cb"]}, ${["read:shop"]})`;
  grantA = await newGrant(A, "pa.myshopify.com", await newRequest("pa.myshopify.com"));
  grantB = await newGrant(B, "pb.myshopify.com", await newRequest("pb.myshopify.com"));
  await newToken(grantA, A, hashA);
  await newToken(grantB, B, hashB);
  await newToken(grantB, B, hashB2, "refresh");
});

afterAll(async () => {
  // partner_clients isn't in the shared truncate; this removes the requests too (stores are truncated per file).
  await admin`delete from partner_grants where client_id = ${CLIENT}`;
  await admin`delete from partner_connect_requests where client_id = ${CLIENT}`;
  await admin`delete from partner_clients where client_id = ${CLIENT}`;
  await admin.end();
  await mod.sql.end();
  for (const s of spies) expect(s).not.toHaveBeenCalled();
});

test("partner_grants and partner_tokens have RLS enabled and forced; clients and requests don't", async () => {
  const rows = await admin`
    select relname, relrowsecurity, relforcerowsecurity from pg_class
    where relname in ('partner_clients', 'partner_connect_requests', 'partner_grants', 'partner_tokens') and relkind = 'r'
    order by relname`;
  expect(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity])).toEqual([
    ["partner_clients", false, false],
    ["partner_connect_requests", false, false],
    ["partner_grants", true, true],
    ["partner_tokens", true, true],
  ]);
});

test("with app.store_id = A, none of B's grants or tokens are visible", async () => {
  const grants = await mod.forStore(A, (tx) => tx.select().from(schema.partnerGrants));
  const tokens = await mod.forStore(A, (tx) => tx.select().from(schema.partnerTokens));
  expect(grants.map((g) => g.id)).toEqual([grantA]);
  expect(tokens.map((t) => t.tokenHash)).toEqual([hashA]);
  expect(await mod.db.select().from(schema.partnerGrants)).toHaveLength(0);
  expect(await mod.db.select().from(schema.partnerTokens)).toHaveLength(0);
});

test("with only app.partner_token_hash = h, exactly that token is visible and no grant", async () => {
  const [tokens, grants] = await mod.db.transaction(async (tx) => {
    await tx.execute(dsql`select set_config('app.partner_token_hash', ${hashB}, true)`);
    return [await tx.select().from(schema.partnerTokens), await tx.select().from(schema.partnerGrants)];
  });
  expect(tokens.map((t) => t.tokenHash)).toEqual([hashB]);
  expect(grants).toHaveLength(0);
  // Transaction-local: nothing is visible afterwards on the same pooled connection.
  expect(await mod.db.select().from(schema.partnerTokens)).toHaveLength(0);
});

test("the hash lookup is read-only: it can't update or delete the token it sees", async () => {
  const [updated, deleted] = await mod.db.transaction(async (tx) => {
    await tx.execute(dsql`select set_config('app.partner_token_hash', ${hashB}, true)`);
    const u = await tx.update(schema.partnerTokens).set({ lastUsedAt: new Date() }).returning();
    const d = await tx.delete(schema.partnerTokens).returning();
    return [u, d];
  });
  expect(updated).toHaveLength(0);
  expect(deleted).toHaveLength(0);
  expect(await admin`select last_used_at from partner_tokens where token_hash = ${hashB}`).toEqual([{ last_used_at: null }]);
});

test("forTokenHash finds the token, then sees its grant and store only", async () => {
  const seen = await partnerDb.forTokenHash(hashB, async (tx, token) => ({
    token,
    grants: await tx.select().from(schema.partnerGrants),
    tokens: await tx.select().from(schema.partnerTokens),
  }));
  expect(seen).not.toBeNull();
  expect(seen!.token.storeId).toBe(B);
  expect(seen!.token.grantId).toBe(grantB);
  expect(seen!.grants.map((g) => g.id)).toEqual([grantB]);
  // Store-scoped from here: both of B's tokens, never A's.
  expect(seen!.tokens.map((t) => t.tokenHash).sort()).toEqual([hashB, hashB2].sort());
  // It can write within the store (P7 updates last_used_at).
  await partnerDb.forTokenHash(hashB, (tx, token) =>
    tx.update(schema.partnerTokens).set({ lastUsedAt: new Date() }).where(dsql`id = ${token.id}`),
  );
  const [row] = await admin`select last_used_at from partner_tokens where token_hash = ${hashB}`;
  expect(row.last_used_at).not.toBeNull();
  expect(await mod.db.select().from(schema.partnerTokens)).toHaveLength(0);
});

test("forTokenHash returns null for an unknown or empty hash and never calls fn", async () => {
  const fn = vi.fn();
  expect(await partnerDb.forTokenHash(hex(), fn)).toBeNull();
  expect(await partnerDb.forTokenHash("", fn)).toBeNull();
  expect(fn).not.toHaveBeenCalled();
});

test("forTokenHash clears the hash setting before fn runs and leaves nothing set afterwards", async () => {
  const inside = await partnerDb.forTokenHash(hashB, async (tx) => {
    const r = await tx.execute(dsql`select current_setting('app.partner_token_hash', true) as h`);
    return (r as unknown as { h: string }[])[0].h;
  });
  expect(inside).toBe("");
  const after = await mod.db.execute(
    dsql`select coalesce(current_setting('app.store_id', true), '') as s, coalesce(current_setting('app.partner_token_hash', true), '') as h`,
  );
  expect([...(after as unknown as { s: string; h: string }[])]).toEqual([{ s: "", h: "" }]);
});

test("app_user can't insert into partner_clients, but can read them", async () => {
  await expect(
    mod.db.insert(schema.partnerClients).values({
      clientId: "pc_evil", name: "x", secretHash: "x", redirectUris: ["https://evil.example"], allowedScopes: ["read:shop"],
    }),
  ).rejects.toMatchObject({ cause: { code: "42501" } }); // insufficient_privilege
  await expect(mod.db.update(schema.partnerClients).set({ name: "x" })).rejects.toMatchObject({ cause: { code: "42501" } });
  const rows = await mod.db.select().from(schema.partnerClients).where(dsql`client_id = ${CLIENT}`);
  expect(rows.map((r) => r.name)).toEqual(["Test portal"]);
});

test("app_user can write connect requests (no store yet, so no RLS)", async () => {
  const [r] = await mod.db.insert(schema.partnerConnectRequests).values({
    clientId: CLIENT, shopDomain: "new.myshopify.com", redirectUri: "https://portal.example/cb", state: "s",
    codeChallenge: "c", scopes: ["read:shop"], status: "pending", expiresAt: new Date(Date.now() + 600_000),
  }).returning();
  expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  await mod.db.update(schema.partnerConnectRequests).set({ status: "expired" }).where(dsql`id = ${r.id}`);
});

test("status, kind and revoked_reason reject unknown values", async () => {
  await expect(
    admin`insert into partner_connect_requests (client_id, shop_domain, redirect_uri, state, code_challenge, scopes, status, expires_at)
          values (${CLIENT}, 'x.myshopify.com', 'https://portal.example/cb', 's', 'c', ${["read:shop"]}, 'foo', now())`,
  ).rejects.toThrow(/partner_connect_requests_status_chk/);
  await expect(newToken(grantA, A, hex(), "foo")).rejects.toThrow(/partner_tokens_kind_chk/);
  await expect(admin`update partner_grants set revoked_reason = 'foo' where id = ${grantA}`).rejects.toThrow(
    /partner_grants_revoked_reason_chk/,
  );
});

test("code_hash and token_hash are unique", async () => {
  const code = hex();
  await newRequest("pa.myshopify.com", code);
  await expect(newRequest("pa.myshopify.com", code)).rejects.toThrow(/partner_connect_requests_code_hash_unique/);
  await expect(newToken(grantA, A, hashA)).rejects.toThrow(/partner_tokens_token_hash_unique/);
});

test("one grant per connect request (one grant per code)", async () => {
  const [{ connect_request_id: req }] = await admin`select connect_request_id from partner_grants where id = ${grantA}`;
  await admin`update partner_grants set revoked_at = now(), revoked_reason = 'reconnect' where id = ${grantA}`;
  try {
    await expect(newGrant(A, "pa.myshopify.com", req)).rejects.toThrow(/partner_grants_connect_request_id_unique/);
  } finally {
    await admin`update partner_grants set revoked_at = null, revoked_reason = null where id = ${grantA}`;
  }
});

test("C33: only one active grant per store and client; revoked ones may stay", async () => {
  await expect(newGrant(A, "pa.myshopify.com")).rejects.toThrow(/partner_grants_active_store_client_uq/);
  await admin`update partner_grants set revoked_at = now(), revoked_reason = 'reconnect' where id = ${grantB}`;
  const replacement = await newGrant(B, "pb.myshopify.com");
  await admin`delete from partner_grants where id = ${replacement}`;
  await admin`update partner_grants set revoked_at = null, revoked_reason = null where id = ${grantB}`;
});

test("a token's store_id must be its grant's store_id", async () => {
  await expect(newToken(grantA, B, hex())).rejects.toThrow(/partner_tokens_grant_fk/);
});

test("deleting a grant deletes its tokens; deleting a store deletes its grants and tokens", async () => {
  const [acc] = await admin`insert into accounts default values returning id`;
  const C = randomUUID();
  await admin`insert into stores (id, account_id, shop_domain) values (${C}, ${acc.id}, 'pc.myshopify.com')`;
  const g1 = await newGrant(C, "pc.myshopify.com");
  await newToken(g1, C, hex());
  await admin`delete from partner_grants where id = ${g1}`;
  expect(await admin`select 1 from partner_tokens where store_id = ${C}`).toHaveLength(0);

  const g2 = await newGrant(C, "pc.myshopify.com");
  await newToken(g2, C, hex());
  await admin`delete from stores where id = ${C}`;
  expect(await admin`select 1 from partner_grants where store_id = ${C}`).toHaveLength(0);
  expect(await admin`select 1 from partner_tokens where store_id = ${C}`).toHaveLength(0);
  // Other stores are untouched.
  expect(await admin`select 1 from partner_tokens where store_id in (${A}, ${B})`).toHaveLength(3);
});
