# Deploying AskCart on EC2 (app + Postgres on one instance)

## What runs where

The repo is split by where things run: **`server/`** goes to EC2, **`shopify/`** goes to Shopify. The
`shopify.app.askcart.toml` at the root is the Shopify CLI's entry point and points at both folders.

| Part | Where | How it gets there |
|---|---|---|
| Theme app extension: chat launcher and widget JS/CSS, the app embed, "Ask about this product" and FAQ blocks (`shopify/extensions/askcart/`) | **Shopify's CDN** | `shopify app deploy` from your machine or CI. Never on EC2. |
| App config: URLs, scopes, webhooks, App Proxy (`shopify.app.askcart.toml`) | **Shopify** | `shopify app deploy` |
| AskCart server (Next.js): AI chat API, admin pages, webhooks, OAuth, partner API, mobile API, MCP tools, `/chat/<shop>`, `/embed.js` | **EC2** | Build and run with Node (below) |
| Background jobs (pg-boss: product sync, webhooks, redaction) | **EC2**, inside the same Node process | Starts automatically with the server (`server/src/instrumentation.ts`). No separate worker. |
| Postgres 17 + pgvector | **EC2** | Installed below |
| OpenAI | OpenAI | Uses `OPENAI_API_KEY` |
| Shopify Storefront/Catalog MCP | Each store's own domain | Called from EC2; nothing to deploy |

The widget is built once (`npm run build:widget`) into `shopify/extensions/askcart/assets/`. Shopify serves those files after
`shopify app deploy`, so run the widget build **before** `shopify app deploy`. The hosted chat page and `embed.js`
are served by EC2 from `server/public/`; `npm run build` already runs the widget build first, so the EC2 build needs nothing extra.

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
sudo snap install aws-cli --classic             # Ubuntu 24.04 has no awscli apt package
aws configure                                    # or attach an instance role that can write to the bucket
aws s3 mb s3://askcart-backups-<unique-suffix>   # then add a lifecycle rule to expire dumps after 30 days
sudo install -d -o ubuntu -g ubuntu /var/backups/askcart
```

`/home/ubuntu/backup-askcart.sh` (`chmod +x`; put the admin password in `~/.pgpass` as
`localhost:5432:*:shopassist:<admin-pw>`, mode 600, so the script has no secret in it):

```bash
#!/bin/bash
set -euo pipefail
# cron's PATH is only /usr/bin:/bin; aws (snap) lives in /snap/bin.
export PATH=/usr/local/bin:/snap/bin:/usr/bin:/bin
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
git clone git@github.com:Developerodin/BNC-SOCIALMEDIAAGENT.git askcart && cd askcart/server   # branch main
npm ci
```

Create `server/.env` (never commit it). Every variable in `.env.example`, with production values:

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
UCP_AGENT_PROFILE_URL=https://app.askcart.example/ucp-agent-profile.json   # turns on Shopify Catalog MCP tools; also powers policy answers via ask_business (old policies tool is the fallback until 2027-01-15)
# Legacy partner access only, if the Social Media Agent still uses it:
# PARTNER_STORE_DOMAIN=...  PARTNER_API_SECRET=...
```

To generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
`TEST_DATABASE_*` aren't needed in production.

Build, migrate, start (all in `askcart/server`):

```bash
npm run build                             # builds the widget files, then Next.js
npx drizzle-kit migrate                   # runs as DATABASE_ADMIN_URL; grants app_user its rights
# --kill-timeout: on restart pm2 waits up to 10 s for running answers to finish before killing the process
pm2 start npm --name askcart --kill-timeout 10000 -- start   # next start on port 3000
pm2 save && pm2 startup                   # restart on reboot (run the command it prints)
```

**Run exactly one instance.** Rate limits are in memory per process, so two instances would double them (known
limit, noted in `server/src/lib/rate-limit.ts`).

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

## 5. Shopify setup (from your machine, not EC2)

Run these on your development machine, in the repo, logged in to the Shopify CLI (`shopify auth login` if needed) with
the account that owns the **AskCart** app (org CellaVei). Replace `app.askcart.example` with your real domain.

### 5.1 Point the app at your server

In `shopify.app.askcart.toml` change the three placeholder URLs:

```toml
application_url = "https://app.askcart.example"

[auth]
redirect_urls = [ "https://app.askcart.example/api/auth" ]

[app_proxy]
url = "https://app.askcart.example/api/proxy"   # website customer sign-in (signed-in shoppers keep their chat history)
subpath = "askcart"
prefix = "apps"
```

Keep the `[access_scopes]` line as it is. What each permission is for (Shopify shows them to the merchant at install,
and the App Store review asks about them):

| Scope | Why AskCart needs it |
|---|---|
| `read_products`, `read_inventory`, `read_publications` | Product sync, search and live price/stock on chat cards |
| `read_orders`, `read_all_orders` | The partner / Social Media Agent read API (`read_all_orders` needs Shopify approval for orders older than 60 days) |
| `unauthenticated_read_customers` | Verifying a mobile-app shopper's login so their chat history follows them |
| `write_app_proxy` | Required by Shopify for any app with an App Proxy (website customer sign-in) |

Commit the toml change, so the next `shopify app deploy` doesn't revert it.

### 5.2 Release the app config and the storefront widget

```bash
npm --prefix server run build:widget                 # bundles the chat widget into shopify/extensions/askcart/assets
shopify app deploy --config shopify.app.askcart.toml # releases URLs, scopes, app proxy, webhooks + the theme extension
```

Confirm the release when asked. Re-run both commands whenever the widget (`server/widget/src`) or the toml changes.
`shopify app dev` (local development) temporarily points the app at your tunnel; after using it, run
`shopify app deploy` again so the store uses the EC2 URLs.

### 5.3 Install link for the merchant (custom distribution)

1. Open the [Dev Dashboard](https://dev.shopify.com) → **Apps → AskCart → Distribution**.
2. Choose **Custom distribution** and enter the merchant's store domain (`their-store.myshopify.com`).
   This choice is **permanent** for this app; the public App Store listing will be a separate app later.
3. Copy the **install link** and send it to the merchant (it only works for that store).

Custom distribution covers **one merchant**: a single store, or several stores in the same Shopify Plus organization.
A second, unrelated merchant needs the public app (App Store review) or an MCP-only store (5.7). Creating a separate
custom app per merchant is against Shopify's Partner Program rules.

#### Store in a different organization (e.g. Bois and Chiffon)

Since **20 November 2026** Shopify requires an **IP allowlist** on any custom app installed on a store outside the
app's organization (new installs now; existing installs from 1 January 2027). Before step 1:

1. Give the EC2 instance an **Elastic IP** (EC2 → Elastic IPs → Allocate → Associate with the instance), so the app
   always calls Shopify from the same address. Point your domain's DNS at it.
2. Dev Dashboard → **Apps → AskCart** → the app's security / network settings → **IP allowlist** → add the Elastic IP
   (`x.x.x.x/32`). AskCart calls Shopify only from this server.
3. Do the same for **every other app in the organization** (CellaVei): if any app lacks an allowlist, Shopify blocks
   installing *any* of the organization's apps on outside stores.
4. If the Dev Dashboard or `shopify app deploy` asks for a **network access** declaration (enforced for some custom
   apps installed outside the organization from 1 December 2026), declare it before sending the link.

Then do steps 1–3 above with the outside store's domain, and the merchant installs as in 5.4 while logged in to **their**
store's admin. If you move the app to another server, update the allowlist first, or Shopify refuses its API calls.

Sources: [IP allowlists for custom apps installed outside your organization](https://shopify.dev/changelog/posts/ip-allowlists-are-now-required-for-custom-apps-installed-outside-your-organization),
[About app distribution](https://shopify.dev/docs/apps/launch/distribution), [About app security](https://shopify.dev/docs/apps/build/security).

### 5.4 What the merchant does (≈2 minutes)

1. Opens the link, logs in to their Shopify admin, reviews the permissions and clicks **Install**.
2. AskCart opens in their admin (Apps → AskCart) and starts syncing products automatically ("Products synced ✓").
3. **Setup guide → Turn on chat** → the theme editor opens with **AskCart chat** selected → **Save** → back in AskCart,
   **I've turned it on**. (Manual path: Online Store → Themes → Customize → the **App embeds** icon in the left toolbar →
   AskCart chat on → Save. App embeds are per theme: use the published one.)
4. Optional: **Chat widget** card: name, accent colour, avatar (a `cdn.shopify.com` Files URL), launcher text and side,
   welcome message, up to 4 suggested questions, teaser. **Save** updates the storefront.

The chat button now shows bottom-right on their storefront.

### 5.5 Optional: other websites, the hosted chat link, the mobile app

- **Another website (WordPress, Wix, custom):** AskCart → **Connect your website** → enter the site → **Allow chat on
  …** → copy the one-line `<script>` into the site's pages, or share the hosted chat link `https://app.askcart.example/chat/<store>.myshopify.com`.
  Only allowed sites can show the chat. Details: `docs/embed.md`.
- **Mobile app:** AskCart → **Mobile app key → Create key** → give the key (shown once) and `docs/mobile-api.md` to the
  app's developer. Customer sign-in from the app works after the merchant approved `unauthenticated_read_customers`.

### 5.6 Agent profile (Shopify MCP features)

`UCP_AGENT_PROFILE_URL` in the EC2 `.env` must be `https://app.askcart.example/ucp-agent-profile.json` (served from
`server/public/`). It turns on: policy answers through Shopify's `ask_business` (the old policies tool is the fallback until
2027-01-15), the `product_details` tool, and MCP-only stores. Check it loads in a browser after deploying.

### 5.7 Optional: an MCP-only store (no app install)

For a Shopify store that has **not** installed AskCart (see `docs/superpowers/plans/2026-11-24-mcp-only-plan.md`):

1. Send the merchant the embed line to paste into their theme (`Online Store → Themes → Edit code → layout/theme.liquid`,
   before `</body>`; for a password-protected store also `layout/password.liquid`):
   `<script src="https://app.askcart.example/embed.js" data-shop="their-store.myshopify.com" defer></script>`
2. On EC2 (in `askcart/server`), create the store record:
   ```bash
   npx tsx --env-file=.env --tsconfig tsconfig.json scripts/provision-mcp-store.mts their-store.myshopify.com --name "Their Store"
   ```
   It checks the storefront, reads the currency from Shopify, and stops if the store redirects to a custom domain:
   check it's theirs, then re-run with `--confirm-domain www.their-domain.com`.
3. Limits for these stores: no stock counts, guest chats only, 100 messages a day. To switch one off:
   `UPDATE stores SET active = false WHERE shop_domain = 'their-store.myshopify.com';`
4. If the merchant later installs the app, the same record switches to the full app automatically.

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
cd askcart/server && git pull && npm ci && npm run build && npx drizzle-kit migrate && pm2 restart askcart
```

If the widget changed, also run `npm --prefix server run build:widget` and `shopify app deploy` from your machine.

**Deploy off-peak.** A restart in the middle of an answer cuts it off and locks that conversation for about 90 seconds
(the shopper sees "busy" until the lock expires). `--kill-timeout 10000` lets short answers finish first, not long ones.
