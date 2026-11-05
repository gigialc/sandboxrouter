import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent37Provider, agent37Shape } from "../src/providers/agent37.js";

/**
 * A stand-in for api.agent37.com: instances are created running, exec runs `sh -c command` for
 * real in a temp dir, enforces the 128 KB body cap and returns {exit_code, stdout, stderr}.
 */
let server: Server;
let base = "";
let root = "";
let shimPath = "";
const seen: { method: string; path: string; auth?: string; body?: any }[] = [];
let status = "running";
let createStatus = "running";
const deleted: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-agent37-"));
  mkdirSync(join(root, "bin"));
  // The instance image has coreutils `timeout`; macOS may not, so give the mock a minimal one.
  if (spawnSync("sh", ["-c", "command -v timeout"]).status !== 0) {
    writeFileSync(
      join(root, "bin", "timeout"),
      ["#!/bin/sh", '[ "$1" = -k ] && shift 2', "s=$1; shift", '"$@" & p=$!', '( sleep "$s"; kill -TERM $p ) >/dev/null 2>&1 & w=$!', "wait $p; c=$?", "kill $w 2>/dev/null", "[ $c -eq 143 ] && exit 124", "exit $c"].join("\n"),
    );
    chmodSync(join(root, "bin", "timeout"), 0o755);
  }
  shimPath = `${join(root, "bin")}:${process.env.PATH}`;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (raw.length > 128 * 1024) return send(413, { error: { code: "invalid_request", message: "body too large" } });
    const body = raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, body });
    if (req.headers.authorization !== "Bearer sk_live_test") return send(401, { error: { code: "unauthorized", message: "invalid key" } });
    const p = url.pathname;
    if (p === "/v1/instances" && req.method === "POST") {
      if (body?.resources?.cpu > 4) return send(400, { error: { code: "invalid_request", message: "invalid shape" } });
      status = createStatus;
      return send(201, { id: "ab12cd34ef", status, url: "https://ab12cd34ef.agent37.app" });
    }
    if (p === "/v1/instances/ab12cd34ef") {
      if (req.method === "DELETE") {
        deleted.push(p);
        return send(200, { id: "ab12cd34ef", status: "deleting" });
      }
      const s = status;
      if (status === "provisioning" || status === "starting") status = "running";
      return send(200, { id: "ab12cd34ef", status: s });
    }
    if (p.startsWith("/v1/instances/") && !p.startsWith("/v1/instances/ab12cd34ef")) return send(404, { error: { code: "not_found", message: "no such instance" } });
    if (p === "/v1/instances/ab12cd34ef/sleep") {
      status = "sleeping";
      return send(200, { id: "ab12cd34ef", status });
    }
    if (p === "/v1/instances/ab12cd34ef/start") {
      status = "starting";
      return send(200, { id: "ab12cd34ef", status });
    }
    if (p === "/v1/instances/ab12cd34ef/exec") {
      if (status !== "running") return send(400, { error: { code: "invalid_request", message: `instance is ${status}; start it first` } });
      const child = spawn("sh", ["-c", body.command], { cwd: root, env: { ...process.env, PATH: shimPath }, detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => send(200, { exit_code: code, stdout, stderr, truncated: false }));
      return;
    }
    send(404, { error: { code: "not_found", message: p } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Agent37Provider", () => {
  const p = () => new Agent37Provider("sk_live_test", base);

  it("creates the smallest shape that fits, with auto-sleep from the lifetime", async () => {
    seen.length = 0;
    const sbx = await p().create({ vcpu: 3, memoryGb: 6, timeoutMinutes: 2, env: { A: "1" }, metadata: { job: "x" } });
    expect(sbx.nativeId).toBe("ab12cd34ef");
    expect(seen[0].auth).toBe("Bearer sk_live_test");
    expect(seen[0].body).toEqual({ template: "agent37-base", resources: { cpu: 4, memory: 8 }, auto_sleep: true, idle_timeout_seconds: 300, env: { A: "1" }, metadata: { job: "x" } });
    // Created already running: no polling.
    expect(seen.length).toBe(1);
    expect(agent37Shape(2, 4)?.usdMonth).toBe(4.76);
    expect(agent37Shape(4, 20)?.memoryGb).toBe(32);
    expect(agent37Shape(8, 4)).toBeUndefined();
    await expect(p().create({ vcpu: 8 })).rejects.toThrow(/no Agent37 shape/);
  });

  it("polls when create returns before the instance runs, and surfaces errors", async () => {
    createStatus = "provisioning";
    try {
      seen.length = 0;
      await p().create({ image: { agent37: "agent37-ubuntu" } });
      expect(seen[0].body.template).toBe("agent37-ubuntu");
      expect(seen.filter((s) => s.method === "GET").length).toBe(2);
    } finally {
      createStatus = "running";
    }
    await expect(new Agent37Provider("bad", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("unauthorized: invalid key") });
  });

  it("runs commands with env and cwd added to the shell command", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec('echo "$GREETING from $(basename "$PWD")"; echo err >&2; exit 3', { env: { GREETING: "it's me" }, cwd: "/tmp", onStdout: (c) => events.push(c) });
    expect(r).toMatchObject({ exitCode: 3, stdout: "it's me from tmp\n", stderr: "err\n" });
    expect(events).toEqual(["it's me from tmp\n"]);
  });

  it("enforces the command timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toThrow(/timed out after 1s/);
  });

  it("round-trips files in chunks that fit the body and output caps", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");
    const big = new Uint8Array(700 * 1024).map((_, i) => (i * 31) % 256);
    seen.length = 0;
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(seen.filter((s) => s.path.endsWith("/exec")).length).toBeGreaterThan(5);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await sbx.writeFile(join(root, "empty"), "");
    expect((await sbx.readFile(join(root, "empty"))).length).toBe(0);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("sleeps on pause, starts on connect, and deletes on kill", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(status).toBe("sleeping");
    seen.length = 0;
    const again = await p().connect("ab12cd34ef");
    expect(seen.some((s) => s.path.endsWith("/start"))).toBe(true);
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    deleted.length = 0;
    await again.kill();
    expect(deleted).toEqual(["/v1/instances/ab12cd34ef"]);
    await expect(p().connect("zz")).rejects.toMatchObject({ status: 404 });
  });

  it("starts a sleeping instance when exec is refused", async () => {
    const sbx = await p().create({});
    status = "sleeping";
    expect((await sbx.exec("echo woke")).stdout).toBe("woke\n");
  });

  it("reports configured() from the key", () => {
    expect(new Agent37Provider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
