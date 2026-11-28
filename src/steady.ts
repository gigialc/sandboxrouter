import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarksPublishable, CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, fixedSize, hourlyCost } from "./catalog.js";
import { median } from "./bench-store.js";
import { percentile } from "./burst.js";
import { sizeOf, type Router } from "./router.js";
import { hashZeros, phaseCommand, ZERO_256_SHA256 } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * Steadiness benchmark: one sandbox kept for several minutes, running the same small piece of work at a fixed
 * interval, the way an agent session does a tool call now and then. Start time and a single job say how fast
 * a provider is; this says whether it stays that fast, which depends on what else shares the machine.
 *
 * Each sample hashes 1 GB on one core (256 MB, four times) and is timed by the sandbox's own clock, so the
 * network between the test machine and the provider is not in the number.
 */

export const STEADY_VERSION = "steady-v1";

const MARK = "SRSTEADY";
// The sandbox's own clock: nanoseconds from GNU date where the image has it, else /proc/uptime (seconds, to
// a hundredth), which busybox images and every Linux kernel have.
const CLOCK = `t=$(date +%s%N 2> /dev/null); case "$t" in ""|*[!0-9]*) cut -d' ' -f1 /proc/uptime ;; *) echo "$t" ;; esac`;
export const STEADY_SAMPLE = `a=$(${CLOCK}); (${phaseCommand(hashZeros(268435456, ZERO_256_SHA256), 4)}); rc=$?; b=$(${CLOCK}); echo "${MARK}|$a|$b"; exit $rc`;

/** Milliseconds between the two clock readings a sample printed, or undefined if they are not there. */
export function sampleMs(stdout: string): number | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith(`${MARK}|`));
  const [, a, b] = line?.trim().split("|") ?? [];
  let ms: number;
  // Nanoseconds since 1970 are 19 digits; uptime is seconds with two decimals.
  if (/^\d{16,}$/.test(a ?? "") && /^\d{16,}$/.test(b ?? "")) ms = Number((BigInt(b) - BigInt(a)) / 1_000_000n);
  else if (/^\d+\.\d+$/.test(a ?? "") && /^\d+\.\d+$/.test(b ?? "")) ms = Math.round((Number(b) - Number(a)) * 1000);
  else return undefined;
  return ms >= 1 ? ms : undefined;
}

export interface SteadyRow {
  provider: string;
  size: { vcpu: number; memoryGb: number };
  /** In-sandbox time of each sample that finished and passed its check, in order, in ms. */
  sampleMs: number[];
  medianMs?: number;
  p95Ms?: number;
  maxMs?: number;
  /** Samples that failed, or were never run because the sandbox stopped answering. */
  failures: number;
  /** List price per hour at this size. */
  hourlyUsd?: number;
}

/** A saved steadiness report (results/, tool "sandboxrouter-steady"). */
export interface SteadyReport {
  tool: "sandboxrouter-steady";
  version: string;
  /** The sample's version: a change to the work makes older reports stop counting. */
  task: string;
  date: string;
  label?: string;
  by?: string;
  spec: { vcpu: number; memoryGb: number };
  /** Samples asked of each sandbox, and the seconds between their starts. */
  samples: number;
  intervalSeconds: number;
  node: string;
  platform: string;
  rows: SteadyRow[];
}

export interface SteadyOptions {
  router: Router;
  providers: ProviderId[];
  samples?: number;
  intervalSeconds?: number;
  spec?: { vcpu: number; memoryGb: number };
  onProgress?: (message: string) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The numbers a row reports, from its samples. */
export function steadySummary(ms: number[]): Pick<SteadyRow, "medianMs" | "p95Ms" | "maxMs"> {
  if (!ms.length) return {};
  const sorted = [...ms].sort((a, b) => a - b);
  return { medianMs: median(sorted), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) };
}

/** One sandbox per provider, all providers at once: each only runs one core's worth of work every interval. */
export async function steady(opts: SteadyOptions): Promise<SteadyRow[]> {
  const samples = opts.samples ?? 60;
  const interval = (opts.intervalSeconds ?? 10) * 1000;
  const asked = opts.spec ?? { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minutes = Math.ceil((samples * interval) / 60_000) + 5;

  return Promise.all(
    opts.providers.map(async (provider): Promise<SteadyRow> => {
      const spec: SandboxSpec = { ...asked, ...fixedSize(provider, asked), timeoutMinutes: minutes };
      const ms: number[] = [];
      let failures = 0;
      let box: Awaited<ReturnType<Router["create"]>> | undefined;
      try {
        box = await opts.router.create(spec, { provider, fallback: false });
        const t0 = Date.now();
        for (let i = 0; i < samples; i++) {
          const wait = t0 + i * interval - Date.now();
          if (wait > 0) await sleep(wait);
          try {
            const r = await box.exec(STEADY_SAMPLE, { timeoutSeconds: 120 });
            const took = r.exitCode === 0 ? sampleMs(r.stdout) : undefined;
            if (took === undefined) failures++;
            else ms.push(took);
          } catch {
            failures++;
          }
          if ((i + 1) % 10 === 0) opts.onProgress?.(`${provider}: ${i + 1}/${samples} samples, ${failures} failed`);
        }
      } catch (e) {
        // No sandbox: every sample is missing.
        failures = samples - ms.length;
        opts.onProgress?.(`${provider}: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`);
      } finally {
        await box?.kill().catch(() => {});
      }
      let hourlyUsd: number | undefined;
      try {
        hourlyUsd = hourlyCost(provider, spec);
      } catch {
        /* no price: the row still stands */
      }
      return { provider, size: sizeOf(provider, spec), sampleMs: ms, ...steadySummary(ms), failures, ...(hourlyUsd !== undefined ? { hourlyUsd } : {}) };
    }),
  );
}

export function loadSteadyReports(dir: string): SteadyReport[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SteadyReport[] = [];
  for (const f of files.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r?.tool === "sandboxrouter-steady" && Array.isArray(r.rows)) out.push(r);
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

const KNOWN = new Set<string>(CATALOG.map((c) => c.id));

/**
 * For the website: per provider, every complete run of the current sample from the 30 days before its newest
 * one. One sandbox is one machine at one time, so the row is the median across runs, and the slowest sample
 * of any of them. Steadiest first: the smallest gap between the 95th percentile and the median.
 */
export function steadyTable(reports: SteadyReport[]) {
  const MONTH = 30 * 86_400_000;
  const by = new Map<string, { row: SteadyRow; rep: SteadyReport }[]>();
  for (const rep of reports) {
    if (rep.task !== STEADY_VERSION) continue;
    for (const row of rep.rows) {
      if (!KNOWN.has(row.provider) || !benchmarksPublishable(row.provider as ProviderId)) continue;
      by.set(row.provider, [...(by.get(row.provider) ?? []), { row, rep }]);
    }
  }
  return [...by.entries()]
    .flatMap(([provider, all]) => {
      const newest = all.reduce((a, b) => (a.rep.date >= b.rep.date ? a : b));
      // Same size and schedule as the newest run, so the runs behind a row are the same test.
      const runs = all.filter(
        ({ row, rep }) =>
          Date.parse(newest.rep.date) - Date.parse(rep.date) <= MONTH &&
          rep.samples === newest.rep.samples && rep.intervalSeconds === newest.rep.intervalSeconds &&
          row.size.vcpu === newest.row.size.vcpu && row.size.memoryGb === newest.row.size.memoryGb,
      );
      // A run with a failed sample keeps the provider off the table: it did not hold for the whole test.
      if (runs.some(({ row, rep }) => row.failures !== 0 || row.sampleMs.length !== rep.samples || row.medianMs === undefined || row.p95Ms === undefined)) return [];
      const spreads = runs.map(({ row }) => row.p95Ms! / row.medianMs! - 1).sort((a, b) => a - b);
      const mid = Math.floor(spreads.length / 2);
      return [{
        provider,
        name: CATALOG.find((c) => c.id === provider)!.name,
        size: newest.row.size,
        medianMs: median(runs.map(({ row }) => row.medianMs!))!,
        maxMs: Math.max(...runs.map(({ row }) => row.maxMs!)),
        /** How much slower the 95th percentile sample was than the median one, as a fraction (0.04 = 4%): the median across runs. */
        spread: spreads.length % 2 ? spreads[mid] : (spreads[mid - 1] + spreads[mid]) / 2,
        /** Each run's own figure, lowest first. */
        spreads,
        runs: runs.length,
        samples: newest.rep.samples,
        intervalSeconds: newest.rep.intervalSeconds,
        ...(newest.row.hourlyUsd !== undefined ? { hourlyUsd: newest.row.hourlyUsd } : {}),
        measuredAt: newest.rep.date,
      }];
    })
    .sort((a, b) => a.spread - b.spread || a.medianMs - b.medianMs);
}
