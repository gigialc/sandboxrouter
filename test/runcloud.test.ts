import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync, writeSync, ftruncateSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunCloudProvider } from "../src/providers/runcloud.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for api.run.cloud following its sandbox routes and guest agent: sandboxes go pending ->
 * starting -> running, /exec runs argv for real and kills the whole process group at timeout_seconds
 * (exit_code -1), and /fs reads and writes real files in base64 chunks, reporting errors in the body.
 */
let server: Server;
let base = "";
const root = mkdtempSync(join(tmpdir(), "sbr-runcloud-"));
const seen: { method: string; path: string; auth?: string; body?: any }[] = [];
const sandboxes = new Map<string, { state: string; polls: number; last_error?: string }>();
let n = 0;
/** What the next created sandbox ends as instead of running. */
let failNext: { state: string; last_error: string } | undefined;
let resumeMoves = false;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, base);
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, body });
    const send = (status: number, obj?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer rc_test") return send(401, { code: "unauthorized", detail: "invalid API key" });
    const p = url.pathname;
    if (p === "/run-cloud/sandboxes" && req.method === "POST") {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { state: "pending", polls: 0 });
      return send(201, { id, state: "pending", image: body.image, milli_cpu: body.cpu * 1000, mem_mb: body.memory });
    }
    const m = p.match(/^\/run-cloud\/sandboxes\/([^/]+)(?:\/(.+))?$/);
    const s = m && sandboxes.get(m[1]);
    if (!m || !s) return send(404, { code: "not_found", detail: "sandbox not found" });
    const [, id, action] = m;
    const view = () => ({ id, state: s.state, ...(s.last_error ? { last_error: s.last_error } : {}) });
    if (!action && req.method === "DELETE") {
      s.state = "destroyed";
      return send(204);
    }
    if (!action && req.method === "GET") {
      s.polls++;
      if (s.state === "pending") s.state = "starting";
      else if (s.state === "starting") {
        if (failNext) {
          Object.assign(s, failNext);
          failNext = undefined;
        } else s.state = "running";
      }
      return send(200, view());
    }
    if (action === "pause") {
      s.state = "paused";
      return send(200, view());
    }
    if (action === "resume") {
      if (resumeMoves && s.state === "paused") {
        // The first answer: the sandbox is moving to another host and still reads paused.
        resumeMoves = false;
        return send(202, view());
      }
      if (s.state === "paused") s.state = "running";
      return send(200, view());
    }
    if (action === "tunnels") {
      return send(201, { id: `tun_${body.port}`, sandboxId: id, url: `https://p${body.port}-${id}.tunnel.test`, port: body.port, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (s.state !== "running") return send(409, { code: "sandbox_not_running", detail: `sandbox is ${s.state}` });
    if (action === "exec") {
      const [cmd, ...args] = body.cmd as string[];
      const child = spawn(cmd, args, { cwd: body.cwd ?? root, env: { ...process.env, ...(body.env ?? {}) }, detached: true });
      let stdout = "";
      let stderr = "";
      let failed: Error | undefined;
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => (failed = e));
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, (body.timeout_seconds ?? 3600) * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        // Like the guest agent: a command that cannot start exits 127, a killed one -1.
        if (failed) return send(200, { exit_code: 127, stdout: "", stderr: `guestagent: ${failed.message}\n` });
        send(200, { exit_code: code ?? -1, stdout, stderr });
      });
      return;
    }
    if (action === "fs") {
      try {
        if (body.op === "read") {
          const size = statSync(body.path).size;
          const buf = readFileSync(body.path).subarray(body.offset, body.offset + body.length);
          const next = body.offset + buf.length;
          return send(200, { ...(buf.length ? { content: buf.toString("base64") } : {}), ...(next >= size ? { eof: true } : {}), ...(next ? { next_offset: next } : {}), ...(size ? { size } : {}) });
        }
        if (body.op === "write") {
          const data = Buffer.from(body.content ?? "", "base64");
          mkdirSync(dirname(body.path), { recursive: true });
          const fd = openSync(body.path, body.truncate === false ? "a+" : "w");
          if (body.truncate === false) ftruncateSync(fd, Math.max(body.offset, statSync(body.path).size));
          writeSync(fd, data, 0, data.length, body.offset);
          closeSync(fd);
          const next = body.offset + data.length;
          return send(200, next ? { next_offset: next } : {});
        }
      } catch (e) {
        return send(200, { error: (e as Error).message.replace(/^ENOENT: /, "") });
      }
    }
    return send(404, { detail: "no route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const p = () => new RunCloudProvider("rc_test", base);

describe("runcloud", () => {
  it("is configured only with a key", () => {
    expect(new RunCloudProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("creates a sandbox with the requested size, image, hard lifetime and tags, then waits for running", async () => {
    seen.length = 0;
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, image: { runcloud: "python:3.12-slim" }, metadata: { job: "j1" } });
    const create = seen.find((s) => s.method === "POST" && s.path === "/run-cloud/sandboxes")!;
    expect(create.auth).toBe("Bearer rc_test");
    expect(create.body).toEqual({ image: "python:3.12-slim", cpu: 4, memory: 8192, timeoutSeconds: 1200, onTimeout: "destroy", tags: { job: "j1" }, wait: false });
    expect(seen.filter((s) => s.method === "GET" && s.path === `/run-cloud/sandboxes/${sbx.nativeId}`).length).toBe(2);
    await sbx.kill();
  });

  it("defaults to the agent-base image at 2 vCPU / 4 GB", async () => {
    seen.length = 0;
    const sbx = await p().create({});
    expect(seen[0].body).toMatchObject({ image: "runcloud/agent-base", cpu: 2, memory: 4096, timeoutSeconds: 1800 });
    await sbx.kill();
  });

  it("surfaces API errors with their status", async () => {
    await expect(new RunCloudProvider("nope", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("unauthorized: invalid API key") });
  });

  it("reports a full fleet as a 409 so the router falls back, and destroys the sandbox", async () => {
    seen.length = 0;
    failNext = { state: "destroyed", last_error: "no host with capacity for 2000m/4096MiB" };
    await expect(p().create({})).rejects.toMatchObject({ status: 404 });
    failNext = { state: "interrupted", last_error: "no host with capacity" };
    await expect(p().create({})).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no host with capacity") });
    failNext = { state: "interrupted", last_error: "boot failed" };
    await expect(p().create({})).rejects.toMatchObject({ status: 502, message: expect.stringContaining("boot failed") });
    expect(seen.filter((s) => s.method === "DELETE").length).toBe(3);
  });

  it("sends argv, cwd, merged env and the timeout to /exec", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    seen.length = 0;
    const r = await sbx.exec('printf "%s %s" "$BASE" "$X"; exit 2', { cwd: "/tmp", env: { X: "x" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 2, stdout: "b x", stderr: "" });
    expect(seen[0].body).toEqual({ cmd: ["/bin/sh", "-c", 'printf "%s %s" "$BASE" "$X"; exit 2'], cwd: "/tmp", env: { BASE: "b", X: "x" }, timeout_seconds: 7 });
    await sbx.kill();
  });

  it("round-trips files larger than one chunk, and empty ones", async () => {
    const sbx = await p().create({});
    const big = new Uint8Array(1_300_000).map((_, i) => (i * 7) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await sbx.writeFile(join(root, "empty"), "");
    expect((await sbx.readFile(join(root, "empty"))).length).toBe(0);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    await sbx.kill();
  });

  it("opens a tunnel for a port and reuses it while it is valid", async () => {
    const sbx = await p().create({});
    seen.length = 0;
    expect(await sbx.url!(3000)).toBe(`https://p3000-${sbx.nativeId}.tunnel.test`);
    expect(await sbx.url!(3000)).toBe(`https://p3000-${sbx.nativeId}.tunnel.test`);
    expect(seen.filter((s) => s.path.endsWith("/tunnels"))).toHaveLength(1);
    expect(seen[0].body).toEqual({ port: 3000 });
    await sbx.kill();
  });

  it("connect resumes a paused sandbox, repeating the resume while it moves hosts", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    resumeMoves = true;
    seen.length = 0;
    const again = await p().connect(sbx.nativeId);
    expect((await again.exec("echo up")).stdout).toBe("up\n");
    expect(seen.filter((s) => s.path.endsWith("/resume"))).toHaveLength(2);
    await sbx.kill();
   }, 15_000);
});

describeConformance("runcloud", { provider: p, dir: root, noStreaming: "uses the buffered /exec endpoint" });
