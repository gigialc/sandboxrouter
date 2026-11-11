import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreestyleProvider, freestyleSize } from "../src/providers/freestyle.js";

/**
 * A stand-in for api.freestyle.sh following its OpenAPI description: Bearer key, {code, message}
 * errors, VM states, exec-await with statusCode null on timeout, raw-byte fs/write (sha256-checked)
 * and fs/read, and background requests: with x-freestyle-background-after-secs a call still
 * running after the window answers 202 and is replayed from /v5/background-requests/:id. The mock
 * uses a 300 ms window so the test stays fast. Commands really run in a temp dir.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; query: URLSearchParams; auth?: string; bg?: string; body?: any }[] = [];
let state = "starting";
let resources = { cpu: 2, memory: 4096, storage: 16384 };
const background = new Map<string, { done: boolean; status: number; body: unknown }>();
let bgCount = 0;

const rootDirs = new Set<string>();

function runCommand(command: string, env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ statusCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: root, env: { ...process.env, ...env }, detached: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    // Kill the process group: on Linux /bin/sh (dash) leaves `sleep` running and holding the pipes otherwise.
    const t = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(killed ? { statusCode: null, stdout, stderr } : { statusCode: code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-freestyle-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const body = req.headers["content-type"]?.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    const bg = req.headers["x-freestyle-background-after-secs"] as string | undefined;
    seen.push({ method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization, bg, body });
    const send = (status: number, obj?: unknown) => {
      res.writeHead(status, obj === undefined ? {} : { "Content-Type": "application/json" });
      res.end(obj === undefined ? undefined : JSON.stringify(obj));
    };
    const error = (status: number, code: string, message: string) => send(status, { code, message });
    if (req.headers.authorization !== "Bearer fs_test") return error(401, "UNAUTHORIZED", "invalid API key");

    /** Answer inline if the work finishes within 300 ms, else 202 and keep it for polling. */
    const maybeBackground = async (work: Promise<{ status: number; body: unknown }>) => {
      if (!bg) {
        const r = await work;
        return send(r.status, r.body);
      }
      const timer = new Promise<"late">((r) => setTimeout(() => r("late"), 300));
      const first = await Promise.race([work, timer]);
      if (first !== "late") return send(first.status, first.body);
      const id = `bgr-${++bgCount}`;
      const entry = { done: false, status: 0, body: undefined as unknown };
      background.set(id, entry);
      work.then((r) => Object.assign(entry, { done: true, ...r }));
      res.writeHead(202, { "Content-Type": "application/json", "x-freestyle-background-request-id": id });
      return res.end(JSON.stringify({ requestId: id, status: "pending" }));
    };

    const bgMatch = url.pathname.match(/^\/v5\/background-requests\/(.+)$/);
    if (bgMatch) {
      const entry = background.get(bgMatch[1]);
      if (!entry) return error(404, "NOT_FOUND", "unknown background request");
      if (!entry.done) return send(202, { requestId: bgMatch[1], status: "pending" });
      return send(entry.status, entry.body);
    }
    const vm = () => ({ id: "vm-1", state, resources, createdAt: "x", updatedAt: "x" });
    if (url.pathname === "/v5/vms" && req.method === "POST") {
      if (!body.firewall) return error(400, "BAD_REQUEST", "firewall is required");
      if (body.snapshotId === "freestyle/ubuntu-2xl") return error(429, "LIMIT_EXCEEDED", "max vCPUs per VM on Free is 4");
      state = "starting";
      resources = body.snapshotId === "me/custom" ? { cpu: 1, memory: 1024, storage: 4096 } : { cpu: 2, memory: 4096, storage: 16384 };
      return send(201, vm());
    }
    const m = url.pathname.match(/^\/v5\/vms\/([^/]+)(\/.*)?$/);
    if (!m) return error(404, "NOT_FOUND", "no route");
    if (m[1] !== "vm-1") return error(404, "NOT_FOUND", "no such VM in this account");
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") {
      const out = vm();
      if (state === "starting") state = "running";
      return send(200, out);
    }
    if (sub === "" && req.method === "DELETE") return send(204);
    if (sub === "/pause") {
      if (state !== "running") return error(409, "CONFLICT", "the VM is not running");
      state = "paused";
      return send(200, vm());
    }
    if (sub === "/start") {
      state = "running";
      return send(200, vm());
    }
    if (sub === "/resize") {
      if (body.cpu < resources.cpu || body.memory < resources.memory) return error(400, "BAD_REQUEST", "grow-only");
      resources = { ...resources, cpu: body.cpu, memory: body.memory };
      return send(200, vm());
    }
    if (sub === "/exec-await") {
      if (state !== "running") return error(409, "VM_NOT_RUNNING", "the VM is not running");
      const limit = bg ? 86_400_000 : 300_000;
      if (body.timeoutMs > limit) return error(400, "BAD_REQUEST", "invalid timeoutMs");
      return maybeBackground(runCommand(body.command, body.env ?? {}, body.timeoutMs ?? 30_000).then((r) => ({ status: 200, body: r })));
    }
    if (sub === "/fs/mkdir") {
      // The real file API runs as root: folders it makes are read-only to commands. Here, mode 555.
      const made: string[] = [];
      for (let d = body.path; !existsSync(d); d = dirname(d)) made.push(d);
      mkdirSync(body.path, { recursive: true });
      for (const d of made) chmodSync(d, 0o555), rootDirs.add(d);
      return send(204);
    }
    if (sub === "/fs/write" && req.method === "PUT") {
      const path = url.searchParams.get("path")!;
      if (!path.startsWith("/")) return error(400, "BAD_REQUEST", "path must be absolute");
      if (url.searchParams.get("sha256") !== createHash("sha256").update(raw).digest("hex")) return error(400, "BAD_REQUEST", "sha256 mismatch");
      if (!existsSync(dirname(path))) return error(404, "NOT_FOUND", "parent directory missing");
      // ...but root can still write in them.
      const parent = dirname(path);
      if (rootDirs.has(parent)) chmodSync(parent, 0o755);
      writeFileSync(path, raw);
      if (rootDirs.has(parent)) chmodSync(parent, 0o555);
      return send(204);
    }
    if (sub === "/fs/read") {
      try {
        const data = readFileSync(url.searchParams.get("path")!);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(data);
      } catch {
        return error(404, "NOT_FOUND", "no such path in the guest");
      }
    }
    error(404, "NOT_FOUND", "no route");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  for (const d of rootDirs) chmodSync(d, 0o755);
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("FreestyleProvider", () => {
  const p = () => new FreestyleProvider("fs_test", base, 50);

  it("creates from the smallest fitting base snapshot with outbound Internet and a TTL", async () => {
    seen.length = 0;
    const sbx = await p().create({ timeoutMinutes: 20, metadata: { run: "r1" } });
    expect(sbx.nativeId).toBe("vm-1");
    const req = seen.find((s) => s.path === "/v5/vms")!;
    expect(req.auth).toBe("Bearer fs_test");
    expect(req.body).toEqual({
      snapshotId: "freestyle/ubuntu-sm",
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      ttlSeconds: 1200,
      metadata: { run: "r1" },
    });
    // Waited for the booting VM to report running.
    expect(seen.filter((s) => s.path === "/v5/vms/vm-1" && s.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("maps sizes to base snapshots", () => {
    expect(freestyleSize(2, 4)?.snapshot).toBe("freestyle/ubuntu-sm");
    expect(freestyleSize(3, 4)?.snapshot).toBe("freestyle/ubuntu");
    expect(freestyleSize(4, 12)?.snapshot).toBe("freestyle/ubuntu-lg");
    expect(freestyleSize(33, 1)).toBeUndefined();
    expect(freestyleSize(2, 4)?.usdHour).toBeCloseTo(2 * 0.04032 + 4 * 0.0129 + 16 * 0.000086, 5);
  });

  it("grows a custom snapshot that is smaller than the spec", async () => {
    seen.length = 0;
    await p().create({ vcpu: 2, memoryGb: 4, image: { freestyle: "me/custom" } });
    expect(seen.find((s) => s.path === "/v5/vms")!.body.snapshotId).toBe("me/custom");
    expect(seen.find((s) => s.path.endsWith("/resize"))!.body).toEqual({ cpu: 2, memory: 4096 });
  });

  it("surfaces Freestyle error codes with the HTTP status", async () => {
    await expect(new FreestyleProvider("wrong", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("UNAUTHORIZED: invalid API key") });
    await expect(p().create({ vcpu: 32, memoryGb: 64 })).rejects.toMatchObject({ status: 429, message: expect.stringContaining("LIMIT_EXCEEDED") });
    await expect(p().create({ vcpu: 64 })).rejects.toThrow(/no Freestyle size/);
  });

  it("runs commands with spec env, per-call env and cwd", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    const r = await sbx.exec('echo "$GREETING $BASE from $(basename "$PWD")"; echo err >&2', { env: { GREETING: "it's me" }, cwd: "/tmp" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "it's me b from tmp\n", stderr: "err\n" });
    const req = seen.filter((s) => s.path.endsWith("/exec-await")).at(-1)!;
    expect(req.body.env).toEqual({ BASE: "b", GREETING: "it's me" });
    expect(req.body.timeoutMs).toBe(60_000);
    expect(req.bg).toBe("5");
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("follows a backgrounded exec to its result and hands output to the callbacks", async () => {
    const sbx = await p().create({});
    const out: string[] = [];
    const r = await sbx.exec("sleep 0.6; echo late", { timeoutSeconds: 600, onStdout: (c) => out.push(c) });
    expect(r).toMatchObject({ exitCode: 0, stdout: "late\n" });
    expect(out).toEqual(["late\n"]);
    expect(seen.some((s) => s.path.startsWith("/v5/background-requests/"))).toBe(true);
    expect(seen.filter((s) => s.path.endsWith("/exec-await")).at(-1)!.body.timeoutMs).toBe(600_000);
  });

  it("reports a command killed by its timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.2 })).rejects.toThrow(/timed out/);
  });

  it("round-trips text and binary files, creating parent directories", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");
    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("makes parent folders that commands can write in", async () => {
    const sbx = await p().create({});
    const dir = join(root, "shared", "work");
    await sbx.writeFile(join(dir, "in.txt"), "in");
    const r = await sbx.exec(`printf out > '${dir}/out.txt'`);
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    expect(new TextDecoder().decode(await sbx.readFile(join(dir, "out.txt")))).toBe("out");
  });

  it("pauses, resumes on the next exec, and resumes on connect", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v5/vms/vm-1/pause" });
    expect(state).toBe("paused");
    expect((await sbx.exec("echo back")).stdout).toBe("back\n");
    expect(seen.some((s) => s.path === "/v5/vms/vm-1/start")).toBe(true);

    await sbx.pause!();
    seen.length = 0;
    const again = await p().connect("vm-1");
    expect(seen.map((s) => `${s.method} ${s.path}`)).toContain("POST /v5/vms/vm-1/start");
    expect((await again.exec("echo hi")).stdout).toBe("hi\n");
    await again.kill();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/v5/vms/vm-1" });
    await expect(p().connect("vm-missing")).rejects.toMatchObject({ status: 404 });
  });

  it("reports configured() from the key", () => {
    expect(new FreestyleProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
