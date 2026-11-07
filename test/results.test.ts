import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_STEPS } from "../src/check.js";
import { contributor, scanText, validateResult, validateResults } from "../src/results.js";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const bench = (over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) => ({
  tool: "sandboxrouter",
  version: "0.3.0",
  date: "2026-11-06T10:00:00Z",
  label: "us-east-1, c7g.large",
  runs: 5,
  spec: {},
  node: "v22.0.0",
  platform: "linux-x64",
  rows: [{ provider: "e2b", runs: 5, failures: 0, medianCreateMs: 330, medianExecMs: 170, hourlyUsd: 0.1, ...row }],
  ...over,
});
const check = (over: Record<string, unknown> = {}) => ({
  tool: "sandboxrouter-check",
  version: "0.3.0",
  date: "2026-11-06T10:00:00Z",
  platform: "linux-x64",
  provider: "modal",
  ok: true,
  results: CHECK_STEPS.map((step) => ({ step, ms: 100, status: "pass" })),
  ...over,
});
const cost = (entry: Record<string, unknown> = {}) => ({
  tool: "sandboxrouter-cost",
  version: "0.3.0",
  date: "2026-11-06T10:00:00Z",
  minutes: 10,
  load: true,
  entries: [{ provider: "sail", requested: { vcpu: 2, memoryGb: 4 }, seconds: 600, predictedUsd: 0.01, bill: { usd: 0.015, source: "x", at: "y" }, ...entry }],
});

describe("contributor", () => {
  it("takes a GitHub username with or without @", () => {
    expect(contributor("@octo-cat")).toBe("octo-cat");
    expect(contributor("octocat")).toBe("octocat");
    expect(contributor(undefined)).toBeUndefined();
  });
  it("refuses things that aren't usernames", () => {
    for (const bad of ["", "a b", "me@example.com", "-lead", "trail-", "x".repeat(40), "<script>"]) expect(() => contributor(bad)).toThrow(/GitHub username/);
  });
});

describe("validateResult", () => {
  it("accepts well-formed bench, check and cost files", () => {
    expect(validateResult(bench(), NOW)).toEqual([]);
    expect(validateResult(bench({ by: "octocat" }), NOW)).toEqual([]);
    expect(validateResult(check(), NOW)).toEqual([]);
    expect(validateResult(cost(), NOW)).toEqual([]);
  });

  it("refuses unknown formats and providers", () => {
    expect(validateResult([], NOW)[0]).toMatch(/not a result file/);
    expect(validateResult({ tool: "other" }, NOW)[0]).toMatch(/unknown tool/);
    expect(validateResult(bench({}, { provider: "acme" }), NOW).join()).toMatch(/"acme" is not in the catalog/);
    expect(validateResult(check({ provider: "acme" }), NOW).join()).toMatch(/not in the catalog/);
    expect(validateResult(cost({ provider: "acme" }), NOW).join()).toMatch(/not in the catalog/);
  });

  it("refuses impossible numbers", () => {
    expect(validateResult(bench({ runs: 1 }), NOW).join()).toMatch(/at least 3/);
    expect(validateResult(bench({}, { medianCreateMs: 0 }), NOW).join()).toMatch(/medianCreateMs/);
    expect(validateResult(bench({}, { medianCreateMs: -5 }), NOW).join()).toMatch(/medianCreateMs/);
    expect(validateResult(bench({}, { failures: 6 }), NOW).join()).toMatch(/failures/);
    expect(validateResult(bench({}, { medianCreateMs: undefined }), NOW).join()).toMatch(/no medianCreateMs/);
    expect(validateResult(cost({ predictedUsd: -1 }), NOW).join()).toMatch(/predictedUsd/);
    expect(validateResult(cost({ bill: { usd: -0.01 } }), NOW).join()).toMatch(/bill.usd/);
    expect(validateResult(check({ results: [{ step: "made up", ms: 1, status: "pass" }] }), NOW).join()).toMatch(/unknown check step/);
  });

  it("refuses dates in the future or before the project", () => {
    expect(validateResult(bench({ date: "2027-01-01T00:00:00Z" }), NOW).join()).toMatch(/future/);
    expect(validateResult(bench({ date: "2020-01-01T00:00:00Z" }), NOW).join()).toMatch(/before/);
    expect(validateResult(bench({ date: "yesterday" }), NOW).join()).toMatch(/ISO/);
  });

  it("refuses labels that give away where someone lives", () => {
    for (const label of ["12 Main Street, Springfield", "221B Baker St", "Calle Mayor 5, Madrid", "Berlin, Apt 4", "me@example.com", "10.0.0.12"]) {
      expect(validateResult(bench({ label }), NOW).join(), label).toMatch(/label/);
    }
    for (const label of ["Berlin, home fiber", "us-east-1, c7g.large", "home laptop, Europe (CET)", "GitHub Actions ubuntu-latest", "eu-west-2"]) {
      expect(validateResult(bench({ label }), NOW), label).toEqual([]);
    }
  });

  it("refuses shared error messages and bad contributor names", () => {
    expect(validateResult(bench({}, { lastError: "boom" }), NOW).join()).toMatch(/lastError/);
    expect(validateResult(bench({ by: "@octocat" }), NOW).join()).toMatch(/username/);
  });
});

describe("scanText", () => {
  it("finds key shapes and prints only a prefix", () => {
    const fake = "e2b_" + "a1".repeat(15);
    const hits = scanText(JSON.stringify({ detail: `using ${fake}` }));
    expect(hits.join()).toMatch(/E2B key/);
    expect(hits.join()).not.toContain(fake);
    expect(scanText("Authorization: Bearer " + "x".repeat(30)).join()).toMatch(/bearer/);
    expect(scanText('"E2B_API_KEY": "' + "z".repeat(20) + '"').join()).toMatch(/key=value/);
  });
  it("finds emails and IP addresses, and leaves sandbox ids and versions alone", () => {
    expect(scanText("ran by jane@example.com").join()).toMatch(/email/);
    expect(scanText("host 203.0.113.9").join()).toMatch(/IP address/);
    expect(scanText('{"sandboxId":"sail:sb_c1a48053-027b-441f-aa43-88c5c3872b47","version":"0.3.0","node":"v22.22.0"}')).toEqual([]);
  });
});

describe("validateResults", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "sr-results-"));
    mkdirSync(join(d, "conformance"));
    writeFileSync(join(d, "README.md"), "notes");
    writeFileSync(join(d, "price-audit-2026-11-05.json"), "[]");
    return d;
  };

  it("passes a clean directory and skips notes and price audits", () => {
    const d = dir();
    writeFileSync(join(d, "bench-a.json"), JSON.stringify(bench()));
    writeFileSync(join(d, "conformance", "modal.json"), JSON.stringify(check()));
    expect(validateResults(d, { now: NOW })).toEqual([]);
  });

  it("reports bad JSON, stray files and secrets per file", () => {
    const d = dir();
    writeFileSync(join(d, "broken.json"), "{");
    writeFileSync(join(d, "notes.txt"), "hi");
    writeFileSync(join(d, "leak.json"), JSON.stringify(bench({ label: "dtn_" + "q".repeat(24) })));
    const problems = validateResults(d, { now: NOW }).map((i) => `${i.file.split("/").pop()}: ${i.problem}`);
    expect(problems.join("\n")).toMatch(/broken.json: is not valid JSON/);
    expect(problems.join("\n")).toMatch(/notes.txt: only .json/);
    expect(problems.join("\n")).toMatch(/leak.json: looks like a Daytona key/);
  });

  it("refuses edits and deletions of bench reports in a PR, but not new runs, checks or cost settles", () => {
    const d = dir();
    const changed = [
      { status: "A", path: `${d}/bench-new.json` },
      { status: "M", path: `${d}/bench-old.json` },
      { status: "D", path: `${d}/bench-gone.json` },
      { status: "M", path: `${d}/conformance/modal.json` },
      { status: "M", path: `${d}/cost/cost-1.json` },
      { status: "M", path: `${d}/README.md` },
    ];
    const problems = validateResults(d, { changed, now: NOW });
    expect(problems.map((p) => p.file.split("/").pop())).toEqual(["bench-old.json", "bench-gone.json"]);
  });
});
