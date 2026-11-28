import { describe, expect, it } from "vitest";
import { validateResult } from "../src/results.js";
import type { Router } from "../src/router.js";
import { sampleMs, steady, steadySummary, steadyTable, STEADY_VERSION, type SteadyReport } from "../src/steady.js";

const NOW = Date.parse("2026-11-29T00:00:00Z");
const times = (n: number, ms: number, slow: number[] = []) => Array.from({ length: n }, (_, i) => (slow.includes(i) ? ms * 2 : ms));
const row = (provider: string, sample: number[], over: Record<string, unknown> = {}) => ({
  provider, size: { vcpu: 2, memoryGb: 4 }, sampleMs: sample, ...steadySummary(sample), failures: 0, hourlyUsd: 0.1, ...over,
});
const report = (over: Record<string, unknown> = {}, rows = [row("modal", times(30, 1000))]): SteadyReport =>
  ({
    tool: "sandboxrouter-steady", version: "0.18.0", task: STEADY_VERSION, date: "2026-11-28T12:00:00Z", label: "home-eu",
    spec: { vcpu: 2, memoryGb: 4 }, samples: 30, intervalSeconds: 10, node: "v22.0.0", platform: "darwin-arm64", rows, ...over,
  }) as SteadyReport;

describe("steady samples", () => {
  it("reads a nanosecond clock and an uptime clock", () => {
    expect(sampleMs("SRSTEADY|1764331200000000000|1764331201250000000\n")).toBe(1250);
    expect(sampleMs("noise\nSRSTEADY|1042.17|1043.42\n")).toBe(1250);
  });

  it("refuses readings that are missing, mixed or not after each other", () => {
    expect(sampleMs("")).toBeUndefined();
    expect(sampleMs("SRSTEADY|%s%N|%s%N")).toBeUndefined();
    expect(sampleMs("SRSTEADY|1042.17|1764331201250000000")).toBeUndefined();
    expect(sampleMs("SRSTEADY|1043.42|1042.17")).toBeUndefined();
  });

  it("times every sample in one sandbox and counts the ones that fail", async () => {
    let n = 0;
    let killed = 0;
    const router = {
      create: async () => ({
        exec: async () => {
          n++;
          if (n === 2) throw new Error("connection reset");
          return n === 3 ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: `SRSTEADY|10.00|${(10 + n / 10).toFixed(2)}\n`, stderr: "" };
        },
        kill: async () => void killed++,
      }),
    } as unknown as Router;
    const [r] = await steady({ router, providers: ["modal"], samples: 5, intervalSeconds: 10, sleep: async () => {} });
    expect(r.sampleMs).toEqual([100, 400, 500]);
    expect(r).toMatchObject({ failures: 2, medianMs: 400, maxMs: 500, size: { vcpu: 2, memoryGb: 4 } });
    expect(killed).toBe(1);
  });

  it("reports every sample missing when the sandbox never starts", async () => {
    const router = { create: async () => { throw new Error("no capacity"); } } as unknown as Router;
    const [r] = await steady({ router, providers: ["modal"], samples: 5, sleep: async () => {} });
    expect(r).toMatchObject({ sampleMs: [], failures: 5 });
    expect(r.medianMs).toBeUndefined();
  });
});

describe("steady reports", () => {
  it("accepts a well-formed report", () => {
    expect(validateResult(report(), NOW)).toEqual([]);
    expect(validateResult(report({}, [row("modal", times(28, 1000), { failures: 2 })]), NOW)).toEqual([]);
  });

  it("refuses numbers that do not reconcile, short runs and shared errors", () => {
    expect(validateResult(report({}, [row("modal", times(30, 1000), { p95Ms: 900 })]), NOW).join()).toMatch(/p95Ms does not match/);
    expect(validateResult(report({}, [row("modal", times(29, 1000))]), NOW).join()).toMatch(/must equal the samples asked for/);
    expect(validateResult(report({ samples: 5 }, [row("modal", times(5, 1000))]), NOW).join()).toMatch(/at least 30/);
    expect(validateResult(report({}, [row("modal", times(30, 1000), { error: "account 123" })]), NOW).join()).toMatch(/errors must not be shared/);
    expect(validateResult(report({}, [row("nope", times(30, 1000))]), NOW).join()).toMatch(/not in the catalog/);
  });
});

describe("steadyTable", () => {
  it("ranks the steadiest first by the median across runs, and leaves out incomplete ones", () => {
    const older = report({ date: "2026-11-20T12:00:00Z" }, [row("modal", times(30, 1000, [1, 2, 3])), row("daytona", times(30, 520, [4, 5]))]);
    const newer = report({}, [
      row("modal", times(30, 1000)),
      row("daytona", times(30, 500, [4, 5])),
      row("e2b", times(29, 800), { failures: 1 }),
    ]);
    const stale = report({ date: "2026-10-01T12:00:00Z" }, [row("modal", times(30, 1000, [1, 2, 3]))]);
    const table = steadyTable([newer, older, stale, report({ task: "steady-v0" }, [row("vercel", times(30, 100))])]);
    expect(table.map((r) => [r.provider, r.spread, r.runs])).toEqual([["modal", 0.5, 2], ["daytona", 1, 2]]);
    expect(table[0]).toMatchObject({ spreads: [0, 1], maxMs: 2000, measuredAt: "2026-11-28T12:00:00Z" });
    expect(table[1]).toMatchObject({ medianMs: 510, maxMs: 1040 });
  });

  it("does not mix runs of another size or schedule into a row", () => {
    const small = report({ date: "2026-11-20T12:00:00Z" }, [row("modal", times(30, 1000, [1, 2, 3]), { size: { vcpu: 1, memoryGb: 1 } })]);
    expect(steadyTable([report(), small])[0]).toMatchObject({ runs: 1, spread: 0 });
  });
});
