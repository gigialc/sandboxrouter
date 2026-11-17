import { describe, expect, it } from "vitest";
import { burst, percentile } from "../src/burst.js";
import { burstTable, type BurstReport } from "../src/leaderboard.js";
import { validateResult } from "../src/results.js";
import { Router } from "../src/router.js";
import { FakeProvider } from "./fake.js";

// FakeProvider echoes "ran: <cmd>"; burst checks for "ok", so answer like a shell.
const shell = (id: "maritime" | "boat", refuseAfter = Infinity) => {
  const p = new FakeProvider(id);
  const create = p.create.bind(p);
  let made = 0;
  p.create = async (spec) => {
    if (++made > refuseAfter) throw new Error("429 Too Many Requests: concurrency limit");
    const box = await create(spec);
    box.exec = async (cmd: string) => ({ exitCode: 0, stdout: cmd === "echo ok" ? "ok\n" : "", stderr: "", durationMs: 1 });
    return box;
  };
  return p;
};

describe("percentile", () => {
  it("is nearest-rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.99)).toBe(99);
    expect(percentile([], 0.5)).toBeUndefined();
  });
});

describe("burst", () => {
  it("starts n at once, counts refusals for a limit apart, and prices the ones that ran", async () => {
    const router = new Router({ providers: [shell("maritime"), shell("boat", 3)], ledger: false });
    const rows = await burst({ router, providers: ["maritime", "boat"], n: 10, parallel: 2 });
    const m = rows.find((r) => r.provider === "maritime")!;
    const b = rows.find((r) => r.provider === "boat")!;
    expect(m).toMatchObject({ n: 10, ok: 10, limited: 0 });
    expect(m.p50Ms).toBeGreaterThanOrEqual(0);
    expect(m.usd).toBeGreaterThan(0);
    expect(b).toMatchObject({ n: 10, ok: 3, limited: 7 });
    // Most started first.
    expect(rows[0].provider).toBe("maritime");
  });
});

describe("burst reports", () => {
  const report = (over: Partial<BurstReport> = {}): BurstReport => ({
    tool: "sandboxrouter-burst",
    version: "0.10.0",
    date: "2026-11-17T12:00:00Z",
    label: "home-eu",
    n: 100,
    node: "v22",
    platform: "darwin-arm64",
    rows: [{ provider: "maritime", n: 100, ok: 98, limited: 2, p50Ms: 900, p95Ms: 1500, p99Ms: 2100, wallMs: 2500, usd: 0.05 }],
    ...over,
  });
  it("validates", () => {
    expect(validateResult(report(), Date.parse("2026-11-18T00:00:00Z"))).toEqual([]);
    expect(validateResult(report({ rows: [{ provider: "maritime", n: 100, ok: 99, limited: 5, wallMs: 1, p50Ms: 1 }] }), Date.parse("2026-11-18T00:00:00Z"))).toContainEqual(
      expect.stringMatching(/add up to at most n/),
    );
  });
  it("keeps each provider's latest, per kind of burst", () => {
    const rows = burstTable([report(), report({ date: "2026-11-17T13:00:00Z", rows: [{ provider: "maritime", n: 100, ok: 100, limited: 0, p50Ms: 800, wallMs: 2000 }] }), report({ task: "python-v1" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(100);
    expect(burstTable([report({ task: "python-v1" })], "python-v1")).toHaveLength(1);
  });
});
