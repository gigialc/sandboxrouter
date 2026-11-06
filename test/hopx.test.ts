import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@hopx-ai/sdk`: `Sandbox.create(options)`, `Sandbox.connect(id, apiKey)`, and an
 * instance with `sandboxId`, `commands.run(cmd, { timeout, workingDir, env })` (resolves with the
 * agent's { success, stdout, stderr, exit_code, execution_time }), `runCodeStream(code, { language,
 * timeout, workingDir, env })` (an async iterator of StreamMessage frames: stdout / stderr /
 * result / error / complete), `files.writeBytes` / `files.readBytes`, `pause()` and `kill()`.
 *
 * Commands really run with `sh -c` in a temp dir, honouring workingDir and env. Like the HOPX
 * agent, both paths kill the command at `timeout`: `run` then throws an error with code
 * EXECUTION_TIMEOUT, and the stream emits an `error` frame with that code. SDK errors are shaped
 * like HopxError (name, optional statusCode and code).
 */
const root = mkdtempSync(join(tmpdir(), "sbr-hopx-"));
const children = new Set<ChildProcess>();
const creates: any[] = [];
const connects: [string, string | undefined][] = [];
const runs: { cmd: string; opts: any }[] = [];
const streams: { code: string; opts: any }[] = [];
const sandboxes = new Map<string, FakeHopx>();
let createError: unknown;
let runError: unknown;
let seq = 0;

const hopxError = (name: string, message: string, extra: { statusCode?: number; code?: string } = {}) =>
  Object.assign(new Error(message), { name, ...extra });
const killGroup = (child: ChildProcess) => {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {}
};
const sh = (cmd: string, cwd: string | undefined, env: Record<string, string>) => {
  const child = spawn("sh", ["-c", cmd], { cwd: cwd ?? root, env: { ...process.env, ...env }, detached: true });
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
};

class FakeHopx {
  state: "running" | "paused" | "killed" = "running";
  constructor(
    readonly sandboxId: string,
    private envVars: Record<string, string> = {},
  ) {}
  private live() {
    if (this.state === "killed") throw hopxError("NotFoundError", `Sandbox ${this.sandboxId} not found`);
  }
  commands = {
    run: async (cmd: string, opts: { timeout?: number; workingDir?: string; env?: Record<string, string> } = {}) => {
      this.live();
      runs.push({ cmd, opts });
      if (runError) throw runError;
      const t0 = Date.now();
      const child = sh(cmd, opts.workingDir, { ...this.envVars, ...opts.env });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      const timeout = opts.timeout ?? 300;
      const timer = setTimeout(() => killGroup(child), timeout * 1000);
      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (c, signal) => resolve(c ?? (signal ? 137 : -1)));
      }).finally(() => clearTimeout(timer));
      if (Date.now() - t0 >= timeout * 1000) throw hopxError("CommandExecutionError", `Command timed out after ${timeout}s`, { code: "EXECUTION_TIMEOUT" });
      return { success: code === 0, stdout, stderr, exit_code: code, execution_time: (Date.now() - t0) / 1000 };
    },
  };
  runCodeStream(code: string, opts: { language?: string; timeout?: number; workingDir?: string; env?: Record<string, string> } = {}) {
    this.live();
    streams.push({ code, opts });
    if (opts.language !== "bash") throw new Error(`mock only runs bash, not ${opts.language}`);
    const child = sh(code, opts.workingDir, { ...this.envVars, ...opts.env });
    const queue: any[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (m: any) => (queue.push(m), wake?.());
    const stamp = () => new Date().toISOString();
    child.stdout!.on("data", (d) => push({ type: "stdout", data: String(d), timestamp: stamp() }));
    child.stderr!.on("data", (d) => push({ type: "stderr", data: String(d), timestamp: stamp() }));
    const timer = setTimeout(() => {
      killGroup(child);
      push({ type: "error", error: "Execution timed out", code: "EXECUTION_TIMEOUT", timestamp: stamp() });
      done = true;
      wake?.();
    }, (opts.timeout ?? 300) * 1000);
    child.on("close", (c) => {
      clearTimeout(timer);
      if (done) return;
      push({ type: "result", exit_code: c ?? -1, execution_time: 0, timestamp: stamp() });
      push({ type: "complete", success: c === 0 });
      done = true;
      wake?.();
    });
    return (async function* () {
      try {
        for (;;) {
          while (queue.length) yield queue.shift();
          if (done) return;
          await new Promise<void>((r) => (wake = r));
        }
      } finally {
        clearTimeout(timer);
        killGroup(child);
      }
    })();
  }
  files = {
    writeBytes: async (path: string, content: Buffer) => {
      this.live();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    readBytes: async (path: string) => {
      this.live();
      if (!existsSync(path)) throw hopxError("FileNotFoundError", `File not found: ${path}`);
      return readFileSync(path);
    },
  };
  pause = async () => {
    this.live();
    this.state = "paused";
  };
  kill = async () => {
    this.live();
    this.state = "killed";
    sandboxes.delete(this.sandboxId);
  };
}

vi.mock("@hopx-ai/sdk", () => ({
  Sandbox: {
    create: async (opts: any) => {
      creates.push(opts);
      if (createError) throw createError;
      const s = new FakeHopx(`hx_${++seq}`, opts.envVars);
      sandboxes.set(s.sandboxId, s);
      return s;
    },
    connect: async (id: string, apiKey?: string) => {
      connects.push([id, apiKey]);
      const s = sandboxes.get(id);
      if (!s) throw hopxError("NotFoundError", `Sandbox ${id} not found`);
      s.state = "running"; // connect resumes a paused sandbox
      return s;
    },
  },
}));

const { HopxProvider } = await import("../src/providers/hopx.js");
const p = () => new HopxProvider("hx_test");

beforeEach(() => {
  for (const a of [creates, connects, runs, streams]) a.length = 0;
  createError = runError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("hopx", { provider: p, dir: root });

describe("HopxProvider", () => {
  it("reports configured() from the key", () => {
    expect(new HopxProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto Sandbox.create: template by name or numeric id, lifetime in seconds, env", async () => {
    const sbx = await p().create({ image: { hopx: "my-tpl" }, timeoutMinutes: 10, env: { A: "1" }, vcpu: 8, memoryGb: 32 });
    expect(sbx.nativeId).toBe(`hx_${seq}`);
    // vCPU and memory come from the template, so they are not sent.
    expect(creates[0]).toEqual({ template: "my-tpl", apiKey: "hx_test", timeoutSeconds: 600, envVars: { A: "1" } });
    await p().create({ image: { hopx: "42" }, timeoutMinutes: 0.1 });
    expect(creates[1]).toEqual({ templateId: "42", apiKey: "hx_test", timeoutSeconds: 60, envVars: undefined });
    await p().create({});
    expect(creates[2]).toMatchObject({ template: "code-interpreter", timeoutSeconds: 1800 });
  });

  it("maps SDK errors to ProviderError with a status from statusCode or the error class", async () => {
    createError = hopxError("AuthenticationError", "Invalid API key");
    await expect(p().create({})).rejects.toMatchObject({ name: "ProviderError", provider: "hopx", status: 401, message: "hopx: Invalid API key" });
    createError = hopxError("APIError", "Too many", { statusCode: 429 });
    await expect(p().create({})).rejects.toMatchObject({ status: 429 });
    await expect(p().connect("hx_missing")).rejects.toMatchObject({ status: 404 });
    expect(connects.at(-1)).toEqual(["hx_missing", "hx_test"]);
  });

  it("runs without callbacks through commands.run with timeout, workingDir and env", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    const r = await sbx.exec('printf "%s %s %s" "$BASE" "$A" "$(basename "$PWD")"; exit 3', { cwd: root, env: { A: "1" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 3, stdout: `b 1 ${root.split("/").pop()}` });
    expect(runs.at(-1)!.opts).toEqual({ timeout: 7, workingDir: root, env: { A: "1" } });
    expect(streams).toHaveLength(0);
    runError = hopxError("TimeoutError", "Request timed out");
    await expect(sbx.exec("true", { timeoutSeconds: 2 })).rejects.toMatchObject({ message: "hopx: command timed out after 2s" });
    runError = hopxError("CommandExecutionError", "agent exploded");
    await expect(sbx.exec("true")).rejects.toMatchObject({ provider: "hopx", message: "hopx: agent exploded" });
  });

  it("streams through runCodeStream as bash and turns the agent's EXECUTION_TIMEOUT frame into the contract error", async () => {
    const sbx = await p().create({});
    const chunks: string[] = [];
    const r = await sbx.exec("echo one; echo two >&2; exit 4", { onStdout: (c) => chunks.push(c), cwd: root, env: { A: "1" }, timeoutSeconds: 9 });
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\n", stderr: "two\n" });
    expect(chunks).toEqual(["one\n"]);
    expect(streams.at(-1)!.opts).toEqual({ language: "bash", timeout: 9, workingDir: root, env: { A: "1" } });
    expect(runs).toHaveLength(0);

    const late = join(root, "stream-late");
    const t0 = Date.now();
    await expect(sbx.exec(`sleep 3; echo late > '${late}'`, { timeoutSeconds: 1, onStdout: () => {} })).rejects.toMatchObject({
      name: "ProviderError",
      message: "hopx: command timed out after 1s",
    });
    expect(Date.now() - t0).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(late)).toBe(false);
  }, 10_000);

  it("round-trips bytes and reports a missing file as 404", async () => {
    const sbx = await p().create({});
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) % 256);
    await sbx.writeFile(join(root, "d", "f.bin"), bytes);
    expect(Buffer.from(await sbx.readFile(join(root, "d", "f.bin"))).equals(Buffer.from(bytes))).toBe(true);
    await expect(sbx.readFile(join(root, "nope"))).rejects.toMatchObject({ provider: "hopx", status: 404 });
  });

  it("pauses, resumes through connect, and is gone after kill", async () => {
    const sbx = await p().create({});
    const fake = sandboxes.get(sbx.nativeId)!;
    await sbx.pause!();
    expect(fake.state).toBe("paused");
    const again = await p().connect(sbx.nativeId);
    expect(fake.state).toBe("running");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await sbx.kill();
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });
});
