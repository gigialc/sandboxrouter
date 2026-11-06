import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for `@beamcloud/beam-js` with the SDK's surface: a module-global beamOpts, `new
 * Sandbox(config).create()`, `Sandbox.connect(id)`, and instances whose processes really run in a
 * temp dir. Streams behave like SandboxProcessStream: async-iterable by line, `.read()` for all so far.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-beam-"));
const beamOpts = { token: "", workspaceId: "", gatewayUrl: "https://app.beam.cloud" };
const configs: Record<string, unknown>[] = [];
const execs: { cmd: string; opts: any }[] = [];
const terminated: string[] = [];
const connected: string[] = [];
let createError: unknown;

class FakeStream {
  buf = "";
  closed = false;
  read = async () => this.buf;
  async *[Symbol.asyncIterator]() {
    let sent = 0;
    for (;;) {
      const nl = this.buf.indexOf("\n", sent);
      if (nl >= 0) {
        yield this.buf.slice(sent, nl + 1);
        sent = nl + 1;
      } else if (this.closed) {
        if (sent < this.buf.length) yield this.buf.slice(sent);
        return;
      } else await new Promise((r) => setTimeout(r, 10));
    }
  }
}

class FakeProcess {
  pid = 42;
  private child: ChildProcess;
  private out = new FakeStream();
  private err = new FakeStream();
  private exit: Promise<number>;
  constructor(cmd: string, opts: any) {
    this.child = spawn("sh", ["-c", cmd], { cwd: opts?.cwd ?? root, env: { ...process.env, ...(opts?.env ?? {}) } });
    this.child.stdout!.on("data", (d) => (this.out.buf += d));
    this.child.stderr!.on("data", (d) => (this.err.buf += d));
    this.exit = new Promise((resolve) =>
      this.child.on("close", (code, signal) => {
        this.out.closed = this.err.closed = true;
        resolve(code ?? (signal ? 137 : 1));
      }),
    );
  }
  wait = () => this.exit;
  kill = async () => void this.child.kill("SIGKILL");
  get stdout() {
    return this.out;
  }
  get stderr() {
    return this.err;
  }
}

function instance(id: string) {
  return {
    containerId: id,
    execShell: async (cmd: string, opts: any) => {
      execs.push({ cmd, opts });
      return new FakeProcess(cmd, opts);
    },
    fs: {
      // Like the real upload, this fails when the parent directory is missing.
      writeBytes: async (path: string, content: Buffer) => writeFileSync(path, content),
      readBytes: async (path: string) => {
        try {
          return readFileSync(path);
        } catch {
          throw Object.assign(new Error("Failed to download file"), { name: "SandboxFileSystemError" });
        }
      },
    },
    terminate: async () => (terminated.push(id), true),
  };
}

vi.mock("@beamcloud/beam-js", () => ({
  beamOpts,
  Sandbox: class {
    constructor(private config: Record<string, unknown>) {}
    async create() {
      configs.push(this.config);
      if (createError) throw createError;
      return instance("sb-test1");
    }
    static async connect(id: string) {
      connected.push(id);
      if (id === "missing") throw Object.assign(new Error("Request failed with status code 404"), { response: { status: 404, data: { errorMsg: "container not found" } } });
      return instance(id);
    }
  },
  Image: { fromRegistry: (uri: string) => ({ baseImage: uri }) },
}));

const { BeamProvider } = await import("../src/providers/beam.js");
const p = () => new BeamProvider("bt_test", "ws_test");

beforeEach(() => {
  configs.length = 0;
  execs.length = 0;
  terminated.length = 0;
  connected.length = 0;
  createError = undefined;
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("BeamProvider", () => {
  it("needs both the token and the workspace id", () => {
    expect(new BeamProvider(undefined, "ws").configured()).toBe(false);
    expect(new BeamProvider("bt", undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto the Sandbox config and sets the SDK's global auth", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, image: { beam: "python:3.12-slim" }, gpu: "T4" });
    expect(sbx.nativeId).toBe("sb-test1");
    expect(beamOpts).toMatchObject({ token: "bt_test", workspaceId: "ws_test" });
    expect(configs[0]).toEqual({
      name: "sandboxrouter",
      cpu: 4,
      memory: 8192,
      keepWarmSeconds: 1200,
      env: { A: "1" },
      image: { baseImage: "python:3.12-slim" },
      gpu: "T4",
    });
  });

  it("uses router defaults and Beam's own image when the spec is empty", async () => {
    await p().create({});
    expect(configs[0]).toEqual({ name: "sandboxrouter", cpu: 2, memory: 4096, keepWarmSeconds: 1800, env: {} });
  });

  it("runs shell text with cwd and env, sandbox env underneath per-call env", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    const r = await sbx.exec(`echo "$BASE $OVER $(basename "$PWD")"; echo 'it''s err' >&2`, { cwd: "/tmp", env: { OVER: "new" } });
    expect(r).toMatchObject({ exitCode: 0, stdout: "b new tmp\n", stderr: "its err\n" });
    // Never wait: true, or the timeout could not start until the command had already finished.
    expect(execs.at(-1)!.opts).toEqual({ cwd: "/tmp", env: { BASE: "b", OVER: "new" }, wait: false });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("streams stdout and stderr line by line", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    expect(execs.at(-1)!.opts.wait).toBe(false);
  });

  it("kills a command that outlives its timeout", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.3 })).rejects.toMatchObject({ message: "beam: command timed out after 0.3s" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("round-trips files, creating a missing parent directory", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(execs.at(-1)!.cmd).toBe(`mkdir -p '${join(root, "nested", "dir")}'`);
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");

    const bin = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
    execs.length = 0;
    await sbx.writeFile(join(root, "bin"), bin);
    expect(execs).toHaveLength(0);
    const back = await sbx.readFile(join(root, "bin"));
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(back).equals(Buffer.from(bin))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "ProviderError" });
  });

  it("reconnects by id and terminates", async () => {
    const sbx = await p().connect("sb-old");
    expect(connected).toEqual(["sb-old"]);
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    await sbx.kill();
    expect(terminated).toEqual(["sb-old"]);
    expect(sbx.pause).toBeUndefined();
  });

  it("carries HTTP status and Beam's errorMsg into ProviderError", async () => {
    await expect(p().connect("missing")).rejects.toMatchObject({ status: 404, message: "beam: connect missing: container not found" });
    createError = Object.assign(new Error("Request failed with status code 401"), { response: { status: 401, data: {} } });
    await expect(p().create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("401") });
  });

  it("refuses to call Beam without credentials", async () => {
    await expect(new BeamProvider("bt", undefined).create({})).rejects.toThrow(/BEAM_WORKSPACE_ID/);
  });
});
