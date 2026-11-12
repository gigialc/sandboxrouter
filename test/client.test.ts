import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, ClientError } from "../src/client.js";
import { Router } from "../src/router.js";
import { createApp, HttpError } from "../src/server.js";
import { ALL, FakeProvider } from "./fake.js";

const servers: Server[] = [];
async function start(...args: Parameters<typeof createApp>) {
  const server = createApp(...args);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterAll(() => servers.forEach((s) => s.close()));

describe("Client", () => {
  let base = "";
  beforeAll(async () => {
    base = await start(new Router({ providers: ALL.map((id) => new FakeProvider(id)) }), "tok");
  });

  it("creates, execs (plain and streamed), moves files and kills with one key", async () => {
    const sr = new Client({ baseUrl: base, apiKey: "tok" });
    const sbx = await sr.create({ vcpu: 1, memoryGb: 1 });
    expect(sbx.provider).toBe("maritime");
    expect((await sbx.exec("ls")).stdout).toBe("ran: ls\n");

    const chunks: string[] = [];
    const streamed = await sbx.exec("pwd", { onStdout: (c) => chunks.push(c) });
    expect(chunks.join("")).toBe("ran: pwd\n");
    expect(streamed.exitCode).toBe(0);

    await sbx.writeFile("/tmp/a.bin", new Uint8Array([0, 255, 7]));
    expect([...(await sbx.readFile("/tmp/a.bin"))]).toEqual([0, 255, 7]);
    await sr.sandbox(sbx.id).kill();
  });

  it("dry-runs and lists providers", async () => {
    const sr = new Client({ baseUrl: base, apiKey: "tok" });
    expect((await sr.route({ gpu: "T4" })).filter((c) => !c.skip).map((c) => c.provider)).toEqual(["modal"]);
    expect((await sr.providers()).map((p) => p.id)).toContain("maritime");
  });

  it("throws ClientError with the status and message", async () => {
    const bad = new Client({ baseUrl: base, apiKey: "nope" });
    await expect(bad.providers()).rejects.toMatchObject({ status: 401, name: "ClientError" });
    const sr = new Client({ baseUrl: base, apiKey: "tok" });
    const err = await sr.create({}, { provider: "nosuch" as any }).catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.status).toBe(400);
  });
});

describe("server hooks", () => {
  it("authorizes per caller, refuses creates, and hides other callers' sandboxes", async () => {
    const owner = new Map<string, string>();
    const killed: string[] = [];
    const fakes = [new FakeProvider("maritime")];
    const base = await start(new Router({ providers: fakes }), undefined, [], {
      authorize: async (req) => ({ "Bearer a": "alice", "Bearer b": "bob", "Bearer broke": "broke" })[req.headers.authorization ?? ""] ?? null,
      beforeCreate: async (who, spec) => {
        if (who === "broke") throw new HttpError(402, "out of credit");
        spec.timeoutMinutes = Math.min(spec.timeoutMinutes ?? 30, 60);
      },
      afterCreate: async (who, sbx) => void owner.set(sbx.id, who as string),
      owns: async (who, id) => owner.get(id) === who,
      afterKill: async (_who, id) => void killed.push(id),
      computers: false,
      pause: false,
    });
    const alice = new Client({ baseUrl: base, apiKey: "a" });
    const bob = new Client({ baseUrl: base, apiKey: "b" });

    const sbx = await alice.create({ timeoutMinutes: 999 });
    expect(owner.get(sbx.id)).toBe("alice");
    expect(fakes[0].created.at(-1)?.timeoutMinutes).toBe(60);
    await expect(bob.sandbox(sbx.id).exec("ls")).rejects.toMatchObject({ status: 404 });
    await expect(sbx.pause()).rejects.toMatchObject({ status: 400 });
    await expect(new Client({ baseUrl: base, apiKey: "broke" }).create()).rejects.toMatchObject({ status: 402, message: "402: out of credit" });
    await expect(new Client({ baseUrl: base, apiKey: "x" }).create()).rejects.toMatchObject({ status: 401 });
    expect((await fetch(`${base}/v1/computers`, { method: "POST", headers: { Authorization: "Bearer a" } })).status).toBe(404);

    await sbx.kill();
    expect(killed).toEqual([sbx.id]);
  });

  it("adds afterCreate's fields to the create response, and tells createFailed about failures", async () => {
    let failed = 0;
    const base = await start(new Router({ providers: [new FakeProvider("maritime"), new FakeProvider("daytona", { fail: "down", failStatus: 503 })] }), undefined, [], {
      authorize: async () => "x",
      afterCreate: async () => ({ hourlyUsd: 0.0232, expiresAt: "2026-01-01T00:00:00.000Z" }),
      createFailed: () => void failed++,
    });
    const sr = new Client({ baseUrl: base });
    const sbx = await sr.create();
    expect(sbx.details).toMatchObject({ hourlyUsd: 0.0232, expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(sbx).toMatchObject({ provider: "maritime", size: { vcpu: 2, memoryGb: 4 } });
    expect(sbx.listHourlyUsd).toBeGreaterThan(0);
    await expect(sr.create({}, { provider: "daytona", fallback: false })).rejects.toMatchObject({ status: 503, code: "all_failed" });
    expect(failed).toBe(1);
  });

  it("kills a sandbox that finishes starting after the caller hung up", async () => {
    const fake = new FakeProvider("maritime", { createMs: 300 });
    let failed = 0;
    let recorded = 0;
    const base = await start(new Router({ providers: [fake], ledger: false }), undefined, [], {
      authorize: async () => "x",
      afterCreate: async () => void recorded++,
      createFailed: () => void failed++,
    });
    const ac = new AbortController();
    const req = fetch(`${base}/v1/sandboxes`, { method: "POST", body: "{}", signal: ac.signal }).catch(() => "aborted");
    setTimeout(() => ac.abort(), 50);
    expect(await req).toBe("aborted");
    await new Promise((r) => setTimeout(r, 500));
    expect([...fake.live.values()].map((b) => b.killed)).toEqual([true]);
    expect(recorded).toBe(0);
    expect(failed).toBe(1);
  });

  it("treats a kill of a sandbox the provider no longer has as done, and reports a real kill failure to afterKill", async () => {
    const outcomes: unknown[] = [];
    const gone = new FakeProvider("maritime", { killFails: true, killStatus: 404 });
    const stuck = new FakeProvider("daytona", { killFails: true, killStatus: 500 });
    const base = await start(new Router({ providers: [gone, stuck], ledger: false }), undefined, [], {
      authorize: async () => "x",
      afterKill: async (_who, id, outcome) => void outcomes.push([id.split(":")[0], outcome?.error?.message ?? "ok"]),
    });
    const sr = new Client({ baseUrl: base });
    await (await sr.create({}, { provider: "maritime" })).kill();
    await expect((await sr.create({}, { provider: "daytona" })).kill()).rejects.toMatchObject({ status: 500 });
    expect(outcomes).toEqual([
      ["maritime", "ok"],
      ["daytona", "daytona: kill failed"],
    ]);
  });

  it("turns computers off when authorize is set, unless asked", async () => {
    const router = new Router({ providers: [new FakeProvider("maritime")] });
    const multi = await start(router, undefined, [], { authorize: async () => "x" });
    expect((await fetch(`${multi}/v1/computers`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("kills the sandbox when afterCreate fails", async () => {
    const fake = new FakeProvider("maritime");
    const base = await start(new Router({ providers: [fake] }), undefined, [], {
      authorize: async () => "x",
      afterCreate: async () => {
        throw new HttpError(500, "could not record it");
      },
    });
    await expect(new Client({ baseUrl: base }).create()).rejects.toMatchObject({ status: 500 });
    expect([...fake.live.values()].map((b) => b.killed)).toEqual([true]);
  });
});
