import { describe, expect, it } from "vitest";
import { checkProvider } from "../src/check.js";
import { Router } from "../src/router.js";
import type { ExecOptions, ExecResult, Provider, ProviderSandbox } from "../src/types.js";

/** A shell-ish fake that behaves like a correct provider for every step `check` runs. */
class GoodBox implements ProviderSandbox {
  files = new Map<string, Uint8Array>([["/tmp/sbr-check/made.txt", new TextEncoder().encode("made")]]);
  constructor(readonly nativeId: string, private owner: GoodProvider) {}
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.owner.live.has(this.nativeId)) throw new Error("gone");
    const ok = (stdout: string, stderr = "", exitCode = 0): ExecResult => {
      if (stdout) opts.onStdout?.(stdout);
      return { exitCode, stdout, stderr, durationMs: 1 };
    };
    if (cmd.startsWith("printf hi")) return ok("hi", "err", 3);
    if (cmd.includes("SBR_CHECK")) return ok(`${opts.env?.SBR_CHECK} ${opts.cwd}`);
    if (cmd.startsWith("for i")) {
      for (const n of [1, 2, 3]) {
        opts.onStdout?.(`${n}\n`);
        await new Promise((r) => setTimeout(r, n < 3 ? 1000 : 0));
      }
      return { exitCode: 0, stdout: "1\n2\n3\n", stderr: "", durationMs: 2000 };
    }
    if (cmd.startsWith("sleep 30")) return { exitCode: 124, stdout: "", stderr: "", durationMs: 3000 };
    if (cmd.startsWith("cat /tmp/sbr-check/hello.txt")) return ok(new TextDecoder().decode(this.files.get("/tmp/sbr-check/hello.txt")));
    return ok("");
  }
  async writeFile(path: string, content: string | Uint8Array) {
    this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }
  async readFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file ${path}`);
    return f;
  }
  async pause() {}
  async kill() {
    this.owner.live.delete(this.nativeId);
  }
}

class GoodProvider implements Provider {
  readonly id = "boat" as const;
  live = new Map<string, GoodBox>();
  constructor(private opts: { leak?: boolean } = {}) {}
  configured() {
    return true;
  }
  async create(): Promise<ProviderSandbox> {
    const b = new GoodBox("b1", this);
    this.live.set(b.nativeId, b);
    if (this.opts.leak) b.kill = async () => {};
    return b;
  }
  async connect(id: string): Promise<ProviderSandbox> {
    const b = this.live.get(id);
    if (!b) throw new Error("not found");
    return b;
  }
}

describe("sandboxrouter check", () => {
  it("passes every step on a provider that behaves", async () => {
    const report = await checkProvider(new Router({ providers: [new GoodProvider()] }), "boat");
    expect(report.results.filter((r) => r.status === "fail")).toEqual([]);
    expect(report.results.map((r) => r.step)).toEqual([
      "create",
      "exec: stdout, stderr, exit code",
      "exec: env and cwd",
      "exec: streaming",
      "files: binary round-trip",
      "files: visible to commands",
      "exec: command timeout",
      "pause and resume",
      "kill",
      "killed sandbox is gone",
    ]);
    expect(report.ok).toBe(true);
  }, 15_000);

  it("fails when kill doesn't actually stop the sandbox", async () => {
    const report = await checkProvider(new Router({ providers: [new GoodProvider({ leak: true })] }), "boat");
    expect(report.ok).toBe(false);
    expect(report.results.at(-1)).toMatchObject({ step: "killed sandbox is gone", status: "fail" });
  }, 15_000);

  it("stops after a failed create", async () => {
    const p = new GoodProvider();
    p.create = async () => {
      throw new Error("429 too many sandboxes");
    };
    const report = await checkProvider(new Router({ providers: [p] }), "boat");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ step: "create", status: "fail" });
    expect(report.results[0].detail).toContain("429");
  });
});
