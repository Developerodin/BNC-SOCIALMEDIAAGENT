import { afterAll, beforeAll, expect, test, vi } from "vitest";
import postgres from "postgres";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { GRANTABLE } from "@/lib/partner/scopes";
import { redirectUriMatches, safeEqualHex, sha256Hex } from "@/lib/partner/secrets";
import { GRANTABLE_SCOPES, hashSecret, parseRedirect } from "../../scripts/partner-client.mjs";

// Task P3: scripts/partner-client.mjs, run as a child process against the test database.

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "../../scripts/partner-client.mjs");
const PORTAL = "https://portal.example/askcart/callback";
const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
const created: string[] = [];
let admin: ReturnType<typeof postgres>;

type Out = { code: number; stdout: string; stderr: string };
async function cli(args: string[], env: Record<string, string | undefined> = {}): Promise<Out> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NODE_ENV: "development", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function create(extra: string[] = []): Promise<{ clientId: string; secret: string; out: Out }> {
  const out = await cli(["create", "--name", "Social Media Agent", "--redirect", PORTAL, ...extra]);
  expect(out.code, out.stderr).toBe(0);
  const clientId = /client_id:\s+(pc_[A-Za-z0-9_-]{16})/.exec(out.stdout)![1];
  const secret = /client_secret:\s+(pcs_[A-Za-z0-9_-]{43})/.exec(out.stdout)![1];
  created.push(clientId);
  return { clientId, secret, out };
}

const row = async (clientId: string) =>
  (await admin`select * from partner_clients where client_id = ${clientId}`)[0];

beforeAll(() => {
  admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1 });
});

afterAll(async () => {
  if (created.length) await admin`delete from partner_clients where client_id in ${admin(created)}`;
  await admin.end();
  for (const s of spies) expect(s).not.toHaveBeenCalled();
});

test("the script's inlined hash and scope list match secrets.ts and scopes.ts", () => {
  for (const s of ["", "pcs_abc", "ünï", "x".repeat(500)]) expect(hashSecret(s)).toBe(sha256Hex(s));
  expect(GRANTABLE_SCOPES).toEqual(GRANTABLE);
});

test("create prints the client id and the secret once; the stored hash verifies it", async () => {
  const { clientId, secret, out } = await create();
  expect(out.stdout).toMatch(/store this now; it can't be shown again/i);
  expect(out.stdout.split(secret)).toHaveLength(2); // printed exactly once
  const r = await row(clientId);
  expect(r.name).toBe("Social Media Agent");
  expect(safeEqualHex(r.secret_hash, sha256Hex(secret))).toBe(true);
  expect(r.secret_hash).not.toContain(secret.slice(4));
  expect(redirectUriMatches(PORTAL, r.redirect_uris)).toBe(true);
  expect(r.allowed_scopes).toEqual([...GRANTABLE]); // default: every grantable scope
  expect(r.disabled_at).toBeNull();
  expect(out.stdout).not.toContain(r.secret_hash);
});

test("create keeps redirect URIs as exact strings, deduplicated, and takes a scope subset", async () => {
  const other = "https://portal.example/askcart/callback/";
  const { clientId } = await create(["--redirect", other, "--redirect", PORTAL, "--scopes", "read:shop,read:orders"]);
  const r = await row(clientId);
  expect(r.redirect_uris).toEqual([PORTAL, other]);
  expect(r.allowed_scopes).toEqual(["read:orders", "read:shop"]);
});

test("a non-https redirect is refused unless --dev, and --dev allows only http://localhost outside production", async () => {
  const before = (await admin`select count(*)::int as n from partner_clients`)[0].n;
  for (const bad of [
    "http://portal.example/cb",
    "https://portal.example/cb#frag",
    "https://user:pw@portal.example/cb",
    "portal.example/cb",
    "https://portal.example/c b",
    "javascript:alert(1)",
  ]) {
    const out = await cli(["create", "--name", "X", "--redirect", bad]);
    expect(out.code, bad).not.toBe(0);
    expect(out.stderr).toMatch(/redirect/i);
  }
  expect((await cli(["create", "--name", "X", "--redirect", "http://portal.example/cb", "--dev"])).code).not.toBe(0);
  const prod = await cli(["create", "--name", "X", "--redirect", "http://localhost:3000/cb", "--dev"], { NODE_ENV: "production" });
  expect(prod.code).not.toBe(0);
  expect((await admin`select count(*)::int as n from partner_clients`)[0].n).toBe(before);

  const { clientId } = await create(["--redirect", "http://localhost:3000/cb", "--dev"]);
  expect((await row(clientId)).redirect_uris).toEqual([PORTAL, "http://localhost:3000/cb"]);
});

test("parseRedirect returns the exact input string", () => {
  expect(parseRedirect(PORTAL, false)).toBe(PORTAL);
  expect(parseRedirect("https://Portal.example/A?x=1", false)).toBe("https://Portal.example/A?x=1");
  expect(() => parseRedirect("http://127.0.0.1/cb", false)).toThrow();
  expect(parseRedirect("http://127.0.0.1/cb", true)).toBe("http://127.0.0.1/cb");
});

test("a reserved or unknown scope is refused, and so is an empty scope list", async () => {
  for (const scopes of ["read:shop,write:orders", "read:customers", "read:everything", "", "read:shop,,read:orders"]) {
    const out = await cli(["create", "--name", "X", "--redirect", PORTAL, "--scopes", scopes]);
    expect(out.code, scopes).not.toBe(0);
    expect(out.stderr).toMatch(/scope/i);
  }
});

test("create refuses a missing name, a missing redirect, and an unknown option", async () => {
  expect((await cli(["create", "--redirect", PORTAL])).code).not.toBe(0);
  expect((await cli(["create", "--name", "   ", "--redirect", PORTAL])).code).not.toBe(0);
  expect((await cli(["create", "--name", "X"])).code).not.toBe(0);
  expect((await cli(["create", "--name", "X", "--redirect", PORTAL, "--secret", "s"])).code).not.toBe(0);
  expect((await cli(["frobnicate"])).code).not.toBe(0);
});

test("rotate-secret makes the old secret fail and prints the new one once", async () => {
  const { clientId, secret } = await create();
  const out = await cli(["rotate-secret", clientId]);
  expect(out.code, out.stderr).toBe(0);
  const fresh = /client_secret:\s+(pcs_[A-Za-z0-9_-]{43})/.exec(out.stdout)![1];
  expect(fresh).not.toBe(secret);
  expect(out.stdout).toMatch(/can't be shown again/i);
  const r = await row(clientId);
  expect(safeEqualHex(r.secret_hash, sha256Hex(secret))).toBe(false);
  expect(safeEqualHex(r.secret_hash, sha256Hex(fresh))).toBe(true);
});

test("set-redirects replaces the list, with the same validation", async () => {
  const { clientId } = await create();
  const next = "https://portal.example/v2/callback";
  expect((await cli(["set-redirects", clientId, "--redirect", "http://portal.example/x"])).code).not.toBe(0);
  expect((await row(clientId)).redirect_uris).toEqual([PORTAL]);
  const out = await cli(["set-redirects", clientId, "--redirect", next]);
  expect(out.code, out.stderr).toBe(0);
  expect((await row(clientId)).redirect_uris).toEqual([next]);
});

test("disable sets disabled_at once; list shows it and never prints a hash or secret", async () => {
  const { clientId, secret } = await create();
  expect((await cli(["disable", clientId])).code).toBe(0);
  const first = (await row(clientId)).disabled_at;
  expect(first).not.toBeNull();
  expect((await cli(["disable", clientId])).code).toBe(0);
  expect((await row(clientId)).disabled_at).toEqual(first); // idempotent

  const out = await cli(["list"]);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout).toContain(clientId);
  expect(out.stdout).toContain(PORTAL);
  expect(out.stdout).toMatch(/disabled/i);
  expect(out.stdout).not.toMatch(/[0-9a-f]{64}/);
  expect(out.stdout).not.toContain(secret);
  expect(out.stdout).not.toMatch(/pcs_/);
});

test("an unknown client id fails without writing", async () => {
  for (const cmd of ["rotate-secret", "disable"]) {
    const out = await cli([cmd, "pc_doesnotexist0000"]);
    expect(out.code).not.toBe(0);
    expect(out.stdout).not.toMatch(/pcs_/);
  }
  expect((await cli(["set-redirects", "pc_doesnotexist0000", "--redirect", PORTAL])).code).not.toBe(0);
});

test("without DATABASE_ADMIN_URL the script refuses to run", async () => {
  const out = await cli(["list"], { DATABASE_ADMIN_URL: "" });
  expect(out.code).not.toBe(0);
  expect(out.stderr).toMatch(/DATABASE_ADMIN_URL/);
});
