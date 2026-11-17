import { BILLED_VS_LIST } from "./billing.js";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU, fittingSpec, fixedSize } from "./catalog.js";
import { median } from "./bench-store.js";
import { Router } from "./router.js";
import { taskUsd } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * Your own workload on several providers: the same setup and command in a new sandbox on each, a few times.
 * Times are measured; the cost is an estimate from each provider's billing rules for the time the sandbox lived
 * (start, setup and run), with every core priced as busy. Failed attempts count: a provider that can't run your
 * setup, or fails the command, says so instead of dropping out.
 */
export interface CompareRow {
  provider: ProviderId;
  runs: number;
  /** Runs where the sandbox started, setup exited 0 and the command exited 0. */
  ok: number;
  /** Of the failures: the sandbox didn't start / setup failed / the command failed or timed out. */
  startFailed: number;
  setupFailed: number;
  commandFailed: number;
  /** Medians over the successful runs, in milliseconds. */
  medianStartMs?: number;
  medianSetupMs?: number;
  medianCommandMs?: number;
  medianTotalMs?: number;
  /** Estimated cost of one successful run (not a bill). */
  estimatedUsd?: number;
  /** The estimate uses what this provider really billed against its list price, where we measured it. */
  billMeasured: boolean;
  /** The size it ran at. */
  size: { vcpu: number; memoryGb: number };
  /** The first failure's message, shortened. */
  error?: string;
}

export async function compare(opts: {
  router?: Router;
  providers: ProviderId[];
  command: string;
  /** Run once in each sandbox before the command: installs, clones. Timed and reported apart. */
  setup?: string;
  runs?: number;
  /** Seconds the setup and the command may each take (default 600). */
  timeoutSeconds?: number;
  /** Providers measured at once (default 4). */
  parallel?: number;
  spec?: SandboxSpec;
  onProgress?: (msg: string) => void;
}): Promise<CompareRow[]> {
  const router = opts.router ?? new Router();
  const runs = Math.max(1, opts.runs ?? 3);
  const timeoutSeconds = opts.timeoutSeconds ?? 600;
  const log = opts.onProgress ?? (() => {});
  const base: SandboxSpec = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB, timeoutMinutes: Math.ceil((timeoutSeconds * 2) / 60) + 5, ...opts.spec };
  const rows: CompareRow[] = [];
  const lastLine = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n").at(-1) ?? "";

  const one = async (id: ProviderId) => {
    const spec = { ...base, ...fixedSize(id, base) };
    const good: { start: number; setup: number; command: number }[] = [];
    const row: CompareRow = { provider: id, runs, ok: 0, startFailed: 0, setupFailed: 0, commandFailed: 0, billMeasured: BILLED_VS_LIST[id] !== undefined, size: fittingSpec(id) };
    const fail = (kind: "startFailed" | "setupFailed" | "commandFailed", msg: string) => {
      row[kind]++;
      row.error ??= msg.replace(/\s+/g, " ").slice(0, 200);
    };
    for (let i = 0; i < runs; i++) {
      let box;
      const t0 = performance.now();
      try {
        box = await router.create(spec, { provider: id, fallback: false });
      } catch (err) {
        fail("startFailed", (err as Error).message);
        continue;
      }
      try {
        const start = performance.now() - t0;
        let setup = 0;
        if (opts.setup) {
          const t1 = performance.now();
          const r = await box.exec(opts.setup, { timeoutSeconds }).catch((e: Error) => ({ exitCode: -1, stdout: "", stderr: e.message }));
          setup = performance.now() - t1;
          if (r.exitCode !== 0) {
            fail("setupFailed", `setup exited ${r.exitCode}: ${lastLine(r)}`);
            continue;
          }
        }
        const t2 = performance.now();
        const r = await box.exec(opts.command, { timeoutSeconds }).catch((e: Error) => ({ exitCode: -1, stdout: "", stderr: e.message }));
        const command = performance.now() - t2;
        if (r.exitCode !== 0) {
          fail("commandFailed", `command exited ${r.exitCode}: ${lastLine(r)}`);
          continue;
        }
        good.push({ start, setup, command });
        row.ok++;
      } finally {
        await box.kill().catch(() => {});
      }
    }
    if (good.length) {
      const m = (f: (g: (typeof good)[number]) => number) => Math.round(median(good.map(f))!);
      row.medianStartMs = m((g) => g.start);
      if (opts.setup) row.medianSetupMs = m((g) => g.setup);
      row.medianCommandMs = m((g) => g.command);
      row.medianTotalMs = m((g) => g.start + g.setup + g.command);
      row.estimatedUsd = taskUsd(id, row.size, row.medianStartMs, (row.medianSetupMs ?? 0) + row.medianCommandMs, undefined, BILLED_VS_LIST[id]?.ratio ?? 1, false);
    }
    rows.push(row);
    log(`${id}: ${row.ok}/${runs} worked${row.medianTotalMs !== undefined ? `, ${(row.medianTotalMs / 1000).toFixed(1)} s in total` : ""}${row.error ? `; ${row.error.slice(0, 120)}` : ""}`);
  };

  const queue = [...opts.providers];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 4, queue.length)) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await one(id);
    }),
  );
  // Most reliable first, then cheapest per successful run.
  const perSuccess = (r: CompareRow) => (r.estimatedUsd === undefined || !r.ok ? Infinity : r.estimatedUsd / (r.ok / r.runs));
  return rows.sort((a, b) => b.ok / b.runs - a.ok / a.runs || perSuccess(a) - perSuccess(b) || a.provider.localeCompare(b.provider));
}
