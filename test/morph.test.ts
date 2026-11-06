import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardTimeout, wrapCommand } from "../src/util.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `morphcloud` with the SDK's surface: `new MorphCloudClient({ apiKey })` with
 * `snapshots.list({ digest })` / `create({ imageId, vcpus, memory, diskSize, digest })` / `get()`
 * and `instances.start({ snapshotId, metadata, ttlSeconds, ttlAction, timeout })` / `get()`.
 * Instances have `status`, `exec(["sh", "-c", script], { timeout, onStdout, onStderr })` (the
 * callbacks stream chunks like the SDK's SSE path; `timeout` abandons the request with the SDK's
 * "Command execution timed out" error), `pause()` / `resume()` / `stop()` / `waitUntilReady()`,
 * and `ssh()` returning a NodeSSH-like `execCommand(cmd, { stdin })` → `{ code, stdout, stderr,
 * signal }` plus `dispose()`. Commands really run in a temp dir; the VM's /etc/sandboxrouter.env is
 * mapped under it, and a `timeout` shim goes on PATH when the host lacks coreutils (macOS). API
 * failures are plain Errors whose message starts "HTTP <status>", as the SDK throws them.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-morph-"));
mkdirSync(join(root, "etc"));
mkdirSync(join(root, "bin"));
if (spawnSync("sh", ["-c", "command -v timeout"]).status !== 0) {
  writeFileSync(
    join(root, "bin", "timeout"),
    ["#!/bin/sh", '[ "$1" = -k ] && shift 2', "s=$1; shift", '"$@" & p=$!', '( sleep "$s"; kill -TERM $p ) >/dev/null 2>&1 & w=$!', "wait $p; c=$?", "kill $w 2>/dev/null", "[ $c -eq 143 ] && exit 124", "exit $c"].join("\n"),
  );
  chmodSync(join(root, "bin", "timeout"), 0o755);
}
const shimPath = `${join(root, "bin")}:${process.env.PATH}`;
const ENV_FILE = "/etc/sandboxrouter.env";
const vmPath = (s: string) => s.replaceAll(ENV_FILE, join(root, "etc", "sandboxrouter.env"));

const clients: unknown[] = [];
const snapshotCreates: unknown[] = [];
const starts: unknown[] = [];
const execs: { command: string | string[]; options: any }[] = [];
const sshCmds: string[] = [];
let disposed = 0;
let pendingPolls = 0;
let execError: Error | undefined;
const snapshots = new Map<string, any>();
const instances = new Map<string, FakeInstance>();
const children = new Set<ChildProcess>();

const http = (status: number, text: string, path: string) => new Error(`HTTP ${status} ${text} for https://cloud.morph.so/api${path}`);
const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {}
};
const exitCode = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 + constants.signals[signal] : -1);

function run(argv: string[], opts: { timeout?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void }, stdin?: string) {
  return new Promise<{ exit_code: number; stdout: string; stderr: string; signal: string | null }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, PATH: shimPath }, detached: true });
    children.add(child);
    child.stdin.end(stdin ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => ((stdout += d), opts.onStdout?.(String(d))));
    child.stderr.on("data", (d) => ((stderr += d), opts.onStderr?.(String(d))));
    const timer = opts.timeout
      ? setTimeout(() => (killGroup(child), reject(new Error(`Command execution timed out after ${opts.timeout} seconds`))), opts.timeout * 1000)
      : undefined;
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ exit_code: exitCode(code, signal), stdout, stderr, signal });
    });
  });
}

class FakeInstance {
  status = "ready";
  constructor(
    readonly id: string,
    readonly refs: { snapshotId: string },
    readonly metadata?: Record<string, string>,
  ) {}
  private live() {
    if (this.status === "stopped") throw http(404, "Not Found", `/instance/${this.id}`);
    if (this.status === "paused") throw http(409, "Conflict", `/instance/${this.id}/exec`);
  }
  async exec(command: string | string[], options: any = {}) {
    this.live();
    execs.push({ command, options });
    if (execError) throw execError;
    const argv = (Array.isArray(command) ? command : ["sh", "-c", command]).map(vmPath);
    return run(argv, options);
  }
  async pause() {
    this.live();
    this.status = "paused";
  }
  async resume() {
    if (this.status !== "paused") throw http(409, "Conflict", `/instance/${this.id}/resume`);
    this.status = "ready";
  }
  async stop() {
    this.live();
    this.status = "stopped";
  }
  async waitUntilReady() {
    if (this.status !== "ready") throw new Error("Instance did not become ready before timeout");
  }
  async ssh() {
    this.live();
    return {
      execCommand: async (cmd: string, o: { stdin?: string } = {}) => {
        sshCmds.push(cmd);
        const r = await run(["sh", "-c", vmPath(cmd)], {}, o.stdin);
        return { code: r.exit_code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), signal: r.signal };
      },
      dispose: () => void disposed++,
    };
  }
}

vi.mock("morphcloud", () => ({
  MorphCloudClient: class {
    apiKey?: string;
    constructor(o: { apiKey?: string } = {}) {
      this.apiKey = o.apiKey;
      clients.push(o);
    }
    private auth(path: string) {
      if (this.apiKey !== "morph_test") throw http(401, "Unauthorized", path);
    }
    snapshots = {
      list: async (o: { digest?: string } = {}) => (this.auth("/snapshot"), [...snapshots.values()].filter((s) => !o.digest || s.digest === o.digest)),
      create: async (o: any) => {
        this.auth("/snapshot");
        snapshotCreates.push(o);
        const snap = { id: `snapshot_${snapshots.size + 1}`, object: "snapshot", status: pendingPolls > 0 ? "pending" : "ready", spec: { vcpus: o.vcpus, memory: o.memory, diskSize: o.diskSize }, refs: { imageId: o.imageId }, digest: o.digest };
        snapshots.set(snap.id, snap);
        return snap;
      },
      get: async ({ snapshotId }: { snapshotId: string }) => {
        const snap = snapshots.get(snapshotId);
        if (!snap) throw http(404, "Not Found", `/snapshot/${snapshotId}`);
        if (snap.status === "pending" && --pendingPolls <= 0) snap.status = "ready";
        return snap;
      },
    };
    instances = {
      start: async (o: any) => {
        this.auth("/instance");
        starts.push(o);
        if (!snapshots.has(o.snapshotId)) throw http(404, "Not Found", `/instance?snapshot_id=${o.snapshotId}`);
        const inst = new FakeInstance(`morphvm_${instances.size + 1}`, { snapshotId: o.snapshotId }, o.metadata);
        instances.set(inst.id, inst);
        return inst;
      },
      get: async ({ instanceId }: { instanceId: string }) => {
        this.auth(`/instance/${instanceId}`);
        const inst = instances.get(instanceId);
        if (!inst || inst.status === "stopped") throw http(404, "Not Found", `/instance/${instanceId}`);
        return inst;
      },
      stop: async ({ instanceId }: { instanceId: string }) => instances.get(instanceId)?.stop(),
    };
  },
}));

const { MorphProvider } = await import("../src/providers/morph.js");
delete process.env.MORPH_API_KEY;
const p = () => new MorphProvider("morph_test");

beforeEach(() => {
  clients.length = snapshotCreates.length = starts.length = execs.length = sshCmds.length = 0;
  disposed = 0;
  execError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("morph", { provider: p, dir: root });

describe("MorphProvider", () => {
  it("reports configured() from the api key", () => {
    expect(new MorphProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("creates a sized morphvm-minimal snapshot keyed by digest, then starts an instance with the ttl", async () => {
    snapshots.clear();
    pendingPolls = 1;
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, metadata: { team: "a" } });
    expect(clients[0]).toEqual({ apiKey: "morph_test" });
    expect(snapshotCreates).toEqual([{ imageId: "morphvm-minimal", vcpus: 4, memory: 8192, diskSize: 8192, digest: "sandboxrouter-morphvm-minimal-4c-8192m-8192d" }]);
    expect(starts[0]).toEqual({ snapshotId: "snapshot_1", metadata: { team: "a" }, ttlSeconds: 1200, ttlAction: "stop", timeout: 300 });
    expect(sbx.nativeId).toMatch(/^morphvm_\d+$/);
    expect(sbx.pause).toBeTypeOf("function");
    await sbx.kill();

    // The ready snapshot is reused; the lifetime never drops under a minute.
    await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 0.1 });
    expect(snapshotCreates).toHaveLength(1);
    expect(starts[1]).toMatchObject({ snapshotId: "snapshot_1", ttlSeconds: 60 });
    expect((await p().create({})).nativeId).toBeDefined();
    expect(snapshotCreates[1]).toMatchObject({ vcpus: 2, memory: 4096, digest: "sandboxrouter-morphvm-minimal-2c-4096m-8192d" });
  }, 10_000);

  it("starts from image.morph without touching snapshots", async () => {
    snapshots.set("snapshot_mine", { id: "snapshot_mine", status: "ready", digest: undefined });
    await p().create({ image: { morph: "snapshot_mine" }, vcpu: 64 });
    expect(snapshotCreates).toEqual([]);
    expect(starts[0]).toMatchObject({ snapshotId: "snapshot_mine" });
  });

  it("stores spec.env in /etc/sandboxrouter.env over SSH and sources it before every command", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    expect(sshCmds[0]).toBe(`mkdir -p '/etc' && base64 -d > '/etc/sandboxrouter.env' && chmod 600 /etc/sandboxrouter.env`);
    expect(disposed).toBe(1);
    const cmd = `echo "$BASE $OVER $(basename "$PWD")"`;
    const r = await sbx.exec(cmd, { cwd: root, env: { OVER: "new" } });
    expect(r).toMatchObject({ exitCode: 0, stdout: `b new ${root.split("/").pop()}\n` });
    // The whole line is guarded by coreutils `timeout` (or the sh watchdog) and sources the env file first.
    expect(execs[0].command).toEqual(["sh", "-c", guardTimeout(`[ -r ${ENV_FILE} ] && . ${ENV_FILE}; ${wrapCommand(cmd, { cwd: root, env: { OVER: "new" } })}`, 60)]);
    expect(execs[0].options).toEqual({ timeout: 75, onStdout: undefined, onStderr: undefined });
  });

  it("streams through the SDK callbacks and keeps nonzero exits as results", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; exit 4", { onStdout: (c) => events.push(`out:${c.trim()}`), onStderr: (c) => events.push(`err:${c.trim()}`) });
    expect(events).toEqual(["out:one", "err:two"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\n", stderr: "two\n" });
    expect(execs[0].options.onStdout).toBeTypeOf("function");
  });

  it("maps the SDK's own request timeout and HTTP errors onto ProviderError", async () => {
    const sbx = await p().create({});
    execError = new Error("Command execution timed out after 75 seconds");
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", message: "morph: command timed out after 60s" });
    execError = undefined;
    await expect(p().connect("morphvm_nope")).rejects.toMatchObject({ name: "ProviderError", status: 404, message: expect.stringMatching(/^morph: HTTP 404 Not Found/) });
    await expect(new MorphProvider("wrong").create({})).rejects.toMatchObject({ status: 401 });
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "ProviderError", message: expect.stringContaining("readFile") });
  });

  it("pauses the VM, resumes it on connect, and stops it on kill", async () => {
    const sbx = await p().create({});
    const inst = instances.get(sbx.nativeId)!;
    await sbx.pause!();
    expect(inst.status).toBe("paused");
    await expect(sbx.exec("true")).rejects.toMatchObject({ status: 409 });
    const again = await p().connect(sbx.nativeId);
    expect(inst.status).toBe("ready");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await again.kill();
    expect(inst.status).toBe("stopped");
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });
});
