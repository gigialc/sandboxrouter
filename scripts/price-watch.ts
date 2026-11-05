// Weekly price check. Fetches every provider's pricing page and compares the dollar amounts on it
// with the last run (scripts/price-watch.json), and flags catalog prices checked too long ago.
// It never edits the catalog: a changed page means a person reads it and updates src/catalog.ts.
//
// Run:    node --import tsx scripts/price-watch.ts            report only, exit 1 if anything needs a look
//         node --import tsx scripts/price-watch.ts --update   also save today's amounts as the new baseline
//         add --md to print the report as Markdown (used by the weekly GitHub workflow)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CATALOG } from "../src/catalog.js";

const BASELINE = new URL("./price-watch.json", import.meta.url);
const STALE_DAYS = 45;
const update = process.argv.includes("--update");
const md = process.argv.includes("--md");

type Entry = { url: string; amounts: string[]; seen: string };
const base: Record<string, Entry> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

/** Visible text of an HTML page, without scripts, styles or tags. */
function text(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/\s+/g, " ");
}

/** Every distinct dollar amount on the page, sorted: "$0.0000126", "$20", ... */
function amounts(page: string): string[] {
  const found = page.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return [...new Set(found.map((a) => a.replace(/[\s,]/g, "")))].sort();
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "sandboxrouter-price-watch (+https://github.com/gigialc/sandboxrouter)", Accept: "text/html,text/markdown,*/*" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  return /markdown|text\/plain/.test(res.headers.get("content-type") ?? "") || url.endsWith(".md") ? body : text(body);
}

const today = new Date().toISOString().slice(0, 10);
const changed: string[] = [];
const unreadable: string[] = [];
const stale: string[] = [];
const next: Record<string, Entry> = { ...base };

const cloud = CATALOG.filter((c) => !c.local);
await Promise.all(
  cloud.map(async (c) => {
    const url = c.pricing.source;
    const ageDays = Math.floor((Date.now() - Date.parse(c.pricing.checked)) / 86_400_000);
    if (ageDays > STALE_DAYS) stale.push(`${c.id}: catalog prices last checked ${c.pricing.checked} (${ageDays} days ago)`);
    let now: string[];
    try {
      now = amounts(await fetchPage(url));
    } catch (err) {
      unreadable.push(`${c.id}: couldn't fetch ${url} (${(err as Error).message})`);
      return;
    }
    if (!now.length) {
      unreadable.push(`${c.id}: no dollar amounts in the page's HTML (rendered by JavaScript?), check by hand: ${url}`);
      return;
    }
    const prev = base[c.id];
    if (prev && prev.url === url) {
      const added = now.filter((a) => !prev.amounts.includes(a));
      const removed = prev.amounts.filter((a) => !now.includes(a));
      if (added.length || removed.length) {
        changed.push(`${c.id}: ${url} changed since ${prev.seen}. New: ${added.join(", ") || "none"}. Gone: ${removed.join(", ") || "none"}.`);
      }
    }
    next[c.id] = { url, amounts: now, seen: today };
  }),
);

for (const list of [changed, unreadable, stale]) list.sort();
const section = (title: string, items: string[]) =>
  items.length ? `${md ? `### ${title}` : title}\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";
const report = [
  md ? `Price check, ${today}. ${changed.length} changed, ${stale.length} stale, ${unreadable.length} to check by hand.\n` : "",
  section("Pricing pages that changed (update src/catalog.ts if a list price moved)", changed),
  section(`Catalog prices older than ${STALE_DAYS} days`, stale),
  section("Pages to check by hand", unreadable),
]
  .filter(Boolean)
  .join("\n");
console.log(report || `All ${cloud.length} pricing pages match the last check, and every price was checked in the last ${STALE_DAYS} days.`);

if (update) {
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
}
if (changed.length || stale.length) process.exitCode = 1;
