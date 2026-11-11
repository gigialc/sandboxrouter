import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for the `modal` SDK: `new ModalClient()` with `apps.fromName(name, { createIfMissing })`,
 * `images.fromRegistry(tag)`, `sandboxes.create(app, image, params)` and `sandboxes.fromId(id)`.
 * Sandboxes have `sandboxId`, `exec(["sh", "-c", cmd], { workdir, env, timeoutMs })` resolving to a
 * ContainerProcess-like `{ stdout, stderr, wait() }` whose outputs are ReadableStream<string>, a
 * `filesystem` with `writeBytes(bytes, path)` / `readBytes(path)` (SandboxFilesystemNotFoundError
 * for a missing file), and `terminate()`. Commands really run in a temp dir on top of the
 * sandbox's env; at `timeoutMs` the process is SIGKILLed and `wait()` resolves 137 (the signal
 * death Modal reports). `fromId` of a terminated sandbox still resolves, as Modal's does, and its
 * exec then fails. Writes create missing parent directories.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-modal-"));
const apps: any[] = [];
const images: string[] = [];
const creates: any[] = [];
const fromIds: string[] = [];
const execs: { command: string[]; params: any }[] = [];
const terminated: string[] = [];
const children = new Set<ChildProcess>();
const sandboxes = new Map<string, FakeSandbox>();
let signalCode: number | undefined; // when set, a killed process reports this instead of 137
let deadlineThrows = false; // newer SDKs: the deadline ends exec with a "Deadline exceeded" error
let execError: Error | undefined;

const killGroup = (c: ChildProcess) => {
  try {
    process.kill(-c.pid!, "SIGKILL");
  } catch {}
};

/** A ReadableStream<string> fed by a child's pipe, closed when the process ends. */
function textStream(src: NodeJS.ReadableStream, done: Promise<unknown>) {
  return new ReadableStream<string>({
    start(controller) {
      src.on("data", (d) => controller.enqueue(String(d)));
      // Like the SDK: a failed exec ends the output streams with its error.
      done.then(() => controller.close(), (err) => controller.error(err));
    },
  });
}

class FakeSandbox {
  alive = true;
  constructor(
    readonly sandboxId: string,
    private env: Record<string, string>,
  ) {}
  private live() {
    if (!this.alive) throw new Error(`Sandbox ${this.sandboxId} has already been terminated`);
  }
  async exec(command: string[], params: any = {}) {
    this.live();
    execs.push({ command, params });
    if (execError) throw execError;
    if (params.workdir && !existsSync(params.workdir)) throw new Error(`failed to exec: chdir ${params.workdir}: no such file or directory`);
    const child = spawn(command[0], command.slice(1), { cwd: params.workdir ?? root, env: { ...process.env, ...this.env, ...(params.env ?? {}) }, detached: true });
    children.add(child);
    let deadline = false;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          deadline = true;
          killGroup(child);
        }, params.timeoutMs)
      : undefined;
    const exit = new Promise<number>((resolve, reject) =>
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        if (deadline && deadlineThrows) return reject(new Error("Deadline exceeded while streaming stdio for exec 44aee20d"));
        resolve(code ?? (signal ? (signalCode ?? 128 + constants.signals[signal]) : -1));
      }),
    );
    return { stdout: textStream(child.stdout!, exit), stderr: textStream(child.stderr!, exit), wait: () => exit };
  }
  filesystem = {
    writeBytes: async (data: Uint8Array, path: string) => {
      this.live();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    readBytes: async (path: string) => {
      this.live();
      if (!existsSync(path)) throw Object.assign(new Error(`No such file or directory: ${path}`), { name: "SandboxFilesystemNotFoundError" });
      return new Uint8Array(readFileSync(path));
    },
  };
  async terminate() {
    terminated.push(this.sandboxId);
    this.alive = false;
  }
}

vi.mock("modal", () => ({
  ModalClient: class {
    apps = { fromName: async (name: string, params: any) => (apps.push({ name, params }), { name }) };
    images = { fromRegistry: (tag: string) => (images.push(tag), { tag }) };
    sandboxes = {
      create: async (app: any, image: any, params: any) => {
        creates.push({ app, image, params });
        if (params.gpu === "none-such") throw new Error("Invalid GPU type: none-such");
        const sb = new FakeSandbox(`sb-${sandboxes.size + 1}`, params.env ?? {});
        sandboxes.set(sb.sandboxId, sb);
        return sb;
      },
      fromId: async (id: string) => {
        fromIds.push(id);
        const sb = sandboxes.get(id);
        if (!sb) throw new Error(`Sandbox not found: ${id}`);
        return sb;
      },
    };
  },
}));

const { ModalProvider } = await import("../src/providers/modal.js");
const saved = { MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID, MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET };
const p = () => new ModalProvider();

beforeEach(() => {
  process.env.MODAL_TOKEN_ID = "ak-test";
  process.env.MODAL_TOKEN_SECRET = "as-test";
  apps.length = images.length = creates.length = fromIds.length = execs.length = terminated.length = 0;
  signalCode = execError = undefined;
  deadlineThrows = false;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("modal", { provider: p, dir: root });

describe("ModalProvider", () => {
  it("is configured by the token pair or a ~/.modal.toml", () => {
    expect(p().configured()).toBe(true);
    delete process.env.MODAL_TOKEN_SECRET;
    expect(p().configured()).toBe(existsSync(join(homedir(), ".modal.toml")));
  });

  it("creates in the sandboxrouter app from a registry image with physical cores, MiB, gpu, lifetime and env", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, gpu: "T4", timeoutMinutes: 20, env: { A: "1" }, image: { modal: "python:3.12-slim" } });
    expect(sbx.nativeId).toMatch(/^sb-\d+$/);
    expect(apps).toEqual([{ name: "sandboxrouter", params: { createIfMissing: true } }]);
    expect(images).toEqual(["python:3.12-slim"]);
    // Modal's cpu counts physical cores (1 core = 2 vCPUs), so the spec's vCPUs are halved.
    expect(creates[0]).toEqual({ app: { name: "sandboxrouter" }, image: { tag: "python:3.12-slim" }, params: { cpu: 2, memoryMiB: 8192, gpu: "T4", timeoutMs: 1_200_000, env: { A: "1" } } });
    await p().create({});
    expect(images[1]).toBe("python:3.13-slim");
    expect(creates[1].params).toEqual({ cpu: 1, memoryMiB: 4096, gpu: undefined, timeoutMs: 1_800_000, env: undefined });
    expect(sbx.pause).toBeUndefined();
  });

  it("execs `sh -c` with workdir, env and timeoutMs, sandbox env underneath", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    const r = await sbx.exec(`echo "$BASE $OVER $(basename "$PWD")"; echo err >&2`, { cwd: root, env: { OVER: "new" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 0, stdout: `b new ${root.split("/").pop()}\n`, stderr: "err\n" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(execs[0]).toEqual({ command: ["sh", "-c", `echo "$BASE $OVER $(basename "$PWD")"; echo err >&2`], params: { workdir: root, env: { OVER: "new" }, timeoutMs: 7000 } });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
    expect(execs[1].params).toEqual({ workdir: undefined, env: undefined, timeoutMs: 60_000 });
  });

  it("treats a signal death at the deadline as the timeout, whether reported as 137 or negative", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "modal: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    signalCode = -9;
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ message: "modal: command timed out after 0.5s" });
    // Exit 137 well before the deadline is the command's own result.
    expect((await sbx.exec("exit 137", { timeoutSeconds: 5 })).exitCode).toBe(137);
  });

  it("treats a \"Deadline exceeded\" error at the deadline as the timeout", async () => {
    const sbx = await p().create({});
    deadlineThrows = true;
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "modal: command timed out after 0.5s" });
  });

  it("wraps SDK failures in ProviderError", async () => {
    const sbx = await p().create({});
    execError = new Error("Sandbox has already been terminated");
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", message: "modal: Sandbox has already been terminated" });
    await expect(p().create({ gpu: "none-such" })).rejects.toThrow("Invalid GPU type");
    await expect(p().connect("sb-nope")).rejects.toThrow("Sandbox not found: sb-nope");
    // readFile passes the SDK's filesystem error through unchanged.
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "SandboxFilesystemNotFoundError" });
  });

  it("reconnects with sandboxes.fromId and terminates on kill", async () => {
    const created = await p().create({});
    const sbx = await p().connect(created.nativeId);
    expect(fromIds).toEqual([created.nativeId]);
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    await sbx.kill();
    expect(terminated).toEqual([created.nativeId]);
    await expect(sbx.exec("true")).rejects.toMatchObject({ name: "ProviderError", message: expect.stringContaining("terminated") });
  });
});
