import { CATALOG, planOnlyStartFee } from "./catalog.js";
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
      .plan(line.spec, { strategy: "cheapest" })
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
