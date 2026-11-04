// Prints the README's price and credentials tables from the catalog, so the README can't drift.
// Run: node --import tsx scripts/readme-tables.ts
import { CATALOG, hourlyCost } from "../src/catalog.js";

const rows = [...CATALOG].sort((a, b) => Number(!!a.local) - Number(!!b.local) || hourlyCost(a.id) - hourlyCost(b.id) || a.id.localeCompare(b.id));

console.log("| Provider | $/hr | Notes | Source |");
console.log("|---|---|---|---|");
for (const c of rows) {
  const price = c.local ? "free" : `$${hourlyCost(c.id).toFixed(3)}`;
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
