// Registers the portals that may use the partner connect flow (plan (e), C36: only the owner's own portal, so there
// is no self-serve registration; this script is the only writer of partner_clients).
//   node --env-file=.env scripts/partner-client.mjs create --name "Social Media Agent" --redirect https://… [--redirect …] [--scopes read:orders,read:products,read:shop] [--dev]
//   node --env-file=.env scripts/partner-client.mjs list
//   node --env-file=.env scripts/partner-client.mjs rotate-secret <client_id>
//   node --env-file=.env scripts/partner-client.mjs set-redirects <client_id> --redirect https://… [--redirect …] [--dev]
//   node --env-file=.env scripts/partner-client.mjs disable <client_id>
// Uses DATABASE_ADMIN_URL because app_user can only read partner_clients; a developer tool like seed-faq.mjs.
// The client secret is printed once (create, rotate-secret) and only its sha256 hex is stored. rotate-secret replaces
// the hash at once, so the portal must be updated straight away: with one portal there is no two-secret overlap
// (ceiling noted in the plan). Redirect URIs are stored as the exact strings given: the connect route matches them
// with no normalisation, so register exactly what the portal sends.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import postgres from "postgres";

// Inlined from src/lib/partner/secrets.ts and scopes.ts (a .mjs can't import TS);
// tests/partner/client-script.test.ts locks that they match.
export const hashSecret = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const GRANTABLE_SCOPES = ["read:orders", "read:products", "read:shop"];
const newClientId = () => "pc_" + randomBytes(12).toString("base64url");
const newClientSecret = () => "pcs_" + randomBytes(32).toString("base64url");

class UsageError extends Error {}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates one redirect URI and returns it unchanged (the exact string is what gets stored and matched).
 * https only, no fragment, no credentials, printable ASCII without spaces. `dev` also allows http on localhost.
 */
export function parseRedirect(s, dev) {
  if (typeof s !== "string" || s.length === 0 || s.length > 2000 || !/^[\x21-\x7e]+$/.test(s)) {
    throw new UsageError(`Invalid redirect URI ${JSON.stringify(s)}: printable ASCII without spaces, at most 2000 characters.`);
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new UsageError(`Invalid redirect URI ${JSON.stringify(s)}: not an absolute URL.`);
  }
  if (s.includes("#")) throw new UsageError(`Invalid redirect URI ${s}: no fragment allowed.`);
  if (u.username || u.password) throw new UsageError(`Invalid redirect URI ${s}: no user or password allowed.`);
  const devHttp = dev && u.protocol === "http:" && DEV_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !devHttp) {
    throw new UsageError(`Invalid redirect URI ${s}: must be https (http://localhost only with --dev).`);
  }
  return s;
}

function parseRedirects(list, dev) {
  if (!list || list.length === 0) throw new UsageError("At least one --redirect is required.");
  if (dev && process.env.NODE_ENV === "production") throw new UsageError("--dev is not allowed when NODE_ENV=production.");
  return [...new Set(list.map((r) => parseRedirect(r, dev)))];
}

function parseScopes(s) {
  if (s === undefined) return [...GRANTABLE_SCOPES];
  const names = s.split(",");
  for (const n of names) {
    // Reserved names (write:*, read:customers) are refused like unknown ones (D73).
    if (!GRANTABLE_SCOPES.includes(n)) throw new UsageError(`Unknown or reserved scope ${JSON.stringify(n)}; allowed: ${GRANTABLE_SCOPES.join(",")}.`);
  }
  return GRANTABLE_SCOPES.filter((g) => names.includes(g));
}

function parseName(s) {
  const name = (s ?? "").trim();
  // Shown to merchants on the consent screen.
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new UsageError("--name is required: 1 to 100 characters, no control characters.");
  }
  return name;
}

function printSecret(clientId, secret) {
  console.log(`client_id:     ${clientId}`);
  console.log(`client_secret: ${secret}`);
  console.log("Store this now; it can't be shown again (only its hash is kept).");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      redirect: { type: "string", multiple: true },
      scopes: { type: "string" },
      dev: { type: "boolean", default: false },
    },
  });
  const clientIdArg = () => {
    if (positionals.length !== 1) throw new UsageError(`Usage: ${cmd} <client_id>`);
    return positionals[0];
  };

  // Validate everything before touching the database.
  let job;
  switch (cmd) {
    case "create": {
      if (positionals.length) throw new UsageError("create takes no positional arguments.");
      const name = parseName(values.name);
      const redirects = parseRedirects(values.redirect, values.dev);
      const scopes = parseScopes(values.scopes);
      job = async (sql) => {
        const clientId = newClientId();
        const secret = newClientSecret();
        await sql`insert into partner_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes)
                  values (${clientId}, ${name}, ${hashSecret(secret)}, ${redirects}, ${scopes})`;
        console.log(`Created portal client "${name}" with scopes ${scopes.join(",")}.`);
        printSecret(clientId, secret);
      };
      break;
    }
    case "list":
      if (positionals.length) throw new UsageError("list takes no arguments.");
      job = async (sql) => {
        // Never select secret_hash.
        const rows = await sql`select client_id, name, redirect_uris, allowed_scopes, created_at, disabled_at
                               from partner_clients order by created_at`;
        if (rows.length === 0) console.log("No portal clients.");
        for (const r of rows) {
          const status = r.disabled_at ? `disabled ${r.disabled_at.toISOString()}` : "active";
          console.log(`${r.client_id}  ${JSON.stringify(r.name)}  ${status}  created ${r.created_at.toISOString()}`);
          console.log(`  scopes:    ${r.allowed_scopes.join(",")}`);
          for (const u of r.redirect_uris) console.log(`  redirect:  ${u}`);
        }
      };
      break;
    case "rotate-secret": {
      const clientId = clientIdArg();
      job = async (sql) => {
        const secret = newClientSecret();
        const res = await sql`update partner_clients set secret_hash = ${hashSecret(secret)} where client_id = ${clientId}`;
        if (res.count !== 1) throw new UsageError(`No portal client ${clientId}.`);
        console.log("Rotated: the old secret stops working now.");
        printSecret(clientId, secret);
      };
      break;
    }
    case "set-redirects": {
      const clientId = clientIdArg();
      const redirects = parseRedirects(values.redirect, values.dev);
      job = async (sql) => {
        const res = await sql`update partner_clients set redirect_uris = ${redirects} where client_id = ${clientId}`;
        if (res.count !== 1) throw new UsageError(`No portal client ${clientId}.`);
        console.log(`Redirect URIs of ${clientId}:`);
        for (const u of redirects) console.log(`  ${u}`);
      };
      break;
    }
    case "disable": {
      const clientId = clientIdArg();
      job = async (sql) => {
        // Idempotent: keeps the first disabled_at. New connects and token exchanges are refused for a disabled client;
        // revoking its existing grants is a separate step.
        const res = await sql`update partner_clients set disabled_at = coalesce(disabled_at, now())
                              where client_id = ${clientId} returning disabled_at`;
        if (res.count !== 1) throw new UsageError(`No portal client ${clientId}.`);
        console.log(`Disabled ${clientId} (since ${res[0].disabled_at.toISOString()}).`);
      };
      break;
    }
    default:
      throw new UsageError("Usage: partner-client.mjs create | list | rotate-secret <id> | set-redirects <id> | disable <id>");
  }

  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new UsageError("DATABASE_ADMIN_URL is not set (run with node --env-file=.env).");
  const sql = postgres(url, { max: 1 });
  try {
    await job(sql);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    // UsageError and parseArgs errors carry no secrets; anything else is reported by message only.
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
