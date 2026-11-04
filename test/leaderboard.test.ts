import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, loadReports, makeReport, renderLeaderboard, type BenchReport } from "../src/leaderboard.js";
import type { BenchRow } from "../src/bench.js";

const row = (provider: BenchRow["provider"], create: number, failures = 0): BenchRow => ({
  provider,
  runs: 3,
  failures,
  medianCreateMs: create,
  medianExecMs: 40,
  hourlyUsd: 0,
});
const report = (rows: BenchRow[], label?: string): BenchReport => ({
  tool: "sandboxrouter",
  version: "0.1.0",
  date: "2026-11-04T12:00:00.000Z",
  label,
  runs: 3,
  spec: { vcpu: 2, memoryGb: 4 },
  node: "v22",
  platform: "linux-x64",
  rows,
});

describe("leaderboard", () => {
  it("takes the median of each submission's medians and sorts by cold start", () => {
    const rows = aggregate([
      report([row("maritime", 900), row("e2b", 300)]),
      report([row("maritime", 1100), row("e2b", 500, 3)]),
      report([row("maritime", 1000)]),
    ]);
    expect(rows.map((r) => [r.provider, r.medianCreateMs, r.submissions])).toEqual([
      ["e2b", 400, 2],
      ["maritime", 1000, 3],
    ]);
    expect(rows[0].successRate).toBeCloseTo(0.5);
    expect(rows[1].hourlyUsd).toBeCloseTo(0.022, 4);
  });

  it("escapes submitter-controlled text", () => {
    const html = renderLeaderboard([report([row("maritime", 900)], `<img src=x onerror=alert(1)>`)]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders an empty state", () => {
    expect(renderLeaderboard([])).toContain("No results yet");
  });

  it("never puts env, metadata or error text in a shared report", () => {
    const r = makeReport([{ ...row("e2b", 300), lastError: "401 for key sk_live_123" }], {
      version: "0.1.0",
      runs: 3,
      spec: { vcpu: 2, memoryGb: 4, env: { SECRET: "x" }, metadata: { team: "y" } },
      label: "laptop",
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain("sk_live_123");
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("team");
    expect(r.spec).toEqual({ vcpu: 2, memoryGb: 4 });
  });

  it("loads only valid reports from a directory and ignores unknown providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbr-results-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify(report([row("maritime", 900), { ...row("e2b", 1), provider: "nope" as any }])));
      writeFileSync(join(dir, "b.json"), "{not json");
      writeFileSync(join(dir, "c.json"), JSON.stringify({ tool: "other" }));
      writeFileSync(join(dir, "readme.md"), "hi");
      const reports = loadReports(dir);
      expect(reports).toHaveLength(1);
      expect(aggregate(reports).map((r) => r.provider)).toEqual(["maritime"]);
      expect(loadReports(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
