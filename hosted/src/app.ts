import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp, type Router } from "../../src/index.js";
import {
  addCredit,
  balance,
  createKey,
  createSession,
  endSession,
  listKeys,
  revokeKey,
  SESSION_DAYS,
  upsertUser,
  userFromKey,
  userFromSession,
  type User,
} from "./accounts.js";
import { MICROS, type Db } from "./db.js";
import { Meter, type Limits } from "./meter.js";
import { createCheckout, verifyWebhook } from "./stripe.js";

export interface HostedConfig {
  /** Where this service is reached, e.g. https://api.sandboxrouter.dev (OAuth and Stripe redirect here). */
  publicUrl: string;
  /** Shown on the dashboard for support and abuse reports. */
  contact: string;
  limits: Limits;
  github?: { clientId: string; clientSecret: string };
  stripe?: { secretKey: string; webhookSecret: string; apiBase?: string };
  /** /auth/dev?login=name signs in without GitHub. Local runs only. */
  devLogin?: boolean;
  /** Credit for each new account, in USD. */
  signupCreditUsd?: number;
  fetch?: typeof fetch;
}

const TOPUPS_USD = [5, 10, 25, 50, 100];
const PORTAL = readFileSync(new URL("./portal.html", import.meta.url), "utf8");

export function createHostedApp(db: Db, router: Router, config: HostedConfig, now?: () => Date) {
  const meter = new Meter(db, router, config.limits, now);
  const f = config.fetch ?? fetch;
  const secure = config.publicUrl.startsWith("https://");
  const base = config.publicUrl.replace(/\/+$/, "");

  const cookie = (name: string, value: string, maxAgeSeconds: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;

  const signIn = async (res: ServerResponse, u: { id: string; login: string; email?: string | null }) => {
    const user = await upsertUser(db, u);
    if (config.signupCreditUsd) await addCredit(db, user.id, "grant", config.signupCreditUsd * MICROS, `signup:${user.id}`, "welcome credit");
    const t = await createSession(db, user.id);
    res.writeHead(302, { Location: "/dashboard", "Set-Cookie": cookie("sr_session", t, SESSION_DAYS * 86400) });
    res.end();
  };

  const me = async (user: User) => {
    const sandboxes = (
      await db.query(
        `select s.id, s.provider, s.list_hourly_usd, s.rate_micros, s.started_at, s.ended_at, s.end_reason,
                coalesce(-l.amount_micros, 0) as cost
         from sandboxes s left join ledger l on l.ref = 'usage:' || s.id
         where s.user_id = $1 order by s.started_at desc limit 30`,
        [user.id],
      )
    ).rows.map((s) => ({
      id: s.id,
      provider: s.provider,
      listHourlyUsd: s.list_hourly_usd,
      hourlyUsd: Number(s.rate_micros) / MICROS,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      endReason: s.end_reason,
      costUsd: Number(s.cost) / MICROS,
    }));
    const ledger = (
      await db.query("select kind, amount_micros, note, created_at from ledger where user_id = $1 and kind <> 'usage' order by created_at desc limit 30", [
        user.id,
      ])
    ).rows.map((l) => ({ kind: l.kind, amountUsd: Number(l.amount_micros) / MICROS, note: l.note, createdAt: l.created_at }));
    return {
      login: user.login,
      blocked: user.blocked,
      balanceUsd: (await balance(db, user.id)) / MICROS,
      keys: await listKeys(db, user.id),
      sandboxes,
      ledger,
      apiUrl: base,
      contact: config.contact,
      limits: config.limits,
      topups: config.stripe ? TOPUPS_USD : [],
    };
  };

  async function account(req: IncomingMessage, res: ServerResponse, parts: string[]) {
    const user = await userFromSession(db, cookies(req).sr_session);
    if (!user) return send(res, 401, { error: "sign in first" });
    if (req.method !== "GET" && req.headers["x-sr"] !== "1") return send(res, 403, { error: "missing X-SR header" });

    if (req.method === "GET" && parts[1] === "me") return send(res, 200, await me(user));
    if (req.method === "POST" && parts[1] === "keys" && parts.length === 2) {
      const { name } = await body(req);
      return send(res, 201, await createKey(db, user.id, typeof name === "string" ? name : ""));
    }
    if (req.method === "DELETE" && parts[1] === "keys" && parts[2]) {
      return send(res, (await revokeKey(db, user.id, parts[2])) ? 200 : 404, { revoked: parts[2] });
    }
    if (req.method === "DELETE" && parts[1] === "sandboxes" && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      if (!(await meter.owns(user, id))) return send(res, 404, { error: "no such sandbox" });
      await (await router.get(id)).kill().catch(() => {});
      await meter.end(id, "deleted");
      return send(res, 200, { id, killed: true });
    }
    if (req.method === "POST" && parts[1] === "topup") {
      if (!config.stripe) return send(res, 400, { error: "payments aren't set up on this server" });
      const usd = Number((await body(req)).usd);
      if (!TOPUPS_USD.includes(usd)) return send(res, 400, { error: `usd must be one of ${TOPUPS_USD.join(", ")}` });
      const session = await createCheckout({
        secretKey: config.stripe.secretKey,
        apiBase: config.stripe.apiBase,
        userId: user.id,
        email: user.email,
        cents: usd * 100,
        successUrl: `${base}/dashboard?topup=done`,
        cancelUrl: `${base}/dashboard`,
        fetch: f,
      });
      return send(res, 200, { url: session.url });
    }
    if (req.method === "POST" && parts[1] === "logout") {
      await endSession(db, cookies(req).sr_session);
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": cookie("sr_session", "", 0) });
      return res.end("{}");
    }
    return send(res, 404, { error: "not found" });
  }

  async function github(req: IncomingMessage, res: ServerResponse, url: URL) {
    const gh = config.github;
    if (!gh) return send(res, 404, { error: "GitHub sign-in isn't set up on this server" });
    const redirectUri = `${base}/auth/github/callback`;
    if (url.pathname === "/auth/github") {
      const state = randomBytes(16).toString("base64url");
      const to = new URL("https://github.com/login/oauth/authorize");
      to.search = new URLSearchParams({ client_id: gh.clientId, redirect_uri: redirectUri, scope: "read:user user:email", state }).toString();
      res.writeHead(302, { Location: to.toString(), "Set-Cookie": cookie("sr_oauth", state, 600) });
      return res.end();
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== cookies(req).sr_oauth) return send(res, 400, { error: "sign-in expired; try again" });
    const tok = (await (
      await f("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: redirectUri }),
      })
    ).json()) as { access_token?: string };
    if (!tok.access_token) return send(res, 400, { error: "GitHub didn't accept the sign-in; try again" });
    const auth = { Authorization: `Bearer ${tok.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "sandboxrouter" };
    const ghUser = (await (await f("https://api.github.com/user", { headers: auth })).json()) as { id: number; login: string; email: string | null };
    let email = ghUser.email;
    if (!email) {
      const emails = (await (await f("https://api.github.com/user/emails", { headers: auth })).json()) as { email: string; primary: boolean; verified: boolean }[];
      email = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified)?.email ?? null) : null;
    }
    return signIn(res, { id: `gh:${ghUser.id}`, login: ghUser.login, email });
  }

  async function stripeWebhook(req: IncomingMessage, res: ServerResponse) {
    if (!config.stripe) return send(res, 404, { error: "not found" });
    let event: any;
    try {
      event = verifyWebhook(await raw(req), req.headers["stripe-signature"] as string | undefined, config.stripe.webhookSecret);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const s = event.data.object;
      const userId = s.metadata?.user_id ?? s.client_reference_id;
      if (s.payment_status === "paid" && userId && s.currency === "usd") {
        // amount_subtotal: what the credit is worth before any tax Stripe added on top.
        const cents = s.amount_subtotal ?? s.amount_total;
        await addCredit(db, userId, "topup", cents * (MICROS / 100), `stripe:${s.id}`, "card top-up");
      }
    }
    return send(res, 200, { received: true });
  }

  const server = createApp(router, undefined, [], {
    computers: false,
    pause: false,
    authorize: async (req) => {
      const h = req.headers.authorization ?? "";
      return h.startsWith("Bearer ") ? ((await userFromKey(db, h.slice(7).trim())) ?? null) : null;
    },
    beforeCreate: (u, spec, route) => meter.beforeCreate(u as User, spec, route),
    afterCreate: (u, sbx, spec) => meter.afterCreate(u as User, sbx, spec),
    owns: (u, id) => meter.owns(u as User, id),
    afterKill: (_u, id) => meter.end(id, "deleted"),
    async extra(req, res, url) {
      const p = url.pathname;
      if (p.startsWith("/v1/")) return false;
      if (p === "/" && req.method === "GET") {
        res.writeHead(302, { Location: "/dashboard" });
        res.end();
      } else if (p === "/dashboard" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(PORTAL);
      } else if ((p === "/auth/github" || p === "/auth/github/callback") && req.method === "GET") {
        await github(req, res, url);
      } else if (p === "/auth/dev" && req.method === "GET" && config.devLogin) {
        const login = (url.searchParams.get("login") ?? "dev").replace(/[^\w-]/g, "").slice(0, 39) || "dev";
        await signIn(res, { id: `dev:${login}`, login });
      } else if (p.startsWith("/account/")) {
        await account(req, res, p.split("/").filter(Boolean));
      } else if (p === "/stripe/webhook" && req.method === "POST") {
        await stripeWebhook(req, res);
      } else return false;
      return true;
    },
  });
  return { server, meter };
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((kv) => kv[0])
      .map(([k, ...v]) => [k, v.join("=")]),
  );
}

async function raw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await raw(req)).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
