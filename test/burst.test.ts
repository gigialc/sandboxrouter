import { describe, expect, it } from "vitest";
import { burst, deal, percentile, spreadBurst } from "../src/burst.js";
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

describe("spreadBurst", () => {
  it("spreads round-robin, and moves sandboxes off a provider that hits its limit", async () => {
    const router = new Router({ providers: [shell("maritime"), shell("boat", 3)], ledger: false });
    const r = await spreadBurst({ router, providers: ["maritime", "boat"], n: 20, weights: "even" });
    expect(r).toMatchObject({ n: 20, ok: 20, failed: 0, saturated: ["boat"] });
    const boat = r.byProvider.find((b) => b.provider === "boat")!;
    const maritime = r.byProvider.find((b) => b.provider === "maritime")!;
    expect(boat.ok).toBe(3);
    expect(maritime.ok).toBe(17);
    // The ones boat refused, plus any that skipped it once it was full, moved to maritime.
    expect(maritime.spilledIn).toBeGreaterThan(0);
    expect(r.p99Ms).toBeGreaterThanOrEqual(0);
  });

  it("deals sandboxes in proportion to capacity, interleaved", () => {
    const d = deal(["maritime", "boat"], 10, { maritime: 4, boat: 1 });
    expect(d.filter((x) => x === "maritime")).toHaveLength(8);
    expect(d.slice(0, 5)).toContain("boat");
  });

  it("counts sandboxes that found no room anywhere", async () => {
    const router = new Router({ providers: [shell("maritime", 2), shell("boat", 3)], ledger: false });
    const r = await spreadBurst({ router, providers: ["maritime", "boat"], n: 10, weights: "even" });
    expect(r).toMatchObject({ ok: 5, failed: 5 });
  });
});

describe("spread reports", () => {
  const spread = (over: Record<string, unknown> = {}) => ({
    tool: "sandboxrouter-spread",
    version: "0.11.0",
    date: "2026-11-17T12:00:00Z",
    label: "home-eu",
    n: 10,
    ok: 10,
    failed: 0,
    p50Ms: 900,
    wallMs: 3000,
    usd: 0.01,
    byProvider: [
      { provider: "maritime", ok: 7, spilledIn: 2, refused: 0 },
      { provider: "boat", ok: 3, spilledIn: 0, refused: 2 },
    ],
    saturated: ["boat"],
    ...over,
  });
  it("validates", () => {
    const now = Date.parse("2026-11-18T00:00:00Z");
    expect(validateResult(spread(), now)).toEqual([]);
    expect(validateResult(spread({ ok: 9 }), now)).toContainEqual(expect.stringMatching(/add up to n/));
    expect(validateResult(spread({ byProvider: [{ provider: "nope", ok: 10, spilledIn: 0, refused: 0 }, { provider: "boat", ok: 0, spilledIn: 0, refused: 0 }] }), now)).toContainEqual(
      expect.stringMatching(/not in the catalog/),
    );
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
  it("keeps each burst size apart and preserves zero starts", () => {
    const ten = report({ n: 10, rows: [{ provider: "maritime", n: 10, ok: 10, limited: 0, p50Ms: 700, wallMs: 900 }, { provider: "boat", n: 10, ok: 0, limited: 10, wallMs: 1 }] });
    expect(burstTable([report(), ten], undefined, 10)).toEqual([
      expect.objectContaining({ provider: "maritime", n: 10, ok: 10 }),
      expect.objectContaining({ provider: "boat", n: 10, ok: 0, limited: 10 }),
    ]);
    expect(burstTable([report(), ten], undefined, 100)).toEqual([expect.objectContaining({ provider: "maritime", n: 100 })]);
  });
  it("takes a latest zero-result burst instead of resurfacing an older success", () => {
    const earlier = report({ n: 10, rows: [{ provider: "maritime", n: 10, ok: 10, limited: 0, p50Ms: 700, wallMs: 900 }] });
    const latest = report({ date: "2026-11-17T13:00:00Z", n: 10, rows: [{ provider: "maritime", n: 10, ok: 0, limited: 0, wallMs: 900, createFailures: 2, commandFailures: 8, taskFailures: 0 }] });
    expect(burstTable([earlier, latest], undefined, 10)).toMatchObject([{ provider: "maritime", n: 10, ok: 0, limited: 0, commandFailures: 8 }]);
  });
});
