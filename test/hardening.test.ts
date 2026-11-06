import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";
import { MaritimeProvider } from "../src/providers/maritime.js";
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { RouterError } from "../src/types.js";
import { FakeProvider } from "./fake.js";

const dir = mkdtempSync(join(tmpdir(), "sbr-hardening-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const ledgerFile = () => join(dir, `ledger-${++n}.jsonl`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a provider whose create hangs", () => {
  it("is given up on after createTimeoutSeconds and the next provider is tried", async () => {
    const slow = new FakeProvider("modal", { createMs: 2000 });
    const fast = new FakeProvider("maritime");
    const router = new Router({ providers: [slow, fast], ledger: false });
    const t0 = Date.now();
    const sbx = await router.create({}, { provider: ["modal", "maritime"], createTimeoutSeconds: 0.2 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sbx.provider).toBe("maritime");
    expect(sbx.attempts[0]).toMatchObject({ provider: "modal", ok: false, error: "modal: create timed out after 0.2s" });
  });

  it("has its sandbox recorded and killed when the create answers late", async () => {
    const slow = new FakeProvider("modal", { createMs: 300 });
    const file = ledgerFile();
    const router = new Router({ providers: [slow, new FakeProvider("maritime")], ledger: file });
    await router.create({}, { provider: ["modal", "maritime"], createTimeoutSeconds: 0.1 });
    await wait(500);
    const [late] = slow.live.values();
    expect(late.killed).toBe(true);
    // Opened and closed: nothing left for gc, only the sandbox that was returned.
    expect(new Ledger(file).list().map((e) => e.provider)).toEqual(["maritime"]);
  });

  it("leaves a late sandbox in the ledger for gc when killing it fails", async () => {
    const slow = new FakeProvider("modal", { createMs: 300, killFails: true });
    const file = ledgerFile();
    const router = new Router({ providers: [slow, new FakeProvider("maritime")], ledger: file });
    const sbx = await router.create({}, { provider: ["modal", "maritime"], createTimeoutSeconds: 0.1 });
    await sbx.kill();
    await wait(500);
    const [late] = slow.live.values();
    expect(new Ledger(file).list().map((e) => e.id)).toEqual([`modal:${late.nativeId}`]);
  });

  it("defaults to a 120 s limit", async () => {
    const { DEFAULT_CREATE_TIMEOUT_S } = await import("../src/router.js");
    expect(DEFAULT_CREATE_TIMEOUT_S).toBe(120);
  });
});

describe("fallback", () => {
  const route = { provider: ["modal", "maritime"] as ("modal" | "maritime")[] };

  it("stops on a setup error (bad key, billing, bad image or request) instead of moving the work", async () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      const fallback = new FakeProvider("maritime");
      const router = new Router({ providers: [new FakeProvider("modal", { fail: "invalid API key", failStatus: status }), fallback], ledger: false });
      const err = await router.create({}, route).catch((e) => e);
      expect(err).toBeInstanceOf(RouterError);
      expect(err.message).toMatch(/^modal: invalid API key\. This looks like a setup problem with modal .* pass fallback: "any"/);
      expect(err.attempts).toHaveLength(1);
      expect(fallback.created).toHaveLength(0);
    }
  });

  it("still falls back when the provider looks unavailable: 429, 5xx, timeouts, or no status", async () => {
    for (const opts of [{ failStatus: 429 }, { failStatus: 503 }, { failStatus: 504 }, {}]) {
      const router = new Router({ providers: [new FakeProvider("modal", { fail: "down", ...opts }), new FakeProvider("maritime")], ledger: false });
      const sbx = await router.create({}, route);
      expect(sbx.provider).toBe("maritime");
      expect(sbx.attempts.map((a) => a.ok)).toEqual([false, true]);
    }
  });

  it('falls back on every error with fallback: "any"', async () => {
    const router = new Router({ providers: [new FakeProvider("modal", { fail: "invalid API key", failStatus: 401 }), new FakeProvider("maritime")], ledger: false });
    const sbx = await router.create({}, { ...route, fallback: "any" });
    expect(sbx.provider).toBe("maritime");
    expect(sbx.attempts[0]).toMatchObject({ provider: "modal", ok: false, error: "modal: invalid API key" });
  });
});

describe("HTTP server auth", () => {
  it("refuses to turn CORS on without a token", () => {
    const router = new Router({ providers: [new FakeProvider("modal")], ledger: false });
    expect(() => createApp(router, undefined, ["*"])).toThrow(/CORS is on but SANDBOXROUTER_TOKEN is not set/);
    expect(() => createApp(router, "", ["https://sandboxrouter.vercel.app"])).toThrow(/SANDBOXROUTER_TOKEN/);
    expect(() => createApp(router, "tok", ["*"])).not.toThrow();
  });

  it("checks the token, including ones of a different length", async () => {
    const app = createApp(new Router({ providers: [new FakeProvider("modal")], ledger: false }), "tok");
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    try {
      const status = async (auth?: string) => (await fetch(`${base}/v1/providers`, { headers: auth ? { Authorization: auth } : {} })).status;
      expect(await status()).toBe(401);
      expect(await status("Bearer to")).toBe(401);
      expect(await status("Bearer tok-longer")).toBe(401);
      expect(await status("Bearer tik")).toBe(401);
      expect(await status("Bearer tok")).toBe(200);
    } finally {
      app.close();
    }
  });
});

describe("Maritime requests", () => {
  let server: Server;
  afterAll(() => server?.close());

  it("give up on a server that accepts the connection and never answers", async () => {
    server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const p = new MaritimeProvider("mk_test", base);
    const t0 = Date.now();
    await expect(p.request("POST", `${base}/api/sandboxes/ephemeral`, { json: {}, timeoutMs: 200 })).rejects.toMatchObject({
      name: "ProviderError",
      message: "maritime: POST /api/sandboxes/ephemeral: no answer after 0.2s",
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    server.closeAllConnections();
  });
});
