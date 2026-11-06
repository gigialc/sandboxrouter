import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for the object SDK of `@runloop/api-client` v3, the part the adapter uses:
 * `new RunloopSDK({ bearerToken })`, `devbox.create(params)` / `devbox.fromId(id)`, and on a
 * Devbox `getInfo()`, `awaitRunning()`, `suspend()` / `awaitSuspended()` / `resume()`, `shutdown()`,
 * `cmd.execAsync(cmd, { stdout, stderr })` returning an Execution (`result({ longPoll })`, `kill()`),
 * `file.upload({ path, file })` / `file.download({ path })` (a fetch Response), plus `toFile`.
 *
 * Runloop's exec has no cwd/env/timeout: the adapter wraps cwd/env into the command text and
 * enforces the deadline itself, so the mock runs the text as-is with `sh -c` in a temp dir.
 * `result()` rejects with PollingTimeoutError once `longPoll.timeoutMs` passes with the command
 * still running (as the SDK's long poll does) and `kill()` SIGKILLs the process group. Streaming
 * callbacks get each output chunk verbatim (the SDK forwards `chunk.output` unchanged). API errors
 * carry `status` like the SDK's APIError; a devbox that was shut down reports status "shutdown".
 */
const root = mkdtempSync(join(tmpdir(), "sbr-runloop-"));
const children = new Set<ChildProcess>();
const sdkOpts: unknown[] = [];
const creates: any[] = [];
const execs: { cmd: string; params: any }[] = [];
const calls: string[][] = [];
const killedExecs: string[] = [];
const uploads: { path: string; name: string }[] = [];
const devboxes = new Map<string, FakeDevbox>();
let createError: unknown;
let seq = 0;

const apiError = (status: number, message: string) => Object.assign(new Error(`${status} ${message}`), { name: "APIError", status });
const killGroup = (child: ChildProcess) => {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {}
};

class FakeExecution {
  readonly executionId = `exec_${++seq}`;
  private child: ChildProcess;
  private out = "";
  private err = "";
  private exit: Promise<number>;
  constructor(cmd: string, cb: { stdout?: (s: string) => void; stderr?: (s: string) => void } = {}) {
    this.child = spawn("sh", ["-c", cmd], { cwd: root, env: process.env, detached: true });
    children.add(this.child);
    this.child.stdout!.on("data", (d) => ((this.out += d), cb.stdout?.(String(d))));
    this.child.stderr!.on("data", (d) => ((this.err += d), cb.stderr?.(String(d))));
    this.exit = new Promise((resolve) => {
      this.child.on("error", () => resolve(-1));
      this.child.on("close", (code, signal) => (children.delete(this.child), resolve(code ?? (signal ? 137 : -1))));
    });
  }
  async result(options: { longPoll?: { timeoutMs?: number } } = {}) {
    const timeoutMs = options.longPoll?.timeoutMs ?? 300_000;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs).unref()));
    const code = await Promise.race([this.exit, late]).finally(() => clearTimeout(timer));
    if (code === "timeout") throw Object.assign(new Error(`Long poll timed out after ${timeoutMs}ms`), { name: "PollingTimeoutError" });
    return { exitCode: code, success: code === 0, stdout: async () => this.out, stderr: async () => this.err };
  }
  async kill() {
    killedExecs.push(this.executionId);
    killGroup(this.child);
  }
}

class FakeDevbox {
  status = "running";
  constructor(
    readonly id: string,
    private missing = false,
  ) {}
  private info() {
    if (this.missing) throw apiError(404, `Devbox ${this.id} not found`);
    return { id: this.id, status: this.status };
  }
  private live() {
    this.info();
    if (this.status !== "running") throw apiError(400, `Devbox ${this.id} is ${this.status}`);
  }
  getInfo = async () => this.info();
  awaitRunning = async () => ((this.status = "running"), this.info());
  awaitSuspended = async () => ((this.status = "suspended"), this.info());
  suspend = async () => (calls.push(["suspend", this.id]), (this.status = "suspending"), this.info());
  resume = async () => (calls.push(["resume", this.id]), (this.status = "running"), this.info());
  shutdown = async () => (calls.push(["shutdown", this.id]), (this.status = "shutdown"), this.info());
  cmd = {
    execAsync: async (cmd: string, params: any = {}) => {
      this.live();
      execs.push({ cmd, params });
      return new FakeExecution(cmd, params);
    },
  };
  file = {
    upload: async ({ path, file }: { path: string; file: { name: string; bytes: Buffer } }) => {
      this.live();
      uploads.push({ path, name: file.name });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes);
      return {};
    },
    download: async ({ path }: { path: string }) => {
      this.live();
      try {
        return new Response(readFileSync(path));
      } catch {
        throw apiError(404, `File not found: ${path}`);
      }
    },
  };
}

vi.mock("@runloop/api-client", () => ({
  RunloopSDK: class {
    devbox = {
      create: async (params: unknown) => {
        creates.push(params);
        if (createError) throw createError;
        const d = new FakeDevbox(`dbx_${++seq}`);
        devboxes.set(d.id, d);
        return d;
      },
      fromId: (id: string) => devboxes.get(id) ?? new FakeDevbox(id, true),
    };
    constructor(opts: unknown) {
      sdkOpts.push(opts);
    }
  },
  toFile: async (value: Uint8Array, name: string) => ({ name, bytes: Buffer.from(value) }),
}));

const { RunloopProvider } = await import("../src/providers/runloop.js");
const p = () => new RunloopProvider("rl_test");

beforeEach(() => {
  for (const a of [sdkOpts, creates, execs, calls, killedExecs, uploads]) a.length = 0;
  createError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("runloop", { provider: p, dir: root });

describe("RunloopProvider", () => {
  it("reports configured() from the key", () => {
    expect(new RunloopProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto devbox.create with a CUSTOM_SIZE and the key as bearer token", async () => {
    const sbx = await p().create({ vcpu: 3, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, metadata: { k: "v" }, image: { runloop: "my-blueprint" } });
    expect(sbx.nativeId).toMatch(/^dbx_/);
    expect(sdkOpts[0]).toEqual({ bearerToken: "rl_test" });
    expect(creates[0]).toEqual({
      blueprint_name: "my-blueprint",
      environment_variables: { A: "1" },
      metadata: { k: "v" },
      launch_parameters: { resource_size_request: "CUSTOM_SIZE", custom_cpu_cores: 4, custom_gb_memory: 8, keep_alive_time_seconds: 1200 },
    });
    await p().create({ image: { runloop: "bpt_123" } });
    expect(creates[1]).toMatchObject({ blueprint_id: "bpt_123" });
    expect(creates[1]).not.toHaveProperty("blueprint_name");
  });

  it("snaps sizes to Runloop's grid and clamps the keep-alive to 60 s .. 48 h", async () => {
    const launch = async (spec: Parameters<typeof RunloopProvider.prototype.create>[0]) => {
      await p().create(spec);
      const { launch_parameters: lp } = creates.at(-1);
      return [lp.custom_cpu_cores, lp.custom_gb_memory, lp.keep_alive_time_seconds];
    };
    expect(await launch({})).toEqual([2, 4, 1800]);
    expect(await launch({ vcpu: 0.5, memoryGb: 0.5, timeoutMinutes: 0.1 })).toEqual([0.5, 1, 60]);
    expect(await launch({ vcpu: 1, memoryGb: 64, timeoutMinutes: 10_000 })).toEqual([1, 8, 172_800]);
    expect(await launch({ vcpu: 32, memoryGb: 1 })).toEqual([16, 32, 1800]);
    expect(creates.at(-1)).not.toHaveProperty("blueprint_name");
  });

  it("carries the SDK's HTTP status into ProviderError", async () => {
    createError = apiError(401, "Unauthorized");
    await expect(p().create({})).rejects.toMatchObject({ name: "ProviderError", status: 401, message: expect.stringContaining("Unauthorized") });
    await expect(p().connect("dbx_missing")).rejects.toMatchObject({ provider: "runloop", status: 404 });
  });

  it("wraps cwd and env into the command text, since exec takes neither", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('printf "%s %s" "$A" "$(basename "$PWD")"', { cwd: root, env: { A: "it's" } });
    expect(r).toMatchObject({ exitCode: 0, stdout: `it's ${root.split("/").pop()}` });
    expect(execs.at(-1)!.cmd).toBe(`cd '${root}' && export A='it'\\''s' && {\nprintf "%s %s" "$A" "$(basename "$PWD")"\n}`);
    expect(execs.at(-1)!.params).toEqual({ stdout: undefined, stderr: undefined });
    await sbx.exec("true", { onStdout: () => {} });
    expect(typeof execs.at(-1)!.params.stdout).toBe("function");
  });

  it("kills the execution when the long poll outlives the timeout", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ message: "runloop: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(killedExecs).toHaveLength(1);
  });

  it("uploads with the file's own name and fails reads of missing files with the API status", async () => {
    const sbx = await p().create({});
    await sbx.writeFile(join(root, "up", "bin.dat"), new Uint8Array([1, 2, 3]));
    expect(uploads.at(-1)).toEqual({ path: join(root, "up", "bin.dat"), name: "bin.dat" });
    await expect(sbx.readFile(join(root, "nope"))).rejects.toMatchObject({ provider: "runloop", status: 404 });
  });

  it("connect resumes a suspended devbox, waits for a starting one and refuses a dead one", async () => {
    const sbx = await p().create({});
    const d = devboxes.get(sbx.nativeId)!;
    await sbx.pause();
    expect(calls).toEqual([["suspend", d.id]]);
    expect(d.status).toBe("suspended");
    await p().connect(d.id);
    expect(calls.at(-1)).toEqual(["resume", d.id]);
    expect(d.status).toBe("running");

    d.status = "provisioning";
    expect((await (await p().connect(d.id)).exec("echo up")).stdout).toBe("up\n");

    await sbx.kill();
    expect(calls.at(-1)).toEqual(["shutdown", d.id]);
    await expect(p().connect(d.id)).rejects.toThrow(/is shutdown/);
  });
});
