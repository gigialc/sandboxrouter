// Builds the README's generated tables from the code, so the README can't drift:
// Prices (catalog), Env (credentials) and Compatibility (saved `check --save` runs).
// Run: node --import tsx scripts/readme-tables.ts           print them
//      node --import tsx scripts/readme-tables.ts --write   replace them in README.md
import { readFileSync, writeFileSync } from "node:fs";
import { CATALOG, hourlyCost, unfit } from "../src/catalog.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable } from "../src/conformance.js";

// Providers that can't take the default size sort after the ones that can, as the router skips them.
const rank = (c: (typeof CATALOG)[number]) => (c.local ? 2 : unfit(c.id, {}) ? 1 : 0);
const rows = [...CATALOG].sort((a, b) => rank(a) - rank(b) || hourlyCost(a.id) - hourlyCost(b.id) || a.id.localeCompare(b.id));
const order = new Map(rows.map((c, i) => [c.id, i]));

const prices = ["| Provider | $/hr | Notes | Source |", "|---|---|---|---|"];
for (const c of rows) {
  const why = unfit(c.id, {});
  const price = c.local ? "free" : why ? `skipped (${why})` : `$${hourlyCost(c.id).toFixed(3)}`;
  const note = (c.pricing.note ?? "").replace(/\|/g, "/");
  // Capitalize a leading plain word ("per second" -> "Per second"), but not codes like "us-east-1" or "iad1".
  const shown = /^[a-z]+(?:-[a-z]+)*(?=[\s,;:(]|$)/.test(note) ? note[0].toUpperCase() + note.slice(1) : note;
  prices.push(`| ${c.name} | ${price} | ${shown} | [pricing](${c.pricing.source}) |`);
}
const dates = CATALOG.filter((c) => !c.local).map((c) => c.pricing.checked).sort();
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
  let readme = readFileSync("README.md", "utf8");
  /** Replace the block of lines that starts with `header`, through the last line `isPart` accepts. */
  const replace = (header: string, lines: string[], isPart: (line: string) => boolean) => {
    const all = readme.split("\n");
    const start = all.findIndex((l) => l.startsWith(header));
    if (start < 0) throw new Error(`README.md has no table starting with "${header}"`);
    let end = start;
    while (end + 1 < all.length && isPart(all[end + 1])) end++;
    all.splice(start, end - start + 1, ...lines);
    readme = all.join("\n");
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
  writeFileSync("README.md", readme);
  console.log("README.md: Prices, Env and Compatibility tables updated");
}
