import { fixedSize } from "./catalog.js";
import type { Router, RoutedSandbox } from "./router.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/** Every step `check` runs, in order. Each provider's saved report is scored against this list. */
export const CHECK_STEPS = [
  "create",
  "exec: stdout, stderr, exit code",
  "exec: env and cwd",
  "exec: UTF-8 output",
  "exec: streaming",
  "files: binary round-trip",
  "files: 1 MB round-trip",
  "files: missing file is an error",
  "files: visible to commands",
  "exec: command timeout",
  "exec: timed-out command was stopped",
  "pause and resume",
  "kill",
  "killed sandbox is gone",
] as const;

export type CheckStatus = "pass" | "fail" | "skip" | "info";

export interface CheckResult {
  step: string;
  status: CheckStatus;
  ms: number;
  detail?: string;
}

export interface CheckReport {
  provider: ProviderId;
  sandboxId?: string;
  results: CheckResult[];
  /** True when no step failed. */
  ok: boolean;
}

/**
 * One real pass over a provider: create, exec (stdout, stderr, exit code, env, cwd), streaming,
 * a binary file round-trip, pause and resume where supported, and kill. Meant for testing an
 * adapter against a real account; every step is recorded, and later steps still run after a
 * failure when they can.
 */
export async function checkProvider(
  router: Router,
  provider: ProviderId,
  opts: { spec?: SandboxSpec; onStep?: (r: CheckResult) => void } = {},
): Promise<CheckReport> {
  const results: CheckResult[] = [];
  const record = (r: CheckResult) => {
    results.push(r);
    opts.onStep?.(r);
  };
  const step = async (name: string, fn: () => Promise<string | void | { status: CheckStatus; detail?: string }>) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      const r = typeof out === "object" && out ? out : { status: "pass" as const, detail: out || undefined };
      record({ step: name, ms: Date.now() - t0, ...r });
      return r.status !== "fail";
    } catch (err) {
      record({ step: name, status: "fail", ms: Date.now() - t0, detail: (err as Error)?.message ?? String(err) });
      return false;
    }
  };

  let sbx: RoutedSandbox | undefined;
  await step("create", async () => {
    sbx = await router.create({ timeoutMinutes: 10, ...fixedSize(provider), ...opts.spec }, { provider, fallback: false });
    return `${sbx.id}, ~$${sbx.estimatedHourlyUsd}/hr`;
  });
  if (!sbx) return { provider, results, ok: false };
  const box = sbx;

  try {
    await step("exec: stdout, stderr, exit code", async () => {
      const r = await box.exec("printf hi; printf err >&2; exit 3");
      const bad: string[] = [];
      if (r.stdout !== "hi") bad.push(`stdout ${JSON.stringify(r.stdout)}`);
      if (r.stderr !== "err") bad.push(`stderr ${JSON.stringify(r.stderr)}`);
      if (r.exitCode !== 3) bad.push(`exit ${r.exitCode}`);
      if (bad.length) throw new Error(`expected "hi" / "err" / 3, got ${bad.join(", ")}`);
    });

    await step("exec: env and cwd", async () => {
      const r = await box.exec('printf "%s %s" "$SBR_CHECK" "$(pwd)"', { env: { SBR_CHECK: "v1" }, cwd: "/tmp" });
      if (r.stdout.trim() !== "v1 /tmp") throw new Error(`expected "v1 /tmp", got ${JSON.stringify(r.stdout)}`);
    });

    await step("exec: UTF-8 output", async () => {
      // "café ✓" as octal escapes, so the command itself is plain ASCII.
      const r = await box.exec("printf 'caf\\303\\251 \\342\\234\\223'");
      if (r.stdout !== "café ✓") throw new Error(`expected "café ✓", got ${JSON.stringify(r.stdout)}`);
    });

    await step("exec: streaming", async () => {
      const t0 = Date.now();
      let first = -1;
      let chunks = 0;
      const r = await box.exec("for i in 1 2 3; do echo $i; sleep 1; done", {
        onStdout: () => {
          chunks++;
          if (first < 0) first = Date.now() - t0;
        },
      });
      const total = Date.now() - t0;
      if (r.stdout.replace(/\s+/g, "") !== "123") throw new Error(`expected 1 2 3, got ${JSON.stringify(r.stdout)}`);
      if (chunks === 0) throw new Error("onStdout was never called");
      const live = first >= 0 && first < total - 1500;
      return { status: live ? "pass" : "info", detail: live ? `first output after ${first} ms` : "output arrived only at the end (no live streaming)" };
    });

    const bytes = new Uint8Array(256 * 4).map((_, i) => i % 256);
    const path = "/tmp/sbr-check/nested/bin.dat";
    await step("files: binary round-trip", async () => {
      await box.writeFile(path, bytes);
      const back = await box.readFile(path);
      if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) throw new Error(`read back ${back.length} bytes, content differs`);
    });

    await step("files: 1 MB round-trip", async () => {
      // Big enough to cross every adapter's chunking; a pattern that isn't all one repeating byte.
      const big = new Uint8Array(1024 * 1024).map((_, i) => (i * 31 + (i >> 10)) % 256);
      await box.writeFile("/tmp/sbr-check/big.bin", big);
      const back = await box.readFile("/tmp/sbr-check/big.bin");
      if (back.length !== big.length) throw new Error(`read back ${back.length} of ${big.length} bytes`);
      const at = back.findIndex((b, i) => b !== big[i]);
      if (at >= 0) throw new Error(`content differs from byte ${at}`);
    });

    await step("files: missing file is an error", async () => {
      let got: Uint8Array;
      try {
        got = await box.readFile("/tmp/sbr-check/does-not-exist");
      } catch {
        return;
      }
      throw new Error(`readFile of a missing file returned ${got.length} bytes instead of throwing`);
    });

    await step("files: visible to commands", async () => {
      await box.writeFile("/tmp/sbr-check/hello.txt", "hello from writeFile\n");
      const r = await box.exec("cat /tmp/sbr-check/hello.txt && printf made > /tmp/sbr-check/made.txt");
      if (r.stdout.trim() !== "hello from writeFile") throw new Error(`cat printed ${JSON.stringify(r.stdout)}`);
      const made = await box.readText("/tmp/sbr-check/made.txt");
      if (made !== "made") throw new Error(`readFile of a command's file gave ${JSON.stringify(made)}`);
    });

    await step("exec: command timeout", async () => {
      // The contract: the command is stopped and exec rejects with "command timed out after Ns".
      const seconds = 3;
      const t0 = Date.now();
      let outcome: string;
      try {
        const r = await box.exec(`sleep 30; echo late`, { timeoutSeconds: seconds });
        outcome = `returned exit ${r.exitCode}${r.stdout.includes("late") ? " and ran to completion" : ""}`;
      } catch (err) {
        const message = (err as Error).message;
        if (message.endsWith(`command timed out after ${seconds}s`)) return `threw after ${Date.now() - t0} ms`;
        outcome = `threw "${message}"`;
      }
      throw new Error(`expected a "command timed out after ${seconds}s" error, ${outcome} after ${Date.now() - t0} ms`);
    });

    await step("exec: timed-out command was stopped", async () => {
      // A command killed by its timeout must not finish on its own later.
      await box.exec("rm -f /tmp/sbr-check/late; sleep 4 && echo late > /tmp/sbr-check/late", { timeoutSeconds: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
      const r = await box.exec("cat /tmp/sbr-check/late 2>/dev/null || echo stopped");
      if (r.stdout.includes("late")) throw new Error("the command kept running after its timeout");
    });

    if (box.canPause) {
      await step("pause and resume", async () => {
        await box.pause();
        const again = await router.get(box.id);
        const r = await again.exec("cat /tmp/sbr-check/hello.txt");
        if (r.stdout.trim() !== "hello from writeFile") throw new Error(`after resume, file read ${JSON.stringify(r.stdout)}`);
      });
    } else {
      record({ step: "pause and resume", status: "skip", ms: 0, detail: "adapter has no pause" });
    }
  } finally {
    await step("kill", () => box.kill());
  }

  await step("killed sandbox is gone", async () => {
    try {
      const again = await router.get(box.id);
      await again.exec("echo still-here", { timeoutSeconds: 10 });
    } catch {
      return;
    }
    return { status: "fail", detail: "the sandbox still ran a command after kill(): check the dashboard, it may still bill" };
  });

  return { provider, sandboxId: box.id, results, ok: !results.some((r) => r.status === "fail") };
}
