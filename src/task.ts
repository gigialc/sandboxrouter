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
 * - "repo": what a coding agent does first: fetch Node 22 and a pinned commit of a real TypeScript project
 *   (sandboxRouter itself, the 0.10.0 release), `npm ci`, then typecheck it. Needs only tar and a way to
 *   download (curl, wget or python3), so a bare image can run it.
 * - "agent": an agent loop with simulated model calls: 10 turns of waiting 6 s (the model thinking; the
 *   sandbox sits idle) and then a short Python tool call. About a minute, mostly idle, which is where
 *   providers that bill active CPU differ from ones that bill what you reserve.
 *
 * Changing a phase changes what the numbers mean: bump that task's version, and older reports stop counting.
 */
export type TaskKind = "short" | "long" | "python" | "download" | "agent" | "repo";

export interface TaskPhaseDef {
  id: string;
  label: string;
  cmd: string;
  /** Seconds the phase may take (default 300, or 900 for a repeated phase). */
  timeoutSeconds?: number;
}

export const ZERO_256_SHA256 = "a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484";
const ZERO_512_SHA256 = "9acca8e8c22201155389f65abbf6bc9723edc7384ead80503839f49dcc56d767";
export const hashZeros = (count: number, hash: string) =>
  `hash=$(head -c ${count} /dev/zero | sha256sum) && [ "${'${hash%% *}'}" = "${hash}" ]`;

const HASH_DISK: TaskPhaseDef[] = [
  // One core: hash 512 MB of zeros.
  { id: "cpu", label: "1 core", cmd: hashZeros(536870912, ZERO_512_SHA256) },
  // Two cores at once (bench asks for 2 vCPU), 256 MB each: shows whether the second vCPU is real.
  {
    id: "cores",
    label: "2 cores",
    cmd: `(${hashZeros(268435456, ZERO_256_SHA256)}) & left=$!; (${hashZeros(268435456, ZERO_256_SHA256)}) & right=$!; wait "$left"; l=$?; wait "$right"; r=$?; [ "$l" = 0 ] && [ "$r" = 0 ]`,
  },
  // Write 256 MB and flush it to disk, then delete it.
  {
    id: "disk",
    label: "disk",
    cmd: 'f=$(mktemp /tmp/sr-task.XXXXXX) || exit $?; dd if=/dev/zero of="$f" bs=1048576 count=256 conv=fsync 2> /dev/null && [ "$(wc -c < "$f")" -eq 268435456 ]; rc=$?; rm -f "$f" || exit $?; exit "$rc"',
  },
];

// 200,000 small records through JSON, a regex and a sort: the kind of thing a code-interpreter call does.
const PYTHON = [
  "import json, random, re",
  "random.seed(1)",
  "rows = [{'id': i, 'name': ''.join(random.choice('abcdefghij') for _ in range(16)), 'v': random.random()} for i in range(200000)]",
  "back = json.loads(json.dumps(rows))",
  "hits = sum(1 for r in back if re.search('abc', r['name']))",
  "top = sorted(back, key=lambda r: (r['name'], r['v']))[:10]",
  "if (hits, top[0]['id']) != (2837, 68550): raise SystemExit('Python output check failed')",
].join("\n");

// The Node.js 22.11.0 Linux release (53 MB), from nodejs.org's CDN: a real download, like installing a toolchain.
const DOWNLOAD_URL = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz";
const PY_FETCH = `import shutil, urllib.request; shutil.copyfileobj(urllib.request.urlopen('${DOWNLOAD_URL}'), open('/dev/null', 'wb'))`;

// The real-repo job's sources, pinned so every provider does exactly the same work.
const REPO_TARBALL = "https://codeload.github.com/gigialc/sandboxrouter/tar.gz/ba2b32a1a403a93acad75a707f55a2eac9368f7a";
const NODE_BASE = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux";
const FETCH = [
  "set -e",
  'case "$(uname -m)" in aarch64|arm64) A=arm64 ;; *) A=x64 ;; esac',
  `get() { if command -v curl > /dev/null; then curl -sSfL -o "$2" "$1"; elif command -v wget > /dev/null; then wget -q -O "$2" "$1"; else python3 -c "import shutil, sys, urllib.request; shutil.copyfileobj(urllib.request.urlopen(sys.argv[1]), open(sys.argv[2], 'wb'))" "$1" "$2"; fi; }`,
  "rm -rf /tmp/sr-node /tmp/sr-repo && mkdir -p /tmp/sr-node /tmp/sr-repo",
  `get "${NODE_BASE}-$A.tar.gz" /tmp/sr-node.tgz || exit $?`,
  "tar xzf /tmp/sr-node.tgz -C /tmp/sr-node --strip-components=1",
  `get "${REPO_TARBALL}" /tmp/sr-repo.tgz || exit $?`,
  "tar xzf /tmp/sr-repo.tgz -C /tmp/sr-repo --strip-components=1",
  "test -x /tmp/sr-node/bin/node && test -f /tmp/sr-repo/package-lock.json",
].join("\n");
const IN_REPO = "cd /tmp/sr-repo && PATH=/tmp/sr-node/bin:$PATH";

// One tool call in the agent loop: a little real work, like reading files and running a check.
const TOOL = "import json, hashlib; d = [{'i': i, 'h': hashlib.sha256(str(i).encode()).hexdigest()} for i in range(40000)]; print(len(json.dumps(d)))";

/** `cpuUtilization`: the hint the job's sandboxes start with (the agent loop is mostly idle), which Modal reserves and pricing uses. */
export const TASKS: Record<TaskKind, { version: string; repeat: number; phases: TaskPhaseDef[]; cpuUtilization?: number }> = {
  short: { version: "v2", repeat: 1, phases: HASH_DISK },
  long: { version: "v2-long", repeat: 40, phases: HASH_DISK },
  python: { version: "python-v2", repeat: 1, phases: [{ id: "python", label: "Python", cmd: `python3 -c "${PYTHON}"` }] },
  repo: {
    version: "repo-v2",
    repeat: 1,
    phases: [
      { id: "fetch", label: "fetch Node and the repo", cmd: FETCH, timeoutSeconds: 600 },
      { id: "install", label: "npm ci", cmd: `${IN_REPO} npm ci --no-audit --no-fund --loglevel=error`, timeoutSeconds: 900 },
      { id: "typecheck", label: "typecheck", cmd: `${IN_REPO} ./node_modules/.bin/tsc --noEmit -p .`, timeoutSeconds: 600 },
    ],
  },
  agent: {
    version: "agent-v2",
    repeat: 1,
    cpuUtilization: 0.1,
    phases: [{ id: "agent", label: "10 turns", cmd: `n=0; while [ $n -lt 10 ]; do sleep 6 && python3 -c "${TOOL}" > /dev/null || exit $?; n=$((n+1)); done` }],
  },
  download: {
    version: "download-v2",
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

const LEGACY_TASKS: Record<string, TaskKind> = {
  v1: "short", "v1-long": "long", "python-v1": "python", "repo-v1": "repo", "agent-v1": "agent", "download-v1": "download",
};

export const isCurrentTask = (version: unknown) => Object.values(TASKS).some((t) => t.version === version);

/** Legacy reports keep their original phase schema for validation and archival. */
export function taskByVersion(version: unknown): (typeof TASKS)[TaskKind] | undefined {
  return Object.values(TASKS).find((t) => t.version === version) ??
    (typeof version === "string" && Object.hasOwn(LEGACY_TASKS, version) ? TASKS[LEGACY_TASKS[version]] : undefined);
}

/** A phase's command, run `repeat` times in a row in one shell (POSIX: no seq, no brace ranges). */
export function phaseCommand(cmd: string, repeat: number): string {
  return repeat <= 1 ? cmd : `n=0; while [ $n -lt ${repeat} ]; do (${cmd}) || exit $?; n=$((n+1)); done`;
}

/** What one run of a task measured: milliseconds per phase, and the CPU time it used across all vCPUs, if the sandbox shows it. */
export interface TaskRun {
  ms: PhaseMs;
  cpuMs?: number;
  /** The busiest single core's busy time, summed over the phases: what a per-VM CPU meter scales by vCPUs. */
  maxCoreMs?: number;
}

// Wraps a phase to read /proc/stat's total CPU line before and after it, so the run also reports the CPU
// time it really used: what providers that bill active CPU charge for.
const MARK = "SRCPU";
// Every "cpu" line (the total, then one per core), joined with ";" so the reading stays on one output line.
const STAT = `grep '^cpu' /proc/stat 2> /dev/null | tr '\\n' ';'`;
const withCpu = (cmd: string) => `a=$(${STAT}); (${cmd}); rc=$?; b=$(${STAT}); echo "${MARK}|$a|$b"; exit $rc`;

/** Busy ticks on one /proc/stat cpu line: user, nice, system, irq and softirq (not idle, iowait or steal). */
const lineTicks = (line: string) => {
  const f = line.trim().split(/\s+/);
  if (!/^cpu\d*$/.test(f[0] ?? "") || f.length < 8) return undefined;
  const n = f.slice(1).map(Number);
  return n[0] + n[1] + n[2] + n[5] + n[6];
};
const perCpu = (reading: string) =>
  new Map(reading.split(";").map((l) => [l.trim().split(/\s+/)[0], lineTicks(l)] as const).filter(([k, v]) => k && v !== undefined));

/** The busiest core's busy milliseconds between two readings, or undefined without per-core lines. */
export function maxCoreMs(before: string, after: string): number | undefined {
  const a = perCpu(before);
  const b = perCpu(after);
  const cores = [...b.keys()].filter((k) => k !== "cpu" && a.has(k));
  if (!cores.length) return undefined;
  const deltas = cores.map((k) => (b.get(k)! - a.get(k)!) * 10);
  return deltas.some((d) => !(d >= 0)) ? undefined : Math.max(...deltas);
}

/** Busy CPU milliseconds between two /proc/stat "cpu" lines: user, nice, system, irq and softirq (not idle, iowait or steal), at 100 ticks a second. */
export function busyMs(before: string, after: string): number | undefined {
  const total = (reading: string) => perCpu(reading).get("cpu");
  const a = total(before);
  const b = total(after);
  return a === undefined || b === undefined || !(b >= a) ? undefined : (b - a) * 10;
}

/** Runs a standard task in `box`: milliseconds per phase (network round trip taken out) and CPU time used. Throws if a phase fails. */
export async function runTask(box: Pick<ProviderSandbox, "exec">, kind: TaskKind = "short"): Promise<TaskRun> {
  const { repeat, phases } = TASKS[kind];
  const rtt: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    if ((await box.exec("true")).exitCode !== 0) throw new Error("task round-trip probe failed");
    rtt.push(performance.now() - t);
  }
  const overhead = rtt.sort((a, b) => a - b)[1];
  const out: PhaseMs = {};
  let cpuMs: number | undefined = 0;
  let coreMs: number | undefined = 0;
  for (const p of phases) {
    const t = performance.now();
    const r = await box.exec(withCpu(phaseCommand(p.cmd, repeat)), { timeoutSeconds: p.timeoutSeconds ?? (repeat > 1 ? 900 : 300) });
    if (r.exitCode !== 0) throw new Error(`task phase ${p.id} exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 120)}`);
    out[p.id] = Math.max(1, Math.round(performance.now() - t - overhead));
    const line = r.stdout.split("\n").find((l) => l.startsWith(`${MARK}|`));
    const used = line ? busyMs(line.split("|")[1] ?? "", line.split("|")[2] ?? "") : undefined;
    cpuMs = cpuMs === undefined || used === undefined ? undefined : cpuMs + used;
    const core = line ? maxCoreMs(line.split("|")[1] ?? "", line.split("|")[2] ?? "") : undefined;
    coreMs = coreMs === undefined || core === undefined ? undefined : coreMs + core;
  }
  return { ms: out, ...(cpuMs !== undefined ? { cpuMs } : {}), ...(cpuMs !== undefined && coreMs !== undefined ? { maxCoreMs: coreMs } : {}) };
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
  size: { vcpu: number; memoryGb: number; cpuUtilization?: number },
  createMs: number,
  taskMillis: number,
  cpuMillis?: number,
  billedVsList = 1,
  reused = false,
  maxCoreMillis?: number,
): number {
  const rules = billingRules(provider);
  // Reused: the job runs in a sandbox that's already up, so there's no start, minimum, step or per-sandbox
  // fee to pay for it; only its own time.
  const { minSeconds, incrementSeconds, perSandboxUsd } = reused ? { minSeconds: 0, incrementSeconds: 1e-9, perSandboxUsd: 0 } : rules;
  const seconds = (reused ? 0 : createMs) / 1000 + taskMillis / 1000;
  const billed = reused ? seconds : Math.max(minSeconds, Math.ceil(seconds / incrementSeconds - 1e-9) * incrementSeconds);
  // Every core busy: the CPU part is then charged by what was used (cpuMillis), not by the hint.
  const full = hourlyCost(provider, { ...size, cpuUtilization: 1 });
  const cpuFull = cpuHourlyAtFull(provider, size);
  if (cpuFull === 0 || cpuMillis === undefined) return (billedVsList * full * billed) / 3600 + perSandboxUsd;
  const { vcpuHour, cpuFloor = 0, cpuMeteredPerVm } = info(provider).pricing;
  const vcpus = cpuFull / vcpuHour;
  // A per-VM meter counts every vCPU while the busiest core works.
  const perVm = cpuMeteredPerVm && maxCoreMillis !== undefined ? (vcpus * maxCoreMillis) / 1000 : 0;
  const cpuSeconds = Math.max(cpuMillis / 1000, cpuFloor * vcpus * seconds, perVm);
  // Memory (and anything else that isn't CPU) is billed for the whole time, minimum included.
  return (billedVsList * ((full - cpuFull) * billed + vcpuHour * cpuSeconds)) / 3600 + perSandboxUsd;
}
