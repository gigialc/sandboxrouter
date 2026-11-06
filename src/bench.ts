import { CATALOG, fixedSize, hourlyCost } from "./catalog.js";
import { loadBench, median, saveBench, type BenchData } from "./bench-store.js";
import { Router } from "./router.js";
import type { ProviderId, SandboxSpec } from "./types.js";

export interface BenchRow {
  provider: ProviderId;
  runs: number;
  failures: number;
  medianCreateMs?: number;
  medianExecMs?: number;
  hourlyUsd: number;
  lastError?: string;
}

/**
 * Cold start = time from create() call to a usable sandbox. Exec = round trip of `echo ok`.
 * Measured from wherever you run it, so network distance to each provider counts.
 */
export async function bench(opts: {
  router?: Router;
  providers?: ProviderId[];
  runs?: number;
  spec?: SandboxSpec;
  benchFile?: string;
  onProgress?: (msg: string) => void;
}): Promise<BenchRow[]> {
  const router = opts.router ?? new Router();
  const runs = opts.runs ?? 3;
  const spec = opts.spec ?? { timeoutMinutes: 5 };
  const ids = opts.providers ?? router.registered().filter((id) => router.isConfigured(id));
  const log = opts.onProgress ?? (() => {});
  const stored: BenchData = loadBench(opts.benchFile);
  const rows: BenchRow[] = [];

  for (const id of ids) {
    const createMs: number[] = [];
    const execMs: number[] = [];
    let failures = 0;
    let lastError: string | undefined;
    for (let i = 0; i < runs; i++) {
      log(`${id} run ${i + 1}/${runs}`);
      let box;
      try {
        const t0 = performance.now();
        box = await router.create({ ...fixedSize(id), ...spec }, { provider: id, fallback: false });
        createMs.push(Math.round(performance.now() - t0));
        const t1 = performance.now();
        const r = await box.exec("echo ok");
        if (r.exitCode !== 0 || r.stdout.trim() !== "ok") throw new Error(`echo returned ${r.exitCode}: ${r.stdout}${r.stderr}`);
        execMs.push(Math.round(performance.now() - t1));
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
      hourlyUsd: hourlyCost(id, { ...fixedSize(id), ...spec }),
      lastError,
    });
  }
  saveBench(stored, opts.benchFile);
  return rows.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity));
}

export function benchMarkdown(rows: BenchRow[]): string {
  const name = (id: ProviderId) => CATALOG.find((c) => c.id === id)!.name;
  const ms = (n?: number) => (n === undefined ? "n/a" : `${n} ms`);
  const lines = [
    "| # | Provider | Cold start (median) | Exec round trip | $/hr (list, size run) | Success |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${name(r.provider)} | ${ms(r.medianCreateMs)} | ${ms(r.medianExecMs)} | $${r.hourlyUsd.toFixed(3)} | ${r.runs - r.failures}/${r.runs} |`,
    ),
  ];
  return lines.join("\n");
}
