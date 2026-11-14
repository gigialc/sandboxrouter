import { describe, expect, it } from "vitest";
import { CHECK_STEPS, checkProvider } from "../src/check.js";
import { Router } from "../src/router.js";
import { ProviderError, SetupError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox } from "../src/types.js";

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
    if (cmd.startsWith("printf 'caf")) return ok("café ✓");
    if (cmd.includes("SBR_CHECK")) return ok(`${opts.env?.SBR_CHECK} ${opts.cwd}`);
    if (cmd.startsWith("for i")) {
      for (const n of [1, 2, 3]) {
        opts.onStdout?.(`${n}\n`);
        await new Promise((r) => setTimeout(r, n < 3 ? 1000 : 0));
      }
      return { exitCode: 0, stdout: "1\n2\n3\n", stderr: "", durationMs: 2000 };
    }
    // The contract: a command that outlives its timeout is stopped and exec rejects with this error.
    if (cmd.startsWith("sleep 30")) throw new ProviderError("boat", `command timed out after ${opts.timeoutSeconds}s`);
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
    expect(report.results.map((r) => r.step)).toEqual([...CHECK_STEPS]);
    expect(report.ok).toBe(true);
  }, 25_000);

  it("calls a run inconclusive, not failing, when the account can't pay (402)", async () => {
    const p = new GoodProvider();
    p.create = async () => {
      throw new ProviderError("boat", "POST /sandboxes -> 402 billing_required: start the plan", 402);
    };
    const report = await checkProvider(new Router({ providers: [p] }), "boat");
    expect(report.inconclusive).toMatch(/can't pay/);
    expect(report.results).toEqual([expect.objectContaining({ step: "create", status: "skip" })]);
    // Any other create failure is still the provider's.
    p.create = async () => {
      throw new ProviderError("boat", "500 internal", 500);
    };
    const failed = await checkProvider(new Router({ providers: [p] }), "boat");
    expect(failed.inconclusive).toBeUndefined();
    expect(failed.results[0]).toMatchObject({ step: "create", status: "fail" });
  });

  it("calls a run inconclusive when the provider's package isn't installed where the check runs", async () => {
    const p = new GoodProvider();
    p.create = async () => {
      throw new SetupError('boat needs the "boat-sdk" package: npm i boat-sdk');
    };
    const report = await checkProvider(new Router({ providers: [p] }), "boat");
    expect(report.inconclusive).toBe(`the machine running the check doesn't have the "boat-sdk" package`);
    expect(report.results).toEqual([expect.objectContaining({ step: "create", status: "skip" })]);
  });

  it("fails when kill doesn't actually stop the sandbox", async () => {
    const report = await checkProvider(new Router({ providers: [new GoodProvider({ leak: true })] }), "boat");
    expect(report.ok).toBe(false);
    expect(report.results.at(-1)).toMatchObject({ step: "killed sandbox is gone", status: "fail" });
  }, 25_000);

  it("fails a provider that returns a timed-out command as a result", async () => {
    const p = new GoodProvider();
    const exec = GoodBox.prototype.exec;
    GoodBox.prototype.exec = async function (cmd, opts) {
      if (cmd.startsWith("sleep 30")) return { exitCode: 124, stdout: "", stderr: "", durationMs: 3000 };
      return exec.call(this, cmd, opts);
    };
    try {
      const report = await checkProvider(new Router({ providers: [p] }), "boat");
      expect(report.results.find((r) => r.step === "exec: command timeout")).toMatchObject({
        status: "fail",
        detail: expect.stringContaining("returned exit 124"),
      });
    } finally {
      GoodBox.prototype.exec = exec;
    }
  }, 25_000);

  it("fails a provider whose readFile returns empty bytes for a missing file, or truncates big files", async () => {
    const p = new GoodProvider();
    const create = p.create.bind(p);
    p.create = async () => {
      const b = (await create()) as GoodBox;
      const read = b.readFile.bind(b);
      b.readFile = async (path) => (path.endsWith("does-not-exist") ? new Uint8Array() : (await read(path)).slice(0, 200_000));
      return b;
    };
    const report = await checkProvider(new Router({ providers: [p], ledger: false }), "boat");
    const failed = report.results.filter((r) => r.status === "fail").map((r) => r.step);
    expect(failed).toEqual(["files: 1 MB round-trip", "files: missing file is an error"]);
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
