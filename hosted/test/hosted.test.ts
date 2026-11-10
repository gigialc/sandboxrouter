import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Router } from "../../src/index.js";
import { FakeProvider } from "../../test/fake.js";
import { createHostedApp } from "../src/app.js";
import { openDb, type Db } from "../src/db.js";
import { DEFAULT_LIMITS, type Meter } from "../src/meter.js";
import { signWebhook } from "../src/stripe.js";

const WHSEC = "whsec_test";
let db: Db;
let server: Server;
let meter: Meter;
let base = "";
let clock = new Date("2026-11-10T12:00:00Z");
const fakes = [new FakeProvider("maritime"), new FakeProvider("e2b")];
const stripeCalls: URLSearchParams[] = [];

// GitHub and Stripe, answered in-process.
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_x" });
  if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "octo", email: null });
  if (url === "https://api.github.com/user/emails") return Response.json([{ email: "octo@example.com", primary: true, verified: true }]);
  if (url === "https://stripe.test/v1/checkout/sessions") {
    stripeCalls.push(new URLSearchParams(String(init?.body)));
    return Response.json({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  }
  return fetch(input, init);
};

beforeAll(async () => {
  db = await openDb("pglite:");
  const app = createHostedApp(
    db,
    new Router({ providers: fakes, ledger: false }),
    {
      publicUrl: "http://localhost",
      contact: "abuse@example.com",
      limits: { ...DEFAULT_LIMITS, maxConcurrent: 2 },
      github: { clientId: "cid", clientSecret: "csec" },
      stripe: { secretKey: "sk_test_x", webhookSecret: WHSEC, apiBase: "https://stripe.test" },
      devLogin: true,
      fetch: fakeFetch,
    },
    () => clock,
  );
  server = app.server;
  meter = app.meter;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await db.close();
});
beforeEach(() => {
  clock = new Date("2026-11-10T12:00:00Z");
});

/** Sign in with the dev route; returns a fetch bound to the session cookie. */
async function signIn(login: string) {
  const r = await fetch(`${base}/auth/dev?login=${login}`, { redirect: "manual" });
  expect(r.status).toBe(302);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { "X-SR": "1" }) =>
    fetch(base + path, { method, headers: { cookie, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function pay(userId: string, cents: number, id: string) {
  const raw = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id, payment_status: "paid", currency: "usd", amount_subtotal: cents, amount_total: cents, metadata: { user_id: userId } } },
  });
  return fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": signWebhook(raw, WHSEC) }, body: raw });
}

async function userWithKey(login: string) {
  const as = await signIn(login);
  const { key } = await (await as("/account/keys", "POST", { name: "test" })).json();
  return { as, key: key as string, sr: new Client({ baseUrl: base, apiKey: key }) };
}

describe("hosted API", () => {
  it("needs a live key, and credit before a sandbox starts", async () => {
    const { as, key, sr } = await userWithKey("alice");
    expect(key).toMatch(/^sr_live_[\w-]{32}$/);
    await expect(new Client({ baseUrl: base, apiKey: "sr_live_nope" }).providers()).rejects.toMatchObject({ status: 401 });
    await expect(sr.create()).rejects.toMatchObject({ status: 402 });

    const me = await (await as("/account/me")).json();
    expect(me).toMatchObject({ login: "alice", balanceUsd: 0, topups: [5, 10, 25, 50, 100] });
    expect(me.keys).toHaveLength(1);
    expect(JSON.stringify(me)).not.toContain(key);

    // Revoked keys stop working at once.
    await as(`/account/keys/${me.keys[0].id}`, "DELETE");
    await expect(sr.providers()).rejects.toMatchObject({ status: 401 });
  });

  it("credits a paid Stripe checkout once, and refuses bad signatures", async () => {
    const as = await signIn("bob");
    expect((await pay("dev:bob", 1000, "cs_bob")).status).toBe(200);
    expect((await pay("dev:bob", 1000, "cs_bob")).status).toBe(200); // Stripe retries; credited once
    expect((await (await as("/account/me")).json()).balanceUsd).toBe(10);

    const forged = await fetch(`${base}/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": signWebhook("{}", "whsec_wrong") }, body: "{}" });
    expect(forged.status).toBe(400);
  });

  it("opens a Stripe Checkout page for a top-up", async () => {
    const as = await signIn("carol");
    expect((await as("/account/topup", "POST", { usd: 7 })).status).toBe(400);
    const { url } = await (await as("/account/topup", "POST", { usd: 25 })).json();
    expect(url).toBe("https://checkout.stripe.test/cs_1");
    const form = stripeCalls.at(-1)!;
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("2500");
    expect(form.get("metadata[user_id]")).toBe("dev:carol");
  });

  it("bills list price plus the fee by the second, and keeps sandboxes private", async () => {
    const { as, sr } = await userWithKey("dana");
    await pay("dev:dana", 500, "cs_dana");
    const sbx = await sr.create({ vcpu: 2, memoryGb: 4, timeoutMinutes: 120 });
    expect(sbx.provider).toBe("maritime");
    expect((await sbx.exec("ls")).stdout).toBe("ran: ls\n");

    // Someone else's key can't see it.
    const eve = await userWithKey("eve");
    await expect(eve.sr.sandbox(sbx.id).exec("ls")).rejects.toMatchObject({ status: 404 });

    const rate = meter.rate(sbx.estimatedHourlyUsd!); // micro-dollars per hour
    expect(rate).toBe(Math.round(sbx.estimatedHourlyUsd! * 1e6 * 1.055));
    clock = new Date(clock.getTime() + 30 * 60_000);
    await meter.tick();
    clock = new Date(clock.getTime() + 30 * 60_000);
    await sbx.kill();

    const me = await (await as("/account/me")).json();
    const row = me.sandboxes.find((s: any) => s.id === sbx.id);
    expect(row).toMatchObject({ provider: "maritime", endReason: "deleted" });
    expect(row.costUsd).toBeCloseTo(rate / 1e6, 6); // one hour
    expect(me.balanceUsd).toBeCloseTo(5 - rate / 1e6, 6);
    await expect(sbx.exec("ls")).rejects.toMatchObject({ status: 404 }); // ended
  });

  it("caps size, count and lifetime", async () => {
    const { sr } = await userWithKey("finn");
    await pay("dev:finn", 500, "cs_finn");
    await expect(sr.create({ vcpu: 64 })).rejects.toMatchObject({ status: 400 });
    const a = await sr.create({ timeoutMinutes: 10_000 });
    expect(fakes[0].created.at(-1)?.timeoutMinutes).toBe(DEFAULT_LIMITS.maxLifetimeMinutes);
    const b = await sr.create();
    await expect(sr.create()).rejects.toMatchObject({ status: 429 });
    await a.kill();
    await b.kill();
  });

  it("stops billing at the lifetime and kills the sandbox", async () => {
    const { as, sr } = await userWithKey("gus");
    await pay("dev:gus", 500, "cs_gus");
    const sbx = await sr.create({ timeoutMinutes: 10 });
    clock = new Date(clock.getTime() + 60 * 60_000);
    const { killed } = await meter.tick();
    expect(killed).toContain(sbx.id);
    expect(fakes[0].live.get(sbx.id.split(":")[1])?.killed).toBe(true);
    const row = (await (await as("/account/me")).json()).sandboxes[0];
    expect(row.endReason).toBe("lifetime");
    expect(row.costUsd).toBeCloseTo((meter.rate(sbx.estimatedHourlyUsd!) / 1e6) * (10 / 60), 6);
  });

  it("kills everything a user runs when their credit runs out", async () => {
    const { as, sr } = await userWithKey("hana");
    await pay("dev:hana", 50, "cs_hana"); // $0.50
    const sbx = await sr.create({ timeoutMinutes: 240 });
    clock = new Date(clock.getTime() + 200 * 60 * 60_000 / 100); // 2 h: well under $0.50 at Maritime's price
    await meter.tick();
    expect((await (await as("/account/me")).json()).sandboxes[0].endedAt).toBeNull();
    await db.query("update sandboxes set rate_micros = 1000000 where id = $1", [sbx.id]); // $1/h from here
    clock = new Date(clock.getTime() + 60 * 60_000);
    const { killed } = await meter.tick();
    expect(killed).toEqual([sbx.id]);
    const me = await (await as("/account/me")).json();
    expect(me.sandboxes[0].endReason).toBe("out of credit");
    expect(me.balanceUsd).toBeLessThanOrEqual(0);
  });

  it("refuses dashboard writes without the X-SR header, and pages without a session", async () => {
    const as = await signIn("ivy");
    expect((await as("/account/keys", "POST", {}, {})).status).toBe(403);
    expect((await fetch(`${base}/account/me`)).status).toBe(401);
    expect((await fetch(`${base}/dashboard`)).headers.get("content-type")).toContain("text/html");
  });

  it("signs in with GitHub", async () => {
    const start = await fetch(`${base}/auth/github`, { redirect: "manual" });
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    const state = to.searchParams.get("state")!;
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0];

    expect((await fetch(`${base}/auth/github/callback?code=c&state=other`, { headers: { cookie: stateCookie }, redirect: "manual" })).status).toBe(400);
    const done = await fetch(`${base}/auth/github/callback?code=c&state=${state}`, { headers: { cookie: stateCookie }, redirect: "manual" });
    expect(done.status).toBe(302);
    const session = done.headers.get("set-cookie")!.split(";")[0];
    const me = await (await fetch(`${base}/account/me`, { headers: { cookie: session } })).json();
    expect(me.login).toBe("octo");
    const { rows } = await db.query("select email from users where id = 'gh:42'");
    expect(rows[0].email).toBe("octo@example.com");
  });
});
