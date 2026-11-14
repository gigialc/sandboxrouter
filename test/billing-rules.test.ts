import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { billedUsd, billingRules } from "../src/catalog.js";
import { billedVsList } from "../src/cost.js";
import { Router } from "../src/router.js";
import { FakeProvider } from "./fake.js";

const dir = mkdtempSync(join(tmpdir(), "sbr-billing-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("billing rules", () => {
  it("bills Agent37 in whole minutes, at least one", () => {
    expect(billingRules("agent37")).toEqual({ minSeconds: 60, incrementSeconds: 60, perSandboxUsd: 0 });
    // Measured 2026-11-14: a 16 s sandbox at $0.0065/h was billed a full minute.
    expect(billedUsd("agent37", 0.0065, 16)).toBeCloseTo(0.0065 / 60, 9);
    expect(billedUsd("agent37", 0.0065, 61)).toBeCloseTo((0.0065 * 2) / 60, 9);
  });

  it("adds Sail's fixed per-sandbox charge and bills the rest by the second", () => {
    expect(billingRules("sail").perSandboxUsd).toBe(0.01);
    expect(billedUsd("sail", 0.036, 10)).toBeCloseTo(0.01 + 0.0001, 9);
  });

  it("bills per second with no minimum where the catalog says nothing", () => {
    expect(billingRules("maritime")).toEqual({ minSeconds: 0, incrementSeconds: 1, perSandboxUsd: 0 });
    expect(billedUsd("maritime", 0.036, 10)).toBeCloseTo(0.0001, 9);
  });

  it("takes a fixed per-sandbox charge out before measuring billed against list", () => {
    // Sail's saved 10-minute run: $0.015138 billed, $0.01 of it the creation charge.
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        tool: "sandboxrouter-cost",
        date: "2026-11-06T19:13:00Z",
        entries: [{ provider: "sail", predictedUsd: 0.010385, bill: { usd: 0.015138, source: "sail /sailboxes/spend" } }],
      }),
    );
    expect(billedVsList(dir)).toEqual([{ provider: "sail", ratio: 0.495, date: "2026-11-06" }]);
  });
});

describe("ranking with a per-sandbox charge", () => {
  const router = () =>
    new Router({ providers: [new FakeProvider("sail"), new FakeProvider("koyeb")], ledger: false, verified: [], failing: [], billedVsList: { sail: 0.495 } });

  it("spreads the charge over the sandbox's lifetime, so it counts more on short sandboxes", () => {
    // Sail $0.0307/h + $0.01; Koyeb $0.0576/h. Over 30 minutes Sail costs $0.0507/h: first.
    expect(router().plan({ vcpu: 2, memoryGb: 4 }).map((c) => c.provider)).toEqual(["sail", "koyeb"]);
    // Over 5 minutes the $0.01 is $0.12/h: Koyeb first.
    expect(router().plan({ vcpu: 2, memoryGb: 4, timeoutMinutes: 5 }).map((c) => c.provider)).toEqual(["koyeb", "sail"]);
    expect(router().plan({ vcpu: 2, memoryGb: 4 }).find((c) => c.provider === "sail")?.perSandboxUsd).toBe(0.01);
  });
});
