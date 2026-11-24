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
are served by EC2 from `public/`; `npm run build` already runs the widget build first, so the EC2 build needs nothing extra.

## 1. Instance

- Ubuntu 24.04 LTS, at least **t3.small (2 GB RAM)**. `next build` needs memory, so add 2 GB of swap on small
  instances:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
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

### Backups (required before the merchant installs)

Without this, one bad disk or a bad migration loses every conversation and every store token. Do it now, and test the
restore once.

```bash
sudo apt install -y awscli                       # or the AWS CLI v2 installer
aws configure                                    # or attach an instance role that can write to the bucket
aws s3 mb s3://askcart-backups-<unique-suffix>   # then add a lifecycle rule to expire dumps after 30 days
sudo install -d -o ubuntu -g ubuntu /var/backups/askcart
```

`/home/ubuntu/backup-askcart.sh` (`chmod +x`; put the admin password in `~/.pgpass` as
`localhost:5432:shopassist:shopassist:<admin-pw>`, mode 600, so the script has no secret in it):

```bash
#!/bin/bash
set -euo pipefail
f=/var/backups/askcart/shopassist-$(date +%F).dump
pg_dump -h localhost -U shopassist -Fc shopassist > "$f"
aws s3 cp "$f" s3://askcart-backups-<unique-suffix>/ --only-show-errors
find /var/backups/askcart -name '*.dump' -mtime +3 -delete
```

`crontab -e`: `15 3 * * * /home/ubuntu/backup-askcart.sh >> /var/log/askcart-backup.log 2>&1`
(`sudo touch /var/log/askcart-backup.log && sudo chown ubuntu /var/log/askcart-backup.log`). Check the next morning that
a file appeared in S3. `TOKEN_KEY` and `CHAT_TOKEN_SECRET` are **not** in the database: store them in a password
manager, or a restored database can't decrypt its store tokens.

**Test a restore** (once now, then every few months) into a scratch database, never over the live one:

```bash
aws s3 cp s3://askcart-backups-<unique-suffix>/shopassist-<date>.dump /tmp/r.dump
sudo -u postgres createdb -O shopassist restore_test
sudo -u postgres psql restore_test -c 'CREATE EXTENSION IF NOT EXISTS vector'
pg_restore -h localhost -U shopassist -d restore_test --no-owner /tmp/r.dump
sudo -u postgres psql restore_test -c 'select count(*) from stores; select count(*) from conversations'
sudo -u postgres dropdb restore_test && rm /tmp/r.dump
```

The counts should match the live database. (EBS snapshots of the volume are a good extra, not a replacement.)

## 3. Node and the app

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs   # Node 22+ (package.json engines)
sudo npm i -g pm2
pm2 install pm2-logrotate         # as the user that runs pm2; without it pm2's logs grow until the disk is full
```

The repository is private, so the instance needs a **read-only deploy key**:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/askcart_deploy -N ""      # on the instance
cat ~/.ssh/askcart_deploy.pub                              # paste into GitHub → the repo → Settings → Deploy keys (leave "Allow write access" off)
printf 'Host github.com\n  IdentityFile ~/.ssh/askcart_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
git clone git@github.com:Developerodin/BNC-SOCIALMEDIAAGENT.git askcart && cd askcart && git checkout m1-foundation
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
# Reasoning effort per model. The small model defaults to "none", and some models reject that. If the smoke test below
# shows "Assistant unavailable", set the one that fails to "low" (and restart: pm2 restart askcart --update-env).
# OPENAI_REASONING_SMALL=low
# OPENAI_REASONING_LARGE=low
UCP_AGENT_PROFILE_URL=https://app.askcart.example/ucp-agent-profile.json   # turns on Shopify Catalog MCP tools
# Legacy partner access only, if the Social Media Agent still uses it:
# PARTNER_STORE_DOMAIN=...  PARTNER_API_SECRET=...
```

To generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
`TEST_DATABASE_*` aren't needed in production.

Build, migrate, start:

```bash
npm run build                             # builds the widget files, then Next.js
npx drizzle-kit migrate                   # runs as DATABASE_ADMIN_URL; grants app_user its rights
# --kill-timeout: on restart pm2 waits up to 10 s for running answers to finish before killing the process
pm2 start npm --name askcart --kill-timeout 10000 -- start   # next start on port 3000
pm2 save && pm2 startup                   # restart on reboot (run the command it prints)
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
  # Shopify webhooks (product syncs, redactions) can be larger than the 1 MB default allows.
  location /api/webhooks {
    client_max_body_size 5m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
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
   `redirect_urls = ["https://app.askcart.example/api/auth"]`, **and** the `[app_proxy]` `url` (currently
   `https://example.com/api/proxy`) to `https://app.askcart.example/api/proxy`. Without it signed-in shoppers can't
   continue their chat on the website.
2. `npm run build:widget`, then `shopify app deploy --config shopify.app.askcart.toml`.
3. Dev Dashboard → **Distribution → Custom** → the merchant's `.myshopify.com` domain → send them the install link.

## 6. Smoke test after deploy

- `https://app.askcart.example/ucp-agent-profile.json` loads.
- The merchant installs the app → the AskCart page loads in their admin → the product sync finishes.
- Connect your website → Turn on chat → Save → the chat answers on the storefront with product cards.
- Ask "What is your return policy?" → the answer comes from Shopify's MCP. If every answer says "Assistant
  unavailable", the model rejected its reasoning setting: set `OPENAI_REASONING_SMALL=low` (see `.env` above).
- Logged in on the storefront, open the chat: it continues the latest conversation (including one from the app).
- `pm2 logs askcart` shows no errors.

## Updating

```bash
cd askcart && git pull && npm ci && npm run build && npx drizzle-kit migrate && pm2 restart askcart
```

If the widget changed, also run `npm run build:widget` and `shopify app deploy` from your machine.

**Deploy off-peak.** A restart in the middle of an answer cuts it off and locks that conversation for about 90 seconds
(the shopper sees "busy" until the lock expires). `--kill-timeout 10000` lets short answers finish first, not long ones.
