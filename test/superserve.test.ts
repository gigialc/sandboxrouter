import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SuperserveProvider } from "../src/providers/superserve.js";

/**
 * A stand-in for api.superserve.ai (control plane, X-API-Key) and sandbox.superserve.ai (data
 * plane, X-Access-Token + X-Superserve-Sandbox-Id) on one port, following the OpenAPI document:
 * /exec/stream runs the command for real under /bin/sh in a temp dir and streams SSE, /files reads
 * and writes real paths, pause answers 202 and lands a moment later, activate rotates the token.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: any }[] = [];
const TEMPLATES = new Set(["superserve/base", "team/big-box"]);
interface Box {
  status: string;
  token: string;
  env: Record<string, string>;
}
const boxes = new Map<string, Box>();
let n = 0;
let tokens = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-superserve-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const isJson = String(req.headers["content-type"] ?? "").includes("json");
    const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body });
    const send = (status: number, obj?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, obj === undefined ? headers : { "Content-Type": "application/json", ...headers });
      res.end(obj === undefined ? undefined : JSON.stringify(obj));
    };
    const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => send(status, { error: { code, message } }, headers);
    const p = url.pathname;

    // Data plane.
    if (p === "/exec/stream" || p === "/files") {
      const box = boxes.get(String(req.headers["x-superserve-sandbox-id"] ?? ""));
      if (!box) return fail(404, "not_found", "sandbox not found");
      if (req.headers["x-access-token"] !== box.token) return fail(401, "unauthorized", "invalid access token");
      if (box.status !== "active") return fail(503, "sandbox_unavailable", "sandbox is not running");
      if (p === "/files") {
        const path = url.searchParams.get("path")!;
        if (req.method === "POST") {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, raw);
          return send(200, { path, size: raw.length });
        }
        if (!existsSync(path)) return fail(404, "not_found", `no such file: ${path}`);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(readFileSync(path));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": keepalive\n\n");
      const event = (e: unknown) => res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), ...(e as object) })}\n\n`);
      const child = spawn("/bin/sh", ["-c", body.command], {
        cwd: body.working_dir ?? root,
        env: { ...process.env, ...box.env, ...(body.env ?? {}) },
        detached: true,
      });
      child.stdin.end();
      let timedOut = false;
      let done = false;
      const killGroup = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, (body.timeout_s ?? 30) * 1000);
      res.on("close", () => {
        if (!done) killGroup();
      });
      child.stdout.on("data", (d: Buffer) => event({ stdout: String(d) }));
      child.stderr.on("data", (d: Buffer) => event({ stderr: String(d) }));
      child.on("close", (code) => {
        done = true;
        clearTimeout(timer);
        event({ exit_code: timedOut ? 124 : (code ?? 137), finished: true });
        res.end();
      });
      return;
    }

    // Control plane.
    if (req.headers["x-api-key"] !== "ss_test") return fail(401, "unauthorized", "invalid API key");
    if (p === "/sandboxes" && req.method === "POST") {
      if (!body?.name) return fail(400, "bad_request", "name is required");
      if (body.from_template && !TEMPLATES.has(body.from_template)) return fail(404, "not_found", `template ${body.from_template} not found`);
      const id = `sb-${++n}`;
      const box: Box = { status: "active", token: `tok-${++tokens}`, env: body.env_vars ?? {} };
      boxes.set(id, box);
      return send(201, { id, name: body.name, status: "active", vcpu_count: 2, memory_mib: 4096, metadata: body.metadata ?? {}, access_token: box.token });
    }
    const m = p.match(/^\/sandboxes\/([^/]+)(\/pause|\/activate)?$/);
    if (m) {
      const box = boxes.get(m[1]);
      if (!box) return fail(404, "not_found", "sandbox not found");
      if (m[2] === "/pause") {
        box.status = "pausing";
        setTimeout(() => (box.status = "paused"), 300);
        return send(202, { status: "pausing" }, { "Retry-After": "1" });
      }
      if (m[2] === "/activate") {
        if (box.status === "pausing") return fail(409, "sandbox_pausing", "sandbox is still pausing", { "Retry-After": "1" });
        box.status = "active";
        box.token = `tok-${++tokens}`;
        return send(200, { id: m[1], status: "active", vcpu_count: 2, memory_mib: 4096, access_token: box.token, routing_hint: "hint-1" });
      }
      if (req.method === "DELETE") {
        boxes.delete(m[1]);
        return send(204);
      }
      return send(200, { id: m[1], status: box.status, vcpu_count: 2, memory_mib: 4096 });
    }
    fail(404, "not_found", `no route ${req.method} ${p}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("SuperserveProvider", () => {
  const p = () => new SuperserveProvider("ss_test", base);

  it("creates from superserve/base with env, metadata and an auto-pause from the lifetime", async () => {
    seen.length = 0;
    const sbx = await p().create({ env: { BASE: "b" }, metadata: { run: "r1" }, timeoutMinutes: 10 });
    expect(sbx.nativeId).toMatch(/^sb-\d+$/);
    const create = seen.find((s) => s.path === "/sandboxes" && s.method === "POST")!;
    expect(create.headers["x-api-key"]).toBe("ss_test");
    expect(create.body).toMatchObject({ from_template: "superserve/base", timeout_seconds: 600, env_vars: { BASE: "b" }, metadata: { run: "r1" } });
    expect(create.body.name).toMatch(/^sbr-/);
    // The create response carries the access token, so there is no extra activate.
    expect(seen.filter((s) => s.path.endsWith("/activate")).length).toBe(0);
  });

  it("uses image.superserve as the template and refuses sizes the system templates lack", async () => {
    seen.length = 0;
    await expect(p().create({ vcpu: 4, memoryGb: 8 })).rejects.toThrow(/fixed at 2 vCPU \/ 4 GB/);
    expect(seen.length).toBe(0);
    await p().create({ vcpu: 4, memoryGb: 8, image: { superserve: "team/big-box" } });
    expect(seen.find((s) => s.path === "/sandboxes")!.body.from_template).toBe("team/big-box");
    await expect(p().create({ image: { superserve: "nope" } })).rejects.toMatchObject({ status: 404, message: expect.stringContaining("not_found: template nope not found") });
  });

  it("surfaces API errors with their code", async () => {
    await expect(new SuperserveProvider("bad", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("unauthorized: invalid API key") });
  });

  it("runs commands with env, cwd and the timeout on the data plane, and returns output and exit code", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    seen.length = 0;
    const r = await sbx.exec('echo "$GREETING $BASE from $(basename "$PWD")"; echo err >&2; exit 3', { env: { GREETING: "it's me" }, cwd: "/tmp", timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 3, stdout: "it's me b from tmp\n", stderr: "err\n" });
    const req = seen.find((s) => s.path === "/exec/stream")!;
    expect(req.body).toEqual({ command: expect.stringContaining("GREETING"), working_dir: "/tmp", env: { GREETING: "it's me" }, timeout_s: 7 });
    expect(req.headers["x-superserve-sandbox-id"]).toBe(sbx.nativeId);
    expect(req.headers["x-access-token"]).toMatch(/^tok-/);
    expect(req.headers["x-api-key"]).toBeUndefined();
  });

  it("streams stdout and stderr chunks as they arrive", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const t0 = Date.now();
    let first = -1;
    const r = await sbx.exec("echo one; sleep 0.6; echo two >&2; sleep 0.6; echo three", {
      onStdout: (c) => {
        if (first < 0) first = Date.now() - t0;
        events.push(`out:${c.trim()}`);
      },
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r.stdout).toBe("one\nthree\n");
    expect(first).toBeLessThan(r.durationMs - 800);
  });

  it("turns the server's timeout kill (exit 124) into a timeout error, but not a quick exit 124", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5; echo late", { timeoutSeconds: 1 })).rejects.toThrow(/command timed out after 1s/);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await sbx.exec("exit 124", { timeoutSeconds: 5 })).exitCode).toBe(124);
  });

  it("round-trips text and binary files that commands can see", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");
    expect((await sbx.exec(`cat '${path}'`)).stdout).toBe("héllo 'quoted'\n");
    const big = new Uint8Array(600 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await sbx.exec(`printf made > '${join(root, "made.txt")}'`);
    expect(new TextDecoder().decode(await sbx.readFile(join(root, "made.txt")))).toBe("made");
    await sbx.writeFile(join(root, "empty"), "");
    expect((await sbx.readFile(join(root, "empty"))).length).toBe(0);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    const sent = seen.filter((s) => s.path.startsWith("/files") && s.method === "POST").at(-1)!;
    expect(sent.headers["content-type"]).toBe("application/octet-stream");
  });

  it("re-activates once when its token was rotated elsewhere", async () => {
    const sbx = await p().create({});
    await p().connect(sbx.nativeId); // mints a new token, invalidating the one from create
    seen.length = 0;
    expect((await sbx.exec("echo still")).stdout).toBe("still\n");
    expect(seen.map((s) => s.path)).toEqual(["/exec/stream", `/sandboxes/${sbx.nativeId}/activate`, "/exec/stream"]);
    expect(seen.at(-1)!.headers["x-superserve-routing-hint"]).toBe("hint-1");
  });

  it("waits for a pause to land, resumes on connect, and auto-resumes a paused box on exec", async () => {
    const sbx = await p().create({});
    await sbx.writeFile(join(root, "keep.txt"), "kept\n");
    await sbx.pause!();
    expect(boxes.get(sbx.nativeId)!.status).toBe("paused");
    const again = await p().connect(sbx.nativeId);
    expect(boxes.get(sbx.nativeId)!.status).toBe("active");
    expect((await again.exec(`cat '${join(root, "keep.txt")}'`)).stdout).toBe("kept\n");
    // The old handle still works after a pause: the data plane says 503, the adapter activates.
    await again.pause!();
    seen.length = 0;
    expect((await again.exec("echo awake")).stdout).toBe("awake\n");
    expect(seen.map((s) => s.path)).toEqual(["/exec/stream", `/sandboxes/${sbx.nativeId}/activate`, "/exec/stream"]);
  });

  it("connect() waits out a pause that is still landing (409 sandbox_pausing)", async () => {
    const sbx = await p().create({});
    const box = boxes.get(sbx.nativeId)!;
    box.status = "pausing";
    setTimeout(() => (box.status = "paused"), 300);
    seen.length = 0;
    const again = await p().connect(sbx.nativeId);
    expect(seen.filter((s) => s.path.endsWith("/activate")).length).toBe(2);
    expect((await again.exec("echo ok")).stdout).toBe("ok\n");
  });

  it("deletes on kill; a killed sandbox cannot be connected and a second kill is a no-op", async () => {
    const sbx = await p().create({});
    await sbx.kill();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `/sandboxes/${sbx.nativeId}` });
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
    await expect(sbx.kill()).resolves.toBeUndefined();
  });

  it("picks hosts from the base URL or the key's region", () => {
    const def = new SuperserveProvider("ss_live_abc", undefined, undefined);
    expect([def.base, def.dataPlane]).toEqual(["https://api.superserve.ai", "https://sandbox.superserve.ai"]);
    const usw = new SuperserveProvider(`ss_live_usw_${"x".repeat(32)}`, undefined, undefined);
    expect([usw.base, usw.dataPlane]).toEqual(["https://api-usw.superserve.ai", "https://usw-sandbox.superserve.ai"]);
    const mock = new SuperserveProvider("k", `${base}/`, undefined);
    expect([mock.base, mock.dataPlane]).toEqual([base, base]);
    const split = new SuperserveProvider("k", "https://api.superserve.ai", "https://boxd.example");
    expect(split.dataPlane).toBe("https://boxd.example");
  });

  it("reports configured() from the key", () => {
    expect(new SuperserveProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
