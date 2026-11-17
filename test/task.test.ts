import { describe, expect, it } from "vitest";
import { taskTable, type BenchReport } from "../src/leaderboard.js";
import { validateResult } from "../src/results.js";
import { bench } from "../src/bench.js";
import { rankUsd, Router } from "../src/router.js";
import { busyMs, phaseCommand, runTask, TASK_PHASES, TASK_VERSION, TASKS, taskMs, taskUsd } from "../src/task.js";
import { cpuHourlyAtFull, hourlyCost } from "../src/catalog.js";
import { FakeProvider } from "./fake.js";
import type { ExecResult } from "../src/types.js";

const phases = { cpu: 1000, cores: 800, disk: 200 };
const report = (over: Partial<BenchReport> = {}, row: Record<string, unknown> = {}): BenchReport => ({
  tool: "sandboxrouter",
  version: "0.9.0",
  date: "2026-11-17T10:00:00Z",
  label: "home-eu",
  runs: 3,
  spec: { vcpu: 2, memoryGb: 4 },
  task: TASK_VERSION,
  node: "v22.0.0",
  platform: "darwin-arm64",
  rows: [{ provider: "maritime", runs: 3, failures: 0, medianCreateMs: 1000, medianExecMs: 100, hourlyUsd: 0.022, medianTaskMs: 2000, taskPhasesMs: phases, ...row }],
  ...over,
});

const size = { vcpu: 2, memoryGb: 4 };

describe("taskUsd", () => {
  it("bills the start plus the task, by the second", () => {
    // Maritime bills allocated capacity per second. 1 s start + 2 s task = 3 s.
    expect(taskUsd("maritime", size, 1000, 2000)).toBeCloseTo((hourlyCost("maritime", size) * 3) / 3600, 12);
  });
  it("rounds up to a provider's minimum charge", () => {
    // Agent37 bills whole minutes: a 3-second job is billed 60 s.
    expect(taskUsd("agent37", size, 1000, 2000)).toBeCloseTo((hourlyCost("agent37", size) * 60) / 3600, 12);
  });
  it("adds a per-sandbox charge", () => {
    expect(taskUsd("sail", size, 1000, 2000)).toBeCloseTo((hourlyCost("sail", size) * 3) / 3600 + 0.01, 12);
  });
  it("charges active-CPU providers for the CPU used, with Vercel's minimum on memory only", () => {
    // Vercel: 4 GB x $0.0212 for the 60 s minimum, plus 1.5 vCPU-seconds at $0.128 (no minimum on CPU).
    expect(taskUsd("vercel", size, 1000, 2000, 1500)).toBeCloseTo((4 * 0.0212 * 60 + 0.128 * 1.5) / 3600, 12);
    // Without a CPU reading it's every core busy for the minimum, as before.
    expect(taskUsd("vercel", size, 1000, 2000)).toBeCloseTo((hourlyCost("vercel", size) * 60) / 3600, 12);
  });
  it("never charges less CPU than a provider's floor", () => {
    // Tensorlake bills at least 20% of 2 vCPUs: 3 s x 2 x 0.2 = 1.2 vCPU-seconds, even for an idle task.
    const mem = hourlyCost("tensorlake", size) - cpuHourlyAtFull("tensorlake", size);
    expect(taskUsd("tensorlake", size, 1000, 2000, 0)).toBeCloseTo((mem * 3 + 0.07 * 1.2) / 3600, 12);
  });
  it("scales by what the provider was measured to bill", () => {
    expect(taskUsd("maritime", size, 1000, 2000, undefined, 0.5)).toBeCloseTo((hourlyCost("maritime", size) * 3 * 0.5) / 3600, 12);
  });
});

describe("active-CPU pricing", () => {
  it("scales only the CPU part by cpuUtilization", () => {
    expect(hourlyCost("vercel", { ...size, cpuUtilization: 0.1 })).toBeCloseTo(2 * 0.128 * 0.1 + 4 * 0.0212, 9);
    expect(hourlyCost("vercel", size)).toBeCloseTo(2 * 0.128 + 4 * 0.0212, 9);
  });
  it("leaves providers that bill allocated capacity alone, Modal included (it bills its reservation)", () => {
    expect(hourlyCost("e2b", { ...size, cpuUtilization: 0.1 })).toBe(hourlyCost("e2b", size));
    expect(hourlyCost("modal", { ...size, cpuUtilization: 0.1 })).toBe(hourlyCost("modal", size));
  });
  it("keeps Tensorlake's 20% CPU floor", () => {
    expect(hourlyCost("tensorlake", { ...size, cpuUtilization: 0.05 })).toBeCloseTo(2 * 0.07 * 0.2 + 4 * 0.015, 9);
  });
  it("ranks a short Vercel run with the one-minute minimum on memory only", () => {
    const router = new Router({ providers: [new FakeProvider("vercel")], ledger: false, verified: [], failing: [], billedVsList: {} });
    const [c] = router.plan({ ...size, cpuUtilization: 0.1, expectedSeconds: 10 });
    // Per hour of this 10 s run: memory billed 60 s, CPU 10 s at 10%.
    const expected = (4 * 0.0212 * 60 + 2 * 0.128 * 0.1 * 10) / 10;
    expect(rankUsd(c, 10 / 3600)).toBeCloseTo(expected, 4);
  });
  it("refuses a cpuUtilization outside (0, 1]", () => {
    const router = new Router({ providers: [new FakeProvider("vercel")], ledger: false });
    expect(() => router.plan({ cpuUtilization: 1.5 })).toThrow(/cpuUtilization/);
    expect(() => router.plan({ cpuUtilization: 0 })).toThrow(/cpuUtilization/);
  });
});

const stat = (user: number, system: number) => `cpu ${user} 0 ${system} 5000 3 0 0 0 0 0`;

describe("runTask", () => {
  const box = (ran: string[], out = "") => ({
    exec: async (cmd: string): Promise<ExecResult> => {
      ran.push(cmd);
      return { exitCode: 0, stdout: cmd === "true" ? "" : out, stderr: "", durationMs: 1 };
    },
  });
  it("runs every phase, takes out the round trip of an empty command, and reads CPU used from /proc/stat", async () => {
    const ran: string[] = [];
    // 100 + 20 more ticks of user and system time between the readings: 1.2 s of CPU per phase.
    const out = await runTask(box(ran, `ran\nSRCPU|${stat(1000, 500)}|${stat(1100, 520)}\n`));
    expect(ran.slice(0, 3)).toEqual(["true", "true", "true"]);
    TASK_PHASES.forEach((p, i) => expect(ran[3 + i]).toContain(p.cmd));
    for (const p of TASK_PHASES) expect(out.ms[p.id]).toBeGreaterThanOrEqual(1);
    expect(out.cpuMs).toBe(1200 * TASK_PHASES.length);
  });
  it("leaves CPU time out when the sandbox doesn't show /proc/stat", async () => {
    const out = await runTask(box([], "SRCPU||\n"));
    expect(out.cpuMs).toBeUndefined();
  });
  it("runs each phase 40 times in one shell for the long job", async () => {
    const ran: string[] = [];
    await runTask(box(ran), "long");
    TASK_PHASES.forEach((p, i) => expect(ran[3 + i]).toContain(phaseCommand(p.cmd, 40)));
    expect(phaseCommand("x", 40)).toBe("n=0; while [ $n -lt 40 ]; do x; n=$((n+1)); done");
    expect(phaseCommand("x", 1)).toBe("x");
  });
  it("throws when a phase fails", async () => {
    const failing = { exec: async (cmd: string): Promise<ExecResult> => ({ exitCode: cmd === "true" ? 0 : 127, stdout: "", stderr: "sha256sum: not found", durationMs: 1 }) };
    await expect(runTask(failing)).rejects.toThrow(/task phase cpu exited 127/);
  });
  it("counts busy ticks only: not idle, iowait or steal", () => {
    expect(busyMs("cpu 10 1 5 100 50 2 3 7", "cpu 20 1 6 900 90 2 4 70")).toBe((10 + 1 + 1) * 10);
    expect(busyMs("garbage", "cpu 1 1 1 1 1 1 1 1")).toBeUndefined();
  });
});

describe("taskTable", () => {
  it("prices each provider's task and puts the cheapest first", () => {
    const rows = taskTable([
      report({}, {}),
      report({ date: "2026-11-17T11:00:00Z" }, { provider: "agent37", hourlyUsd: 0.0065 }),
    ]);
    expect(rows.map((r) => r.provider)).toEqual(["maritime", "agent37"]);
    expect(rows[0].taskMs).toBe(2000);
    expect(rows[0].taskUsd).toBeCloseTo(taskUsd("maritime", rows[0].size, 1000, 2000), 12);
    expect(rows[1].minimumSeconds).toBe(60);
    expect(taskMs(rows[0].phasesMs)).toBe(2000);
  });
  it("keeps the short and long jobs apart", () => {
    const reports = [report({}, { medianTaskMs: 2000 }), report({ task: TASKS.long.version }, { medianTaskMs: 80000 })];
    expect(taskTable(reports)[0].taskMs).toBe(2000);
    expect(taskTable(reports, TASKS.long.version)[0].taskMs).toBe(80000);
  });
  it("prices the Python and download jobs from their own phases", () => {
    const rows = taskTable([report({ task: TASKS.download.version }, { medianTaskMs: 900, taskPhasesMs: { download: 900 } })], TASKS.download.version);
    expect(rows[0].phasesMs).toEqual({ download: 900 });
    expect(taskTable([report()], TASKS.python.version)).toEqual([]);
  });
  it("ignores reports without the task, or from an older task version", () => {
    expect(taskTable([report({ task: undefined }), report({ task: "v0" })])).toEqual([]);
  });
  it("drops a CPU reading the sandbox's own vCPUs couldn't have produced (a container showing the host)", () => {
    // Vercel, 2 vCPU, 2 s task: at most about 4 s of CPU. 3 s counts; 30 s is the host's.
    const ok = taskTable([report({}, { provider: "vercel", medianTaskCpuMs: 3000 })]);
    expect(ok[0].cpuMs).toBe(3000);
    const host = taskTable([report({}, { provider: "vercel", medianTaskCpuMs: 30000 })]);
    expect(host[0].cpuMs).toBeUndefined();
    expect(host[0].taskUsd).toBeCloseTo(taskUsd("vercel", host[0].size, 1000, 2000), 12);
  });
  it("keeps each location's latest run, then takes the median across locations", () => {
    const rows = taskTable([
      report({ date: "2026-11-01T00:00:00Z" }, { medianTaskMs: 9000 }),
      report({ date: "2026-11-02T00:00:00Z" }, { medianTaskMs: 3000 }),
      report({ label: "us-east-1" }, { medianTaskMs: 5000 }),
    ]);
    expect(rows[0].taskMs).toBe(4000);
  });
});

describe("validateResult with task times", () => {
  const NOW = Date.parse("2026-11-18T00:00:00Z");
  it("accepts a report from bench --task", () => {
    expect(validateResult(report(), NOW)).toEqual([]);
  });
  it("refuses task times without the task version", () => {
    expect(validateResult(report({ task: undefined }), NOW)).toContainEqual(expect.stringMatching(/doesn't say which task/));
  });
  it("checks each job against its own phases", () => {
    const py = report({ task: TASKS.python.version }, { medianTaskMs: 1500, taskPhasesMs: { python: 1500 } });
    expect(validateResult(py, NOW)).toEqual([]);
    expect(validateResult(report({ task: TASKS.python.version }), NOW)).toContainEqual(expect.stringMatching(/taskPhasesMs needs python/));
    expect(validateResult(report({ task: "made-up" }), NOW)).toContainEqual(expect.stringMatching(/unknown task "made-up"/));
  });
  it("refuses a missing or impossible phase", () => {
    expect(validateResult(report({}, { taskPhasesMs: { cpu: 1000, cores: 800 } }), NOW)).toContainEqual(expect.stringMatching(/taskPhasesMs needs/));
    expect(validateResult(report({}, { medianTaskMs: 0 }), NOW)).toContainEqual(expect.stringMatching(/medianTaskMs/));
  });
});

describe("bench", () => {
  it("benches providers in parallel and runs the task in each", async () => {
    // FakeProvider echoes "ran: <cmd>", which bench's `echo ok` check rejects: answer like a shell instead.
    const shell = (id: "maritime" | "boat" | "agent37") => {
      const p = new FakeProvider(id);
      const create = p.create.bind(p);
      p.create = async (spec) => {
        const box = await create(spec);
        box.exec = async (cmd: string) => ({ exitCode: 0, stdout: cmd === "echo ok" ? "ok\n" : "", stderr: "", durationMs: 1 });
        return box;
      };
      return p;
    };
    const router = new Router({ providers: [shell("maritime"), shell("boat"), shell("agent37")], ledger: false });
    const rows = await bench({ router, runs: 1, task: "short", parallel: 2, benchFile: "/dev/null" });
    expect(rows.map((r) => r.provider).sort()).toEqual(["agent37", "boat", "maritime"]);
    for (const r of rows) expect(Object.keys(r.taskPhasesMs ?? {})).toEqual(TASK_PHASES.map((p) => p.id));
  });
});
