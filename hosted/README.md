# Hosted sandboxrouter

The one-key version. Users sign in with GitHub, add credit by card, create an `sr_live_` key and call the same HTTP API as `sandboxrouter serve`. Sandboxes run on the service's own provider accounts and are billed by the second at the provider's list price plus a fee.

```ts
const sr = new Client({ baseUrl: "https://<host>", apiKey: process.env.SANDBOXROUTER_API_KEY });
```

## Run it locally

```bash
cd hosted && npm install
set -a; . ../.env.providers; set +a                 # provider keys: the pool
DEV_LOGIN=1 SIGNUP_CREDIT_USD=1 npm start            # http://localhost:8787/auth/dev?login=you
```

Without `DATABASE_URL` it keeps data in `./.data` (PGlite, in-process Postgres). PGlite allows one process at a time, so `npm run admin` needs the server stopped, or a real Postgres.

## Deploy

One Node process plus Postgres (Render, Fly, Railway or any VM). Start command `npm start` from `hosted/`, after `npm ci` in the repo root and in `hosted/`.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres. The schema is created on start. |
| `PUBLIC_URL` | e.g. `https://api.sandboxrouter.dev`; OAuth and Stripe send users back here |
| `NODE_ENV=production` | requires `DATABASE_URL`, turns dev login off |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | a GitHub OAuth app with callback `PUBLIC_URL/auth/github/callback` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | a webhook to `PUBLIC_URL/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded` |
| provider keys | the same variables as the CLI (`E2B_API_KEY`, `MARITIME_API_KEY`, …); every configured provider joins the pool |
| `POOL_PROVIDERS` | optional: only these providers, e.g. `maritime,e2b,daytona` |
| `CONTACT_EMAIL` | shown on the dashboard for support and abuse reports |
| `FEE_PCT` (5.5), `MAX_CONCURRENT` (5), `MAX_LIFETIME_MINUTES` (240), `MAX_VCPU` (8), `MAX_MEMORY_GB` (16), `MIN_BALANCE_USD` (0.10), `SIGNUP_CREDIT_USD` (0) | limits |

## How billing works

- Credit is prepaid. A sandbox can't start below `MIN_BALANCE_USD`.
- Each sandbox is charged `list price for its size × (1 + FEE_PCT/100)` per hour, by the second, from start to kill.
- Every minute the meter bills running sandboxes. It kills any that are past their lifetime, and every sandbox of a user whose balance is gone or who is blocked. A user can go at most about a minute of usage below zero.
- The ledger has one row per top-up and one growing row per sandbox. Stripe events are idempotent by session id.
- Pause and desktop computers are off on the hosted API for now; both need their own pricing.

## Operating it

```bash
npm run admin -- users                 # balances and running sandboxes
npm run admin -- grant octocat 5 beta  # free credit
npm run admin -- block octocat         # their sandboxes die within a minute
```

The router's own ledger (`~/.sandboxrouter`) records every sandbox it starts, so `npx sandboxrouter gc` on the host cleans up any sandbox the service lost track of after a crash.

## Before taking real money

- **Provider terms.** Most providers' self-serve terms forbid reselling or giving third parties access to their service without written permission. Anything a user runs counts as the account holder's activity, and each provider can suspend the whole account. Get written permission where the terms allow it. `POOL_PROVIDERS` switches a provider off without a code change.
- **Abuse.** Crypto mining, scanning and proxies from users' code would land on these accounts. The limits above cap the damage; blocking is manual.
- **Tax.** Stripe Checkout here charges in USD without tax. Selling to EU customers needs VAT handling (Stripe Tax, or a merchant of record such as Paddle or Lemon Squeezy).
