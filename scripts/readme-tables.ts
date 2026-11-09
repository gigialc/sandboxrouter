// Builds the docs' generated tables from the code, so they can't drift: Prices (catalog) in README.md,
// Env (credentials) and Compatibility (saved `check --save` runs) in docs/reference.md.
// Run: node --import tsx scripts/readme-tables.ts           print them
//      node --import tsx scripts/readme-tables.ts --write   replace them in those files
import { readFileSync, writeFileSync } from "node:fs";
import { CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, accessLabel, hourlyCost, listingOrder, planLabel, unfit } from "../src/catalog.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable, liveStatus } from "../src/conformance.js";

// The Prices table is for the router's default size, asked for explicitly.
const SIZE = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
const rows = listingOrder(SIZE);
const order = new Map(rows.map((c, i) => [c.id, i]));
const live = new Map(conformanceTable().map((r) => [r.provider, liveStatus(r)]));

// Billing fine print (per-provider notes) lives on each provider's page on the site, not here.
const prices = ["| Provider | $/hr | Plan needed | Real-account check | Source |", "|---|---|---|---|---|"];
for (const c of rows) {
  const why = unfit(c.id, SIZE);
  const cost = `$${hourlyCost(c.id, SIZE).toFixed(3)}`;
  const price = c.local ? "free" : why ? `skipped (${why})` : c.billing === "active-cpu" ? `up to ${cost}` : cost;
  const plan = c.local ? "none" : planLabel(c.id);
  const tested = live.get(c.id)!.label;
  const gated = accessLabel(c.id);
  const name = gated ? `${c.name} (${gated})` : c.name;
  prices.push(`| [${name}](https://sandboxrouter.vercel.app/providers/${c.id}) | ${price} | ${plan} | ${tested} | [pricing](${c.pricing.source}) |`);
}
const dates = CATALOG.filter((c) => !c.local).flatMap((c) => [c.pricing.checked, ...(c.plan ? [c.plan.checked] : [])]).sort();
prices.push("", `Checked ${dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} to ${dates.at(-1)}`}.`);

const env = ["| Provider | Env |", "|---|---|"];
for (const c of CATALOG) {
  const vars = c.credentials.length ? c.credentials.map((g) => g.map((k) => `\`${k}\``).join(" + ")).join(", or ") : "none: Docker running locally";
  env.push(`| ${c.name} | ${vars} |`);
}

// Same order as the Prices table: the providers that get traffic first are listed first.
const checks = [`| Provider | Real-account check (${CHECK_STEPS.length} steps) | Result since |`, "|---|---|---|"];
for (const row of conformanceTable().sort((a, b) => order.get(a.provider)! - order.get(b.provider)!)) {
  const r = row.run;
  if (!r) {
    checks.push(`| ${row.name} | not run yet | |`);
    continue;
  }
  const parts = [`${r.passed}/${CHECK_STEPS.length - r.skipped.length} passed`];
  if (r.failed.length) parts.push(`failed: ${r.failed.map((f) => f.step).join(", ")}`);
  if (r.skipped.length) parts.push(`n/a: ${r.skipped.join(", ")}`);
  if (r.notRun.length) parts.push(`not covered by this run: ${r.notRun.join(", ")}`);
  if (r.notes.length) parts.push(`note: ${r.notes.map((n) => n.detail ?? n.step).join("; ")}`);
  checks.push(`| ${row.name} | ${parts.join("; ").replace(/\|/g, "/")} | ${r.date.slice(0, 10)}, v${r.version} |`);
}

if (!process.argv.includes("--write")) {
  console.log([prices.join("\n"), env.join("\n"), checks.join("\n")].join("\n\n---\n\n"));
} else {
  const FILES = ["README.md", "docs/reference.md"];
  const docs = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
  /** Replace the block of lines that starts with `header`, through the last line `isPart` accepts, in whichever file has it. */
  const replace = (header: string, lines: string[], isPart: (line: string) => boolean) => {
    const file = FILES.find((f) => docs.get(f)!.split("\n").some((l) => l.startsWith(header)));
    if (!file) throw new Error(`no table starting with "${header}" in ${FILES.join(" or ")}`);
    const all = docs.get(file)!.split("\n");
    const start = all.findIndex((l) => l.startsWith(header));
    let end = start;
    while (end + 1 < all.length && isPart(all[end + 1])) end++;
    all.splice(start, end - start + 1, ...lines);
    docs.set(file, all.join("\n"));
  };
  const tableRow = (l: string) => l.startsWith("|");
  let afterTable = false;
  replace("| Provider | $/hr |", prices, (l) => {
    // The Prices table, a blank line, then its "Checked ..." line.
    if (afterTable) return false;
    if (l.startsWith("Checked ")) return (afterTable = true);
    return tableRow(l) || l === "";
  });
  replace("| Provider | Env |", env, tableRow);
  replace("| Provider | Real-account check", checks, tableRow);
  for (const [file, text] of docs) writeFileSync(file, text);
  console.log("README.md: Prices; docs/reference.md: Env and Compatibility tables updated");
}
