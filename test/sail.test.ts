import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hourlyCost, info, unfit } from "../src/catalog.js";
import { BILL_READERS } from "../src/cost.js";
import { SailProvider } from "../src/providers/sail.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for api.sailresearch.com (apps) and sailbox-api.sailresearch.com (Sailboxes) on one
 * port, following the OpenAPI document: exec really runs the command under /bin/sh in a temp dir
 * and streams NDJSON with base64 output, files read and write real paths, a paused box answers 409.
 */
let server: Server;
let base = "";
let root = "";
let shimPath = "";
const seen: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: any }[] = [];
interface Box {
  status: string;
  env: Record<string, string>;
  app: string;
}
const boxes = new Map<string, Box>();
const apps = new Map<string, string>();
let n = 0;
/** Make the next create come back failed (accepted, but the machine never came up). */
let failNextCreate = false;
/** Drop the next exec stream right after `started`, so the adapter must call /wait. */
let dropNextStream = false;
/** Make the next exec's server-side timeout fire after this many ms, ahead of the adapter's own guard. */
let serverTimeoutNextMs: number | undefined;
const results = new Map<string, { status: string; return_code: number; timed_out: boolean }>();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sbr-sail-")));
  // Sail's Debian image has coreutils `timeout`, which the adapter's guardTimeout uses; macOS does
  // not, so give the mock a minimal one (as test/koyeb.test.ts does).
  mkdirSync(join(root, "bin"));
  if (spawnSync("sh", ["-c", "command -v timeout"]).status !== 0) {
    writeFileSync(
      join(root, "bin", "timeout"),
      [
        "#!/bin/sh",
        '[ "$1" = -k ] && shift 2',
        "s=$1; shift",
        '"$@" & p=$!',
        '( sleep "$s"; kill -TERM $p ) >/dev/null 2>&1 & w=$!',
        "wait $p; c=$?",
        "kill $w 2>/dev/null",
        "[ $c -eq 143 ] && exit 124",
        "exit $c",
      ].join("\n"),
    );
    chmodSync(join(root, "bin", "timeout"), 0o755);
  }
  shimPath = `${join(root, "bin")}:${process.env.PATH}`;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const isJson = String(req.headers["content-type"] ?? "").includes("json");
    const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body });
    const send = (status: number, obj?: unknown) => {
      res.writeHead(status, obj === undefined ? {} : { "Content-Type": "application/json" });
      res.end(obj === undefined ? undefined : JSON.stringify(obj));
    };
    const fail = (status: number, type: string, message: string) => send(status, { error: { message, type, param: null, code: null } });
    if (req.headers.authorization !== "Bearer sk_test") return fail(401, "authentication_error", "invalid API key");
    const p = url.pathname;

    if (p === "/v1/apps/find" && req.method === "POST") {
      if (!apps.has(body.name)) {
        if (!body.mint_if_missing) return fail(404, "not_found_error", "no such app");
        apps.set(body.name, `app_${apps.size + 1}`);
      }
      return send(200, { id: apps.get(body.name), name: body.name, created_at: 1 });
    }
    if (p === "/v1/sailboxes" && req.method === "POST") {
      if (!body?.app_id || ![...apps.values()].includes(body.app_id)) return fail(400, "invalid_request_error", "app_id is required");
      if (!body.name || !body.image?.base) return fail(400, "invalid_request_error", "name and image are required");
      if (body.memory_limit_gib !== undefined && body.memory_limit_gib < 16) return fail(400, "invalid_request_error", "memory_limit_gib must be 16 to 512");
      const id = `sb_${++n}`;
      const status = failNextCreate ? "failed" : "running";
      boxes.set(id, { status, env: body.env ?? {}, app: body.app_id });
      if (failNextCreate) {
        failNextCreate = false;
        return send(200, { sailbox_id: id, status, error_message: "no capacity" });
      }
      return send(200, { sailbox_id: id, status });
    }
    if (p === "/v1/sailboxes/spend") {
      return send(200, {
        cost_usd_nanos: 1_250_000,
        creation_fees_waived: false,
        sailboxes: [{ sailbox_id: url.searchParams.get("sailbox_id"), cost_usd_nanos: 1_250_000, running_seconds: 601, vcpu_seconds: 1190, memory_gib_seconds: 2400, creation_count: 1 }],
      });
    }
    const m = p.match(/^\/v1\/sailboxes\/([^/]+)(\/.*)?$/);
    if (!m) return fail(404, "not_found_error", `no route ${req.method} ${p}`);
    const box = boxes.get(m[1]);
    if (!box || box.status === "terminated") {
      if (m[2] === "/terminate" && box) return send(200, { sailbox_id: m[1], status: "terminated" });
      return fail(404, "not_found_error", "No such Sailbox");
    }
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") return send(200, { sailbox_id: m[1], status: box.status });
    if (sub === "/terminate") {
      box.status = "terminated";
      return send(200, { sailbox_id: m[1], status: "terminated" });
    }
    if (sub === "/pause") {
      box.status = "paused";
      return send(200, { sailbox_id: m[1], status: "paused" });
    }
    if (sub === "/resume") {
      const was = box.status;
      box.status = "running";
      return send(200, { sailbox_id: m[1], status: "running", resume_state: was === "running" ? "already_running" : "running" });
    }
    const wait = sub.match(/^\/exec\/([^/]+)\/(wait|cancel)$/);
    if (wait) {
      if (wait[2] === "cancel") return send(200, {});
      // Like Sail's, /wait blocks until the guest has the result.
      const id = decodeURIComponent(wait[1]);
      for (let i = 0; i < 100 && !results.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      const r = results.get(id);
      if (!r) return fail(404, "not_found_error", "no such exec");
      return send(200, { exec_request_id: wait[1], stdout: "", stderr: "", ...r });
    }
    if (box.status === "paused") return fail(409, "conflict_error", "Sailbox is paused; resume it first");
    if (sub === "/files") {
      const path = url.searchParams.get("path")!;
      if (req.method === "PUT") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, raw);
        return send(200, { path, size: raw.length });
      }
      if (!existsSync(path)) return fail(404, "not_found_error", `no such file: ${path}`);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Sail-File-Mode": "420" });
      return res.end(readFileSync(path));
    }
    if (sub === "/exec" && req.method === "POST") {
      if (typeof body?.command !== "string") return fail(400, "invalid_request_error", "command must be a string here");
      const execId = `exec_${++n}`;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const event = (e: unknown) => res.write(`${JSON.stringify(e)}\n`);
      event({ type: "started", exec_request_id: execId });
      // Sail runs a string command under /bin/sh -lc. The mock drops -l so the test machine's own login
      // profile (which may start background processes holding the output pipe) stays out of it.
      const child = spawn("/bin/sh", ["-c", body.command], {
        cwd: root,
        env: { ...process.env, PATH: shimPath, ...box.env, ...(body.env ?? {}) },
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
      }, serverTimeoutNextMs ?? (body.timeout ?? 3600) * 1000);
      serverTimeoutNextMs = undefined;
      const drop = dropNextStream;
      dropNextStream = false;
      if (drop) setTimeout(() => res.destroy(), 50);
      res.on("close", () => {
        if (!done && !drop) killGroup();
      });
      let seq = 0;
      child.stdout.on("data", (d: Buffer) => event({ type: "stdout", data: d.toString("base64"), seq: ++seq }));
      child.stderr.on("data", (d: Buffer) => event({ type: "stderr", data: d.toString("base64"), seq: ++seq }));
      child.on("close", (code) => {
        done = true;
        clearTimeout(timer);
        // What a real account sends at the timeout: status timed_out, return_code 124, timed_out true.
        const rc = timedOut ? 124 : (code ?? 137);
        const r = { status: timedOut ? "timed_out" : rc === 0 ? "succeeded" : "failed", return_code: rc, timed_out: timedOut };
        results.set(execId, r);
        event({ type: "exit", status: r.status, return_code: r.return_code, ...(timedOut ? { timed_out: true } : {}) });
        res.end();
      });
      return;
    }
    fail(404, "not_found_error", `no route ${req.method} ${p}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const provider = () => new SailProvider("sk_test", base);

describeConformance("sail", { provider, get dir() { return root; } });

describe("SailProvider", () => {
  it("finds or mints the app once, then creates a Debian box at the requested vCPUs with the 16 GiB memory floor", async () => {
    seen.length = 0;
    const p = provider();
    const sbx = await p.create({ vcpu: 2, memoryGb: 4, env: { BASE: "b" }, timeoutMinutes: 10 });
    await p.create({});
    expect(sbx.nativeId).toMatch(/^sb_\d+$/);
    expect(seen.filter((s) => s.path === "/v1/apps/find")).toHaveLength(1);
    expect(seen.find((s) => s.path === "/v1/apps/find")!.body).toEqual({ name: "sandboxrouter", mint_if_missing: true });
    const create = seen.find((s) => s.path === "/v1/sailboxes" && s.method === "POST")!;
    expect(create.headers.authorization).toBe("Bearer sk_test");
    expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.body).toMatchObject({
      app_id: "app_1",
      image: { base: "BASE_IMAGE_DEBIAN" },
      vcpu_count: 2,
      memory_limit_gib: 16,
      max_lifetime_seconds: 600,
      env: { BASE: "b" },
    });
    expect(create.body.name).toMatch(/^sbr-/);
    await p.create({ vcpu: 3.5, memoryGb: 40 });
    expect(seen.filter((s) => s.path === "/v1/sailboxes").at(-1)!.body).toMatchObject({ vcpu_count: 4, memory_limit_gib: 40 });
  });

  it("takes image.sail = devbox, and refuses images it can't build over HTTPS", async () => {
    seen.length = 0;
    await provider().create({ image: { sail: "devbox" } });
    expect(seen.find((s) => s.path === "/v1/sailboxes")!.body.image).toEqual({ base: "BASE_IMAGE_DEVBOX" });
    seen.length = 0;
    await expect(provider().create({ image: { sail: "python:3.13" } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("debian") });
    expect(seen).toHaveLength(0);
  });

  it("terminates a box that was accepted but never came up, and reports it without a status so the router can fall back", async () => {
    failNextCreate = true;
    seen.length = 0;
    const err = await provider().create({}).catch((e) => e);
    expect(err.message).toBe("sail: sailbox sb_" + String(n) + " failed: no capacity");
    expect(err.status).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `/v1/sailboxes/sb_${n}/terminate` });
  });

  it("surfaces API errors with their type and status", async () => {
    await expect(new SailProvider("bad", base).create({})).rejects.toMatchObject({ status: 401, message: "sail: POST /apps/find -> 401 authentication_error: invalid API key" });
  });

  it("sends env as an API field, decodes base64 output and keeps multibyte characters whole across chunks", async () => {
    const sbx = await provider().create({ env: { BASE: "b" } });
    seen.length = 0;
    const r = await sbx.exec(`printf '%s %s ' "$GREETING" "$BASE"; printf '\\303'; sleep 0.2; printf '\\251\\n'; echo err >&2; exit 3`, { env: { GREETING: "it's me" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 3, stdout: "it's me b é\n", stderr: "err\n" });
    const req = seen.find((s) => s.path.endsWith("/exec"))!;
    expect(req.body.env).toEqual({ GREETING: "it's me" });
    expect(req.body.timeout).toBe(17);
  });

  it("treats Sail's own timed_out exit as the contract's timeout error", async () => {
    const sbx = await provider().create({});
    serverTimeoutNextMs = 300;
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 4 })).rejects.toMatchObject({ message: "sail: command timed out after 4s" });
  });

  it("asks /wait for the result when the stream drops before the exit event", async () => {
    const sbx = await provider().create({});
    dropNextStream = true;
    seen.length = 0;
    const r = await sbx.exec("sleep 0.3; exit 7");
    expect(r.exitCode).toBe(7);
    expect(seen.some((s) => /\/exec\/exec_\d+\/wait$/.test(s.path))).toBe(true);
  });

  it("resumes a paused box on its own when a command or file call gets 409", async () => {
    const sbx = await provider().create({});
    await sbx.pause!();
    seen.length = 0;
    expect((await sbx.exec("echo awake")).stdout).toBe("awake\n");
    expect(seen.map((s) => s.path.replace(/sb_\d+/, "X"))).toEqual(["/v1/sailboxes/X/exec", "/v1/sailboxes/X/resume", "/v1/sailboxes/X/exec"]);
  });

  it("connect refuses a terminated box; kill twice is fine", async () => {
    const sbx = await provider().create({});
    await sbx.kill();
    await expect(sbx.kill()).resolves.toBeUndefined();
    await expect(provider().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });

  it("reads the real charge from /sailboxes/spend for the cost check", async () => {
    const prev = [process.env.SAIL_API_KEY, process.env.SAILBOX_API_URL];
    process.env.SAIL_API_KEY = "sk_test";
    process.env.SAILBOX_API_URL = base;
    try {
      const bill = await BILL_READERS.sail!({ provider: "sail", sandboxId: "sb_9", startedAt: "2026-11-06T10:00:00Z", endedAt: "2026-11-06T10:10:00Z" } as any);
      expect(bill).toMatchObject({ usd: 0.00125, seconds: 601, source: expect.stringContaining("1 creation charge") });
      expect(seen.at(-1)!.path).toContain("sailbox_id=sb_9");
    } finally {
      [process.env.SAIL_API_KEY, process.env.SAILBOX_API_URL] = prev;
      if (prev[0] === undefined) delete process.env.SAIL_API_KEY;
      if (prev[1] === undefined) delete process.env.SAILBOX_API_URL;
    }
  });

  it("is priced on use: every core busy plus the requested memory, at most", () => {
    expect(info("sail").billing).toBe("active-cpu");
    expect(hourlyCost("sail", { vcpu: 2, memoryGb: 4 })).toBeCloseTo(2 * 0.015 + 4 * 0.008, 6);
    expect(unfit("sail", { vcpu: 2, memoryGb: 4 })).toBeNull();
    expect(unfit("sail", { vcpu: 128 })).toBe("max 64 vCPU");
  });

  it("uses the public hosts by default and one host for both APIs when only the Sailbox URL is given", () => {
    const def = new SailProvider("k", undefined, undefined);
    expect([def.sailboxApi, def.mainApi]).toEqual(["https://sailbox-api.sailresearch.com/v1", "https://api.sailresearch.com/v1"]);
    const mock = new SailProvider("k", `${base}/v1/`);
    expect([mock.sailboxApi, mock.mainApi]).toEqual([`${base}/v1`, `${base}/v1`]);
    expect(new SailProvider(undefined, base).configured()).toBe(false);
  });
});
