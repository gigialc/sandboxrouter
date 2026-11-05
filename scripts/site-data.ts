// Generates web/src/data/site.json from the library itself, so the website can't drift from the code.
// Run from the repo root: node --import tsx scripts/site-data.ts
import { readFileSync, writeFileSync } from "node:fs";
import { CATALOG, hourlyCost, unfit } from "../src/catalog.js";
import { aggregate, loadReports } from "../src/leaderboard.js";
import { computerCatalog } from "../src/computers.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable } from "../src/conformance.js";

const SHAPES = [
  { vcpu: 1, memoryGb: 2 },
  { vcpu: 2, memoryGb: 4 },
  { vcpu: 4, memoryGb: 8 },
  { vcpu: 8, memoryGb: 16 },
  { vcpu: 16, memoryGb: 32 },
  { vcpu: 32, memoryGb: 128 },
];

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const reports = loadReports("results");
const conformance = new Map(conformanceTable().map((r) => [r.provider, r.run]));

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
    check: conformance.get(c.id) ?? null,
    computers: Object.keys(computerCatalog().find((d) => d.id === c.id)?.os ?? {}),
    prices: Object.fromEntries(
      SHAPES.map((s) => [`${s.vcpu}x${s.memoryGb}`, { usd: Math.round(hourlyCost(c.id, s) * 10000) / 10000, unfit: unfit(c.id, s) }]),
    ),
  })),
  checkSteps: CHECK_STEPS,
  desktops: computerCatalog(),
  leaderboard: aggregate(reports),
  submissions: reports.map((r) => ({ date: r.date, label: r.label ?? null, platform: r.platform, runs: r.runs, providers: r.rows.length })),
};

writeFileSync("web/src/data/site.json", JSON.stringify(data, null, 2) + "\n");
console.log(`site.json: ${data.providers.length} providers, ${data.desktops.length} desktop providers, ${reports.length} reports`);
