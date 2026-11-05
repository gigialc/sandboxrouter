// Prints the README's price and credentials tables from the catalog, so the README can't drift.
// Run: node --import tsx scripts/readme-tables.ts
import { CATALOG, hourlyCost, unfit } from "../src/catalog.js";

// Providers that can't take the default size sort after the ones that can, as the router skips them.
const rank = (c: (typeof CATALOG)[number]) => (c.local ? 2 : unfit(c.id, {}) ? 1 : 0);
const rows = [...CATALOG].sort((a, b) => rank(a) - rank(b) || hourlyCost(a.id) - hourlyCost(b.id) || a.id.localeCompare(b.id));

console.log("| Provider | $/hr | Notes | Source |");
console.log("|---|---|---|---|");
for (const c of rows) {
  const why = unfit(c.id, {});
  const price = c.local ? "free" : why ? `skipped (${why})` : `$${hourlyCost(c.id).toFixed(3)}`;
  const note = (c.pricing.note ?? "").replace(/\|/g, "/");
  console.log(`| ${c.name} | ${price} | ${note[0]?.toUpperCase() ?? ""}${note.slice(1)} | [pricing](${c.pricing.source}) |`);
}
console.log("\n---\n");
console.log("| Provider | Env |");
console.log("|---|---|");
for (const c of [...CATALOG]) {
  const env = c.credentials.length ? c.credentials.map((g) => g.map((k) => `\`${k}\``).join(" + ")).join(", or ") : "none: Docker running locally";
  console.log(`| ${c.name} | ${env} |`);
}
