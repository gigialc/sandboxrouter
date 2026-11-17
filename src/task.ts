import { billingRules, cpuHourlyAtFull, hourlyCost, info } from "./catalog.js";
import type { ProviderId, ProviderSandbox } from "./types.js";

/**
 * The standard tasks for `bench --task`: the same fixed piece of work in every sandbox, so providers can be
 * compared on what a job costs, not just on their hourly price. A slower CPU, disk or network makes the job
 * take longer, and a longer job is billed more.
 *
 * Each phase is its own command, timed from here, minus the sandbox's own round trip for an empty command,
 * so network distance to the provider mostly drops out.
 *
 * - "short": hash on one core, then two, then write to disk, once (seconds). Only POSIX shell and tools every
 *   Linux image has (coreutils or busybox), so no provider fails for lack of a package.
 * - "long": the short job's phases 40 times in a row (minutes): sustained speed (CPUs that slow down after a
 *   burst) and prices once minimum charges stop mattering.
 * - "python": a pure-Python script like a code-interpreter call. Needs python3 in the default image; a
 *   provider without it fails the task, which is itself worth knowing.
 * - "download": fetch the 53 MB Node.js release from nodejs.org's CDN, with curl, else wget, else python3:
 *   what installing toolchains and packages depends on.
 *
 * Changing a phase changes what the numbers mean: bump that task's version, and older reports stop counting.
 */
export type TaskKind = "short" | "long" | "python" | "download";

export interface TaskPhaseDef {
  id: string;
  label: string;
  cmd: string;
}

const HASH_DISK: TaskPhaseDef[] = [
  // One core: hash 512 MB of zeros.
  { id: "cpu", label: "1 core", cmd: "head -c 536870912 /dev/zero | sha256sum > /dev/null" },
  // Two cores at once (bench asks for 2 vCPU), 256 MB each: shows whether the second vCPU is real.
  { id: "cores", label: "2 cores", cmd: "for i in 1 2; do (head -c 268435456 /dev/zero | sha256sum > /dev/null) & done; wait" },
  // Write 256 MB and flush it to disk, then delete it.
  { id: "disk", label: "disk", cmd: "dd if=/dev/zero of=/tmp/sr-task bs=1048576 count=256 conv=fsync 2> /dev/null; rm -f /tmp/sr-task" },
];

// 200,000 small records through JSON, a regex and a sort: the kind of thing a code-interpreter call does.
const PYTHON = [
  "import json, random, re",
  "random.seed(1)",
  "rows = [{'id': i, 'name': ''.join(random.choice('abcdefghij') for _ in range(16)), 'v': random.random()} for i in range(200000)]",
  "back = json.loads(json.dumps(rows))",
  "hits = sum(1 for r in back if re.search('abc', r['name']))",
  "top = sorted(back, key=lambda r: (r['name'], r['v']))[:10]",
  "print(hits, top[0]['id'])",
].join("\n");

// The Node.js 22.11.0 Linux release (53 MB), from nodejs.org's CDN: a real download, like installing a toolchain.
const DOWNLOAD_URL = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz";
const PY_FETCH = `import shutil, urllib.request; shutil.copyfileobj(urllib.request.urlopen('${DOWNLOAD_URL}'), open('/dev/null', 'wb'))`;

export const TASKS: Record<TaskKind, { version: string; repeat: number; phases: TaskPhaseDef[] }> = {
  short: { version: "v1", repeat: 1, phases: HASH_DISK },
  long: { version: "v1-long", repeat: 40, phases: HASH_DISK },
  python: { version: "python-v1", repeat: 1, phases: [{ id: "python", label: "Python", cmd: `python3 -c "${PYTHON}"` }] },
  download: {
    version: "download-v1",
    repeat: 1,
    phases: [
      {
        id: "download",
        label: "53 MB download",
        cmd:
          `if command -v curl > /dev/null; then curl -sSfL -o /dev/null '${DOWNLOAD_URL}'; ` +
          `elif command -v wget > /dev/null; then wget -q -O /dev/null '${DOWNLOAD_URL}'; ` +
          `else python3 -c "${PY_FETCH}"; fi`,
      },
    ],
  },
};

/** The short task's version and phases, which is what plain `bench --task` records. */
export const TASK_VERSION = TASKS.short.version;
export const TASK_PHASES = TASKS.short.phases;

/** Milliseconds per phase, by phase id. */
export type PhaseMs = Record<string, number>;

/** The task a report's `task` version names, if it's one this release knows. */
export function taskByVersion(version: unknown): (typeof TASKS)[TaskKind] | undefined {
  return Object.values(TASKS).find((t) => t.version === version);
}

/** A phase's command, run `repeat` times in a row in one shell (POSIX: no seq, no brace ranges). */
export function phaseCommand(cmd: string, repeat: number): string {
  return repeat <= 1 ? cmd : `n=0; while [ $n -lt ${repeat} ]; do ${cmd}; n=$((n+1)); done`;
}

/** What one run of a task measured: milliseconds per phase, and the CPU time it used across all vCPUs, if the sandbox shows it. */
export interface TaskRun {
  ms: PhaseMs;
  cpuMs?: number;
}

// Wraps a phase to read /proc/stat's total CPU line before and after it, so the run also reports the CPU
// time it really used: what providers that bill active CPU charge for.
const MARK = "SRCPU";
const withCpu = (cmd: string) =>
  `a=$(head -n 1 /proc/stat 2> /dev/null); ${cmd}; rc=$?; b=$(head -n 1 /proc/stat 2> /dev/null); echo "${MARK}|$a|$b"; exit $rc`;

/** Busy CPU milliseconds between two /proc/stat "cpu" lines: user, nice, system, irq and softirq (not idle, iowait or steal), at 100 ticks a second. */
export function busyMs(before: string, after: string): number | undefined {
  const ticks = (line: string) => {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "cpu" || f.length < 8) return undefined;
    const n = f.slice(1).map(Number);
    return n[0] + n[1] + n[2] + n[5] + n[6];
  };
  const a = ticks(before);
  const b = ticks(after);
  return a === undefined || b === undefined || !(b >= a) ? undefined : (b - a) * 10;
}

/** Runs a standard task in `box`: milliseconds per phase (network round trip taken out) and CPU time used. Throws if a phase fails. */
export async function runTask(box: Pick<ProviderSandbox, "exec">, kind: TaskKind = "short"): Promise<TaskRun> {
  const { repeat, phases } = TASKS[kind];
  const rtt: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await box.exec("true");
    rtt.push(performance.now() - t);
  }
  const overhead = rtt.sort((a, b) => a - b)[1];
  const out: PhaseMs = {};
  let cpuMs: number | undefined = 0;
  for (const p of phases) {
    const t = performance.now();
    const r = await box.exec(withCpu(phaseCommand(p.cmd, repeat)), { timeoutSeconds: repeat > 1 ? 900 : 300 });
    if (r.exitCode !== 0) throw new Error(`task phase ${p.id} exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 120)}`);
    out[p.id] = Math.max(1, Math.round(performance.now() - t - overhead));
    const line = r.stdout.split("\n").find((l) => l.startsWith(`${MARK}|`));
    const used = line ? busyMs(line.split("|")[1] ?? "", line.split("|")[2] ?? "") : undefined;
    cpuMs = cpuMs === undefined || used === undefined ? undefined : cpuMs + used;
  }
  return { ms: out, ...(cpuMs !== undefined ? { cpuMs } : {}) };
}

/** The whole task's time: the phases added up. */
export const taskMs = (phases: PhaseMs) => Object.values(phases).reduce((s, ms) => s + ms, 0);

/**
 * What one task would be billed, USD, on a sandbox of `size`. It's billed from create until the task is
 * done: the start time plus the task, rounded up to the provider's minimum charge and billing increment,
 * plus its per-sandbox charge.
 *
 * Providers that bill CPU only while busy are charged for the CPU time the task really used (`cpuMillis`,
 * at least their CPU floor) plus their memory for the whole time; their minimum charge covers memory only
 * where that's how they bill (Vercel). Without `cpuMillis` they're charged as if every core was busy.
 * `billedVsList` scales the price by what the provider was measured to really bill.
 */
export function taskUsd(
  provider: ProviderId,
  size: { vcpu: number; memoryGb: number },
  createMs: number,
  taskMillis: number,
  cpuMillis?: number,
  billedVsList = 1,
): number {
  const { minSeconds, incrementSeconds, perSandboxUsd } = billingRules(provider);
  const seconds = (createMs + taskMillis) / 1000;
  const billed = Math.max(minSeconds, Math.ceil(seconds / incrementSeconds - 1e-9) * incrementSeconds);
  const full = hourlyCost(provider, size);
  const cpuFull = cpuHourlyAtFull(provider, size);
  if (cpuFull === 0 || cpuMillis === undefined) return (billedVsList * full * billed) / 3600 + perSandboxUsd;
  const { vcpuHour, cpuFloor = 0 } = info(provider).pricing;
  const vcpus = cpuFull / vcpuHour;
  const cpuSeconds = Math.max(cpuMillis / 1000, cpuFloor * vcpus * seconds);
  // Memory (and anything else that isn't CPU) is billed for the whole time, minimum included.
  return (billedVsList * ((full - cpuFull) * billed + vcpuHour * cpuSeconds)) / 3600 + perSandboxUsd;
}
