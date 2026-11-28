import { CATALOG, planOnlyStartFee, withOwnImages } from "./catalog.js";
import { median } from "./bench-store.js";
import { Router, rankUsd, runHours } from "./router.js";
import { VERIFIED } from "./verified.js";
import type { Provider, ProviderId, SandboxSpec } from "./types.js";

/**
 * The price index: what a few standard pieces of sandbox work cost today across the providers that passed
 * the real-account check. Each line shows the median and lowest estimated direct-provider cost (list
 * price, corrected by measured bills, with minimum charges and modeled per-sandbox fees over the run).
 * Account-specific fees, such as Boat's allowance overages, are excluded.
 */
export const INDEX_LINES = [
  { id: "2x4-hour", label: "2 vCPU / 4 GB, one hour", unit: "per hour", spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 60 }, scale: 1 },
  {
    id: "agent-hour",
    label: "Agent session, one hour at 10% CPU",
    unit: "per hour",
    spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 60, cpuUtilization: 0.1 },
    scale: 1,
  },
  { id: "calls-1000", label: "1,000 tool calls, 10 s each", unit: "per 1,000", spec: { vcpu: 2, memoryGb: 4, expectedSeconds: 10 }, scale: 1000 },
] as const satisfies readonly { id: string; label: string; unit: string; spec: SandboxSpec; scale: number }[];

export interface IndexLine {
  id: (typeof INDEX_LINES)[number]["id"];
  label: string;
  unit: string;
  /** Median across the providers that fit, USD for the line's unit of work. */
  median: number;
  cheapest: { provider: ProviderId; name: string; usd: number };
  providers: number;
}

// Stand-ins with every key "set": the index reads only the catalog, never a provider.
const stub = (id: ProviderId): Provider => ({
  id,
  configured: () => true,
  create: () => Promise.reject(new Error("the price index never starts sandboxes")),
  connect: () => Promise.reject(new Error("the price index never starts sandboxes")),
});

/** Today's index: one line per standard piece of work. */
export function priceIndex(verified: readonly ProviderId[] = Object.keys(VERIFIED) as ProviderId[]): IndexLine[] {
  const router = new Router({ providers: verified.map(stub), ledger: false, requireVerified: true, verified: [...verified] });
  return INDEX_LINES.map((line) => {
    const hours = runHours(line.spec);
    const costs = router
      // Every provider at the line's size, including those that need your own image to run it.
      .plan(withOwnImages(line.spec), { strategy: "cheapest" })
      .filter((c) => !c.skip)
      // What the unit of work costs: a run of `hours`, times how many runs the line counts.
      // Without a fee only one plan pays, like the published tables.
      .map((c) => ({ provider: c.provider, usd: (rankUsd(c, hours) * hours - planOnlyStartFee(c.provider)) * line.scale }))
      .sort((a, b) => a.usd - b.usd);
    const best = costs[0];
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    return {
      id: line.id,
      label: line.label,
      unit: line.unit,
      median: round(median(costs.map((c) => c.usd * 1e6))! / 1e6),
      cheapest: { provider: best.provider, name: CATALOG.find((p) => p.id === best.provider)!.name, usd: round(best.usd) },
      providers: costs.length,
    };
  });
}

/** The size the price spread compares providers at. */
export const SPREAD_SIZE = { vcpu: 2, memoryGb: 4 } as const;

export interface SpreadRow {
  provider: ProviderId;
  name: string;
  /** List price for a 2 vCPU / 4 GB sandbox running for an hour with every core busy. */
  hourlyUsd: number;
  /** The same, per vCPU (each with its 2 GB of memory). */
  vcpuHourUsd: number;
  /** Passed the real-account check. */
  tested: boolean;
}

/**
 * Every hosted provider's list price for the same sandbox, cheapest first, and the median: how far apart
 * prices are today. List prices only, straight from the catalog: no measured-bill correction and no fees.
 */
export function priceSpread(verified: readonly ProviderId[] = Object.keys(VERIFIED) as ProviderId[]): { size: typeof SPREAD_SIZE; medianVcpuHourUsd: number; rows: SpreadRow[] } {
  const hosted = CATALOG.filter((c) => !c.local).map((c) => c.id);
  const router = new Router({ providers: hosted.map(stub), ledger: false });
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const rows = router
    .plan(withOwnImages({ ...SPREAD_SIZE }), { strategy: "cheapest" })
    .filter((c) => !c.skip && c.listHourlyUsd > 0)
    .map((c) => ({
      provider: c.provider,
      name: CATALOG.find((p) => p.id === c.provider)!.name,
      hourlyUsd: round(c.listHourlyUsd),
      vcpuHourUsd: round(c.listHourlyUsd / SPREAD_SIZE.vcpu),
      tested: verified.includes(c.provider),
    }))
    .sort((a, b) => a.hourlyUsd - b.hourlyUsd || a.provider.localeCompare(b.provider));
  return { size: SPREAD_SIZE, medianVcpuHourUsd: round(median(rows.map((r) => r.vcpuHourUsd * 1e6))! / 1e6), rows };
}

export interface PriceHistoryEntry {
  date: string;
  /** Each provider's list price for 2 vCPU / 4 GB for an hour, USD. */
  prices: Record<string, number>;
  /** What changed, where someone wrote it down: a provider's own price change, a new provider, or a correction of ours. */
  note?: string;
}

/**
 * The history with today's prices added, if they differ from the last entry. Prices change only when the
 * catalog does, so the entry is written by the same change that edits the catalog.
 */
export function withTodaysPrices(history: PriceHistoryEntry[], today: string, rows: SpreadRow[] = priceSpread().rows): PriceHistoryEntry[] {
  const prices = Object.fromEntries([...rows].sort((a, b) => a.provider.localeCompare(b.provider)).map((r) => [r.provider, r.hourlyUsd]));
  const last = history.at(-1);
  if (last && JSON.stringify(last.prices) === JSON.stringify(prices)) return history;
  // A second change on the same day replaces that day's entry.
  const kept = last?.date === today ? history.slice(0, -1) : history;
  return [...kept, { date: today, prices }];
}
