import { describe, expect, it } from "vitest";
import { imageBench, imageTable, type ImageReport } from "../src/image-bench.js";
import { validateResult } from "../src/results.js";
import type { Router } from "../src/router.js";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const report = (over: Record<string, unknown> = {}, row: Record<string, unknown> = {}): ImageReport =>
  ({
    tool: "sandboxrouter-image",
    version: "0.17.0",
    date: "2026-11-26T12:00:00Z",
    label: "home-eu",
    image: "python:3.11-bookworm",
    verify: { command: "python3 --version", contains: "Python 3.11" },
    spec: { vcpu: 4, memoryGb: 8 },
    repeats: 3,
    node: "v22.0.0",
    platform: "darwin-arm64",
    rows: [
      { provider: "daytona", size: { vcpu: 4, memoryGb: 8 }, firstCreateMs: 13617, repeatCreateMs: [960, 1010, 801], medianRepeatCreateMs: 960, verified: 4, failures: 0, hourlyUsd: 0.3312, ...row },
    ],
    ...over,
  }) as ImageReport;

describe("image reports", () => {
  it("accepts a well-formed report, with a host, a port or a digest in the image", () => {
    expect(validateResult(report(), NOW)).toEqual([]);
    expect(validateResult(report({ image: "mcr.microsoft.com/playwright:v1.65.1-noble" }), NOW)).toEqual([]);
    expect(validateResult(report({ image: "registry.example.com:5000/team/app:1.2.0" }), NOW)).toEqual([]);
    expect(validateResult(report({ image: `python@sha256:${"a".repeat(64)}` }), NOW)).toEqual([]);
  });

  it("refuses an image with credentials, no tag, or no way to verify it", () => {
    expect(validateResult(report({ image: "user:secret@registry.example.com/app:1" }), NOW).join()).toMatch(/public registry reference/);
    expect(validateResult(report({ image: "python" }), NOW).join()).toMatch(/public registry reference/);
    expect(validateResult(report({ verify: { command: "true" } }), NOW).join()).toMatch(/verify needs/);
    expect(validateResult(report({ repeats: 1 }), NOW).join()).toMatch(/at least 3/);
  });

  it("refuses counts and medians that do not reconcile", () => {
    expect(validateResult(report({}, { medianRepeatCreateMs: 900 }), NOW).join()).toMatch(/median of repeatCreateMs/);
    expect(validateResult(report({}, { verified: 3 }), NOW).join()).toMatch(/verified must count/);
    expect(validateResult(report({}, { firstCreateMs: undefined, verified: 3 }), NOW).join()).toMatch(/without a first start/);
    expect(validateResult(report({}, { repeatCreateMs: [1, 2, 3, 4] }), NOW).join()).toMatch(/at most 3 times/);
    expect(validateResult(report({}, { error: "account 123 refused" }), NOW).join()).toMatch(/errors must not be shared/);
    expect(validateResult(report({}, { provider: "nope" }), NOW).join()).toMatch(/not in the catalog/);
  });

  it("accepts a provider whose first start failed, and keeps it off the table", () => {
    const failed = { provider: "modal", size: { vcpu: 4, memoryGb: 8 }, repeatCreateMs: [], verified: 0, failures: 1 };
    const r = report({ rows: [report().rows[0], failed] });
    expect(validateResult(r, NOW)).toEqual([]);
    expect(imageTable([r])[0].rows.map((x) => x.provider)).toEqual(["daytona"]);
  });
});

describe("imageTable", () => {
  it("groups by image, keeps each provider's latest run and sorts by repeat start", () => {
    const older = report({ date: "2026-11-20T12:00:00Z" }, { medianRepeatCreateMs: 5000, repeatCreateMs: [5000, 5000, 5000] });
    const newer = report({
      rows: [
        report().rows[0],
        { provider: "northflank", size: { vcpu: 4, memoryGb: 8 }, firstCreateMs: 7424, repeatCreateMs: [7335, 5712, 7013], medianRepeatCreateMs: 7013, verified: 4, failures: 0, hourlyUsd: 0.1333 },
      ],
    });
    const other = report({ image: "node:22-bookworm" });
    const tables = imageTable([newer, older, other]);
    expect(tables.map((t) => t.image)).toEqual(["node:22-bookworm", "python:3.11-bookworm"]);
    expect(tables[1].rows.map((r) => [r.provider, r.medianRepeatCreateMs, r.name])).toEqual([
      ["daytona", 960, "Daytona"],
      ["northflank", 7013, "Northflank"],
    ]);
    expect(tables[1].rows[0].measuredAt).toBe("2026-11-26T12:00:00Z");
  });

  it("leaves out a provider with any start that failed or was the wrong image", () => {
    const r = report({}, { repeatCreateMs: [960, 1010], medianRepeatCreateMs: 985, verified: 3, failures: 1 });
    expect(validateResult(r, NOW)).toEqual([]);
    expect(imageTable([r])).toEqual([]);
  });
});

describe("imageBench", () => {
  const fakeRouter = (stdout: (n: number) => string, failCreate = false) => {
    let creates = 0;
    const killed: number[] = [];
    const router = {
      create: async (spec: { vcpu: number; memoryGb: number; image: Record<string, string> }, route: { provider: string; fallback: boolean }) => {
        if (failCreate) throw new Error("image build failed\n  with detail");
        const n = ++creates;
        expect(spec.image).toEqual({ [route.provider]: "python:3.11-bookworm" });
        expect(route.fallback).toBe(false);
        return { size: { vcpu: spec.vcpu, memoryGb: spec.memoryGb }, exec: async () => ({ stdout: stdout(n), stderr: "", exitCode: 0 }), kill: async () => void killed.push(n) };
      },
      plan: async () => [{ listHourlyUsd: 0.25 }],
    } as unknown as Router;
    return { router, killed };
  };
  const opts = { providers: ["daytona" as const], image: "python:3.11-bookworm", verify: { command: "python3 --version", contains: "Python 3.11" }, spec: { vcpu: 4, memoryGb: 8 } };

  it("times a first start and the repeats, verifies each, and kills every sandbox", async () => {
    const { router, killed } = fakeRouter(() => "Python 3.11.18\n");
    const [row] = await imageBench({ router, ...opts });
    expect(row).toMatchObject({ provider: "daytona", verified: 4, failures: 0, hourlyUsd: 0.25, size: { vcpu: 4, memoryGb: 8 } });
    expect(row.repeatCreateMs).toHaveLength(3);
    expect(row.firstCreateMs).toBeGreaterThanOrEqual(0);
    expect(killed).toEqual([1, 2, 3, 4]);
  });

  it("does not count a sandbox that is some other image", async () => {
    const { router, killed } = fakeRouter((n) => (n === 3 ? "Python 3.12.16\n" : "Python 3.11.18\n"));
    const [row] = await imageBench({ router, ...opts });
    expect(row).toMatchObject({ verified: 3, failures: 1 });
    expect(row.repeatCreateMs).toHaveLength(2);
    expect(killed).toHaveLength(4);
  });

  it("stops after a failed first start", async () => {
    const { router } = fakeRouter(() => "", true);
    const [row] = await imageBench({ router, ...opts });
    expect(row).toMatchObject({ verified: 0, failures: 1, repeatCreateMs: [] });
    expect(row.firstCreateMs).toBeUndefined();
  });
});
