// Steadiness benchmark: keep one sandbox per provider and run the same small job at a fixed interval, timed
// by the sandbox's own clock. Writes a report for results/. See src/steady.ts.
//
// Run:  node --import tsx scripts/steady-bench.ts --providers daytona,modal --label home-eu \
//         --out results/steady-2026-11-28-home-eu.json
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { parseArgs } from "node:util";
import { benchmarksPublishable, CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../src/catalog.js";
import { contributor } from "../src/results.js";
import { Router } from "../src/router.js";
import { steady, STEADY_VERSION, type SteadyReport } from "../src/steady.js";
import type { ProviderId } from "../src/types.js";

const { values } = parseArgs({
  options: {
    providers: { type: "string" },
    samples: { type: "string", default: "60" },
    interval: { type: "string", default: "10" },
    label: { type: "string" },
    by: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.providers) {
  console.error("usage: steady-bench.ts --providers a,b,c [--samples 60 --interval 10 --label L --by USER --out FILE]");
  process.exit(2);
}
const known = new Set<string>(CATALOG.map((c) => c.id));
const providers = values.providers.split(",").map((p) => p.trim()).filter(Boolean);
const unknown = providers.filter((p) => !known.has(p));
if (unknown.length) {
  console.error(`not in the catalog: ${unknown.join(", ")}`);
  process.exit(2);
}
const by = contributor(values.by);
const spec = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
const samples = Number(values.samples);
const intervalSeconds = Number(values.interval);

const rows = await steady({
  router: new Router({ ledger: false }),
  providers: providers as ProviderId[],
  samples,
  intervalSeconds,
  spec,
  onProgress: (m) => console.error(m),
});

const report: SteadyReport = {
  tool: "sandboxrouter-steady",
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  task: STEADY_VERSION,
  date: new Date().toISOString(),
  ...(values.label ? { label: values.label } : {}),
  ...(by ? { by } : {}),
  spec,
  samples,
  intervalSeconds,
  node: process.version,
  platform: `${platform()}-${arch()}`,
  rows: rows.filter((r) => benchmarksPublishable(r.provider as ProviderId)),
};
const file = values.out ?? `sandboxrouter-steady-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`\n| Provider | Median | 95th percentile | Slowest | Samples |\n|---|---|---|---|---|`);
for (const r of rows) {
  const ms = (v?: number) => (v === undefined ? "n/a" : `${v} ms`);
  console.log(`| ${r.provider} | ${ms(r.medianMs)} | ${ms(r.p95Ms)} | ${ms(r.maxMs)} | ${r.sampleMs.length}/${r.sampleMs.length + r.failures} |`);
}
console.log(`\nsaved ${file}`);
process.exit(0);
