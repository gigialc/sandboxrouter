/**
 * The hosted sandboxrouter API. Users sign in with GitHub, prepay credit with Stripe and call one
 * key; sandboxes run on the provider keys in this process's environment (the same variables the
 * CLI reads, e.g. E2B_API_KEY). Configuration: see README.md.
 */
import { CATALOG, Router, defaultProviders } from "../src/index.js";
import { createHostedApp } from "./src/app.js";
import { openDb } from "./src/db.js";
import { DEFAULT_LIMITS, type Limits } from "./src/meter.js";

const env = process.env;
const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);
const production = env.NODE_ENV === "production";

const databaseUrl = env.DATABASE_URL ?? (production ? undefined : "pglite:./.data");
if (!databaseUrl) throw new Error("DATABASE_URL is required in production");
const port = num("PORT", 8787);
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;

// Local-only providers (Docker) never serve hosted traffic; POOL_PROVIDERS narrows the pool further.
const pool = env.POOL_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean);
const local = new Set(CATALOG.filter((c) => c.local).map((c) => c.id));
const router = new Router({ providers: defaultProviders().filter((p) => !local.has(p.id) && (!pool || pool.includes(p.id))) });

const limits: Limits = {
  feePct: num("FEE_PCT", DEFAULT_LIMITS.feePct),
  maxConcurrent: num("MAX_CONCURRENT", DEFAULT_LIMITS.maxConcurrent),
  minBalanceUsd: num("MIN_BALANCE_USD", DEFAULT_LIMITS.minBalanceUsd),
  maxLifetimeMinutes: num("MAX_LIFETIME_MINUTES", DEFAULT_LIMITS.maxLifetimeMinutes),
  maxVcpu: num("MAX_VCPU", DEFAULT_LIMITS.maxVcpu),
  maxMemoryGb: num("MAX_MEMORY_GB", DEFAULT_LIMITS.maxMemoryGb),
};

const devLogin = !production && env.DEV_LOGIN === "1";
const db = await openDb(databaseUrl);
const { server, meter } = createHostedApp(db, router, {
  publicUrl,
  contact: env.CONTACT_EMAIL ?? "github.com/gigialc/sandboxrouter/security",
  limits,
  github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
  stripe: env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET } : undefined,
  devLogin,
  signupCreditUsd: num("SIGNUP_CREDIT_USD", 0),
});

const tick = () => meter.tick().catch((err) => console.error("meter:", err.message));
setInterval(tick, 60_000);
void tick();

server.listen(port, () => {
  const configured = router.registered().filter((id) => router.isConfigured(id));
  console.log(`sandboxrouter hosted on ${publicUrl} (port ${port})`);
  console.log(`pool: ${configured.join(", ") || "no provider keys set"}`);
  console.log(`sign-in: ${env.GITHUB_CLIENT_ID ? "GitHub" : "GitHub not set"}${devLogin ? ", dev login on" : ""}; payments: ${env.STRIPE_SECRET_KEY ? "Stripe" : "not set"}`);
});
