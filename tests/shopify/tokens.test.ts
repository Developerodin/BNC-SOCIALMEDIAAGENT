import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

let admin: ReturnType<typeof postgres>;
let tokens: typeof import("@/lib/shopify/tokens");
let client: typeof import("@/db/client");
const A = randomUUID();

beforeAll(async () => {
  tokens = await import("@/lib/shopify/tokens");
  client = await import("@/db/client");
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
  const [acc] = await admin`insert into accounts default values returning id`;
  await admin`insert into stores (id, account_id, shop_domain) values (${A}, ${acc.id}, 'a.myshopify.com')`;
});

afterAll(async () => {
  await admin.end();
  await client.sql.end();
});

const future = (ms: number) => new Date(Date.now() + ms);

test("expired token is refreshed exactly once under concurrency", async () => {
  await tokens.saveTokens(A, {
    accessToken: "old",
    accessExpiresAt: future(-1000),
    refreshToken: "r-old",
    refreshExpiresAt: future(86_400_000),
  });
  const refresh = vi.fn(async ({ shop, refreshToken }: { shop: string; refreshToken: string }) => {
    expect(shop).toBe("a.myshopify.com");
    expect(refreshToken).toBe("r-old");
    await new Promise((r) => setTimeout(r, 50));
    return {
      accessToken: "new",
      accessExpiresAt: future(3_600_000),
      refreshToken: "r-new",
      refreshExpiresAt: future(86_400_000),
    };
  });
  const [x, y] = await Promise.all([tokens.getAccessToken(A, refresh), tokens.getAccessToken(A, refresh)]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect([x, y]).toEqual(["new", "new"]);
});

test("valid token is returned without refreshing", async () => {
  const refresh = vi.fn();
  expect(await tokens.getAccessToken(A, refresh)).toBe("new");
  expect(refresh).not.toHaveBeenCalled();
});

test("expired refresh token throws a clear error", async () => {
  await tokens.saveTokens(A, {
    accessToken: "old",
    accessExpiresAt: future(-1000),
    refreshToken: "r-old",
    refreshExpiresAt: future(-1000),
  });
  await expect(tokens.getAccessToken(A, vi.fn())).rejects.toThrow(/refresh token/i);
});

test("an expired refresh token marks the store as needing a reconnect", async () => {
  await admin`update stores set sync_error = null where id = ${A}`;
  await expect(tokens.getAccessToken(A, vi.fn())).rejects.toBeInstanceOf(tokens.ReconnectNeededError);
  expect((await admin`select sync_error from stores where id = ${A}`)[0].sync_error).toBe(tokens.RECONNECT_NEEDED);
});
