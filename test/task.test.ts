import { describe, expect, it } from "vitest";
import { taskTable, type BenchReport } from "../src/leaderboard.js";
import { validateResult } from "../src/results.js";
import { runTask, TASK_PHASES, TASK_VERSION, taskMs, taskUsd } from "../src/task.js";
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

describe("taskUsd", () => {
  it("bills the start plus the task, by the second", () => {
    // Maritime: $0.022/h, per second. 1 s start + 2 s task = 3 s.
    expect(taskUsd("maritime", 0.022, 1000, 2000)).toBeCloseTo((0.022 * 3) / 3600, 12);
  });
  it("rounds up to a provider's minimum charge", () => {
    // Agent37 bills whole minutes: a 3-second job is billed 60 s.
    expect(taskUsd("agent37", 0.0065, 1000, 2000)).toBeCloseTo((0.0065 * 60) / 3600, 12);
  });
  it("adds a per-sandbox charge", () => {
    expect(taskUsd("sail", 0.031, 1000, 2000)).toBeCloseTo((0.031 * 3) / 3600 + 0.01, 12);
  });
});

describe("runTask", () => {
  it("runs every phase and takes out the round trip of an empty command", async () => {
    const ran: string[] = [];
    const box = {
      exec: async (cmd: string): Promise<ExecResult> => {
        ran.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    };
    const out = await runTask(box);
    expect(ran.slice(0, 3)).toEqual(["true", "true", "true"]);
    expect(ran.slice(3)).toEqual(TASK_PHASES.map((p) => p.cmd));
    for (const p of TASK_PHASES) expect(out[p.id]).toBeGreaterThanOrEqual(1);
  });
  it("throws when a phase fails", async () => {
    const box = { exec: async (cmd: string): Promise<ExecResult> => ({ exitCode: cmd === "true" ? 0 : 127, stdout: "", stderr: "sha256sum: not found", durationMs: 1 }) };
    await expect(runTask(box)).rejects.toThrow(/task phase cpu exited 127/);
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
    expect(rows[0].taskUsd).toBeCloseTo(taskUsd("maritime", rows[0].hourlyUsd, 1000, 2000), 12);
    expect(rows[1].minimumSeconds).toBe(60);
    expect(taskMs(rows[0].phasesMs)).toBe(2000);
  });
  it("ignores reports without the task, or from an older task version", () => {
    expect(taskTable([report({ task: undefined }), report({ task: "v0" })])).toEqual([]);
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
  it("refuses a missing or impossible phase", () => {
    expect(validateResult(report({}, { taskPhasesMs: { cpu: 1000, cores: 800 } }), NOW)).toContainEqual(expect.stringMatching(/taskPhasesMs needs/));
    expect(validateResult(report({}, { medianTaskMs: 0 }), NOW)).toContainEqual(expect.stringMatching(/medianTaskMs/));
  });
});
