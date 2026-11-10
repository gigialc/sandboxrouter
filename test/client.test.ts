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
