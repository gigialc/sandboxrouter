import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { ALL, FakeProvider } from "./fake.js";

let server: Server;
let base = "";
const fakes = ALL.map((id) => new FakeProvider(id, id === "maritime" ? { fail: "429 concurrency_limit" } : {}));

beforeAll(async () => {
  server = createApp(new Router({ providers: fakes }), "tok");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { Authorization: "Bearer tok", "Content-Type": "application/json", ...init.headers } });

describe("HTTP API", () => {
  it("requires the token", async () => {
    expect((await fetch(`${base}/v1/providers`)).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("lists providers with prices", async () => {
    const { providers } = await (await api("/v1/providers")).json();
    expect(providers[0]).toMatchObject({ id: "maritime", configured: true });
    expect(providers[0].estimatedHourlyUsd).toBeCloseTo(0.022, 4);
  });

  it("dry-runs a route", async () => {
    const { candidates } = await (await api("/v1/route", { method: "POST", body: JSON.stringify({ gpu: "T4" }) })).json();
    expect(candidates.filter((c: any) => !c.skip).map((c: any) => c.provider)).toEqual(["modal"]);
  });

  it("creates with fallback, execs, moves files, and deletes", async () => {
    const created = await api("/v1/sandboxes", { method: "POST", body: JSON.stringify({ vcpu: 2, env: { X: "1" } }) });
    expect(created.status).toBe(201);
    const sbx = await created.json();
    expect(sbx.provider).toBe("e2b");
    expect(sbx.attempts.map((a: any) => a.provider)).toEqual(["maritime", "e2b"]);
    expect(fakes[1].created.at(-1)).toEqual({ vcpu: 2, env: { X: "1" } });

    const id = encodeURIComponent(sbx.id);
    const ex = await (await api(`/v1/sandboxes/${id}/exec`, { method: "POST", body: JSON.stringify({ cmd: "ls" }) })).json();
    expect(ex).toMatchObject({ exitCode: 0, stdout: "ran: ls\n" });

    const streamed = await (await api(`/v1/sandboxes/${id}/exec`, { method: "POST", body: JSON.stringify({ cmd: "ls", stream: true }) })).text();
    const events = [...streamed.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
    expect(events.slice(0, 3)).toEqual([["stdout", "ran: "], ["stderr", "warn\n"], ["stdout", "ls\n"]]);
    expect(events[3][0]).toBe("result");
    expect(events[3][1]).toMatchObject({ exitCode: 0, stdout: "ran: ls\n" });

    expect((await api(`/v1/sandboxes/${id}/pause`, { method: "POST" })).status).toBe(200);
    expect(fakes[1].live.get(sbx.id.split(":")[1])!.paused).toBe(true);

    expect((await api(`/v1/sandboxes/${id}/files?path=/a.bin`, { method: "PUT", body: new Uint8Array([1, 2, 255]) })).status).toBe(200);
    const got = new Uint8Array(await (await api(`/v1/sandboxes/${id}/files?path=/a.bin`)).arrayBuffer());
    expect([...got]).toEqual([1, 2, 255]);

    expect((await api(`/v1/sandboxes/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(fakes[1].live.get(sbx.id.split(":")[1])!.killed).toBe(true);
  });

  it("answers CORS only for allowed origins", async () => {
    const app = createApp(new Router({ providers: fakes }), "tok", ["https://sandboxrouter.dev"]);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    try {
      const ok = await fetch(`${url}/v1/providers`, { method: "OPTIONS", headers: { Origin: "https://sandboxrouter.dev" } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://sandboxrouter.dev");
      const pna = await fetch(`${url}/v1/providers`, {
        method: "OPTIONS",
        headers: { Origin: "https://sandboxrouter.dev", "Access-Control-Request-Private-Network": "true" },
      });
      expect(pna.headers.get("access-control-allow-private-network")).toBe("true");
      const bad = await fetch(`${url}/v1/providers`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
      expect(bad.status).toBe(403);
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
      // CORS never replaces the token
      expect((await fetch(`${url}/v1/providers`, { headers: { Origin: "https://sandboxrouter.dev" } })).status).toBe(401);
    } finally {
      app.close();
    }
  });

  it("returns 400 for bad input and 502 when routing fails", async () => {
    expect((await api("/v1/sandboxes", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await api("/v1/sandboxes/e2b:x/exec", { method: "POST", body: "{}" })).status).toBe(400);
    const r = await api("/v1/sandboxes", { method: "POST", body: JSON.stringify({ provider: "maritime", fallback: false }) });
    expect(r.status).toBe(502);
    expect((await r.json()).attempts[0]).toMatchObject({ provider: "maritime", ok: false });
  });
});
