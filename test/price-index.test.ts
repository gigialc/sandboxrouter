import { describe, expect, it } from "vitest";
import { hourlyCost } from "../src/catalog.js";
import { INDEX_LINES, priceIndex } from "../src/price-index.js";

describe("priceIndex", () => {
  it("has a line per standard piece of work, with a median and the cheapest provider", () => {
    const lines = priceIndex(["agent37", "boat", "maritime"]);
    expect(lines.map((l) => l.id)).toEqual(INDEX_LINES.map((l) => l.id));
    const hour = lines.find((l) => l.id === "2x4-hour")!;
    // Agent37 $0.0065, Boat $0.018, Maritime $0.022 an hour at 2 vCPU / 4 GB: the median is Boat's.
    expect(hour.providers).toBe(3);
    expect(hour.cheapest.provider).toBe("agent37");
    expect(hour.median).toBeCloseTo(hourlyCost("boat", { vcpu: 2, memoryGb: 4 }), 4);
  });

  it("prices 1,000 tool calls as a whole run each, minimum charges included", () => {
    const calls = priceIndex(["agent37", "boat", "maritime"]).find((l) => l.id === "calls-1000")!;
    // 10 s each: Agent37 bills a full minute, so the per-second Boat is cheapest.
    expect(calls.cheapest.provider).toBe("boat");
    expect(calls.cheapest.usd).toBeCloseTo(((hourlyCost("boat", { vcpu: 2, memoryGb: 4 }) * 10) / 3600) * 1000, 4);
  });
});
