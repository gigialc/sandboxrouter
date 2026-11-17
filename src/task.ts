import { billingRules } from "./catalog.js";
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

/** Runs a standard task in `box`: milliseconds per phase, network round trip taken out. Throws if a phase fails. */
export async function runTask(box: Pick<ProviderSandbox, "exec">, kind: TaskKind = "short"): Promise<PhaseMs> {
  const { repeat, phases } = TASKS[kind];
  const rtt: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await box.exec("true");
    rtt.push(performance.now() - t);
  }
  const overhead = rtt.sort((a, b) => a - b)[1];
  const out: PhaseMs = {};
  for (const p of phases) {
    const t = performance.now();
    const r = await box.exec(phaseCommand(p.cmd, repeat), { timeoutSeconds: repeat > 1 ? 900 : 300 });
    if (r.exitCode !== 0) throw new Error(`task phase ${p.id} exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 120)}`);
    out[p.id] = Math.max(1, Math.round(performance.now() - t - overhead));
  }
  return out;
}

/** The whole task's time: the phases added up. */
export const taskMs = (phases: PhaseMs) => Object.values(phases).reduce((s, ms) => s + ms, 0);

/**
 * What one task would be billed, USD: the sandbox is billed from create until it's done, so the seconds
 * are the start time plus the task, rounded up to the provider's minimum charge and billing increment,
 * plus its per-sandbox charge. `hourlyUsd` is the price for the size it ran at.
 */
export function taskUsd(provider: ProviderId, hourlyUsd: number, createMs: number, taskMillis: number): number {
  const { minSeconds, incrementSeconds, perSandboxUsd } = billingRules(provider);
  const seconds = (createMs + taskMillis) / 1000;
  const billed = Math.max(minSeconds, Math.ceil(seconds / incrementSeconds - 1e-9) * incrementSeconds);
  return (hourlyUsd * billed) / 3600 + perSandboxUsd;
}
