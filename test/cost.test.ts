import { afterEach, describe, expect, it, vi } from "vitest";
import { hourlyCost } from "../src/catalog.js";
import { BILL_READERS, costMarkdown, costRun, settle, type CostRun } from "../src/cost.js";
import { Router } from "../src/router.js";
import { FakeBox, FakeProvider } from "./fake.js";

/** A fake whose sandboxes report a given size to nproc / MemTotal, and remember every command. */
class SizedProvider extends FakeProvider {
  cmds: string[] = [];
  constructor(id: "e2b" | "maritime", private size: string) {
    super(id);
  }
  async create(spec: Parameters<FakeProvider["create"]>[0]) {
    const box = (await super.create(spec)) as FakeBox;
    const exec = box.exec.bind(box);
    box.exec = async (cmd, opts) => {
      this.cmds.push(cmd);
      return cmd.includes("nproc") && cmd.includes("MemTotal") ? { exitCode: 0, stdout: `${this.size}\n`, stderr: "", durationMs: 1 } : exec(cmd, opts);
    };
    return box;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("cost run", () => {
  it("records the size each sandbox really got, keeps its cores busy, kills it and predicts list × time", async () => {
    const small = new SizedProvider("e2b", "2 482");
    const full = new SizedProvider("maritime", "2 3942");
    const router = new Router({ providers: [small, full], ledger: false });
    const run = await costRun({ router, providers: ["e2b", "maritime"], minutes: 0.002, version: "test" });

    const [e, m] = run.entries;
    // With no size given, each provider is asked for one it can take: E2B's fixed default size.
    expect(e).toMatchObject({ provider: "e2b", requested: { vcpu: 2, memoryGb: 0.5 }, delivered: { vcpu: 2, memoryMb: 482 } });
    expect(m).toMatchObject({ requested: { vcpu: 2, memoryGb: 4 }, delivered: { vcpu: 2, memoryMb: 3942 } });
    expect(e.listUsdHour).toBe(hourlyCost("e2b"));
    expect(m.deliveredUsdHour).toBeLessThan(m.listUsdHour);
    expect(e.predictedUsd).toBeCloseTo((e.listUsdHour * e.seconds!) / 3600, 6);
    expect(small.cmds.some((c) => c.includes("yes > /dev/null"))).toBe(true);
    expect([...small.live.values()].every((b) => b.killed)).toBe(true);
    expect(small.created[0]).toMatchObject({ vcpu: 2, memoryGb: 0.5 });
  });

  it("skips the CPU load with load: false, and records a failed create without throwing", async () => {
    const p = new SizedProvider("e2b", "2 482");
    const broken = new FakeProvider("maritime", { fail: "Sandbox failed to start", failStatus: 500 });
    const run = await costRun({ router: new Router({ providers: [p, broken], ledger: false }), providers: ["e2b", "maritime"], minutes: 0.001, load: false, version: "t" });
    expect(p.cmds.some((c) => c.includes("yes > /dev/null"))).toBe(false);
    expect(run.entries[1]).toMatchObject({ provider: "maritime", error: expect.stringMatching(/failed to start/) });
    expect(run.entries[1].predictedUsd).toBeUndefined();
  });
});

describe("settle", () => {
  const run = (): CostRun => ({
    tool: "sandboxrouter-cost",
    version: "t",
    date: "2026-11-06T16:00:00Z",
    minutes: 10,
    load: true,
    entries: [
      {
        provider: "maritime",
        sandboxId: "sbx-abc",
        requested: { vcpu: 2, memoryGb: 4 },
        startedAt: "2026-11-06T16:00:00Z",
        endedAt: "2026-11-06T16:10:00Z",
        seconds: 600,
        listUsdHour: 0.022,
        predictedUsd: 0.003667,
      },
    ],
  });

  it("reads Maritime's per-sandbox metered usage, in cents and seconds", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ plan: null, byMachineDay: { "sandbox:sbx-abc": [{ date: "2026-11-06", cents: 1, seconds: 598.4 }] } })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await settle(run());
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.maritime.sh/api/billing/metered-usage");
    expect(r.entries[0].bill).toMatchObject({ usd: 0.01, seconds: 598, source: expect.stringMatching(/maritime metered-usage/) });
    expect(costMarkdown(r)).toContain("| $0.0100 | 273% |");
  });

  it("leaves a row unsettled when the bill hasn't posted, and settles it on a later run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ byMachineDay: {} }))));
    const r = await settle(run());
    expect(r.entries[0].bill).toMatchObject({ source: expect.stringMatching(/not posted yet/) });
    expect(r.entries[0].bill?.usd).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ byMachineDay: { "sandbox:sbx-abc": [{ cents: 0, seconds: 600 }] } }))));
    expect((await settle(r)).entries[0].bill).toMatchObject({ usd: 0, seconds: 600 });
  });

  it("records an API error as the source instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    expect((await settle(run())).entries[0].bill?.source).toMatch(/could not read: 401 nope/);
  });

  it("says where to look for providers without a billing API", async () => {
    const r = run();
    r.entries[0].provider = "e2b";
    expect((await settle(r)).entries[0].bill?.source).toMatch(/no billing API/);
    expect(Object.keys(BILL_READERS).sort()).toEqual(["blaxel", "daytona", "e2b", "maritime", "openscale", "sail"]);
  });
});
