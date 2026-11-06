import { describe, expect, it } from "vitest";
import { CATALOG, hourlyCost, listingOrder, planLabel, unfit } from "../src/catalog.js";
import { liveStatus } from "../src/conformance.js";

describe("listing order", () => {
  it("lists open sign-ups cheapest first, then gated, then ones that can't take the size, then Docker", () => {
    const rows = listingOrder();
    const rank = (c: (typeof rows)[number]) => (c.local ? 3 : unfit(c.id, {}) ? 2 : c.access ? 1 : 0);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      expect(rank(a)).toBeLessThanOrEqual(rank(b));
      if (rank(a) === rank(b)) {
        const d = hourlyCost(a.id) - hourlyCost(b.id);
        expect(d < 0 || (d === 0 && a.id < b.id)).toBe(true);
      }
    }
    expect(rows.at(-1)!.id).toBe("docker");
    expect(rows.length).toBe(CATALOG.length);
  });

  it("puts a waitlisted provider after every open one that fits", () => {
    const ids = listingOrder().map((c) => c.id);
    const lastOpen = Math.max(...listingOrder().filter((c) => !c.local && !c.access && !unfit(c.id, {})).map((c) => ids.indexOf(c.id)));
    expect(ids.indexOf("instabox")).toBeGreaterThan(lastOpen);
  });
});

describe("plan and billing", () => {
  it("labels plans", () => {
    expect(planLabel("e2b")).toBe("none");
    expect(planLabel("maritime")).toBe("$20/mo (credited)");
    expect(planLabel("cloudflare")).toBe("$5/mo");
    expect(planLabel("superserve")).toBe("maybe $20/mo (credited)");
  });

  it("gives every provider a billing model", () => {
    for (const c of CATALOG) expect(["allocated", "active-cpu"]).toContain(c.billing);
  });
});

describe("liveStatus", () => {
  const base = { provider: "e2b" as const, name: "E2B" };
  const run = { date: "2026-11-06T01:00:00Z", version: "0.2.0", passed: 14, failed: [], skipped: [], notRun: [], notes: [], steps: {} };
  it("says untested, passed or failing", () => {
    expect(liveStatus({ ...base, run: null })).toEqual({ status: "untested", label: "not run yet" });
    expect(liveStatus({ ...base, run })).toEqual({ status: "passed", label: "passed (2026-11-06)" });
    expect(liveStatus({ ...base, run: { ...run, failed: [{ step: "create" }] } }).status).toBe("failing");
  });
});
