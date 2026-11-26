// Image boot benchmark: start a sandbox straight from a public registry image, with no template or snapshot
// step, and time the first start and the starts after it. Writes a report for results/. See src/image-bench.ts.
//
// Run:  node --import tsx scripts/image-bench.ts --image python:3.11-bookworm \
//         --verify "python3 --version" --contains "Python 3.11" --providers daytona,modal,northflank \
//         --label home-eu --out results/image-2026-11-26-home-eu-python.json
//
// The first start can only be measured once per image and account: after it, the provider has the image.
import { writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { parseArgs } from "node:util";
import { benchmarksPublishable, CATALOG } from "../src/catalog.js";
import { imageBench, type ImageReport } from "../src/image-bench.js";
import { contributor } from "../src/results.js";
import { Router } from "../src/router.js";
import type { ProviderId } from "../src/types.js";

const { values } = parseArgs({
  options: {
    image: { type: "string" },
    verify: { type: "string" },
    contains: { type: "string" },
    providers: { type: "string" },
    vcpu: { type: "string", default: "4" },
    memory: { type: "string", default: "8" },
    repeats: { type: "string", default: "3" },
    label: { type: "string" },
    by: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.image || !values.verify || !values.contains || !values.providers) {
  console.error("usage: image-bench.ts --image REF --verify COMMAND --contains TEXT --providers a,b,c [--vcpu 4 --memory 8 --repeats 3 --label L --by USER --out FILE]");
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
const spec = { vcpu: Number(values.vcpu), memoryGb: Number(values.memory) };
const verify = { command: values.verify, contains: values.contains };

const rows = await imageBench({
  router: new Router({ ledger: false }),
  providers: providers as ProviderId[],
  image: values.image,
  verify,
  spec,
  repeats: Number(values.repeats),
  onProgress: (m) => console.error(m),
});

const version = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const report: ImageReport = {
  tool: "sandboxrouter-image",
  version,
  date: new Date().toISOString(),
  ...(values.label ? { label: values.label } : {}),
  ...(by ? { by } : {}),
  image: values.image,
  verify,
  spec,
  repeats: Number(values.repeats),
  node: process.version,
  platform: `${platform()}-${arch()}`,
  rows: rows.filter((r) => benchmarksPublishable(r.provider)),
};
const file = values.out ?? `sandboxrouter-image-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`\n| Provider | First start | Repeat starts, median | Verified | Per hour |\n|---|---|---|---|---|`);
for (const r of rows) {
  const ms = (v?: number) => (v === undefined ? "n/a" : `${v} ms`);
  console.log(`| ${r.provider} | ${ms(r.firstCreateMs)} | ${ms(r.medianRepeatCreateMs)} | ${r.verified}/${r.verified + r.failures} | ${r.hourlyUsd === undefined ? "n/a" : `$${r.hourlyUsd.toFixed(4)}`} |`);
}
console.log(`\nsaved ${file}`);
process.exit(0);
