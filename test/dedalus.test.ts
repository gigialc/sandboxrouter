import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DedalusProvider } from "../src/providers/dedalus.js";

/**
 * A stand-in for dcs.dedaluslabs.ai following its OpenAPI document: machines go accepted ->
 * starting -> running, executions run argv for real in a temp dir, stream through the events feed
 * and expose full output at /output.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; auth?: string; body?: any }[] = [];
let phase = "running";
let polls = 0;
let failCreate = false;
const executions = new Map<string, { status: string; exit_code?: number; signal?: number; error_code?: string; stdout: string; stderr: string; events: any[] }>();
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-dedalus-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, base);
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, path: url.pathname + url.search, auth: req.headers.authorization, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer dsk_test") return send(401, { error_code: "UNAUTHORIZED", message: "invalid api key", retryable: false });
    const p = url.pathname;
    if (p === "/v1/machines" && req.method === "POST") {
      if (failCreate) return send(403, { error_code: "FORBIDDEN", message: "DCS is in private beta; this org has not been admitted", retryable: false });
      polls = 0;
      return send(202, { machine_id: "m-1", phase: "accepted", desired_state: "running" });
    }
    let m = p.match(/^\/v1\/machines\/([^/]+)$/);
    if (m) {
      if (m[1] !== "m-1") return send(404, { error_code: "NOT_FOUND", message: "machine not found", retryable: false });
      if (req.method === "DELETE") return send(202, { machine_id: "m-1", phase: "destroying" });
      polls++;
      const ph = polls === 1 && phase === "running" ? "starting" : phase;
      return send(200, { machine_id: "m-1", vcpu: 2, memory_mib: 4096, storage_gib: 10, autosleep_seconds: 300, desired_state: "running", status: { phase: ph, reason: "", retryable: false, revision: "1" } });
    }
    if (p === "/v1/machines/m-1/sleep") {
      phase = "sleeping";
      return send(202, { machine_id: "m-1", phase: "stopping" });
    }
    if (p === "/v1/machines/m-1/wake") {
      phase = "running";
      return send(202, { machine_id: "m-1", phase: "starting" });
    }
    if (p === "/v1/machines/m-1/executions" && req.method === "POST") {
      const id = `e-${++n}`;
      const ex = { status: "running", stdout: "", stderr: "", events: [] as any[] } as any;
      executions.set(id, ex);
      const [cmd, ...args] = body.command as string[];
      const child = spawn(cmd, args, { cwd: body.cwd ?? root, env: { ...process.env, ...(body.env ?? {}) }, detached: true });
      if (body.stdin !== undefined) child.stdin.end(body.stdin);
      else child.stdin.end();
      const timer = setTimeout(() => {
        ex.error_code = "EXECUTION_TIMEOUT";
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, body.timeout_ms);
      for (const s of ["stdout", "stderr"] as const) {
        child[s].on("data", (d: Buffer) => {
          ex[s] += String(d);
          ex.events.push({ sequence: ex.events.length, type: s, chunk: String(d), at: new Date().toISOString() });
        });
      }
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        ex.status = ex.error_code ? "failed" : code === 0 ? "succeeded" : "failed";
        if (signal) ex.signal = 9;
        else ex.exit_code = code;
        ex.events.push({ sequence: ex.events.length, type: "lifecycle", status: ex.status, exit_code: ex.exit_code, at: new Date().toISOString() });
      });
      return send(200, { execution_id: id, machine_id: "m-1", status: "queued", command: body.command, created_at: "", log_capture: {} });
    }
    m = p.match(/^\/v1\/machines\/m-1\/executions\/([^/]+)(\/events|\/output)?$/);
    if (m) {
      const ex = executions.get(m[1]);
      if (!ex) return send(404, { error_code: "NOT_FOUND", message: "execution not found", retryable: false });
      if (req.method === "DELETE") return send(200, {});
      if (m[2] === "/output") return send(200, { execution_id: m[1], stdout: ex.stdout, stderr: ex.stderr, stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false });
      if (m[2] === "/events") {
        const from = Number(url.searchParams.get("cursor") ?? 0);
        const items = ex.events.slice(from, from + 2); // small pages to exercise the cursor
        return send(200, { items, next_cursor: String(from + items.length) });
      }
      return send(200, { execution_id: m[1], machine_id: "m-1", status: ex.status, exit_code: ex.exit_code, signal: ex.signal, error_code: ex.error_code });
    }
    send(404, { title: "Not Found", status: 404, detail: `no route ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("DedalusProvider", () => {
  const p = () => new DedalusProvider("dsk_test", base);

  it("creates a machine with the requested size and an autosleep from the lifetime, then waits for running", async () => {
    seen.length = 0;
    const sbx = await p().create({ vcpu: 2, memoryGb: 3, timeoutMinutes: 10 });
    expect(sbx.nativeId).toBe("m-1");
    const create = seen.find((s) => s.path === "/v1/machines" && s.method === "POST")!;
    expect(create.auth).toBe("Bearer dsk_test");
    expect(create.body).toEqual({ vcpu: 2, memory_mib: 3072, storage_gib: 10, autosleep: "600s" });
    expect(seen.filter((s) => s.path === "/v1/machines/m-1").length).toBe(2);
  });

  it("surfaces API errors, including the private-beta 403", async () => {
    await expect(new DedalusProvider("nope", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("UNAUTHORIZED: invalid api key") });
    failCreate = true;
    try {
      await expect(p().create({})).rejects.toMatchObject({ status: 403, message: expect.stringContaining("private beta") });
    } finally {
      failCreate = false;
    }
  });

  it("fails and cleans up when the machine fails to start", async () => {
    phase = "failed";
    seen.length = 0;
    try {
      await expect(p().create({})).rejects.toThrow(/machine m-1 is failed/);
      expect(seen.some((s) => s.method === "DELETE" && s.path.startsWith("/v1/machines/m-1"))).toBe(true);
    } finally {
      phase = "running";
    }
  });

  it("runs commands as argv with env, cwd and the timeout, and returns output and exit code", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    const r = await sbx.exec('echo "$GREETING $BASE from $(basename "$PWD")"; echo err >&2; exit 3', { env: { GREETING: "it's me" }, cwd: "/tmp", timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 3, stdout: "it's me b from tmp\n", stderr: "err\n" });
    const req = seen.filter((s) => s.path === "/v1/machines/m-1/executions").at(-1)!.body;
    expect(req.command[0]).toBe("/bin/sh");
    expect(req).toMatchObject({ cwd: "/tmp", env: { BASE: "b", GREETING: "it's me" }, timeout_ms: 7000 });
  });

  it("streams chunks from the events feed, across pages", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.6; echo two >&2; sleep 0.6; echo three", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r.stdout).toBe("one\nthree\n");
  });

  it("reports a command timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toThrow(/timed out after 1s/);
  });

  it("round-trips text and binary files through stdin/stdout base64", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");
    const big = new Uint8Array(600 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await sbx.writeFile(join(root, "empty"), "");
    expect((await sbx.readFile(join(root, "empty"))).length).toBe(0);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("sleeps on pause, wakes on connect, and force-deletes on kill", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(phase).toBe("sleeping");
    seen.length = 0;
    const again = await p().connect("m-1");
    expect(seen.some((s) => s.path === "/v1/machines/m-1/wake")).toBe(true);
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await again.kill();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/machines/m-1?force=true" });
    await expect(p().connect("m-2")).rejects.toMatchObject({ status: 404 });
  });

  it("reports configured() from the key", () => {
    expect(new DedalusProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
