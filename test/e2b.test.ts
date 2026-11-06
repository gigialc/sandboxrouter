import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for the `e2b` SDK's sandbox API (the desktop SDK is covered by e2b-desktop.test.ts):
 * `Sandbox.create([template,] { apiKey, timeoutMs, envs, metadata })`, `Sandbox.connect(id, { apiKey })`,
 * and an instance with `sandboxId`, `commands.run(cmd, { cwd, envs, background: true, timeoutMs,
 * onStdout, onStderr })` -> CommandHandle `{ pid, wait(), kill() }`, `files.write(path, bytes)`,
 * `files.read(path, { format: "bytes" })`, `pause()` and `kill()`.
 *
 * Commands really run with `sh -c` in a temp dir, honouring cwd and envs (sandbox envs underneath).
 * Like the SDK, `wait()` resolves { exitCode: 0, stdout, stderr }, rejects with a CommandExitError
 * (name, exitCode, stdout, stderr) on a nonzero exit, and rejects with a TimeoutError once the
 * stream's `timeoutMs` passes without stopping the process; `kill()` SIGKILLs the process group
 * and resolves true. A missing file or sandbox is a NotFoundError; connect resumes a paused one.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-e2b-"));
const children = new Set<ChildProcess>();
const creates: unknown[][] = [];
const connects: unknown[][] = [];
const runs: { cmd: string; opts: any }[] = [];
const kills: number[] = [];
const sandboxes = new Map<string, FakeE2B>();
let hangingHandle: { wait: () => Promise<never>; kill: ReturnType<typeof vi.fn> } | undefined;
let seq = 0;

const sdkError = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
const killGroup = (child: ChildProcess) => {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {}
};

class FakeE2B {
  state: "running" | "paused" | "killed" = "running";
  constructor(
    readonly sandboxId: string,
    private envs: Record<string, string> = {},
  ) {}
  private live() {
    if (this.state !== "running") throw sdkError("NotFoundError", `sandbox ${this.sandboxId} is ${this.state}`);
  }
  commands = {
    run: async (cmd: string, opts: any = {}) => {
      this.live();
      runs.push({ cmd, opts });
      if (!opts.background) throw new Error("mock expects background: true");
      if (hangingHandle) return hangingHandle;
      const child = spawn("sh", ["-c", cmd], { cwd: opts.cwd ?? root, env: { ...process.env, ...this.envs, ...opts.envs }, detached: true });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d) => ((stdout += d), opts.onStdout?.(String(d))));
      child.stderr!.on("data", (d) => ((stderr += d), opts.onStderr?.(String(d))));
      const exit = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
          children.delete(child);
          const exitCode = code ?? (signal ? 137 : -1);
          if (exitCode === 0) resolve({ exitCode, stdout, stderr });
          else reject(sdkError("CommandExitError", `exit status ${exitCode}`, { exitCode, stdout, stderr }));
        });
      });
      exit.catch(() => {});
      const pid = child.pid ?? 0;
      return {
        pid,
        wait: () => {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(sdkError("TimeoutError", `[DEADLINE_EXCEEDED] after ${opts.timeoutMs}ms`)), opts.timeoutMs ?? 60_000).unref();
          });
          return Promise.race([exit, late]).finally(() => clearTimeout(timer));
        },
        kill: async () => {
          kills.push(pid);
          killGroup(child);
          return true;
        },
      };
    },
  };
  files = {
    write: async (path: string, data: Uint8Array) => {
      this.live();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
      return { name: path.split("/").pop(), type: "file", path };
    },
    read: async (path: string, opts: { format: string }) => {
      this.live();
      if (opts?.format !== "bytes") throw new Error("mock expects format: bytes");
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        throw sdkError("NotFoundError", `path '${path}' does not exist`);
      }
    },
  };
  pause = async () => {
    this.live();
    this.state = "paused";
    return true;
  };
  kill = async () => {
    this.live();
    this.state = "killed";
    sandboxes.delete(this.sandboxId);
    return true;
  };
}

vi.mock("e2b", () => ({
  Sandbox: {
    create: async (...args: any[]) => {
      creates.push(args);
      const opts = typeof args[0] === "string" ? args[1] : args[0];
      const s = new FakeE2B(`i${++seq}abc`, opts?.envs);
      sandboxes.set(s.sandboxId, s);
      return s;
    },
    connect: async (id: string, opts: unknown) => {
      connects.push([id, opts]);
      const s = sandboxes.get(id);
      if (!s) throw sdkError("NotFoundError", `sandbox ${id} not found`);
      s.state = "running";
      return s;
    },
  },
}));

const { E2BProvider, E2BCompatBox } = await import("../src/providers/e2b.js");
const p = () => new E2BProvider("e2b_test");

beforeEach(() => {
  for (const a of [creates, connects, runs, kills]) a.length = 0;
  hangingHandle = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("e2b", { provider: p, dir: root });

describe("E2BProvider", () => {
  it("reports configured() from the key", () => {
    expect(new E2BProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto Sandbox.create: template first when image.e2b is set, lifetime in ms, envs, metadata", async () => {
    const opts = { apiKey: "e2b_test", timeoutMs: 600_000, envs: { A: "1" }, metadata: { k: "v" } };
    const sbx = await p().create({ timeoutMinutes: 10, env: { A: "1" }, metadata: { k: "v" }, vcpu: 8 });
    expect(sbx.nativeId).toBe(`i${seq}abc`);
    expect(creates[0]).toEqual([opts]); // vCPU and memory come from the template
    await p().create({ image: { e2b: "my-tpl" }, timeoutMinutes: 10, env: { A: "1" }, metadata: { k: "v" } });
    expect(creates[1]).toEqual(["my-tpl", opts]);
    await p().create({});
    expect(creates[2]).toEqual([{ apiKey: "e2b_test", timeoutMs: 1_800_000, envs: undefined, metadata: undefined }]);
  });

  it("runs in the background with cwd, envs and a stream deadline past the command's", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    const chunks: string[] = [];
    const r = await sbx.exec('printf "%s %s %s" "$BASE" "$A" "$(basename "$PWD")"', { cwd: root, env: { A: "1" }, timeoutSeconds: 5, onStdout: (c) => chunks.push(c) });
    expect(r).toMatchObject({ exitCode: 0, stdout: `b 1 ${root.split("/").pop()}` });
    expect(chunks.join("")).toBe(r.stdout);
    expect(runs.at(-1)!.opts).toEqual({ cwd: root, envs: { A: "1" }, background: true, timeoutMs: 20_000, onStdout: expect.any(Function), onStderr: undefined });
    // A nonzero exit arrives as CommandExitError and is a result, not a failure.
    expect(await sbx.exec("printf out; printf err >&2; exit 3")).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err" });
  });

  it("rejects with the contract's timeout and kills the handle when wait() never settles", async () => {
    const sbx = await p().create({});
    hangingHandle = { wait: () => new Promise<never>(() => {}), kill: vi.fn(async () => true) };
    const t0 = Date.now();
    await expect(sbx.exec("sleep 60", { timeoutSeconds: 1 })).rejects.toMatchObject({ name: "ProviderError", message: "e2b: command timed out after 1s" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(hangingHandle.kill).toHaveBeenCalledTimes(1);
  });

  it("maps the SDK's TimeoutError and other failures to ProviderError labelled e2b", async () => {
    const sbx = await p().create({});
    hangingHandle = { wait: () => Promise.reject(sdkError("TimeoutError", "[DEADLINE_EXCEEDED]")), kill: vi.fn(async () => true) };
    await expect(sbx.exec("true", { timeoutSeconds: 2 })).rejects.toMatchObject({ message: "e2b: command timed out after 2s" });
    hangingHandle = { wait: () => Promise.reject(new Error("connection reset")), kill: vi.fn(async () => true) };
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", provider: "e2b", message: "e2b: connection reset" });
    await expect(sbx.readFile(join(root, "nope"))).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("E2BCompatBox labels errors with its own provider and has no pause", async () => {
    const fake = new FakeE2B("ix1");
    sandboxes.set(fake.sandboxId, fake);
    const box = new E2BCompatBox(fake, "novita");
    expect(box.nativeId).toBe("ix1");
    expect(box.pause).toBeUndefined();
    expect((await box.exec("echo hi")).stdout).toBe("hi\n");
    await expect(box.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ provider: "novita", message: "novita: command timed out after 0.5s" });
    expect(kills).toHaveLength(1);
    await box.kill();
    expect(fake.state).toBe("killed");
  });

  it("pauses, resumes through connect with the key, and is gone after kill", async () => {
    const sbx = await p().create({});
    const fake = sandboxes.get(sbx.nativeId)!;
    await sbx.pause!();
    expect(fake.state).toBe("paused");
    const again = await p().connect(sbx.nativeId);
    expect(connects.at(-1)).toEqual([sbx.nativeId, { apiKey: "e2b_test" }]);
    expect(fake.state).toBe("running");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await sbx.kill();
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
