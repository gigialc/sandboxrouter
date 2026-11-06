import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@blaxel/core`: `initialize(config)` and `SandboxInstance` with the statics
 * `create(cfg)`, `get(name)`, `unarchive(name)` and `updateTtl(name, ttl)`. Instances expose
 * `metadata.name`, `status`, `process.exec({ command, workingDir, env, timeout, waitForCompletion,
 * onStdout, onStderr })` resolving to a ProcessResponse (`status`, `exitCode`, `stdout`, `stderr`,
 * `pid`, ...), `process.wait(pid)`, `fs.writeBinary(path, bytes)` / `fs.readBinary(path)` (a Blob),
 * `archive()` and `delete()`. Commands really run in a temp dir with the sandbox's `envs`
 * underneath the request's `env`; one killed at `timeout` has status "killed", a nonzero exit
 * "failed". Failed requests carry `status` like the SDK's errors.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-blaxel-"));
const inits: any[] = [];
const creates: any[] = [];
const ttls: any[] = [];
const execs: any[] = [];
const archived: string[] = [];
const deleted: string[] = [];
const children = new Set<ChildProcess>();
const sandboxes = new Map<string, FakeSandbox>();
let killEarly = false;
/** Answer a timeout the way a real account does: 422 "process timed out after N seconds". */
let timeoutAs422 = false;
let pids = 0;

const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {}
};
let deleteDelayMs = 0;
const fail = (status: number, detail: string) => Object.assign(new Error(`Sandbox request failed with status ${status}: ${detail}`), { status });

class FakeSandbox {
  status: string = "DEPLOYED";
  metadata: { name: string; labels?: Record<string, string> };
  constructor(
    name: string,
    readonly cfg: any,
  ) {
    this.metadata = { name, labels: cfg.labels };
  }
  private live() {
    if (this.status === "TERMINATED") throw fail(404, `sandbox ${this.metadata.name} not found`);
    if (this.status === "ARCHIVED") throw fail(409, "sandbox is archived");
  }
  process = {
    exec: (req: any) => {
      this.live();
      const { onStdout, onStderr, ...request } = req;
      execs.push(request);
      if (request.workingDir && !existsSync(request.workingDir)) throw fail(400, `chdir ${request.workingDir}: no such file or directory`);
      const envs = Object.fromEntries((this.cfg.envs ?? []).map((e: any) => [e.name, e.value]));
      return new Promise<any>((resolve, reject) => {
        const child = spawn("sh", ["-c", request.command], { cwd: request.workingDir ?? root, env: { ...process.env, ...envs, ...(request.env ?? {}) }, detached: true });
        children.add(child);
        const pid = String(++pids);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => ((stdout += d), onStdout?.(String(d))));
        child.stderr.on("data", (d) => ((stderr += d), onStderr?.(String(d))));
        let killed = false;
        const timer = setTimeout(() => ((killed = true), killGroup(child)), killEarly ? 100 : (request.timeout ?? 3600) * 1000);
        child.on("close", (code) => {
          clearTimeout(timer);
          children.delete(child);
          if (killed && timeoutAs422) return reject(fail(422, `process timed out after ${request.timeout} seconds`));
          const status = killed ? "killed" : code === 0 ? "completed" : "failed";
          resolve({ pid, name: request.name ?? pid, command: request.command, status, exitCode: code ?? 137, stdout, stderr, logs: stdout + stderr, workingDir: request.workingDir ?? "/", startedAt: "", completedAt: "" });
        });
      });
    },
    wait: async () => {
      throw new Error("not reached: exec waits for completion");
    },
  };
  fs = {
    writeBinary: async (path: string, content: Uint8Array) => {
      this.live();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    readBinary: async (path: string) => {
      this.live();
      if (!existsSync(path)) throw fail(404, `file not found: ${path}`);
      return new Blob([readFileSync(path)]);
    },
  };
  async archive() {
    this.live();
    archived.push(this.metadata.name);
    this.status = "ARCHIVED";
    return this;
  }
  async delete() {
    deleted.push(this.metadata.name);
    // Deletion is asynchronous on Blaxel: the sandbox reads as TERMINATING for a while first.
    if (deleteDelayMs) {
      this.status = "TERMINATING";
      setTimeout(() => (this.status = "TERMINATED"), deleteDelayMs);
    } else this.status = "TERMINATED";
    return {};
  }
}

const find = (name: string) => {
  const sbx = sandboxes.get(name);
  if (!sbx || sbx.status === "TERMINATED") throw fail(404, `sandbox ${name} not found`);
  return sbx;
};

vi.mock("@blaxel/core", () => ({
  initialize: (config: any) => void inits.push(config),
  SandboxInstance: {
    create: async (cfg: any) => {
      creates.push(cfg);
      if (!inits.length) throw fail(401, "no credentials");
      if (cfg.memory > 65536) throw fail(400, "memory too large");
      const sbx = new FakeSandbox(`sandbox-${sandboxes.size + 1}`, cfg);
      sandboxes.set(sbx.metadata.name, sbx);
      return sbx;
    },
    get: async (name: string) => find(name),
    unarchive: async (name: string) => {
      const sbx = find(name);
      if (sbx.status !== "ARCHIVED") throw fail(409, "sandbox is not archived");
      sbx.status = "DEPLOYED";
      return sbx;
    },
    updateTtl: async (name: string, ttl: string | null) => (ttls.push({ name, ttl }), find(name)),
  },
}));

const { BlaxelProvider } = await import("../src/providers/blaxel.js");
const p = () => new BlaxelProvider("bl_test", "ws_test");

beforeEach(() => {
  creates.length = ttls.length = execs.length = archived.length = deleted.length = 0;
  killEarly = false;
  timeoutAs422 = false;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("blaxel", { provider: p, dir: root });

describe("BlaxelProvider", () => {
  it("needs both the api key and the workspace, and initializes the SDK with them once", async () => {
    expect(new BlaxelProvider(undefined, "ws").configured()).toBe(false);
    expect(new BlaxelProvider("k", undefined).configured()).toBe(false);
    const prov = p();
    expect(prov.configured()).toBe(true);
    inits.length = 0;
    await prov.create({});
    await prov.create({});
    expect(inits).toEqual([{ apiKey: "bl_test", workspace: "ws_test" }]);
  });

  it("sizes by memory at 2 GB per vCPU, with envs, labels, region and a max-age ttl of at least 5m", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 2, timeoutMinutes: 20, env: { A: "1" }, metadata: { team: "a" }, image: { blaxel: "blaxel/py-app:latest" } });
    expect(sbx.nativeId).toMatch(/^sandbox-\d+$/);
    expect(creates[0]).toEqual({ image: "blaxel/py-app:latest", memory: 8192, region: "us-pdx-1", envs: [{ name: "A", value: "1" }], labels: { team: "a" }, ttl: "20m" });
    await new BlaxelProvider("bl_test", "ws_test", "eu-lon-1").create({ timeoutMinutes: 1 });
    expect(creates[1]).toEqual({ image: "blaxel/base-image:latest", memory: 4096, region: "eu-lon-1", envs: [], labels: undefined, ttl: "5m" });
    await p().create({ memoryGb: 16, vcpu: 1 });
    expect(creates[2].memory).toBe(16384);
    // No pause: archiving is a per-workspace preview, and a real account answers 403.
    expect(sbx.pause).toBeUndefined();
  });

  it("execs with workingDir, env and timeout, waiting for completion; a failed status is a result", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    const r = await sbx.exec(`echo "$BASE $OVER $(basename "$PWD")"; echo err >&2`, { cwd: root, env: { OVER: "new" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 0, stdout: `b new ${root.split("/").pop()}\n`, stderr: "err\n" });
    expect(execs[0]).toEqual({ command: `echo "$BASE $OVER $(basename "$PWD")"; echo err >&2`, workingDir: root, env: { OVER: "new" }, timeout: 7, waitForCompletion: true });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
    expect(execs[1]).toMatchObject({ workingDir: undefined, env: undefined, timeout: 60 });
  });

  it("reads status killed as the timeout at the deadline, and as an error before it", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "blaxel: command timed out after 0.5s" });
    killEarly = true;
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 5 })).rejects.toMatchObject({ name: "ProviderError", message: "blaxel: command killed before it finished" });
  });

  it("reads a real account's 422 \"process timed out\" as the contract's timeout error", async () => {
    const sbx = await p().create({});
    timeoutAs422 = true;
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toMatchObject({ name: "ProviderError", message: "blaxel: command timed out after 1s" });
  });

  it("carries the SDK's status into ProviderError", async () => {
    await expect(p().connect("sandbox-nope")).rejects.toMatchObject({ name: "ProviderError", status: 404, message: expect.stringContaining("sandbox-nope not found") });
    await expect(p().create({ memoryGb: 1024 })).rejects.toMatchObject({ status: 400 });
    const sbx = await p().create({});
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    await expect(sbx.exec("true", { cwd: join(root, "nope") })).rejects.toMatchObject({ status: 400 });
  });

  it("connect unarchives a sandbox archived elsewhere; kill waits until the sandbox is terminated", async () => {
    const sbx = await p().create({});
    const inst = sandboxes.get(sbx.nativeId)!;
    await inst.archive();
    const again = await p().connect(sbx.nativeId);
    expect(inst.status).toBe("DEPLOYED");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    deleteDelayMs = 700;
    try {
      await again.kill();
    } finally {
      deleteDelayMs = 0;
    }
    expect(deleted).toEqual([sbx.nativeId]);
    expect(inst.status).toBe("TERMINATED");
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });
});
