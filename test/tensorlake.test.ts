import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@tensorlakeai/tensorlake`: `Sandbox.create(options)` and
 * `Sandbox.connect({ sandboxId, apiKey })` return sandboxes with `sandboxId`, `run(cmd, { args,
 * timeout })` → `{ exitCode, stdout, stderr, timedOut, reason }`, `startProcess(cmd, { args })` →
 * `{ pid, status }`, `followOutput(pid, { signal })` yielding `{ stream, line, timestamp }` per
 * line (the abort reason is thrown when the signal fires), `getProcess(pid)` → `{ status,
 * exitCode, signal }`, `killProcess(pid)`, `writeFile(path, bytes)` / `readFile(path)`, `info()`,
 * `update({ name })`, `status()`, `suspend()`, `resume()` and `terminate()`. Commands really run in
 * a temp dir; a run killed at `timeout` reports `timedOut: true`. API failures carry `statusCode`
 * like the SDK's RemoteAPIError. The sandbox's /tmp/.sandboxrouter.env is mapped under the temp dir.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-tensorlake-"));
const ENV_FILE = "/tmp/.sandboxrouter.env";
const vmPath = (s: string) => s.replaceAll(ENV_FILE, join(root, ".sandboxrouter.env"));

const creates: any[] = [];
const connects: any[] = [];
const runs: any[] = [];
const starts: any[] = [];
const updates: any[] = [];
const killed: number[] = [];
const terminated: string[] = [];
const children = new Set<ChildProcess>();
const sandboxes = new Map<string, FakeSandbox>();
let suspendingPolls = 0;
let pids = 100;

const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {}
};
const apiError = (statusCode: number, message: string) => Object.assign(new Error(message), { name: "RemoteAPIError", statusCode });

interface Proc {
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
  lines: { stream: string; line: string; timestamp: Date }[];
  raw: { stdout: string; stderr: string };
  child: ChildProcess;
}

class FakeSandbox {
  state = "running";
  name: string | null = null;
  procs = new Map<number, Proc>();
  constructor(
    readonly sandboxId: string,
    readonly opts: any,
  ) {
    this.name = opts.name ?? null;
  }
  private live() {
    if (this.state === "terminated") throw apiError(404, `sandbox ${this.sandboxId} not found`);
    if (this.state !== "running") throw apiError(409, `sandbox is ${this.state}`);
  }
  private spawn(cmd: string, args: string[]): Proc {
    const child = spawn(cmd, args.map(vmPath), { cwd: root, env: { ...process.env }, detached: true });
    children.add(child);
    const proc: Proc = { status: "running", lines: [], raw: { stdout: "", stderr: "" }, child };
    const pending = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.on("data", (d) => {
        proc.raw[stream] += d;
        pending[stream] += d;
        let nl: number;
        while ((nl = pending[stream].indexOf("\n")) !== -1) {
          proc.lines.push({ stream, line: pending[stream].slice(0, nl), timestamp: new Date() });
          pending[stream] = pending[stream].slice(nl + 1);
        }
      });
    }
    child.on("close", (code, signal) => {
      children.delete(child);
      for (const s of ["stdout", "stderr"] as const) if (pending[s]) proc.lines.push({ stream: s, line: pending[s], timestamp: new Date() });
      proc.status = "exited";
      if (code != null) proc.exitCode = code;
      else proc.signal = signal === "SIGKILL" ? 9 : 15;
    });
    return proc;
  }
  async run(cmd: string, o: { args?: string[]; timeout?: number } = {}) {
    this.live();
    runs.push({ cmd, ...o });
    const proc = this.spawn(cmd, o.args ?? []);
    let timedOut = false;
    const timer = o.timeout ? setTimeout(() => ((timedOut = true), killGroup(proc.child)), o.timeout * 1000) : undefined;
    await new Promise((r) => proc.child.on("close", r));
    clearTimeout(timer);
    return { exitCode: proc.exitCode ?? 128 + (proc.signal ?? 0), ...proc.raw, timedOut, reason: timedOut ? "TIMED_OUT" : "EXITED" };
  }
  async startProcess(cmd: string, o: { args?: string[] } = {}) {
    this.live();
    starts.push({ cmd, ...o });
    const pid = ++pids;
    this.procs.set(pid, this.spawn(cmd, o.args ?? []));
    return { pid, status: "running", command: cmd, args: o.args ?? [], stdinWritable: false, startedAt: new Date() };
  }
  async *followOutput(pid: number, o: { signal?: AbortSignal } = {}) {
    const proc = this.procs.get(pid)!;
    let sent = 0;
    for (;;) {
      if (o.signal?.aborted) throw o.signal.reason;
      if (sent < proc.lines.length) yield proc.lines[sent++];
      else if (proc.status === "exited") return;
      else await new Promise((r) => setTimeout(r, 10));
    }
  }
  async getProcess(pid: number) {
    const proc = this.procs.get(pid);
    if (!proc) throw apiError(404, `process ${pid} not found`);
    return { pid, status: proc.status, exitCode: proc.exitCode, signal: proc.signal, command: "", args: [], stdinWritable: false, startedAt: new Date() };
  }
  async killProcess(pid: number) {
    killed.push(pid);
    killGroup(this.procs.get(pid)!.child);
  }
  async writeFile(path: string, content: Uint8Array) {
    this.live();
    mkdirSync(dirname(vmPath(path)), { recursive: true });
    writeFileSync(vmPath(path), content);
  }
  async readFile(path: string) {
    this.live();
    if (!existsSync(vmPath(path))) throw apiError(404, `file not found: ${path}`);
    return new Uint8Array(readFileSync(vmPath(path)));
  }
  async info() {
    return { sandboxId: this.sandboxId, name: this.name ?? undefined, status: this.state, namespace: "default", autoResume: false, resources: {} };
  }
  async status() {
    if (this.state === "suspending" && --suspendingPolls <= 0) this.state = "suspended";
    return this.state;
  }
  async update(o: { name?: string }) {
    updates.push(o);
    if (o.name) throw apiError(400, "Sandbox names are immutable; set name when creating the sandbox");
    return this.info();
  }
  async suspend() {
    this.live();
    if (!this.name) throw apiError(400, "only named sandboxes can be suspended");
    this.state = suspendingPolls > 0 ? "suspending" : "suspended";
  }
  async resume() {
    if (this.state !== "suspended") throw apiError(409, `cannot resume a ${this.state} sandbox`);
    this.state = "running";
  }
  async terminate() {
    terminated.push(this.sandboxId);
    this.state = "terminated";
  }
}

vi.mock("@tensorlakeai/tensorlake", () => ({
  Sandbox: {
    create: async (o: any) => {
      creates.push(o);
      if (o.apiKey !== "tl_test") throw apiError(401, "invalid api key");
      const sbx = new FakeSandbox(`sb-${sandboxes.size + 1}`, o);
      sandboxes.set(sbx.sandboxId, sbx);
      return sbx;
    },
    connect: async (o: any) => {
      connects.push(o);
      const sbx = sandboxes.get(o.sandboxId);
      if (!sbx || sbx.state === "terminated") throw apiError(404, `sandbox ${o.sandboxId} not found`);
      return sbx;
    },
  },
}));

const { TensorlakeProvider } = await import("../src/providers/tensorlake.js");
delete process.env.TENSORLAKE_API_KEY;
const p = () => new TensorlakeProvider("tl_test");

beforeEach(() => {
  creates.length = connects.length = runs.length = starts.length = updates.length = killed.length = terminated.length = 0;
  suspendingPolls = 0;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("tensorlake", { provider: p, dir: root });

describe("TensorlakeProvider", () => {
  it("reports configured() from the api key", () => {
    expect(new TensorlakeProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto Sandbox.create and keeps spec.env in a sourced file", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, gpu: "A100", image: { tensorlake: "my-image" }, env: { BASE: "b", OVER: "old" } });
    expect(sbx.nativeId).toMatch(/^sb-\d+$/);
    expect(creates[0]).toEqual({ apiKey: "tl_test", name: expect.stringMatching(/^sbr-[0-9a-f-]{36}$/), image: "my-image", cpus: 4, memoryMb: 8192, timeoutSecs: 1200, gpuModel: "A100" });
    expect(readFileSync(vmPath(ENV_FILE), "utf8")).toBe("export BASE='b' && export OVER='old' && {\n:\n}\n");
    const r = await sbx.exec(`echo "$BASE $OVER $(basename "$PWD")"`, { cwd: root, env: { OVER: "new" } });
    expect(r.stdout).toBe(`b new ${root.split("/").pop()}\n`);
    expect(runs[0]).toEqual({ cmd: "/bin/sh", args: ["-c", `[ -f '${ENV_FILE}' ] && . '${ENV_FILE}'; cd '${root}' && export OVER='new' && {\necho "$BASE $OVER $(basename "$PWD")"\n}`], timeout: 60 });
    await p().create({});
    expect(creates[1]).toEqual({ apiKey: "tl_test", name: expect.stringMatching(/^sbr-[0-9a-f-]{36}$/), image: undefined, cpus: 2, memoryMb: 4096, timeoutSecs: 1800 });
    expect(creates[1].name).not.toBe(creates[0].name);
    expect(sbx.pause).toBeTypeOf("function");
  });

  it("uses run() with its timeout when nothing streams, and reads timedOut as the contract's error", async () => {
    const sbx = await p().create({});
    expect(await sbx.exec("printf hi; exit 3", { timeoutSeconds: 7 })).toMatchObject({ exitCode: 3, stdout: "hi" });
    expect(runs[0].timeout).toBe(7);
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "tensorlake: command timed out after 0.5s" });
    expect(starts).toEqual([]);
  });

  it("streams with startProcess/followOutput, taking the exit code from getProcess and killing at the deadline", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; sleep 0.2; printf three; exit 4", { onStdout: (c) => events.push(`out:${c}`), onStderr: (c) => events.push(`err:${c}`) });
    expect(events).toEqual(["out:one\n", "err:two\n", "out:three\n"]);
    // The returned text is exactly what was streamed, line endings included.
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    expect(starts[0]).toMatchObject({ cmd: "/bin/sh" });
    expect(runs).toEqual([]);

    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5, onStdout: () => {} })).rejects.toMatchObject({ message: "tensorlake: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(killed).toHaveLength(1);
  });

  it("carries statusCode into ProviderError", async () => {
    await expect(new TensorlakeProvider("wrong").create({})).rejects.toMatchObject({ name: "ProviderError", status: 401, message: "tensorlake: invalid api key" });
    await expect(p().connect("sb-nope")).rejects.toMatchObject({ status: 404 });
    const sbx = await p().create({});
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "ProviderError", status: 404 });
  });

  it("creates a named sandbox and suspends without renaming; connect resumes; kill terminates", async () => {
    const sbx = await p().create({});
    const inst = sandboxes.get(sbx.nativeId)!;
    suspendingPolls = 1;
    await sbx.pause!();
    expect(inst.name).toMatch(/^sbr-[0-9a-f-]{36}$/);
    expect(updates).toEqual([]);
    expect(inst.state).toBe("suspending");
    const again = await p().connect(sbx.nativeId);
    expect(connects[0]).toEqual({ sandboxId: sbx.nativeId, apiKey: "tl_test" });
    expect(inst.state).toBe("running");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    // Repeated suspend also leaves the immutable name untouched.
    await again.pause!();
    expect(updates).toHaveLength(0);
    await (await p().connect(sbx.nativeId)).kill();
    expect(terminated).toEqual([sbx.nativeId]);
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });
});
