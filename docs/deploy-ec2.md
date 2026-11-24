# Deploying AskCart on EC2 (app + Postgres on one instance)

## What runs where

| Part | Where | How it gets there |
|---|---|---|
| Theme app extension: chat launcher and widget JS/CSS, the app embed, "Ask about this product" and FAQ blocks (`extensions/askcart/`) | **Shopify's CDN** | `shopify app deploy` from your machine or CI. Never on EC2. |
| App config: URLs, scopes, webhooks, App Proxy (`shopify.app.askcart.toml`) | **Shopify** | `shopify app deploy` |
| AskCart server (Next.js): AI chat API, admin pages, webhooks, OAuth, partner API, mobile API, MCP tools, `/chat/<shop>`, `/embed.js` | **EC2** | Build and run with Node (below) |
| Background jobs (pg-boss: product sync, webhooks, redaction) | **EC2**, inside the same Node process | Starts automatically with the server (`src/instrumentation.ts`). No separate worker. |
| Postgres 17 + pgvector | **EC2** | Installed below |
| OpenAI | OpenAI | Uses `OPENAI_API_KEY` |
| Shopify Storefront/Catalog MCP | Each store's own domain | Called from EC2; nothing to deploy |

The widget is built once (`npm run build:widget`) into `extensions/askcart/assets/`. Shopify serves those files after
`shopify app deploy`, so run the widget build **before** `shopify app deploy`. The hosted chat page and `embed.js`
(once merged) are served by EC2 from `public/`, so the EC2 build must also run the widget build.

## 1. Instance

- Ubuntu 24.04 LTS, at least **t3.small (2 GB RAM)**. `next build` needs memory, so add 2 GB of swap on small
  instances.
- Security group: inbound **443** and **80** (for the TLS certificate) from anywhere, and **22** from your IP only.
  **Never open 5432.**
- A **domain name** pointing at the instance's Elastic IP, e.g. `app.askcart.example`. Shopify refuses IP addresses
  and URLs containing "shopify" or "example".

## 2. Postgres 17 + pgvector (same instance)

```bash
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-17 postgresql-17-pgvector
```

Postgres listens on localhost only by default; keep it that way. Create the two roles: one owns the schema and runs
migrations, and `app_user` is what the app connects as. Row-level security only protects data when the app is **not**
the owner.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE shopassist LOGIN PASSWORD '<strong-admin-password>';
CREATE DATABASE shopassist OWNER shopassist;
CREATE ROLE app_user LOGIN PASSWORD '<strong-app-password>' NOSUPERUSER NOBYPASSRLS;
\c shopassist
CREATE EXTENSION IF NOT EXISTS vector;   -- needs superuser; migration 0004 then finds it
SQL
```

Backups: a nightly `pg_dump` to S3 (cron), or EBS snapshots of the volume. Set this up before real merchant data
arrives.

## 3. Node and the app

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs   # Node 22+ (package.json engines)
sudo npm i -g pm2
git clone https://github.com/Developerodin/BNC-SOCIALMEDIAAGENT.git askcart && cd askcart && git checkout m1-foundation
npm ci
```

Create `.env` (never commit it). Every variable in `.env.example`, with production values:

```ini
NODE_ENV=production
SHOPIFY_APP_URL=https://app.askcart.example
SHOPIFY_API_KEY=<client_id from the Dev Dashboard>
SHOPIFY_API_SECRET=<client secret>
DATABASE_ADMIN_URL=postgres://shopassist:<admin-pw>@localhost:5432/shopassist
DATABASE_URL=postgres://app_user:<app-pw>@localhost:5432/shopassist
TOKEN_KEY=<32 random bytes, base64>          # encrypts Shopify tokens at rest. Never change it after launch.
CHAT_TOKEN_SECRET=<32 random bytes, base64>  # signs chat and customer sessions. Changing it signs everyone out.
OPENAI_API_KEY=<key>
OPENAI_MODEL_SMALL=<model>
OPENAI_MODEL_LARGE=<model>
UCP_AGENT_PROFILE_URL=https://app.askcart.example/ucp-agent-profile.json   # turns on Shopify Catalog MCP tools
# Legacy partner access only, if the Social Media Agent still uses it:
# PARTNER_STORE_DOMAIN=...  PARTNER_API_SECRET=...
```

To generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
`TEST_DATABASE_*` aren't needed in production.

Build, migrate, start:

```bash
npm run build:widget && npm run build     # widget files first, then Next.js
npx drizzle-kit migrate                   # runs as DATABASE_ADMIN_URL; grants app_user its rights
pm2 start npm --name askcart -- start     # next start on port 3000
pm2 save && pm2 startup                   # restart on reboot
```

**Run exactly one instance.** Rate limits are in memory per process, so two instances would double them (known
limit, noted in `src/lib/partner/rate-limit.ts`).

## 4. Nginx + TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/askcart`:

```nginx
server {
  server_name app.askcart.example;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Overwrite (never append): the mobile key's per-IP rate limit trusts the first value.
    proxy_set_header X-Forwarded-For $remote_addr;
    # The chat streams its answer (SSE): no buffering, long reads.
    proxy_buffering off;
    proxy_read_timeout 120s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/askcart /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.askcart.example
```

## 5. Point Shopify at it (from your machine, not EC2)

1. In `shopify.app.askcart.toml`, set `application_url = "https://app.askcart.example"` and
   `redirect_urls = ["https://app.askcart.example/api/auth"]`, plus the App Proxy `url` if the customer-login work is
   merged.
2. `npm run build:widget`, then `shopify app deploy --config shopify.app.askcart.toml`.
3. Dev Dashboard → **Distribution → Custom** → the merchant's `.myshopify.com` domain → send them the install link.

## 6. Smoke test after deploy

- `https://app.askcart.example/ucp-agent-profile.json` loads.
- The merchant installs the app → the AskCart page loads in their admin → the product sync finishes.
- Connect your website → Turn on chat → Save → the chat answers on the storefront with product cards.
- Ask "What is your return policy?" → the answer comes from Shopify's MCP.
- `pm2 logs askcart` shows no errors.

## Updating

```bash
cd askcart && git pull && npm ci && npm run build:widget && npm run build && npx drizzle-kit migrate && pm2 restart askcart
```

If the widget changed, also run `shopify app deploy` from your machine.
