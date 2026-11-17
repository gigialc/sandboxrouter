import { describe, expect, it } from "vitest";
import { PUBLISHED } from "../src/published.js";
import { recommend, type PublishedData } from "../src/recommend.js";

const job = (name: string, taskUsd: number, taskMs: number, successRate = 1, runs = 10) => ({
  name,
  createMs: 1000,
  taskMs,
  taskUsd,
  reusedUsd: taskUsd / 2,
  successRate,
  runs,
  measuredAt: "2026-11-17T00:00:00Z",
});
const data: PublishedData = {
  schema: 1,
  dataThrough: "2026-11-17T00:00:00Z",
  start: {},
  jobs: { python: { a: job("A", 0.001, 4000), b: job("B", 0.002, 1000), c: job("C", 0.0005, 4000, 0.25) } },
  load: [
    {
      n: 10,
      job: "rl",
      rows: {
        a: { name: "A", n: 10, ok: 10, limited: 0, p50Ms: 500, wallMs: 5000, measuredAt: "2026-11-17T00:00:00Z" },
        b: { name: "B", n: 10, ok: 4, limited: 6, p50Ms: 400, wallMs: 5000, measuredAt: "2026-11-17T00:00:00Z" },
        c: { name: "C", n: 10, ok: 10, limited: 0, p50Ms: 900, wallMs: 5000, measuredAt: "2026-11-17T00:00:00Z" },
      },
    },
  ],
};

describe("recommend", () => {
  it("ranks per successful run: a cheap provider that fails often pays for it", () => {
    const r = recommend(data, { job: "python", priority: "cost" });
    // C costs $0.0005 but works 1 in 4 times: $0.002 per success, more than A's $0.001.
    expect(r.results.map((x) => x.provider)).toEqual(["a", "b", "c"]);
    expect(r.results[2].notes).toContain("25% of runs worked");
    expect(recommend(data, { job: "python", priority: "speed" }).results[0].provider).toBe("b");
  });

  it("uses start times under load from 10 at once, and lists providers not measured at that size after", () => {
    const r = recommend(data, { job: "python", count: 50, priority: "speed" });
    expect(r.results.map((x) => x.provider)).toEqual(["a", "c", "b"]);
    expect(r.results[0]).toMatchObject({ measuredAtOnce: 10, readyAtOnceMs: 500, secondsEach: 4.5 });
    expect(r.results[2].notes).toContain("4 of 10 completed (6 reported limit refusals)");
    expect(r.results[0].usdTotal).toBeCloseTo(0.05);
    expect(r.basis).toContain("readiness measured on batches of 10");
  });

  it("filters to the providers you name, and reuse leaves out the start", () => {
    const r = recommend(data, { job: "python", providers: ["a"], reuse: true });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ secondsEach: 4, usdEach: 0.0005 });
  });

  it("warns about conditional start fees only for fresh sandboxes", () => {
    const opts = { job: "short", count: 1_000, providers: ["boat"] } as const;
    const verified = {
      ...data,
      conditionalStartFees: PUBLISHED.conditionalStartFees,
      jobs: { short: { boat: { ...data.jobs.python!.a, name: "Boat", taskUsd: 0.000015 } } },
    };
    const fresh = recommend(verified, opts).results[0];
    expect(fresh.usdTotal).toBeCloseTo(0.015, 6);
    expect(fresh.notes).toContain("excludes $0.03–$0.07 per start above allowance");

    const reused = recommend(verified, { ...opts, reuse: true }).results[0];
    expect(reused.notes.some((note) => note.includes("start above allowance"))).toBe(false);
  });

  it("explains a workload with no current evidence", () => {
    const r = recommend(data, { job: "repo", count: 1 });
    expect(r.results).toEqual([]);
    expect(r.basis).toContain("No current verified results");
  });

  it("serves measured create timings from the bundled data", () => {
    const r = recommend(PUBLISHED, { job: "start", priority: "speed" });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every(({ provider, secondsEach }) => PUBLISHED.start[provider] && secondsEach > 0)).toBe(true);
  });
});
