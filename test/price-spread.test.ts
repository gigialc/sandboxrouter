import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG } from "../src/catalog.js";
import { priceSpread, withTodaysPrices, type PriceHistoryEntry } from "../src/price-index.js";

describe("priceSpread", () => {
  const spread = priceSpread(["modal"]);

  it("lists hosted providers with a price at 2 vCPU / 4 GB, cheapest first, per vCPU", () => {
    expect(spread.rows.length).toBeGreaterThan(20);
    const local = CATALOG.filter((c) => c.local).map((c) => c.id as string);
    for (const r of spread.rows) {
      expect(local).not.toContain(r.provider);
      expect(r.hourlyUsd).toBeGreaterThan(0);
      expect(r.vcpuHourUsd).toBeCloseTo(r.hourlyUsd / 2, 6);
    }
    const prices = spread.rows.map((r) => r.hourlyUsd);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(spread.rows.filter((r) => r.tested).map((r) => r.provider)).toEqual(["modal"]);
  });

  it("puts the median between the cheapest and the most expensive", () => {
    expect(spread.medianVcpuHourUsd).toBeGreaterThanOrEqual(spread.rows[0].vcpuHourUsd);
    expect(spread.medianVcpuHourUsd).toBeLessThanOrEqual(spread.rows.at(-1)!.vcpuHourUsd);
  });
});

describe("price history", () => {
  const rows = [
    { provider: "modal" as const, name: "Modal", hourlyUsd: 0.2, vcpuHourUsd: 0.1, tested: true },
    { provider: "e2b" as const, name: "E2B", hourlyUsd: 0.1, vcpuHourUsd: 0.05, tested: true },
  ];

  it("adds an entry only when a price differs from the last one", () => {
    const first = withTodaysPrices([], "2026-11-28", rows);
    expect(first).toEqual([{ date: "2026-11-28", prices: { e2b: 0.1, modal: 0.2 } }]);
    expect(withTodaysPrices(first, "2026-11-29", rows)).toBe(first);
    const cut = withTodaysPrices(first, "2026-12-03", [rows[0], { ...rows[1], hourlyUsd: 0.08 }]);
    expect(cut.map((e) => e.date)).toEqual(["2026-11-28", "2026-12-03"]);
    expect(cut[1].prices.e2b).toBe(0.08);
  });

  it("replaces the day's entry when prices change twice in a day", () => {
    const first = withTodaysPrices([], "2026-11-28", rows);
    const again = withTodaysPrices(first, "2026-11-28", [rows[0]]);
    expect(again).toEqual([{ date: "2026-11-28", prices: { modal: 0.2 } }]);
  });

  it("is current: the last recorded entry matches today's catalog", () => {
    const history = JSON.parse(readFileSync("scripts/price-history.json", "utf8")) as PriceHistoryEntry[];
    expect(withTodaysPrices(history, "2099-01-01")).toBe(history);
  });
});
