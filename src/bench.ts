import { CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, fittingSpec, fixedSize, hourlyCost } from "./catalog.js";
import { loadBench, median, saveBench, type BenchData } from "./bench-store.js";
import { Router, sizeOf, type Size } from "./router.js";
import { runTask, taskMs, taskUsd, TASKS, type TaskKind, type TaskRun } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

export interface BenchRow {
  provider: ProviderId;
  runs: number;
  /** Create or first-command failures. Workload and cleanup outcomes are counted separately. */
  failures: number;
  /** Shape selected by the router, before any provider-side allocation. */
  size?: Size;
  medianCreateMs?: number;
  medianExecMs?: number;
  /** Paired time from request to first successful command. */
  medianReadyMs?: number;
  hourlyUsd: number;
  /**
   * Of the failures, how many the provider refused for a limit or quota on the benchmarking account (a rate limit,
   * a concurrency or service quota): the account's plan, not the provider's reliability. Success rates leave them out.
   */
  limited?: number;
  createFailures?: number;
  commandFailures?: number;
  cleanupFailures?: number;
  /** With a workload: requests whose workload finished and passed its checks. */
  taskOk?: number;
  /** Readiness time of the boxes where the workload succeeded. */
  medianTaskReadyMs?: number;
  /** With `task`: median time of the standard task (src/task.ts), and of each of its phases. */
  medianTaskMs?: number;
  taskPhasesMs?: Record<string, number>;
  /** With `task`: median CPU time the task used across all vCPUs, where the sandbox shows /proc/stat. */
  medianTaskCpuMs?: number;
  /** With `task`: median busy time of the busiest core, for providers that meter CPU per VM. */
  medianTaskMaxCoreMs?: number;
  lastError?: string;
}

/**
 * Cold start = time from create() call to a usable sandbox. Exec = round trip of `echo ok`.
 * Measured from wherever you run it, so network distance to each provider counts. Every provider is
 * asked for the same size (2 vCPU / 4 GB unless `spec` says otherwise), except ones whose default
 * image fixes the size, which run at that size.
 */
export async function bench(opts: {
  router?: Router;
  providers?: ProviderId[];
  runs?: number;
  spec?: SandboxSpec;
  benchFile?: string;
  /** Also run a standard task (src/task.ts) in each sandbox, to price a fixed piece of work: true or "short", "long", "python", "download". */
  task?: boolean | TaskKind;
  /** Providers benched at once (default 1). Each provider's own runs stay one after another. */
  parallel?: number;
  onProgress?: (msg: string) => void;
}): Promise<BenchRow[]> {
  const router = opts.router ?? new Router();
  const runs = opts.runs ?? 3;
  // The CLI passes unset flags as undefined: drop them so they don't wipe the defaults.
  const given = Object.fromEntries(Object.entries(opts.spec ?? {}).filter(([, v]) => v !== undefined)) as SandboxSpec;
  const kind: TaskKind | undefined = opts.task === true ? "short" : opts.task || undefined;
  // The long task can take minutes on a slow provider: give the sandbox room to finish it.
  const spec: SandboxSpec = {
    vcpu: DEFAULT_VCPU,
    memoryGb: DEFAULT_MEMORY_GB,
    timeoutMinutes: kind === "long" ? 20 : 5,
    ...(kind && TASKS[kind].cpuUtilization ? { cpuUtilization: TASKS[kind].cpuUtilization } : {}),
    ...given,
  };
  const ids = opts.providers ?? router.registered().filter((id) => router.isConfigured(id));
  const log = opts.onProgress ?? (() => {});
  const stored: BenchData = loadBench(opts.benchFile);
  const rows: BenchRow[] = [];

  const one = async (id: ProviderId) => {
    const shape = sized(id, spec);
    const createMs: number[] = [];
    const execMs: number[] = [];
    const readyMs: number[] = [];
    const tasks: TaskRun[] = [];
    const taskReadyMs: number[] = [];
    let createFailures = 0;
    let commandFailures = 0;
    let cleanupFailures = 0;
    let limited = 0;
    let lastError: string | undefined;
    for (let i = 0; i < runs; i++) {
      log(`${id} run ${i + 1}/${runs}`);
      let box;
      try {
        const t0 = performance.now();
        box = await router.create(shape, { provider: id, fallback: false });
        const t1 = performance.now();
        const r = await box.exec("echo ok");
        if (r.exitCode !== 0 || r.stdout.trim() !== "ok") throw new Error(`echo returned ${r.exitCode}: ${r.stdout}${r.stderr}`);
        const done = performance.now();
        const took = Math.max(1, Math.round(done - t0));
        createMs.push(Math.max(1, Math.round(t1 - t0)));
        execMs.push(Math.max(1, Math.round(done - t1)));
        readyMs.push(took);
        if (kind) {
          try {
            tasks.push(await runTask(box, kind));
            taskReadyMs.push(took);
          } catch (err) {
            lastError = `task: ${(err as Error).message.slice(0, 180)}`;
          }
        }
      } catch (err) {
        lastError = (err as Error).message.slice(0, 200);
        if (box) commandFailures++;
        else {
          createFailures++;
          if (LIMITED_ERROR.test(lastError)) limited++;
        }
      } finally {
        await box?.kill().catch((err) => {
          cleanupFailures++;
          log(`${id} cleanup failed: ${(err as Error).message.slice(0, 180)}`);
        });
      }
    }
    const failures = createFailures + commandFailures;
    stored[id] = { createMs, execMs, failures, at: new Date().toISOString() };
    rows.push({
      provider: id,
      runs,
      failures,
      createFailures,
      commandFailures,
      cleanupFailures,
      size: sizeOf(id, shape),
      medianCreateMs: median(createMs),
      medianExecMs: median(execMs),
      medianReadyMs: median(readyMs),
      hourlyUsd: hourlyCost(id, shape),
      ...(limited ? { limited } : {}),
      ...(kind ? { taskOk: tasks.length, medianTaskReadyMs: median(taskReadyMs) } : {}),
      ...(tasks.length ? taskSummary(tasks, kind!) : {}),
      lastError,
    });
  };
  // A small pool: `parallel` providers at a time, each taking the next id when it finishes.
  const queue = [...ids];
  const lanes = Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, ids.length)) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await one(id);
  });
  await Promise.all(lanes);
  saveBench(stored, opts.benchFile);
  return rows.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity));
}

/** Medians of the task runs that finished: the whole task, and each phase. */
function taskSummary(tasks: TaskRun[], kind: TaskKind): Pick<BenchRow, "medianTaskMs" | "taskPhasesMs" | "medianTaskCpuMs" | "medianTaskMaxCoreMs"> {
  const phases = Object.fromEntries(TASKS[kind].phases.map((p) => [p.id, median(tasks.map((t) => t.ms[p.id]))!]));
  const cpu = tasks.every((t) => t.cpuMs !== undefined) ? median(tasks.map((t) => t.cpuMs!)) : undefined;
  const core = tasks.every((t) => t.maxCoreMs !== undefined) ? median(tasks.map((t) => t.maxCoreMs!)) : undefined;
  return {
    medianTaskMs: median(tasks.map((t) => taskMs(t.ms))),
    taskPhasesMs: phases,
    ...(cpu !== undefined ? { medianTaskCpuMs: cpu } : {}),
    ...(core !== undefined ? { medianTaskMaxCoreMs: core } : {}),
  };
}

/** The spec a provider is benched at: the asked size, or its fixed default size if its image has one. */
function sized(id: ProviderId, spec: SandboxSpec): SandboxSpec {
  return { ...spec, ...fixedSize(id, spec) };
}

export function benchMarkdown(rows: BenchRow[]): string {
  const name = (id: ProviderId) => CATALOG.find((c) => c.id === id)!.name;
  const ms = (n?: number) => (n === undefined ? "n/a" : `${n} ms`);
  const task = rows.some((r) => r.taskOk !== undefined);
  const cost = (r: BenchRow) =>
    r.medianTaskMs !== undefined && r.medianTaskReadyMs !== undefined
      ? `$${taskUsd(r.provider, r.size ?? fittingSpec(r.provider), r.medianTaskReadyMs, r.medianTaskMs, r.medianTaskCpuMs, 1, false, r.medianTaskMaxCoreMs).toFixed(6)}`
      : "n/a";
  const lines = [
    `| # | Provider | Create (median) | Ready (median) | Exec round trip |${task ? " Task (median) | Est. task cost | Completed |" : ""} $/hr (list, size run) | Ready |`,
    `|---|---|---|---|---|${task ? "---|---|---|" : ""}---|---|`,
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${name(r.provider)} | ${ms(r.medianCreateMs)} | ${ms(r.medianReadyMs)} | ${ms(r.medianExecMs)} |${task ? ` ${ms(r.medianTaskMs)} | ${cost(r)} | ${r.taskOk ?? 0}/${r.runs} |` : ""} $${r.hourlyUsd.toFixed(3)} | ${r.runs - r.failures}/${r.runs}${r.limited ? ` (${r.limited} refused)` : ""} |`,
    ),
  ];
  return lines.join("\n");
}

/** Errors that are about the account running the benchmark, not the provider: setup problems, payment, limits. */
export const ACCOUNT_ERROR = /setup problem|Payment Required|\b40[123]\b|creation limit|quota|insufficient (?:credit|balance|funds)/i;
export const NETWORK_ERROR = /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|ETIMEDOUT|Name resolution failed|getaddrinfo/i;

/** A refusal for a limit or quota on the account running the benchmark: rate limits, concurrency and service quotas. */
export const LIMITED_ERROR = /\b429\b|\b402\b|rate.?limit|ServiceQuotaExceeded|quota|too many|concurrency limit|creation limit|trial_exhausted|insufficient_credits|Payment Required|throttl/i;
