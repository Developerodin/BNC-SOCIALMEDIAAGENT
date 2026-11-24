# AskCart

An AI shopping assistant for Shopify stores: a chat on the storefront that finds products, shows cards with live price
and stock, adds to the cart, and answers store policy questions (through Shopify's MCP). The same assistant is available
on other websites (one-line embed or a hosted chat link) and in the merchant's mobile app (mobile API).

Built with Next.js 16, TypeScript, Postgres 17 + pgvector, pg-boss jobs and OpenAI.

## Guides

| I want to… | Read |
|---|---|
| Deploy on EC2 and set the app up in Shopify (step by step) | [`docs/deploy-ec2.md`](docs/deploy-ec2.md) |
| Put the chat on a non-Shopify website | [`docs/embed.md`](docs/embed.md) |
| Connect a mobile app | [`docs/mobile-api.md`](docs/mobile-api.md) |
| Connect a partner portal (Social Media Agent) | [`docs/partner-api.md`](docs/partner-api.md) |
| Prepare the Shopify App Store submission | [`docs/publish-checklist.md`](docs/publish-checklist.md) |
| Serve stores without an app install (MCP-only) | [`docs/superpowers/plans/2026-11-24-mcp-only-plan.md`](docs/superpowers/plans/2026-11-24-mcp-only-plan.md) |

## Local development (Windows or macOS)

Needs Node 22+, Docker Desktop and the Shopify CLI.

```bash
npm ci
cp .env.example .env          # fill in the values (see the comments in the file)
docker compose up -d          # Postgres + pgvector on localhost:5432
npx drizzle-kit migrate       # create the tables
shopify app dev --config shopify.app.askcart.toml --store <your-dev-store>.myshopify.com
```

Enter the storefront password when asked (Shopify admin → Online Store → Preferences → Store access). Press `p` to open
the app, then turn on **AskCart chat** in the theme's App embeds and open the storefront (not `127.0.0.1:9293`, which is
the CLI's separate development theme).

Tests: `npx vitest run` (the `tests/live` files call the real OpenAI API and only run when it is configured).
Type check: `npx tsc --noEmit -p .` · Lint: `npx eslint src tests widget`.

If Docker stops (for example after a crash), start Docker Desktop and run `docker compose up -d` again.
