import { spawn } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DenoProvider, type DenoSdk } from "../src/providers/deno.js";

/**
 * Deno Sandbox is only reachable through `@deno/sandbox` (its WebSocket RPC is SDK-private), so
 * the contract is the SDK surface documented at https://docs.deno.com/sandbox/ and in the
 * package's typings (0.13.2): Sandbox.create/connect options, spawn() with piped web streams and a
 * status promise, fs.writeFile/readFile/mkdir, kill(). This fake runs commands for real in a temp
 * dir and records every call.
 */
let root = "";
const calls: [string, any][] = [];

function fakeSandbox(id: string) {
  return {
    id,
    async spawn(command: string, options: any) {
      calls.push(["spawn", { command, ...options }]);
      const child = spawn(command, options.args, { cwd: options.cwd ?? root, env: { ...process.env, ...(options.env ?? {}) } });
      const status = new Promise<{ code: number; signal: string | null; success: boolean }>((resolve) =>
        // Like the Deno SDK: a signal death has a negative code (minus the signal number) and the signal's name.
        child.on("close", (code, signal) => resolve({ code: code ?? -(osConstants.signals[signal!] ?? 0), signal, success: code === 0 })),
      );
      return {
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        status,
        async kill(signal?: string) {
          calls.push(["child.kill", signal]);
          child.kill(signal as NodeJS.Signals);
        },
      };
    },
    fs: {
      async writeFile(path: string, data: Uint8Array) {
        calls.push(["fs.writeFile", path]);
        await fs.writeFile(path, data);
      },
      async readFile(path: string) {
        calls.push(["fs.readFile", path]);
        try {
          return new Uint8Array(await fs.readFile(path));
        } catch {
          throw Object.assign(new Error(`No such file or directory (os error 2): readfile '${path}'`), { name: "NotFound" });
        }
      },
      async mkdir(path: string, options: any) {
        calls.push(["fs.mkdir", { path, ...options }]);
        await fs.mkdir(path, options);
      },
    },
    async kill() {
      calls.push(["kill", id]);
    },
    async close() {
      calls.push(["close", id]);
    },
  };
}

const fake: DenoSdk = {
  Sandbox: {
    async create(options: any) {
      calls.push(["create", options]);
      if (options.token === "ddo_bad") throw Object.assign(new Error("Invalid token"), { name: "ConnectionEstablishmentError", status: 401, code: "UNAUTHORIZED" });
      return fakeSandbox("sbx_ord_abc123");
    },
    async connect(options: any) {
      calls.push(["connect", options]);
      if (options.id !== "sbx_ord_abc123") throw Object.assign(new Error("Sandbox not found"), { name: "ConnectionEstablishmentError", status: 404 });
      return fakeSandbox(options.id);
    },
  },
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sbr-deno-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DenoProvider", () => {
  const p = (token = "ddo_test", org?: string) => new DenoProvider(token, org, "ams", async () => fake);

  it("creates with a duration timeout, memory, env, labels and root image", async () => {
    calls.length = 0;
    const sbx = await p().create({ vcpu: 2, memoryGb: 2, timeoutMinutes: 20, env: { A: "1" }, metadata: { run: "r1" }, image: { deno: "my-snapshot" } });
    expect(sbx.nativeId).toBe("sbx_ord_abc123");
    expect(calls[0]).toEqual([
      "create",
      { token: "ddo_test", memory: "2048MiB", timeout: "20m", region: "ams", env: { A: "1" }, labels: { run: "r1" }, root: "my-snapshot" },
    ]);
  });

  it("clamps memory and lifetime to Deno's limits and rejects what cannot fit", async () => {
    calls.length = 0;
    await p().create({ memoryGb: 0.5, timeoutMinutes: 120 });
    expect(calls[0][1]).toMatchObject({ memory: "768MiB", timeout: "30m" });
    await p().create({});
    expect(calls[1][1]).toMatchObject({ memory: "4096MiB", timeout: "30m" });
    await expect(p().create({ vcpu: 4 })).rejects.toThrow(/2 vCPU/);
    await expect(p().create({ memoryGb: 8 })).rejects.toThrow(/at most 4096 MB/);
  });

  it("passes the org with a personal token and reports configured()", async () => {
    calls.length = 0;
    await p("ddp_me", "acme").create({});
    expect(calls[0][1]).toMatchObject({ token: "ddp_me", org: "acme" });
    expect(new DenoProvider(undefined, undefined).configured()).toBe(false);
    expect(new DenoProvider("ddp_me", undefined).configured()).toBe(false);
    expect(new DenoProvider("ddp_me", "acme").configured()).toBe(true);
    expect(p().configured()).toBe(true);
  });

  it("surfaces SDK errors with their status", async () => {
    await expect(p("ddo_bad").create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("Invalid token") });
    await expect(p().connect("sbx_ord_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("runs commands through /bin/sh with env and cwd", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('echo "$GREETING from $(basename "$PWD")"; echo err >&2', { env: { GREETING: "it's me" }, cwd: "/tmp" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "it's me from tmp\n", stderr: "err\n" });
    expect(calls.filter((c) => c[0] === "spawn").at(-1)![1]).toMatchObject({
      command: "/bin/sh",
      args: ["-c", expect.any(String)],
      cwd: "/tmp",
      env: { GREETING: "it's me" },
      stdout: "piped",
      stderr: "piped",
    });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("streams stdout and stderr chunks as they happen", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
  });

  it("reports a signal death the way a shell would, as 128 plus the signal number", async () => {
    const sbx = await p().create({});
    expect((await sbx.exec("kill -9 $$")).exitCode).toBe(137);
    expect((await sbx.exec("kill -TERM $$")).exitCode).toBe(143);
  });

  it("kills a command that outlives its timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.3 })).rejects.toThrow(/timed out after 0.3s/);
    expect(calls.some((c) => c[0] === "child.kill" && c[1] === "SIGKILL")).toBe(true);
  });

  it("round-trips text and binary files, creating parent directories", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(calls).toContainEqual(["fs.mkdir", { path: join(root, "nested", "dir"), recursive: true }]);
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");
    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("reconnects by id and kills", async () => {
    calls.length = 0;
    const sbx = await p().connect("sbx_ord_abc123");
    expect(calls[0]).toEqual(["connect", { token: "ddo_test", id: "sbx_ord_abc123" }]);
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    await sbx.kill();
    expect(calls.at(-1)).toEqual(["kill", "sbx_ord_abc123"]);
  });

  it("explains how to install the SDK when it is missing", async () => {
    await expect(new DenoProvider("ddo_test").create({})).rejects.toThrow(/npm i @deno\/sandbox/);
  });
});
