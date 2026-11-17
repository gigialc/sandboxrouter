// Records the price index (src/price-index.ts) in scripts/price-index.json when it has changed since the last
// entry, so the website can show how it moves. Run daily by .github/workflows/price-index.yml; the index only
// changes when a provider's price in the catalog does, so most days write nothing.
//
// Run: node --import tsx scripts/index-snapshot.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { priceIndex } from "../src/price-index.js";

const FILE = "scripts/price-index.json";
type Entry = { date: string; lines: Record<string, { median: number; cheapest: number; provider: string }> };

const history: Entry[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
const lines = Object.fromEntries(priceIndex().map((l) => [l.id, { median: l.median, cheapest: l.cheapest.usd, provider: l.cheapest.provider }]));
const last = history.at(-1);
if (last && JSON.stringify(last.lines) === JSON.stringify(lines)) {
  console.log(`price index unchanged since ${last.date}`);
} else {
  history.push({ date: new Date().toISOString().slice(0, 10), lines });
  writeFileSync(FILE, JSON.stringify(history, null, 2) + "\n");
  console.log(`price index recorded (${history.length} entries)`);
}
