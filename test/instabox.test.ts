import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstaboxProvider, instaboxSize } from "../src/providers/instabox.js";

/**
 * A stand-in for api.instabox.sh following its OpenAPI document: changes answer 202 with an
 * operation, machines go creating -> running (ready a poll later), exec runs the command for real
 * in a temp dir (JSON or server-sent events), and the files API reads and writes the real disk.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: any }[] = [];
interface MockMachine {
  id: string;
  state: string;
  ready: boolean;
  env: Record<string, string>;
  operationId: string | null;
}
const machines = new Map<string, MockMachine>();
const ops = new Map<string, { id: string; machineId: string; type: string; state: string; polls: number; then: () => void; error?: any }>();
let allowed = ["2/4096", "4/8192", "8/16384"];
let failCreate: string | undefined;
let n = 0;

function op(m: MockMachine, type: string, then: () => void, error?: any) {
  const o = { id: `op_${++n}`, machineId: m.id, type, state: "running", polls: 0, then, error };
  ops.set(o.id, o);
  m.operationId = o.id;
  return o;
}

const view = (o: { id: string; machineId: string; type: string; state: string; error?: any }) => ({
  id: o.id,
  machineId: o.machineId,
  type: o.type,
  state: o.state,
  phase: o.state === "running" ? "booting" : "",
  error: o.state === "failed" ? { code: o.error.code, message: o.error.message, retryable: true, requestId: "req_1", operationId: null } : null,
  createdAt: "",
  updatedAt: "",
});

function fail(res: ServerResponse, status: number, code: string, message: string, retryable = false) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code, message, requestId: "req_1", retryable, operationId: null, docs_url: `https://instabox.sh/docs/errors#${code}` } }));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-instabox-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const p = url.pathname;
    const isJson = (req.headers["content-type"] ?? "").includes("json");
    const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: p + url.search, headers: req.headers, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers["x-api-key"] !== "ibk_test") return fail(res, 401, "invalid_key", "no such API key");
    const needsKey = req.method === "DELETE" || (req.method === "POST" && /^\/v1\/machines(\/[^/]+\/(start|suspend|resume|stop))?$/.test(p));
    if (needsKey && !req.headers["idempotency-key"]) return fail(res, 400, "bad_request", "missing Idempotency-Key");

    if (p === "/v1/machines" && req.method === "POST") {
      const known = ["vcpus", "memMiB", "deleteAfterSeconds", "env", "metadata", "templateId", "snapshotId"];
      const unknown = Object.keys(body).find((k) => !known.includes(k));
      if (unknown) return fail(res, 400, "unknown_field", `unknown field "${unknown}"`);
      if (!allowed.includes(`${body.vcpus}/${body.memMiB}`)) return fail(res, 400, "spec_not_allowed", `size ${body.vcpus}/${body.memMiB} is not one of yours`);
      const m: MockMachine = { id: `m_${String(++n).padStart(26, "a")}`, state: "creating", ready: false, env: body.env ?? {}, operationId: null };
      machines.set(m.id, m);
      const o = op(
        m,
        "create",
        () => {
          // A create from a snapshot with storage ends stopped.
          m.state = body.snapshotId ? "stopped" : "running";
          if (failCreate) machines.delete(m.id);
        },
        failCreate ? { code: failCreate, message: "no host has room for 2 vCPUs / 4 GiB; retry in 60s" } : undefined,
      );
      if (failCreate) o.state = "failed";
      return send(202, view(o));
    }
    let r = p.match(/^\/v1\/operations\/([^/]+)$/);
    if (r) {
      const o = ops.get(r[1]);
      if (!o) return fail(res, 404, "not_found", "no such operation");
      if (o.state === "failed") {
        o.then();
        return send(200, view(o));
      }
      if (o.state === "running" && ++o.polls >= 2) {
        o.state = "succeeded";
        o.then();
        const m = machines.get(o.machineId);
        if (m) m.operationId = null;
      }
      return send(200, view(o));
    }
    r = p.match(/^\/v1\/machines\/([^/]+)(\/.*)?$/);
    if (!r) return fail(res, 404, "not_found", `no route ${p}`);
    const m = machines.get(r[1]);
    if (!m) return fail(res, 404, "not_found", "no such sandbox");
    const sub = r[2] ?? "";
    if (sub === "" && req.method === "GET") {
      const ready = m.state === "running" && m.ready;
      if (m.state === "running") m.ready = true; // ready one poll after running
      return send(200, { id: m.id, name: "box-1", state: m.state, desiredState: m.state, runtime: { ready }, operationId: m.operationId, spec: { vcpus: 2, memMiB: 4096, persistentDiskGiB: 20 } });
    }
    if (sub === "" && req.method === "DELETE") {
      if (req.headers["x-confirm-delete"] !== m.id) return fail(res, 409, "delete_confirmation_required", `send X-Confirm-Delete: ${m.id}`);
      m.state = "deleting";
      return send(202, view(op(m, "delete", () => machines.delete(m.id))));
    }
    if (sub === "/suspend") {
      if (m.state !== "running") return fail(res, 409, "operation_conflict", "machine is not running");
      m.state = "suspending";
      return send(202, view(op(m, "suspend", () => (m.state = "suspended"))));
    }
    if (sub === "/start") {
      if (m.state !== "stopped" && m.state !== "suspended") return fail(res, 409, "operation_conflict", "machine is running");
      const from = m.state;
      m.state = from === "suspended" ? "resuming" : "starting";
      m.ready = false;
      return send(202, view(op(m, "start", () => (m.state = "running"))));
    }
    const notRunning = () => fail(res, 409, "machine_not_running", `machine is ${m.state}; start it first`);
    if (sub === "/exec" && req.method === "POST") {
      if (m.state !== "running") return notRunning();
      const sse = (req.headers.accept ?? "").includes("text/event-stream");
      const child = spawn("bash", ["-c", body.cmd], { cwd: body.cwd ?? root, env: { ...process.env, ...m.env, ...(body.envs ?? {}) }, detached: true });
      child.stdin.end(body.stdin ?? "");
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, (body.timeoutSeconds ?? 60) * 1000);
      const out = { stdout: "", stderr: "" };
      if (sse) res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const s of ["stdout", "stderr"] as const) {
        child[s].on("data", (d: Buffer) => {
          out[s] += String(d);
          if (sse) res.write(`event: ${s}\ndata: ${JSON.stringify({ data: String(d) })}\n\n`);
        });
      }
      child.on("close", (code) => {
        clearTimeout(timer);
        const result = { exitCode: timedOut ? 124 : (code ?? 255), timedOut, truncated: false };
        if (sse) res.end(`event: exit\ndata: ${JSON.stringify({ ...result, stdout: "", stderr: "" })}\n\n`);
        else send(200, { ...result, ...out });
      });
      return;
    }
    if (sub === "/files" && req.method === "PUT") {
      if (m.state !== "running") return notRunning();
      const path = url.searchParams.get("path")!;
      if (!existsSync(dirname(path))) {
        if (url.searchParams.get("parents") !== "true") return fail(res, 404, "missing_parent", "parent directory does not exist");
        mkdirSync(dirname(path), { recursive: true });
      }
      const created = !existsSync(path);
      writeFileSync(path, raw);
      return send(created ? 201 : 200, { path, size: raw.length, mode: "0644", created, sha256: "" });
    }
    if (sub === "/files/content" && req.method === "GET") {
      if (m.state !== "running") return notRunning();
      const path = url.searchParams.get("path")!;
      if (!existsSync(path)) return fail(res, 404, "not_found", `no such file: ${path}`);
      if (statSync(path).isDirectory()) return fail(res, 409, "not_a_file", `${path} is a directory`);
      const bytes = readFileSync(path);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      return res.end(bytes);
    }
    fail(res, 404, "not_found", `no route ${req.method} ${p}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

const lastCreate = () => seen.filter((s) => s.method === "POST" && s.path === "/v1/machines").at(-1)!;

describe("InstaboxProvider", () => {
  const p = () => new InstaboxProvider("ibk_test", base);

  it("picks the smallest fixed size that fits", () => {
    expect(instaboxSize(2, 4)).toEqual({ vcpu: 2, memoryGb: 4 });
    expect(instaboxSize(3, 4)).toEqual({ vcpu: 4, memoryGb: 8 });
    expect(instaboxSize(1, 9)).toEqual({ vcpu: 8, memoryGb: 16 });
    expect(instaboxSize(33, 1)).toBeUndefined();
  });

  it("creates with the size, env, labels and a delete deadline from the lifetime, then waits until ready", async () => {
    const sbx = await p().create({ vcpu: 2, memoryGb: 3, timeoutMinutes: 10, env: { BASE: "b" }, metadata: { task: "t1" } });
    expect(sbx.nativeId).toMatch(/^m_/);
    const create = lastCreate();
    expect(create.headers["x-api-key"]).toBe("ibk_test");
    expect(create.headers["idempotency-key"]).toBeTruthy();
    expect(create.body).toEqual({ vcpus: 2, memMiB: 4096, deleteAfterSeconds: 600, env: { BASE: "b" }, metadata: { task: "t1" } });
    expect(seen.some((s) => s.path.startsWith("/v1/operations/") && s.path.includes("wait=25s"))).toBe(true);
    // Polled the machine until runtime.ready, not just state running.
    expect(seen.filter((s) => s.method === "GET" && s.path === `/v1/machines/${sbx.nativeId}`).length).toBe(2);

    await p().create({ vcpu: 3, timeoutMinutes: 24 * 60 * 2 });
    expect(lastCreate().body).toEqual({ vcpus: 4, memMiB: 8192, deleteAfterSeconds: 86400 });
    await expect(p().create({ vcpu: 64 })).rejects.toThrow(/no InstaBox size has 64 vCPU/);
  });

  it("maps spec.image to a template or a snapshot, and starts a machine created stopped", async () => {
    await p().create({ image: { instabox: "universal@2026-10-15.4" } });
    expect(lastCreate().body.templateId).toBe("universal@2026-10-15.4");
    const sbx = await p().create({ image: { instabox: "sn_abc123" } });
    expect(lastCreate().body.snapshotId).toBe("sn_abc123");
    expect(seen.some((s) => s.method === "POST" && s.path === `/v1/machines/${sbx.nativeId}/start`)).toBe(true);
    expect((await sbx.exec("echo up")).stdout).toBe("up\n");
    await p().create({ image: { instabox: "snapshot:my-snap" } });
    expect(lastCreate().body.snapshotId).toBe("my-snap");
  });

  it("falls back to the default 4/8 size when the plan (free) refuses a smaller one", async () => {
    allowed = ["4/8192"];
    try {
      await p().create({});
      const creates = seen.filter((s) => s.method === "POST" && s.path === "/v1/machines");
      expect(creates.map((c) => `${c.body.vcpus}/${c.body.memMiB}`)).toEqual(["2/4096", "4/8192"]);
      expect(creates[0].headers["idempotency-key"]).not.toBe(creates[1].headers["idempotency-key"]);
      await expect(p().create({ vcpu: 8, memoryGb: 16 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("spec_not_allowed") });
    } finally {
      allowed = ["2/4096", "4/8192", "8/16384"];
    }
  });

  it("surfaces API errors and failed create operations", async () => {
    await expect(new InstaboxProvider("nope", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("invalid_key: no such API key") });
    failCreate = "no_capacity";
    try {
      await expect(p().create({})).rejects.toMatchObject({ status: 503, message: expect.stringContaining("no_capacity: no host has room") });
    } finally {
      failCreate = undefined;
    }
    await expect(new InstaboxProvider(undefined, base).create({})).rejects.toThrow(/INSTABOX_API_KEY is not set/);
  });

  it("runs commands with env, cwd and the timeout, and returns output and exit code", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    const r = await sbx.exec('echo "$GREETING $BASE from $(basename "$PWD")"; echo err >&2; exit 3', { env: { GREETING: "it's me" }, cwd: "/tmp", timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 3, stdout: "it's me b from tmp\n", stderr: "err\n" });
    const req = seen.filter((s) => s.path.endsWith("/exec")).at(-1)!;
    expect(req.body).toEqual({ cmd: expect.any(String), cwd: "/tmp", envs: { GREETING: "it's me" }, timeoutSeconds: 7 });
    expect(req.headers.accept ?? "").not.toContain("text/event-stream");
    await sbx.exec("true", { timeoutSeconds: 3600 });
    expect(seen.filter((s) => s.path.endsWith("/exec")).at(-1)!.body.timeoutSeconds).toBe(600);
  });

  it("streams stdout and stderr as server-sent events", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.4; echo two >&2; sleep 0.4; echo three; exit 2", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 2, stdout: "one\nthree\n", stderr: "two\n" });
    expect(seen.filter((s) => s.path.endsWith("/exec")).at(-1)!.headers.accept).toContain("text/event-stream");
  });

  it("reports a command timeout, with and without streaming", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5; echo late", { timeoutSeconds: 1 })).rejects.toThrow(/command timed out after 1s/);
    await expect(sbx.exec("echo early; sleep 5", { timeoutSeconds: 1, onStdout: () => {} })).rejects.toThrow(/command timed out after 1s/);
    expect(Date.now() - t0).toBeLessThan(4500);
  });

  it("round-trips text and binary files through the files API", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "deeper", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.path).toContain("parents=true");
    expect(put.headers["content-type"]).toBe("application/octet-stream");
    const big = new Uint8Array(600 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await sbx.writeFile(join(root, "empty"), "");
    expect((await sbx.readFile(join(root, "empty"))).length).toBe(0);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    // Files written by commands are readable, and written files are visible to commands.
    await sbx.exec(`cat ${JSON.stringify(path)} > ${JSON.stringify(join(root, "copy.txt"))}`);
    expect(new TextDecoder().decode(await sbx.readFile(join(root, "copy.txt")))).toBe("héllo 'quoted'\n");
  });

  it("pauses with suspend, resumes on connect, starts a paused box on exec, and deletes on kill", async () => {
    const sbx = await p().create({});
    const id = sbx.nativeId;
    await sbx.pause!();
    expect(machines.get(id)!.state).toBe("suspended");
    expect(seen.find((s) => s.path === `/v1/machines/${id}/suspend`)!.headers["idempotency-key"]).toBeTruthy();

    seen.length = 0;
    const again = await p().connect(id);
    expect(seen.some((s) => s.method === "POST" && s.path === `/v1/machines/${id}/start`)).toBe(true);
    expect((await again.exec("echo back")).stdout).toBe("back\n");

    // A call on a paused box (409 machine_not_running) starts it and retries.
    await again.pause!();
    expect((await again.exec("echo woke")).stdout).toBe("woke\n");

    await again.kill();
    const del = seen.filter((s) => s.method === "DELETE").at(-1)!;
    expect(del.path).toBe(`/v1/machines/${id}`);
    expect(del.headers["x-confirm-delete"]).toBe(id);
    await expect(p().connect(id)).rejects.toMatchObject({ status: 404 });
    await again.kill(); // deleting twice is fine
    await expect(p().connect("m_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("reports configured() from the key", () => {
    expect(new InstaboxProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
