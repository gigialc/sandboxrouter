// Generates web/src/data/site.json from the library itself, so the website can't drift from the code.
// Run from the repo root: node --import tsx scripts/site-data.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { benchmarksPublishable, CATALOG, hourlyCost, planLabel, unfit } from "../src/catalog.js";
import { aggregate, loadReports } from "../src/leaderboard.js";
import { computerCatalog } from "../src/computers.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable, liveStatus } from "../src/conformance.js";
import { BILLED_VS_LIST } from "../src/billing.js";
import type { CostRun } from "../src/cost.js";

const SHAPES = [
  { vcpu: 1, memoryGb: 2 },
  { vcpu: 2, memoryGb: 4 },
  { vcpu: 4, memoryGb: 8 },
  { vcpu: 8, memoryGb: 16 },
  { vcpu: 16, memoryGb: 32 },
  { vcpu: 32, memoryGb: 128 },
];

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Providers whose terms forbid publishing benchmarks are dropped from every report before anything is computed.
const reports = loadReports("results").map((r) => ({ ...r, rows: r.rows.filter((x) => benchmarksPublishable(x.provider)) }));
const rows = new Map(conformanceTable().map((r) => [r.provider, r]));
const conformance = new Map([...rows].map(([id, r]) => [id, r.run]));
const names = new Map(CATALOG.map((c) => [c.id, c.name]));

/** Every saved `cost run` (results/cost/*.json), newest first: list price × time against the provider's own bill. */
const COST_DIR = "results/cost";
const costRuns = (existsSync(COST_DIR) ? readdirSync(COST_DIR).filter((f) => f.endsWith(".json")) : [])
  .map((f) => JSON.parse(readFileSync(`${COST_DIR}/${f}`, "utf8")) as CostRun)
  .sort((a, b) => b.date.localeCompare(a.date));
const costRows = costRuns.flatMap((run) =>
  run.entries.filter((e) => benchmarksPublishable(e.provider)).map((e) => ({
    provider: e.provider,
    name: names.get(e.provider) ?? e.provider,
    date: run.date,
    minutes: run.minutes,
    load: run.load,
    by: run.by ?? null,
    requested: e.requested,
    delivered: e.delivered ? { vcpu: e.delivered.vcpu, memoryGb: Math.round((e.delivered.memoryMb / 1024) * 10) / 10 } : null,
    seconds: e.seconds ?? null,
    predictedUsd: e.predictedUsd ?? null,
    billedUsd: e.bill?.usd ?? null,
    billedSeconds: e.bill?.seconds ?? null,
    billSource: e.bill?.source ?? null,
    error: e.error ?? null,
  })),
);

const data = {
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  shapes: SHAPES.map((s) => `${s.vcpu}x${s.memoryGb}`),
  providers: CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    local: c.local ?? false,
    capabilities: c.capabilities,
    limits: c.limits,
    credentials: c.credentials,
    docs: c.docs,
    pricing: c.pricing,
    access: c.access ?? null,
    billing: c.billing,
    plan: c.plan ?? null,
    noBenchmarks: c.noBenchmarks ?? null,
    planLabel: c.local ? "none" : planLabel(c.id),
    defaultSize: c.defaultSize ? { vcpu: c.defaultSize.vcpu, memoryGb: c.defaultSize.memoryGb } : null,
    check: conformance.get(c.id) ?? null,
    live: liveStatus(rows.get(c.id)!),
    billedVsList: BILLED_VS_LIST[c.id] ?? null,
    computers: Object.keys(computerCatalog().find((d) => d.id === c.id)?.os ?? {}),
    prices: Object.fromEntries(
      SHAPES.map((s) => [`${s.vcpu}x${s.memoryGb}`, { usd: Math.round(hourlyCost(c.id, s) * 10000) / 10000, unfit: unfit(c.id, s) }]),
    ),
  })),
  checkSteps: CHECK_STEPS,
  desktops: computerCatalog(),
  leaderboard: aggregate(reports),
  costRuns: costRows,
  submissions: reports.map((r) => ({
    date: r.date,
    label: r.label ?? null,
    by: r.by ?? null,
    platform: r.platform,
    runs: r.runs,
    providers: r.rows.length,
    ids: r.rows.map((x) => x.provider),
  })),
};

writeFileSync("web/src/data/site.json", JSON.stringify(data, null, 2) + "\n");
console.log(`site.json: ${data.providers.length} providers, ${data.desktops.length} desktop providers, ${reports.length} reports`);
