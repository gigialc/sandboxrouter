import { BILLED_VS_LIST } from "./billing.js";
import { fittingSpec, fixedSize, DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "./catalog.js";
import { Router } from "./router.js";
import { runTask, taskMs, taskUsd, TASKS, type TaskKind, type TaskRun } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * One provider under load: `n` sandboxes asked for at the same moment, the way parallel agents or an RL run
 * start them. Each must answer a command (time to interactive, measured from the moment they were all asked
 * for, so queueing on the provider counts); with a job, each then runs it. Every sandbox is killed after.
 */
export interface BurstRow {
  provider: ProviderId;
  /** Sandboxes asked for at once. */
  n: number;
  /** How many were ready and (with a job) finished it. */
  ok: number;
  /** Of the failures, how many the provider refused for a limit or quota on this account (429, "limit", ...). */
  limited: number;
  /** Time to interactive across the ready ones: create plus first command, from the burst's start. */
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  /** From the burst's start until the last sandbox finished (its job, with one). */
  wallMs: number;
  /** Median time of the job inside each sandbox, with one. */
  jobP50Ms?: number;
  /** What the whole burst would be billed: each finished sandbox priced as a new one (start, job, minimum, fee). */
  usd?: number;
}

const LIMIT = /\b429\b|rate limit|too many|limit|quota|concurren|capacity/i;

/** The value at percentile `p` (0 to 1) of sorted numbers, nearest-rank. */
export function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export async function burst(opts: {
  router?: Router;
  providers: ProviderId[];
  n: number;
  /** A standard job to run in every sandbox (src/task.ts): "python" for RL-style rollouts, "agent" for parallel agents. */
  task?: TaskKind;
  /** Providers loaded at once (default 1: a burst of 100 is enough load for this machine). */
  parallel?: number;
  onProgress?: (msg: string) => void;
}): Promise<BurstRow[]> {
  const router = opts.router ?? new Router();
  const kind = opts.task;
  const base: SandboxSpec = {
    vcpu: DEFAULT_VCPU,
    memoryGb: DEFAULT_MEMORY_GB,
    timeoutMinutes: 10,
    ...(kind && TASKS[kind].cpuUtilization ? { cpuUtilization: TASKS[kind].cpuUtilization } : {}),
  };
  const log = opts.onProgress ?? (() => {});
  const rows: BurstRow[] = [];

  const one = async (id: ProviderId) => {
    log(`${id}: ${opts.n} at once${kind ? `, each running the ${kind} job` : ""}`);
    const spec = { ...base, ...fixedSize(id, base) };
    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: opts.n }, async () => {
        let box;
        try {
          box = await router.create(spec, { provider: id, fallback: false, deadlineSeconds: 240 });
          const createMs = performance.now() - t0;
          const r = await box.exec("echo ok");
          if (r.exitCode !== 0 || r.stdout.trim() !== "ok") throw new Error(`echo returned ${r.exitCode}`);
          const tti = performance.now() - t0;
          const job: TaskRun | undefined = kind ? await runTask(box, kind) : undefined;
          return { ok: true as const, tti, createMs, job, done: performance.now() - t0 };
        } catch (err) {
          return { ok: false as const, error: (err as Error).message, done: performance.now() - t0 };
        } finally {
          await box?.kill().catch(() => {});
        }
      }),
    );
    const ok = results.filter((r) => r.ok);
    const ttis = ok.map((r) => Math.round(r.tti)).sort((a, b) => a - b);
    const jobs = ok.map((r) => (r.job ? taskMs(r.job.ms) : undefined)).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
    const size = fittingSpec(id);
    const ratio = BILLED_VS_LIST[id]?.ratio ?? 1;
    const usd = ok.reduce(
      (sum, r) =>
        sum +
        taskUsd(id, { ...size, ...(spec.cpuUtilization ? { cpuUtilization: spec.cpuUtilization } : {}) }, r.createMs, r.job ? taskMs(r.job.ms) : 0, r.job?.cpuMs, ratio, false, r.job?.maxCoreMs),
      0,
    );
    const failed = results.filter((r) => !r.ok) as { error: string }[];
    rows.push({
      provider: id,
      n: opts.n,
      ok: ok.length,
      limited: failed.filter((f) => LIMIT.test(f.error)).length,
      p50Ms: percentile(ttis, 0.5),
      p95Ms: percentile(ttis, 0.95),
      p99Ms: percentile(ttis, 0.99),
      wallMs: Math.round(Math.max(...results.map((r) => r.done))),
      ...(jobs.length ? { jobP50Ms: percentile(jobs, 0.5) } : {}),
      ...(ok.length ? { usd: Math.round(usd * 1e6) / 1e6 } : {}),
    });
    const sample = failed[0]?.error;
    log(`${id}: ${ok.length}/${opts.n} ready, p50 ${percentile(ttis, 0.5) ?? "-"} ms, p99 ${percentile(ttis, 0.99) ?? "-"} ms${sample ? `; e.g. ${sample.slice(0, 140)}` : ""}`);
  };

  const queue = [...opts.providers];
  const lanes = Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, queue.length)) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await one(id);
  });
  await Promise.all(lanes);
  return rows.sort((a, b) => b.ok - a.ok || (a.p50Ms ?? Infinity) - (b.p50Ms ?? Infinity));
}
