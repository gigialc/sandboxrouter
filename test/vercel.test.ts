import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@vercel/sandbox`: `Sandbox.create(params)` and `Sandbox.get({ name, ...creds })`
 * return sandboxes with `name`, `runCommand({ cmd, args, cwd, env, signal, timeoutMs, detached })`,
 * `writeFiles([{ path, content }])`, `readFileToBuffer({ path })` (null for a missing file) and
 * `stop()`. A non-detached run resolves to a CommandFinished (`exitCode`, `stdout()`, `stderr()`);
 * a detached one to a Command with `logs({ signal })` yielding `{ stream, data }` chunks and
 * `wait({ signal })`. Commands really run in a temp dir; at `timeoutMs` the process is SIGKILLed
 * and reports exit 137, as the service does. writeFiles creates parent directories like the real
 * tarball extraction. The credentials passed with each call are recorded.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-vercel-"));
const creates: any[] = [];
const gets: any[] = [];
const runs: any[] = [];
const stopped: string[] = [];
const children = new Set<ChildProcess>();
let runError: Error | undefined;
const sandboxes = new Map<string, FakeSandbox>();

const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {}
};

class FakeCommand {
  exitCode: number | null = null;
  private out = "";
  private err = "";
  private chunks: { stream: "stdout" | "stderr"; data: string }[] = [];
  private closed = false;
  private done: Promise<number>;
  constructor(params: any, sandboxEnv: Record<string, string>) {
    if (params.cwd && !existsSync(params.cwd)) throw new Error(`cwd ${params.cwd}: no such file or directory`);
    const child = spawn(params.cmd, params.args ?? [], { cwd: params.cwd ?? root, env: { ...process.env, ...sandboxEnv, ...(params.env ?? {}) }, detached: true });
    children.add(child);
    const push = (stream: "stdout" | "stderr") => (d: Buffer) => {
      this[stream === "stdout" ? "out" : "err"] += d;
      this.chunks.push({ stream, data: String(d) });
    };
    child.stdout!.on("data", push("stdout"));
    child.stderr!.on("data", push("stderr"));
    const timer = params.timeoutMs ? setTimeout(() => killGroup(child), params.timeoutMs) : undefined;
    this.done = new Promise((resolve) =>
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        this.closed = true;
        resolve((this.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1)));
      }),
    );
  }
  async *logs(opts: { signal?: AbortSignal } = {}) {
    let sent = 0;
    for (;;) {
      opts.signal?.throwIfAborted();
      if (sent < this.chunks.length) yield this.chunks[sent++];
      else if (this.closed) return;
      else await new Promise((r) => setTimeout(r, 10));
    }
  }
  async wait(opts: { signal?: AbortSignal } = {}) {
    opts.signal?.throwIfAborted();
    await this.done;
    return this;
  }
  stdout = async () => (await this.done, this.out);
  stderr = async () => (await this.done, this.err);
}

class FakeSandbox {
  alive = true;
  constructor(
    readonly name: string,
    private env: Record<string, string>,
  ) {}
  private live() {
    if (!this.alive) throw new Error(`Sandbox ${this.name} is stopped`);
  }
  async runCommand(params: any) {
    this.live();
    runs.push(params);
    if (runError) throw runError;
    const cmd = new FakeCommand(params, this.env);
    return params.detached ? cmd : cmd.wait();
  }
  async writeFiles(files: { path: string; content: Buffer }[]) {
    this.live();
    for (const f of files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
  }
  async readFileToBuffer({ path }: { path: string }) {
    this.live();
    return existsSync(path) ? readFileSync(path) : null;
  }
  async stop() {
    stopped.push(this.name);
    this.alive = false;
  }
}

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: async (params: any) => {
      creates.push(params);
      if (params.token !== "vt_test") throw Object.assign(new Error("Unauthorized: invalid token"), { status: 401 });
      const sbx = new FakeSandbox(`sbx_${sandboxes.size + 1}`, params.env ?? {});
      sandboxes.set(sbx.name, sbx);
      return sbx;
    },
    get: async (params: any) => {
      gets.push(params);
      const sbx = sandboxes.get(params.name);
      if (!sbx) throw new Error(`Sandbox ${params.name} not found`);
      return sbx;
    },
  },
}));

const { VercelProvider } = await import("../src/providers/vercel.js");
const ENV = { VERCEL_TOKEN: "vt_test", VERCEL_TEAM_ID: "team_test", VERCEL_PROJECT_ID: "prj_test" };
const saved = { ...ENV, VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN };
const p = () => new VercelProvider();

beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.VERCEL_OIDC_TOKEN;
  creates.length = gets.length = runs.length = stopped.length = 0;
  runError = undefined;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("vercel", { provider: p, dir: root });

describe("VercelProvider", () => {
  it("is configured by an OIDC token or the token + team + project triple", () => {
    expect(p().configured()).toBe(true);
    delete process.env.VERCEL_PROJECT_ID;
    expect(p().configured()).toBe(false);
    process.env.VERCEL_OIDC_TOKEN = "oidc";
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto Sandbox.create with 2 GB per vCPU, passing the credentials", async () => {
    const sbx = await p().create({ vcpu: 1, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, image: { vercel: "python3.13" }, metadata: { team: "a" } });
    expect(sbx.nativeId).toMatch(/^sbx_\d+$/);
    expect(creates[0]).toEqual({
      token: "vt_test",
      teamId: "team_test",
      projectId: "prj_test",
      runtime: "python3.13",
      timeout: 1_200_000,
      resources: { vcpus: 4 },
      env: { A: "1" },
      tags: { team: "a" },
    });
    await p().create({});
    expect(creates[1]).toEqual({ token: "vt_test", teamId: "team_test", projectId: "prj_test", runtime: "node22", timeout: 1_800_000, resources: { vcpus: 2 }, env: undefined, tags: undefined });
    await p().create({ vcpu: 16, memoryGb: 1 });
    expect(creates[2].resources).toEqual({ vcpus: 8 });
    // With only an OIDC token the SDK finds the credentials itself; create's errors pass through unwrapped.
    delete process.env.VERCEL_TOKEN;
    process.env.VERCEL_OIDC_TOKEN = "oidc";
    await expect(p().create({})).rejects.toMatchObject({ message: "Unauthorized: invalid token", status: 401 });
    expect(creates[3]).not.toHaveProperty("token");
  });

  it("runs `sh -c` with cwd, env and timeoutMs; detached with logs only when streaming", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    const r = await sbx.exec(`echo "$BASE $OVER"; echo err >&2`, { cwd: root, env: { OVER: "new" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 0, stdout: "b new\n", stderr: "err\n" });
    expect(runs[0]).toMatchObject({ cmd: "sh", args: ["-c", `echo "$BASE $OVER"; echo err >&2`], cwd: root, env: { OVER: "new" }, timeoutMs: 7000 });
    expect(runs[0].detached).toBeUndefined();
    expect(runs[0].signal).toBeInstanceOf(AbortSignal);
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);

    const events: string[] = [];
    const s = await sbx.exec("echo one; sleep 0.2; echo two >&2; exit 4", { onStdout: (c) => events.push(`out:${c.trim()}`), onStderr: (c) => events.push(`err:${c.trim()}`) });
    expect(events).toEqual(["out:one", "err:two"]);
    expect(s).toMatchObject({ exitCode: 4, stdout: "one\n", stderr: "two\n" });
    expect(runs.at(-1)).toMatchObject({ detached: true, timeoutMs: 60_000 });
  });

  it("reports the SIGKILL at the deadline as the contract's timeout, in both modes", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "vercel: command timed out after 0.5s" });
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5, onStdout: () => {} })).rejects.toMatchObject({ message: "vercel: command timed out after 0.5s" });
    // A client-side abort of the wait is the same timeout; anything else is a ProviderError.
    runError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    await expect(sbx.exec("true", { timeoutSeconds: 2 })).rejects.toMatchObject({ message: "vercel: command timed out after 2s" });
    runError = new Error("session is not running");
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", message: "vercel: session is not running" });
  });

  it("round-trips bytes and reports a missing file as ProviderError", async () => {
    const sbx = await p().create({});
    const bin = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "deep", "er", "bin"), bin);
    expect(Buffer.from(await sbx.readFile(join(root, "deep", "er", "bin"))).equals(Buffer.from(bin))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "ProviderError", message: `vercel: no such file: ${join(root, "missing")}` });
  });

  it("connects by name with the credentials, stops on kill, and has no pause", async () => {
    const created = await p().create({});
    const sbx = await p().connect(created.nativeId);
    expect(gets[0]).toEqual({ token: "vt_test", teamId: "team_test", projectId: "prj_test", name: created.nativeId });
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    expect(sbx.pause).toBeUndefined();
    await sbx.kill();
    expect(stopped).toEqual([created.nativeId]);
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError" });
  });
});
