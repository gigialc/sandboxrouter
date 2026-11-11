import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@fly/sprites`: `new SpritesClient(token)`, `createSprite(name, { config: { cpus,
 * ramMB }, environment })`, `getSprite(name)`, and a Sprite with `name`, `spawn(command, args,
 * { cwd, env })` returning a SpriteCommand-like EventEmitter (stdout/stderr Readables, "exit" with
 * the code, "error", `kill(signal)`, `close()`), `filesystem().writeFile(path, Buffer)` /
 * `readFile(path, null)` and `delete()`.
 *
 * Spawned commands really run in a temp dir with the sprite's environment under the per-call env.
 * `kill("SIGKILL")` kills the process group. API failures carry `statusCode` like the SDK's
 * APIError; a deleted sprite is 404 to getSprite and errors any spawn.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-sprites-"));
const children = new Set<ChildProcess>();
const tokens: string[] = [];
const creates: { name: string; options: any }[] = [];
const gets: string[] = [];
const spawns: { command: string; args: string[]; options: any }[] = [];
const kills: string[] = [];
const deletes: string[] = [];
const sprites = new Map<string, FakeSprite>();
let createError: unknown;

const apiError = (statusCode: number, message: string) => Object.assign(new Error(message), { name: "APIError", statusCode });
const killGroup = (child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") => {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {}
};

class FakeCommand extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  private child?: ChildProcess;
  constructor(sprite: FakeSprite, command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    super();
    if (!sprites.has(sprite.name)) {
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      setImmediate(() => this.emit("error", apiError(404, `sprite ${sprite.name} not found`)));
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: { ...process.env, ...sprite.environment, ...options.env }, detached: true });
    this.child = child;
    children.add(child);
    this.stdout = child.stdout!;
    this.stderr = child.stderr!;
    child.on("error", (e) => this.emit("error", e));
    child.on("close", (code, signal) => {
      children.delete(child);
      this.emit("exit", code ?? (signal ? 137 : -1));
    });
  }
  private exited = false;
  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "exit") {
      if (this.exited) return false;
      this.exited = true;
    }
    return super.emit(event, ...args);
  }
  kill(signal = "SIGTERM") {
    kills.push(signal);
    if (this.child) killGroup(this.child, signal as NodeJS.Signals);
  }
  // Like the SDK: closing the connection ends the command at once, reported as exit -1.
  close() {
    this.emit("exit", -1);
  }
}

class FakeSprite {
  constructor(
    readonly name: string,
    readonly environment: Record<string, string> = {},
  ) {}
  spawn(command: string, args: string[] = [], options?: any) {
    spawns.push({ command, args, options });
    return new FakeCommand(this, command, args, options);
  }
  filesystem() {
    return {
      writeFile: async (path: string, data: Buffer) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
      },
      readFile: async (path: string, encoding: null) => {
        if (encoding !== null) throw new Error("mock expects a null encoding for bytes");
        try {
          return readFileSync(path);
        } catch {
          throw apiError(404, `${path}: no such file`);
        }
      },
    };
  }
  async delete() {
    deletes.push(this.name);
    if (!sprites.delete(this.name)) throw apiError(404, `sprite ${this.name} not found`);
  }
}

vi.mock("@fly/sprites", () => ({
  Sprite: FakeSprite,
  SpritesClient: class {
    constructor(token: string) {
      tokens.push(token);
    }
    async createSprite(name: string, options: any) {
      creates.push({ name, options });
      if (createError) throw createError;
      const s = new FakeSprite(name, options?.environment);
      sprites.set(name, s);
      return s;
    }
    async getSprite(name: string) {
      gets.push(name);
      const s = sprites.get(name);
      if (!s) throw apiError(404, `sprite ${name} not found`);
      return s;
    }
  },
}));

const { SpritesProvider } = await import("../src/providers/sprites.js");
const p = () => new SpritesProvider("sp_test");

beforeEach(() => {
  for (const a of [tokens, creates, gets, spawns, kills, deletes]) a.length = 0;
  createError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("sprites", { provider: p, dir: root });

describe("SpritesProvider", () => {
  it("reports configured() from the token", () => {
    expect(new SpritesProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("creates a named sprite with cpus, ramMB and environment from the spec", async () => {
    const sbx = await p().create({ vcpu: 2, memoryGb: 4, env: { A: "1" }, timeoutMinutes: 5, metadata: { k: "v" } });
    expect(tokens).toEqual(["sp_test"]);
    expect(sbx.nativeId).toMatch(/^sbr-[0-9a-f-]{12}$/);
    // No lifetime or metadata knobs on a sprite; vCPU and GB map to cpus and MB.
    expect(creates[0]).toEqual({ name: sbx.nativeId, options: { config: { cpus: 2, ramMB: 4096 }, environment: { A: "1" } } });
    await p().create({});
    expect(creates[1].options).toEqual({ config: { cpus: undefined, ramMB: undefined }, environment: undefined });
  });

  it("carries the SDK's statusCode into ProviderError", async () => {
    createError = apiError(402, "payment required");
    await expect(p().create({})).rejects.toMatchObject({ name: "ProviderError", provider: "sprites", status: 402, message: "sprites: payment required" });
    await expect(p().connect("sbr-missing")).rejects.toMatchObject({ status: 404 });
    expect(gets).toEqual(["sbr-missing"]);
  });

  it("spawns `sh -c` with cwd and env (sprite.exec would split on whitespace), sprite env underneath", async () => {
    const sbx = await p().create({ env: { BASE: "b", OVER: "old" } });
    const r = await sbx.exec(`printf "%s %s %s" "$BASE" "$OVER" "$(basename "$PWD")"; echo 'it''s err' >&2; exit 5`, { cwd: root, env: { OVER: "new" } });
    expect(r).toMatchObject({ exitCode: 5, stdout: `b new ${root.split("/").pop()}`, stderr: "its err\n" });
    expect(spawns.at(-1)).toEqual({
      command: "sh",
      args: ["-c", `printf "%s %s %s" "$BASE" "$OVER" "$(basename "$PWD")"; echo 'it''s err' >&2; exit 5`],
      options: { cwd: root, env: { OVER: "new" } },
    });
  });

  it("SIGKILLs a command that outlives its timeout", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.5 })).rejects.toMatchObject({ name: "ProviderError", message: "sprites: command timed out after 0.5s" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(kills).toEqual(["SIGKILL"]);
  });

  it("moves bytes through the sprite filesystem and wraps a missing file", async () => {
    const sbx = await p().create({});
    const bytes = new Uint8Array(512).map((_, i) => (i * 13) % 256);
    await sbx.writeFile(join(root, "fs", "a.bin"), bytes);
    const back = await sbx.readFile(join(root, "fs", "a.bin"));
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    await expect(sbx.readFile(join(root, "nope"))).rejects.toMatchObject({ provider: "sprites", message: expect.stringContaining("no such file") });
  });

  it("has no pause; kill deletes the sprite so it cannot be reached again", async () => {
    const sbx = await p().create({});
    expect(sbx.pause).toBeUndefined();
    const same = await p().connect(sbx.nativeId);
    expect((await same.exec("echo hi")).stdout).toBe("hi\n");
    await sbx.kill();
    expect(deletes).toEqual([sbx.nativeId]);
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
    await expect(same.exec("echo zombie")).rejects.toMatchObject({ provider: "sprites" });
  });
});
