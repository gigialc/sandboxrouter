import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for `@codesandbox/sdk`: `new CodeSandbox(key).sandboxes.{create,resume,hibernate,
 * shutdown,delete}`, `sandbox.connect()` -> client with `commands.runBackground` and `fs`. Commands
 * really run through bash with HOME in a temp dir, so the adapter's redirect-to-files exec, env
 * file and polling are exercised end to end. Like the real Command, waitUntilComplete rejects with
 * a CommandError carrying `exitCode` when the exit is nonzero, and with exitCode 1 when killed.
 */
const home = mkdtempSync(join(tmpdir(), "sbr-csb-home-"));
const root = mkdtempSync(join(tmpdir(), "sbr-csb-"));
const calls: [string, ...unknown[]][] = [];
const lines: string[] = [];
let sessions = 0;

class CommandError extends Error {
  constructor(
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(`Command failed with exit code ${exitCode}`);
    this.name = "CommandError";
  }
}

function client(id: string) {
  sessions++;
  return {
    commands: {
      runBackground: async (line: string) => {
        lines.push(line);
        const child = spawn("bash", ["-c", line], { env: { ...process.env, HOME: home } });
        let killed = false;
        const exit = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
        return {
          waitUntilComplete: async () => {
            const code = await exit;
            if (killed) throw new CommandError(1, "");
            if (code !== 0) throw new CommandError(code, "pty output");
            return "pty output";
          },
          kill: async () => {
            killed = true;
            calls.push(["command.kill", id]);
            child.kill("SIGKILL");
          },
        };
      },
    },
    fs: {
      writeFile: async (path: string, content: Uint8Array, opts: unknown) => {
        calls.push(["fs.writeFile", path, opts]);
        writeFileSync(path, content);
      },
      readFile: async (path: string) => new Uint8Array(readFileSync(path)),
      mkdir: async (path: string, recursive: boolean) => {
        calls.push(["fs.mkdir", path, recursive]);
        mkdirSync(path, { recursive });
      },
      remove: async (path: string, recursive: boolean) => rmSync(path, { recursive, force: true }),
    },
    disconnect: async () => void calls.push(["disconnect", id]),
  };
}

const sandbox = (id: string) => ({ id, connect: async () => client(id) });

vi.mock("@codesandbox/sdk", () => ({
  CodeSandbox: class {
    constructor(key: string, opts: unknown) {
      calls.push(["CodeSandbox", key, opts]);
    }
    sandboxes = {
      create: async (opts: unknown) => (calls.push(["create", opts]), sandbox("csb-1")),
      resume: async (id: string) => {
        calls.push(["resume", id]);
        if (id === "gone") throw Object.assign(new Error("Sandbox not found"), { status: 404 });
        return sandbox(id);
      },
      hibernate: async (id: string) => void calls.push(["hibernate", id]),
      shutdown: async (id: string) => void calls.push(["shutdown", id]),
      delete: async (id: string) => void calls.push(["delete", id]),
    };
  },
  VMTier: { fromName: (name: string) => ({ name }) },
}));

const { CodeSandboxProvider, codesandboxTier, CODESANDBOX_TIERS } = await import("../src/providers/codesandbox.js");
const p = () => new CodeSandboxProvider("csb_test");
const called = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  sessions = 0;
  rmSync(join(home, ".sandboxrouter.env"), { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("codesandboxTier", () => {
  it("picks the smallest tier that fits, Pico only when both documented specs fit", () => {
    expect(codesandboxTier(2, 4).name).toBe("Nano");
    expect(codesandboxTier(1, 1).name).toBe("Pico");
    expect(codesandboxTier(1, 2).name).toBe("Nano");
    expect(codesandboxTier(2, 1).name).toBe("Pico");
    expect(codesandboxTier(3, 4).name).toBe("Micro");
    expect(codesandboxTier(8, 17).name).toBe("Medium");
    expect(codesandboxTier(200, 1).name).toBe("XLarge");
    // Pico's two vCPUs cost $0.03715 each per hour; other tiers cost $0.0743 per vCPU-hour.
    for (const t of CODESANDBOX_TIERS) expect(t.usdHour / t.vcpu).toBeCloseTo(t.name === "Pico" ? 0.03715 : 0.0743, 5);
  });
});

describe("CodeSandboxProvider", () => {
  it("is configured by the API key", () => {
    expect(new CodeSandboxProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("creates a private sandbox on the fitting tier with the template and hibernation timeout", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, image: { codesandbox: "tmpl123" }, metadata: { name: "job" } });
    expect(sbx.nativeId).toBe("csb-1");
    expect(called("CodeSandbox")).toEqual([["csb_test", undefined]]);
    expect(called("create")).toEqual([
      [
        {
          id: "tmpl123",
          vmTier: { name: "Micro" },
          hibernationTimeoutSeconds: 1200,
          privacy: "private",
          tags: ["sdk", "sandboxrouter"],
          title: "job",
        },
      ],
    ]);
  });

  it("clamps the hibernation timeout to 60 s .. 1 day and defaults to Nano", async () => {
    await p().create({ timeoutMinutes: 0.1 });
    await p().create({ timeoutMinutes: 10_000 });
    const [a, b] = called("create").map((c) => c[0] as any);
    expect(a).toMatchObject({ vmTier: { name: "Nano" }, hibernationTimeoutSeconds: 60 });
    expect(a.id).toBeUndefined();
    expect(b.hibernationTimeoutSeconds).toBe(86_400);
  });

  it("separates stdout from stderr, keeps exit codes, honours cwd and env", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec(`echo "$GREETING from $(basename "$PWD")"; echo err >&2`, { cwd: root, env: { GREETING: "it's me" } });
    expect(r).toMatchObject({ exitCode: 0, stdout: `it's me from ${root.split("/").pop()}\n`, stderr: "err\n" });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
    // The command line survives the SDK's own `bash -c '...'` quoting: no single quotes in it.
    expect(lines.at(-1)).not.toContain("'");
    // Temp output dirs are cleaned up.
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync("/tmp").filter((f) => f.startsWith(".sbr-") && existsSync(join("/tmp", f, "out")))).toEqual([]);
  });

  it("does not let a command read the PTY's stdin", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec("cat; echo done", { timeoutSeconds: 5 });
    expect(r.stdout).toBe("done\n");
  });

  it("persists spec.env in the sandbox so later sessions see it", async () => {
    const sbx = await p().create({ env: { TOKEN: "a'b c", OTHER: "$NOT_EXPANDED" } });
    expect(readFileSync(join(home, ".sandboxrouter.env"), "utf8")).toBe(`export TOKEN='a'\\''b c'\nexport OTHER='$NOT_EXPANDED'\n`);
    expect((await sbx.exec('printf "%s|%s" "$TOKEN" "$OTHER"')).stdout).toBe("a'b c|$NOT_EXPANDED");
    const again = await p().connect("csb-1");
    expect((await again.exec('printf %s "$TOKEN"')).stdout).toBe("a'b c");
    expect((await again.exec('printf %s "$TOKEN"', { env: { TOKEN: "override" } })).stdout).toBe("override");
  });

  it("cleans up when setup after create fails", async () => {
    await expect(p().create({ env: { "BAD-NAME": "x" } })).rejects.toMatchObject({ name: "ProviderError", message: expect.stringContaining("invalid env var name") });
    expect(called("delete")).toEqual([["csb-1"]]);
  });

  it("streams stdout and stderr by polling the output files", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.6; echo two >&2; sleep 0.6; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
  });

  it("kills a command that outlives its timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 0.3 })).rejects.toMatchObject({ message: "codesandbox: command timed out after 0.3s" });
    expect(called("command.kill")).toEqual([["csb-1"]]);
  });

  it("round-trips text and binary files, creating parent directories", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted'\n");
    expect(called("fs.mkdir")).toEqual([[join(root, "nested", "dir"), true]]);
    expect(called("fs.writeFile")).toEqual([[path, { create: true, overwrite: true }]]);
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted'\n");
    const bin = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "bin"), bin);
    expect(Buffer.from(await sbx.readFile(join(root, "bin"))).equals(Buffer.from(bin))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ name: "ProviderError" });
  });

  it("pauses by hibernating, and the next call resumes", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(calls.filter((c) => c[0] === "disconnect" || c[0] === "hibernate")).toEqual([
      ["disconnect", "csb-1"],
      ["hibernate", "csb-1"],
    ]);
    expect(sessions).toBe(1);
    expect((await sbx.exec("echo back")).stdout).toBe("back\n");
    expect(called("resume")).toEqual([["csb-1"]]);
    expect(sessions).toBe(2);
  });

  it("connects by resuming, and kill shuts down then deletes", async () => {
    const sbx = await p().connect("csb-9");
    expect(called("resume")).toEqual([["csb-9"]]);
    await sbx.kill();
    expect(calls.slice(-3)).toEqual([["disconnect", "csb-9"], ["shutdown", "csb-9"], ["delete", "csb-9"]]);
    await expect(p().connect("gone")).rejects.toMatchObject({ status: 404, message: "codesandbox: resume gone: Sandbox not found" });
  });
});
