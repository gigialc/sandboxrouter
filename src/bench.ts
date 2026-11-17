import { CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, fixedSize, hourlyCost } from "./catalog.js";
import { loadBench, median, saveBench, type BenchData } from "./bench-store.js";
import { Router } from "./router.js";
import { runTask, taskMs, taskUsd, TASKS, type PhaseMs, type TaskKind } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

export interface BenchRow {
  provider: ProviderId;
  runs: number;
  failures: number;
  medianCreateMs?: number;
  medianExecMs?: number;
  hourlyUsd: number;
  /** With `task`: median time of the standard task (src/task.ts), and of each of its phases. */
  medianTaskMs?: number;
  taskPhasesMs?: PhaseMs;
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
  const spec: SandboxSpec = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB, timeoutMinutes: kind === "long" ? 20 : 5, ...given };
  const ids = opts.providers ?? router.registered().filter((id) => router.isConfigured(id));
  const log = opts.onProgress ?? (() => {});
  const stored: BenchData = loadBench(opts.benchFile);
  const rows: BenchRow[] = [];

  const one = async (id: ProviderId) => {
    const createMs: number[] = [];
    const execMs: number[] = [];
    const tasks: PhaseMs[] = [];
    let failures = 0;
    let lastError: string | undefined;
    for (let i = 0; i < runs; i++) {
      log(`${id} run ${i + 1}/${runs}`);
      let box;
      try {
        const t0 = performance.now();
        box = await router.create(sized(id, spec), { provider: id, fallback: false });
        createMs.push(Math.round(performance.now() - t0));
        const t1 = performance.now();
        const r = await box.exec("echo ok");
        if (r.exitCode !== 0 || r.stdout.trim() !== "ok") throw new Error(`echo returned ${r.exitCode}: ${r.stdout}${r.stderr}`);
        execMs.push(Math.round(performance.now() - t1));
        if (kind) {
          // A failed task doesn't fail the run: the start time still counts, the task just has no time.
          try {
            tasks.push(await runTask(box, kind));
          } catch (err) {
            lastError = `task: ${(err as Error).message.slice(0, 180)}`;
          }
        }
      } catch (err) {
        failures++;
        lastError = (err as Error).message.slice(0, 200);
      } finally {
        await box?.kill().catch(() => {});
      }
    }
    stored[id] = { createMs, execMs, failures, at: new Date().toISOString() };
    rows.push({
      provider: id,
      runs,
      failures,
      medianCreateMs: median(createMs),
      medianExecMs: median(execMs),
      hourlyUsd: hourlyCost(id, sized(id, spec)),
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
function taskSummary(tasks: PhaseMs[], kind: TaskKind): Pick<BenchRow, "medianTaskMs" | "taskPhasesMs"> {
  const phases: PhaseMs = Object.fromEntries(TASKS[kind].phases.map((p) => [p.id, median(tasks.map((t) => t[p.id]))!]));
  return { medianTaskMs: median(tasks.map(taskMs)), taskPhasesMs: phases };
}

/** The spec a provider is benched at: the asked size, or its fixed default size if its image has one. */
function sized(id: ProviderId, spec: SandboxSpec): SandboxSpec {
  return { ...spec, ...fixedSize(id, spec) };
}

export function benchMarkdown(rows: BenchRow[]): string {
  const name = (id: ProviderId) => CATALOG.find((c) => c.id === id)!.name;
  const ms = (n?: number) => (n === undefined ? "n/a" : `${n} ms`);
  const task = rows.some((r) => r.taskPhasesMs);
  const cost = (r: BenchRow) =>
    r.medianTaskMs !== undefined && r.medianCreateMs !== undefined ? `$${taskUsd(r.provider, r.hourlyUsd, r.medianCreateMs, r.medianTaskMs).toFixed(6)}` : "n/a";
  const lines = [
    `| # | Provider | Cold start (median) | Exec round trip |${task ? " Task (median) | Task cost |" : ""} $/hr (list, size run) | Success |`,
    `|---|---|---|---|${task ? "---|---|" : ""}---|---|`,
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${name(r.provider)} | ${ms(r.medianCreateMs)} | ${ms(r.medianExecMs)} |${task ? ` ${ms(r.medianTaskMs)} | ${cost(r)} |` : ""} $${r.hourlyUsd.toFixed(3)} | ${r.runs - r.failures}/${r.runs} |`,
    ),
  ];
  return lines.join("\n");
}
