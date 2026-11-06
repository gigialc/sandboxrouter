import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@daytonaio/sdk` (0.227) with the surface DaytonaProvider/DaytonaBox use:
 * `new Daytona({apiKey})`, `create(params)` (CreateSandboxFromSnapshotParams / FromImageParams),
 * `get(id)` (throws once deleted) and sandboxes whose `process` sessions really run commands with
 * `sh -c` in a temp dir: createSession, executeSessionCommand({command, runAsync}) -> {cmdId},
 * getSessionCommandLogs(session, cmdId, onStdout, onStderr) (resolves when the command ends),
 * getSessionCommand -> {id, command, exitCode}, deleteSession (ends the session's running
 * commands, as the real one does); `executeCommand(command, cwd, env, timeout)` -> {exitCode, result}
 * with stdout and stderr merged into `result`, which stops the command at its timeout and throws a
 * 408 DaytonaProcessExecutionTimeoutError, as the real one does (checked against a real account);
 * `fs.uploadFile(Buffer, path)` / `fs.downloadFile(path)`;
 * `setAutoDeleteInterval`, `stop`, `start`, `delete`, `state`. The desktop side (computerUse) is
 * covered by daytona-desktop.test.ts.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-daytona-"));
const configs: unknown[] = [];
const created: any[] = [];
const calls: [string, ...unknown[]][] = [];
const live = new Map<string, FakeSandbox>();
const children: ChildProcess[] = [];
let createError: Error | undefined;
let nextId = 1;

const killGroup = (c: ChildProcess) => {
  if (c.pid && c.exitCode === null && c.signalCode === null) try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
};

interface Cmd {
  child: ChildProcess;
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  done: Promise<void>;
}

class FakeSandbox {
  readonly id = `sbx-${nextId++}`;
  state = "started";
  autoDeleteInterval = 0;
  private sessions = new Map<string, Map<string, Cmd>>();
  constructor(readonly params: any) {}

  private alive() {
    if (!live.has(this.id)) throw new Error(`Sandbox with ID ${this.id} not found`);
    if (this.state !== "started") throw new Error(`Sandbox ${this.id} is ${this.state}`);
  }
  private cmd(session: string, cmdId: string): Cmd {
    const c = this.sessions.get(session)?.get(cmdId);
    if (!c) throw new Error(`Command ${cmdId} not found in session ${session}`);
    return c;
  }

  process = {
    createSession: async (session: string) => {
      this.alive();
      calls.push(["createSession", this.id, session]);
      if (this.sessions.has(session)) throw new Error(`Session ${session} already exists`);
      this.sessions.set(session, new Map());
    },
    executeSessionCommand: async (session: string, req: { command: string; runAsync?: boolean }) => {
      this.alive();
      calls.push(["executeSessionCommand", session, req]);
      const sess = this.sessions.get(session);
      if (!sess) throw new Error(`Session ${session} not found`);
      const child = spawn("sh", ["-c", req.command], { cwd: root, env: { ...process.env, ...(this.params.envVars ?? {}) }, detached: true });
      children.push(child);
      const cmd: Cmd = { child, command: req.command, stdout: "", stderr: "", done: undefined as any };
      cmd.done = new Promise<void>((r) =>
        child.on("close", (code, signal) => {
          cmd.exitCode = code ?? (signal ? 137 : -1);
          r();
        }),
      );
      child.stdout!.on("data", (d) => (cmd.stdout += d));
      child.stderr!.on("data", (d) => (cmd.stderr += d));
      const cmdId = randomUUID();
      sess.set(cmdId, cmd);
      if (!req.runAsync) {
        await cmd.done;
        return { cmdId, exitCode: cmd.exitCode, output: cmd.stdout + cmd.stderr, stdout: cmd.stdout, stderr: cmd.stderr };
      }
      return { cmdId };
    },
    getSessionCommandLogs: async (session: string, cmdId: string, onStdout?: (c: string) => void, onStderr?: (c: string) => void) => {
      const cmd = this.cmd(session, cmdId);
      if (!onStdout) {
        await cmd.done;
        return { stdout: cmd.stdout, stderr: cmd.stderr, output: cmd.stdout + cmd.stderr };
      }
      // Everything written so far, then live chunks until the command ends.
      if (cmd.stdout) onStdout(cmd.stdout);
      if (cmd.stderr) onStderr?.(cmd.stderr);
      cmd.child.stdout!.on("data", (d) => onStdout(String(d)));
      cmd.child.stderr!.on("data", (d) => onStderr?.(String(d)));
      await cmd.done;
    },
    getSessionCommand: async (session: string, cmdId: string) => {
      const cmd = this.cmd(session, cmdId);
      return { id: cmdId, command: cmd.command, exitCode: cmd.exitCode };
    },
    deleteSession: async (session: string) => {
      calls.push(["deleteSession", this.id, session]);
      const sess = this.sessions.get(session);
      if (!sess) throw new Error(`Session ${session} not found`);
      for (const c of sess.values()) killGroup(c.child);
      this.sessions.delete(session);
    },
    executeCommand: async (command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => {
      this.alive();
      calls.push(["executeCommand", command, cwd, env, timeout]);
      const child = spawn("sh", ["-c", command], { cwd: cwd ?? root, env: { ...process.env, ...(this.params.envVars ?? {}), ...(env ?? {}) }, detached: true });
      children.push(child);
      let result = "";
      child.stdout!.on("data", (d) => (result += d));
      child.stderr!.on("data", (d) => (result += d));
      const code = await new Promise<number | "timeout">((resolve) => {
        const timer = timeout ? setTimeout(() => (killGroup(child), resolve("timeout")), timeout * 1000) : undefined;
        child.on("close", (c, signal) => (clearTimeout(timer), resolve(c ?? (signal ? 137 : -1))));
      });
      if (code === "timeout") throw Object.assign(new Error("command execution timeout"), { name: "DaytonaProcessExecutionTimeoutError", statusCode: 408 });
      return { exitCode: code, result };
    },
  };

  fs = {
    uploadFile: async (file: Buffer, remotePath: string) => {
      this.alive();
      mkdirSync(dirname(remotePath), { recursive: true });
      writeFileSync(remotePath, file);
    },
    downloadFile: async (remotePath: string) => {
      this.alive();
      try {
        return readFileSync(remotePath);
      } catch {
        throw new Error(`File not found: ${remotePath}`);
      }
    },
  };

  private endSessions() {
    for (const s of this.sessions.values()) for (const c of s.values()) killGroup(c.child);
    this.sessions.clear();
  }
  async setAutoDeleteInterval(interval: number) {
    calls.push(["setAutoDeleteInterval", this.id, interval]);
    this.autoDeleteInterval = interval;
  }
  async stop() {
    calls.push(["stop", this.id]);
    this.endSessions();
    this.state = "stopped";
  }
  async start(timeout?: number) {
    calls.push(["start", this.id, timeout]);
    this.state = "started";
  }
  async waitUntilStarted(timeout?: number) {
    calls.push(["waitUntilStarted", this.id, timeout]);
    this.state = "started";
  }
  /** What refreshData() will see next, for a sandbox caught mid-transition. */
  nextStates: string[] = [];
  async delete() {
    calls.push(["delete", this.id]);
    this.endSessions();
    this.state = "destroyed";
    live.delete(this.id);
  }
  async refreshData() {
    calls.push(["refreshData", this.id]);
    const next = this.nextStates.shift();
    if (next) this.state = next;
  }
}

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    constructor(config: unknown) {
      configs.push(config);
    }
    async create(params: unknown) {
      created.push(params);
      if (createError) throw createError;
      const s = new FakeSandbox(params);
      live.set(s.id, s);
      return s;
    }
    async get(id: string) {
      calls.push(["get", id]);
      const s = live.get(id);
      if (!s) throw new Error(`Sandbox with ID ${id} not found`);
      return s;
    }
  },
}));

const { DaytonaProvider } = await import("../src/providers/daytona.js");
const p = () => new DaytonaProvider("dtn_test");
const sdk = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  configs.length = 0;
  createError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("daytona", { provider: p, dir: root });

describe("DaytonaProvider", () => {
  it("reports configured() from the API key and hands it to the SDK client", async () => {
    expect(new DaytonaProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
    await (await p().create({})).kill();
    expect(configs).toEqual([{ apiKey: "dtn_test" }]);
  });

  it("maps the spec onto create params: snapshot by default, image plus resources when asked", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, metadata: { team: "x" }, image: { daytona: "python:3.12" } });
    expect(created[0]).toEqual({
      envVars: { A: "1" },
      labels: { team: "x" },
      autoStopInterval: 20,
      autoDeleteInterval: 1,
      image: "python:3.12",
      resources: { cpu: 4, memory: 8 },
    });
    expect((await sbx.exec("echo $A")).stdout).toBe("1\n");
    await sbx.kill();
    await (await p().create({})).kill();
    expect(created[1]).toEqual({ autoStopInterval: 30, autoDeleteInterval: 1 });
    expect(created[1]).not.toHaveProperty("image");
    await (await p().create({ timeoutMinutes: 0.2 })).kill();
    expect(created[2].autoStopInterval).toBe(1);
    createError = new Error("Insufficient resources in the organization's quota");
    await expect(p().create({})).rejects.toThrow(/quota/);
  });

  it("runs a plain command with executeCommand, stderr through a temp file, cwd and env wrapped in", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('printf "%s %s" "$X" "$(pwd)"; printf oops >&2; exit 3', { cwd: root, env: { X: "y" } });
    expect(r).toMatchObject({ exitCode: 3, stdout: `y ${root}`, stderr: "oops" });
    const [[command, cwd, env, timeout]] = sdk("executeCommand");
    expect(command).toMatch(new RegExp(`^\\{\\ncd '${root}' && export X='y' && \\{\\n\\(\\n[^]*\\n\\)\\n\\}\\n\\} 2>/tmp/sbr-stderr-[0-9a-f-]{36}$`));
    // Daytona's own cwd/env params are left unset; the timeout is Daytona's to enforce.
    expect([cwd, env, timeout]).toEqual([undefined, undefined, 60]);
    // No session for a plain command (session logs add a newline to output that lacks one).
    expect(sdk("createSession")).toEqual([]);
    // The stderr file is removed afterwards.
    await new Promise((res) => setTimeout(res, 100));
    expect(sdk("executeCommand").at(-1)![0]).toMatch(/^rm -f \/tmp\/sbr-stderr-/);
    await sbx.kill();
  });

  it("maps Daytona's own timeout (408) onto the contract's error", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "daytona: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    await sbx.kill();
  });

  it("streams through a throwaway session, in a subshell, and enforces its deadline by deleting the session", async () => {
    const sbx = await p().create({});
    const out: string[] = [];
    const r = await sbx.exec("echo a; exit 3", { cwd: root, env: { X: "y" }, onStdout: (c) => out.push(c) });
    expect(r).toMatchObject({ exitCode: 3, stdout: "a\n" });
    expect(out.join("")).toBe("a\n");
    const [session] = sdk("createSession").map((c) => c[1]);
    expect(session).toMatch(/^sbr-[0-9a-f-]{36}$/);
    expect(sdk("executeSessionCommand")).toEqual([[session, { command: `cd '${root}' && export X='y' && {\n(\necho a; exit 3\n)\n}`, runAsync: true }]]);
    expect(sdk("deleteSession")).toEqual([[sbx.nativeId, session]]);

    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5, onStdout: () => {} })).rejects.toMatchObject({ name: "ProviderError", message: "daytona: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sdk("deleteSession")).toHaveLength(2);
    const child = children.at(-1)!;
    await new Promise((res) => setTimeout(res, 200));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await sbx.kill();
  });

  it("wraps SDK failures during exec in ProviderError", async () => {
    const sbx = await p().create({});
    live.get(sbx.nativeId)!.state = "stopped";
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", message: `daytona: Sandbox ${sbx.nativeId} is stopped` });
    live.get(sbx.nativeId)!.state = "started";
    await expect(sbx.readFile(join(root, "missing"))).rejects.toThrow(/File not found/);
    await sbx.kill();
  });

  it("connect starts a sandbox Daytona archived or paused on its own, waiting longer for an archived one", async () => {
    const sbx = await p().create({});
    const fake = live.get(sbx.nativeId)!;
    // Archived: the disk comes back from storage, which can take minutes.
    fake.state = "archived";
    calls.length = 0;
    expect((await (await p().connect(sbx.nativeId)).exec("echo back")).stdout.trim()).toBe("back");
    expect(calls.slice(0, 2)).toEqual([["get", sbx.nativeId], ["start", sbx.nativeId, 600]]);
    // Paused: a plain start.
    fake.state = "paused";
    calls.length = 0;
    await p().connect(sbx.nativeId);
    expect(calls).toEqual([["get", sbx.nativeId], ["start", sbx.nativeId, 60]]);
    // Caught mid-transition: wait for the state to settle, then start.
    fake.state = "stopping";
    fake.nextStates = ["stopping", "stopped"];
    calls.length = 0;
    await p().connect(sbx.nativeId);
    expect(calls).toEqual([["get", sbx.nativeId], ["refreshData", sbx.nativeId], ["refreshData", sbx.nativeId], ["start", sbx.nativeId, 60]]);
    // Already starting (another client woke it): wait for that instead of a second start.
    fake.state = "resuming";
    calls.length = 0;
    await p().connect(sbx.nativeId);
    expect(calls).toEqual([["get", sbx.nativeId], ["waitUntilStarted", sbx.nativeId, 600]]);
    // Gone for good: a clear error, not a start that cannot work.
    fake.state = "error";
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ name: "ProviderError", message: `daytona: sandbox ${sbx.nativeId} is in state "error" and cannot be started` });
    fake.state = "started";
    await sbx.kill();
  }, 15_000);

  it("pause stops the sandbox but keeps its disk; connect starts a stopped one; kill deletes", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(calls).toEqual([["setAutoDeleteInterval", sbx.nativeId, -1], ["stop", sbx.nativeId]]);
    expect(live.get(sbx.nativeId)!.state).toBe("stopped");
    calls.length = 0;
    const again = await p().connect(sbx.nativeId);
    expect(again.nativeId).toBe(sbx.nativeId);
    expect(calls).toEqual([["get", sbx.nativeId], ["start", sbx.nativeId, 60]]);
    calls.length = 0;
    await p().connect(sbx.nativeId);
    expect(calls).toEqual([["get", sbx.nativeId]]);
    calls.length = 0;
    await again.kill();
    expect(calls).toEqual([["delete", sbx.nativeId]]);
    await expect(p().connect(sbx.nativeId)).rejects.toThrow(`Sandbox with ID ${sbx.nativeId} not found`);
  });
});
