import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { RouterError } from "../src/types.js";
import { FakeProvider } from "./fake.js";

// Agent37 $0.0065/h billed in whole minutes; Maritime $0.022/h by the second; Sail $0.062/h + $0.01 a sandbox.
const router = () =>
  new Router({
    providers: [new FakeProvider("agent37"), new FakeProvider("maritime"), new FakeProvider("sail")],
    ledger: false,
    verified: [],
    failing: [],
    billedVsList: {},
  });
const spec = { vcpu: 2, memoryGb: 4 };

describe('strategy "cheapest"', () => {
  it("ranks by what the run costs, not the hourly price alone", () => {
    // 10 s: Agent37 bills a full minute ($0.039/h for the run), Maritime $0.022/h, Sail's $0.01 dwarfs both.
    expect(router().plan({ ...spec, expectedSeconds: 10 }, { strategy: "cheapest" }).map((c) => c.provider)).toEqual(["maritime", "agent37", "sail"]);
    // 30 minutes: Agent37's minute no longer matters.
    expect(router().plan(spec, { strategy: "cheapest" }).map((c) => c.provider)).toEqual(["agent37", "maritime", "sail"]);
  });
});

describe("maxHourlyUsd", () => {
  it("skips providers whose run would cost more per hour, counting minimums and per-sandbox charges", () => {
    const plan = router().plan({ ...spec, expectedSeconds: 10 }, { maxHourlyUsd: 0.03 });
    expect(plan.filter((c) => !c.skip).map((c) => c.provider)).toEqual(["maritime"]);
    expect(plan.find((c) => c.provider === "agent37")?.skip).toMatch(/^over your price cap: \$0\.039\/h for this run, cap \$0\.03\/h/);
    // Over 30 minutes Agent37 is under the same cap.
    expect(router().plan(spec, { maxHourlyUsd: 0.03 }).filter((c) => !c.skip).map((c) => c.provider)).toEqual(["agent37", "maritime"]);
  });

  it("says which provider is cheapest when the cap leaves nothing", async () => {
    await expect(router().create({ ...spec, expectedSeconds: 10 }, { maxHourlyUsd: 0.001 })).rejects.toThrow(
      /every provider you have keys for is over your price cap \(maxHourlyUsd\)\. Cheapest: maritime, \$0\.022\/h for this run, cap \$0\.001\/h/,
    );
  });

  it("must be a positive number", () => {
    expect(() => router().plan(spec, { maxHourlyUsd: 0 })).toThrow(/maxHourlyUsd must be a positive number/);
  });
});

describe("quote", () => {
  it("names the provider a create would use and what the run costs there", () => {
    const q = router().quote({ ...spec, expectedSeconds: 10 });
    expect(q).toMatchObject({ provider: "maritime", runSeconds: 10, hourlyUsd: 0.022 });
    expect(q.estimatedUsd).toBeCloseTo((0.022 * 10) / 3600, 9);
    const a = router().quote({ ...spec, expectedSeconds: 10 }, { provider: "agent37" });
    expect(a).toMatchObject({ provider: "agent37", minimumSeconds: 60, billedInSecondsOf: 60 });
    expect(a.estimatedUsd).toBeCloseTo(0.0065 / 60, 9);
    const s = router().quote({ ...spec, expectedSeconds: 10 }, { provider: "sail" });
    expect(s.perSandboxUsd).toBe(0.01);
    expect(s.estimatedUsd).toBeCloseTo(0.01 + (0.062 * 10) / 3600, 6);
  });

  it("throws the create's reason when nothing fits", () => {
    expect(() => router().quote(spec, { maxHourlyUsd: 0.001 })).toThrow(RouterError);
  });
});

describe("server", () => {
  const listen = async (hooks = {}) => {
    const server = createApp(router(), "t", [], hooks);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    return { server, base };
  };

  it("answers POST /v1/quote", async () => {
    const { server, base } = await listen();
    try {
      const r = await fetch(`${base}/v1/quote`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: JSON.stringify({ ...spec, expectedSeconds: 10, maxHourlyUsd: 0.03 }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).provider).toBe("maritime");
    } finally {
      server.close();
    }
  });

  it("routes each caller through routerFor", async () => {
    const mine = new Router({ providers: [new FakeProvider("boat")], ledger: false, verified: [], failing: [], billedVsList: {} });
    const { server, base } = await listen({ routerFor: () => mine });
    try {
      const r = await fetch(`${base}/v1/sandboxes`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      });
      const sbx = await r.json();
      expect(sbx.provider).toBe("boat");
      const e = await fetch(`${base}/v1/sandboxes/${encodeURIComponent(sbx.id)}/exec`, {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "echo hi" }),
      });
      expect(e.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
