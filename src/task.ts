import { billingRules } from "./catalog.js";
import type { ProviderId, ProviderSandbox } from "./types.js";

/**
 * The standard task for `bench --task`: the same fixed piece of work in every sandbox, so providers can be
 * compared on what a job costs, not just on their hourly price. A slower CPU or disk makes the job take
 * longer, and a longer job is billed more.
 *
 * Only POSIX shell and tools every Linux image has (coreutils or busybox: head, sha256sum, dd), so no
 * provider fails for lack of a package manager. Each phase is its own command, timed from here, minus the
 * sandbox's own round trip for an empty command, so network distance mostly drops out.
 *
 * Two sizes of the same job: "short" runs each phase once (seconds), "long" runs each phase 40 times in a
 * row (minutes), which shows sustained speed (CPUs that slow down after a burst) and prices where minimum
 * charges stop mattering. Changing a phase changes what the numbers mean: bump the versions, and older
 * reports stop counting.
 */
export type TaskKind = "short" | "long";

export const TASKS: Record<TaskKind, { version: string; repeat: number }> = {
  short: { version: "v1", repeat: 1 },
  long: { version: "v1-long", repeat: 40 },
};

/** The short task's version, which is what `bench --task` records. */
export const TASK_VERSION = TASKS.short.version;

export const TASK_PHASES = [
  // One core: hash 512 MB of zeros.
  { id: "cpu", label: "1 core", cmd: "head -c 536870912 /dev/zero | sha256sum > /dev/null" },
  // Two cores at once (bench asks for 2 vCPU), 256 MB each: shows whether the second vCPU is real.
  { id: "cores", label: "2 cores", cmd: "for i in 1 2; do (head -c 268435456 /dev/zero | sha256sum > /dev/null) & done; wait" },
  // Write 256 MB and flush it to disk, then delete it.
  { id: "disk", label: "disk", cmd: "dd if=/dev/zero of=/tmp/sr-task bs=1048576 count=256 conv=fsync 2> /dev/null; rm -f /tmp/sr-task" },
] as const;

export type TaskPhase = (typeof TASK_PHASES)[number]["id"];
export type PhaseMs = Record<TaskPhase, number>;

/** A phase's command, run `repeat` times in a row in one shell (POSIX: no seq, no brace ranges). */
export function phaseCommand(cmd: string, repeat: number): string {
  return repeat <= 1 ? cmd : `n=0; while [ $n -lt ${repeat} ]; do ${cmd}; n=$((n+1)); done`;
}

/** Runs the standard task in `box`: milliseconds per phase, network round trip taken out. Throws if a phase fails. */
export async function runTask(box: Pick<ProviderSandbox, "exec">, kind: TaskKind = "short"): Promise<PhaseMs> {
  const { repeat } = TASKS[kind];
  const rtt: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await box.exec("true");
    rtt.push(performance.now() - t);
  }
  const overhead = rtt.sort((a, b) => a - b)[1];
  const out = {} as PhaseMs;
  for (const p of TASK_PHASES) {
    const t = performance.now();
    const r = await box.exec(phaseCommand(p.cmd, repeat), { timeoutSeconds: repeat > 1 ? 900 : 300 });
    if (r.exitCode !== 0) throw new Error(`task phase ${p.id} exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 120)}`);
    out[p.id] = Math.max(1, Math.round(performance.now() - t - overhead));
  }
  return out;
}

/** The whole task's time: the phases added up. */
export const taskMs = (phases: PhaseMs) => TASK_PHASES.reduce((s, p) => s + phases[p.id], 0);

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
