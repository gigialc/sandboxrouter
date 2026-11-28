// Assistant session benchmark: what a chat assistant with a code tool asks of a sandbox in one conversation.
// First answer, a file up and a file down, 20 short calls, and one call after a minute idle. Writes a report
// for results/. See src/assistant.ts.
//
// Run:  node --import tsx scripts/assistant-bench.ts --providers daytona,modal --label home-eu \
//         --out results/assistant-2026-11-28-home-eu.json
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { parseArgs } from "node:util";
import { assistant, ASSISTANT_CALLS, ASSISTANT_IDLE_SECONDS, ASSISTANT_VERSION, assistantFixture, type AssistantReport } from "../src/assistant.js";
import { benchmarksPublishable, CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../src/catalog.js";
import { contributor } from "../src/results.js";
import { Router } from "../src/router.js";
import type { ProviderId } from "../src/types.js";

const { values } = parseArgs({
  options: {
    providers: { type: "string" },
    runs: { type: "string", default: "3" },
    label: { type: "string" },
    by: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.providers) {
  console.error("usage: assistant-bench.ts --providers a,b,c [--runs 3 --label L --by USER --out FILE]");
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
const runs = Number(values.runs);
const fixture = assistantFixture();

const rows = await assistant({
  router: new Router({ ledger: false }),
  providers: providers as ProviderId[],
  runs,
  spec,
  onProgress: (m) => console.error(m),
});

const report: AssistantReport = {
  tool: "sandboxrouter-assistant",
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  task: ASSISTANT_VERSION,
  date: new Date().toISOString(),
  ...(values.label ? { label: values.label } : {}),
  ...(by ? { by } : {}),
  spec,
  runs,
  calls: ASSISTANT_CALLS,
  idleSeconds: ASSISTANT_IDLE_SECONDS,
  uploadBytes: Buffer.byteLength(fixture.csv),
  downloadBytes: fixture.resultBytes,
  node: process.version,
  platform: `${platform()}-${arch()}`,
  rows: rows.filter((r) => benchmarksPublishable(r.provider as ProviderId)),
};
const file = values.out ?? `sandboxrouter-assistant-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`\n| Provider | First answer | Upload | Analyse | Download | Call, median | Call, p95 | After idle | Session | Sessions |\n|---|---|---|---|---|---|---|---|---|---|`);
for (const r of [...rows].sort((a, b) => (a.firstAnswerMs ?? Infinity) - (b.firstAnswerMs ?? Infinity))) {
  const ms = (v?: number) => (v === undefined ? "n/a" : `${v} ms`);
  console.log(`| ${r.provider} | ${ms(r.firstAnswerMs)} | ${ms(r.uploadMs)} | ${ms(r.analyseMs)} | ${ms(r.downloadMs)} | ${ms(r.callMs)} | ${ms(r.callP95Ms)} | ${ms(r.idleMs)} | ${r.sessionUsd === undefined ? "n/a" : `$${r.sessionUsd.toFixed(6)}`} | ${r.sessions.length}/${r.sessions.length + r.failures} |`);
}
console.log(`\nsaved ${file}`);
process.exit(0);
