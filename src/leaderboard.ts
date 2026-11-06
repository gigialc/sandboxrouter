import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, fittingSpec, hourlyCost } from "./catalog.js";
import { median } from "./bench-store.js";
import type { BenchRow } from "./bench.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * A shareable bench result. People submit these as PRs to results/, and `sandboxrouter
 * leaderboard` renders every submission into one static page. No server, nothing to trust but
 * the files in the repo.
 */
export interface BenchReport {
  tool: "sandboxrouter";
  version: string;
  date: string;
  /** Free text from the submitter, e.g. "us-east-1 c7g.large" or "Berlin, home fiber". */
  label?: string;
  runs: number;
  spec: SandboxSpec;
  node: string;
  platform: string;
  rows: BenchRow[];
}

export function makeReport(rows: BenchRow[], opts: { version: string; runs: number; spec: SandboxSpec; label?: string }): BenchReport {
  return {
    tool: "sandboxrouter",
    version: opts.version,
    date: new Date().toISOString(),
    label: opts.label,
    runs: opts.runs,
    // Only the shape matters for comparison; never ship env or metadata.
    spec: { vcpu: opts.spec.vcpu, memoryGb: opts.spec.memoryGb },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    rows: rows.map(({ lastError: _drop, ...r }) => r),
  };
}

export function loadReports(dir: string): BenchReport[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: BenchReport[] = [];
  for (const f of files.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r?.tool === "sandboxrouter" && Array.isArray(r.rows)) out.push(r);
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

export interface LeaderRow {
  provider: ProviderId;
  name: string;
  submissions: number;
  medianCreateMs?: number;
  medianExecMs?: number;
  successRate: number;
  /** List price for the size the bench runs it at (`size`). */
  hourlyUsd: number;
  /** The size bench runs: 2 vCPU / 4 GB, or the provider's fixed default size. */
  size: { vcpu: number; memoryGb: number };
}

const KNOWN = new Set(CATALOG.map((c) => c.id));

/** Median of each submission's medians, so one heavy submitter can't skew a provider. */
export function aggregate(reports: BenchReport[]): LeaderRow[] {
  const by = new Map<ProviderId, BenchRow[]>();
  for (const rep of reports) for (const r of rep.rows) if (KNOWN.has(r.provider)) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  const rows: LeaderRow[] = [...by.entries()].map(([id, rs]) => {
    const runs = rs.reduce((n, r) => n + r.runs, 0);
    const ok = rs.reduce((n, r) => n + (r.runs - r.failures), 0);
    return {
      provider: id,
      name: CATALOG.find((c) => c.id === id)!.name,
      submissions: rs.length,
      medianCreateMs: median(rs.map((r) => r.medianCreateMs).filter((n): n is number => typeof n === "number")),
      medianExecMs: median(rs.map((r) => r.medianExecMs).filter((n): n is number => typeof n === "number")),
      successRate: runs ? ok / runs : 0,
      hourlyUsd: hourlyCost(id, fittingSpec(id)),
      size: fittingSpec(id),
    };
  });
  return rows.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity));
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function bar(value: number | undefined, max: number, text: string, tip: string): string {
  if (value === undefined) return `<td class="num muted">n/a</td>`;
  const pct = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return `<td class="barcell" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
    <div class="track"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div><span class="val">${esc(text)}</span></td>`;
}

/** One self-contained HTML page: a sorted table with an inline bar per measure, each on its own scale. */
export function renderLeaderboard(reports: BenchReport[]): string {
  const rows = aggregate(reports);
  const maxCreate = Math.max(0, ...rows.map((r) => r.medianCreateMs ?? 0));
  const maxPrice = Math.max(0, ...rows.map((r) => r.hourlyUsd));
  const dates = reports.map((r) => r.date).sort();
  const span = dates.length ? `${dates[0].slice(0, 10)} to ${dates.at(-1)!.slice(0, 10)}` : "no submissions yet";

  const body = rows
    .map(
      (r, i) => `<tr>
  <td class="num rank">${i + 1}</td>
  <th scope="row">${esc(r.name)}</th>
  ${bar(r.medianCreateMs, maxCreate, r.medianCreateMs === undefined ? "" : `${r.medianCreateMs.toLocaleString("en-US")} ms`, `${r.name}: median cold start ${r.medianCreateMs} ms across ${r.submissions} submission${r.submissions === 1 ? "" : "s"}`)}
  <td class="num">${r.medianExecMs === undefined ? "n/a" : `${r.medianExecMs} ms`}</td>
  ${bar(r.hourlyUsd, maxPrice, `$${r.hourlyUsd.toFixed(3)}`, `${r.name}: $${r.hourlyUsd.toFixed(4)} per hour at list price, ${r.size.vcpu} vCPU / ${r.size.memoryGb} GB`)}
  <td class="num">${(r.successRate * 100).toFixed(0)}%</td>
  <td class="num muted">${r.submissions}</td>
</tr>`,
    )
    .join("\n");

  const subs = reports
    .map((r) => `<li>${esc(r.date.slice(0, 10))} · ${esc(r.label ?? "unlabeled")} · ${esc(r.platform)} · ${r.runs} runs · ${r.rows.length} providers</li>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sandboxrouter leaderboard</title>
<style>
.viz-root {
  color-scheme: light;
  --page: #f9f9f7; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --text-muted: #898781; --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7;
    --text-muted: #898781; --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7;
  --text-muted: #898781; --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
  --series-1: #3987e5;
}
* { box-sizing: border-box; }
body { margin: 0; }
.viz-root { background: var(--page); color: var(--text-primary); min-height: 100vh;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 48px 24px; }
main { max-width: 1040px; margin: 0 auto; }
h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--text-secondary); margin: 0 0 24px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 8px 16px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
caption { text-align: left; color: var(--text-muted); font-size: 13px; padding: 12px 0 4px; caption-side: bottom; }
th, td { padding: 10px 8px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
thead th { color: var(--text-muted); font-weight: 500; font-size: 13px; border-bottom-color: var(--baseline); }
tbody tr:last-child > * { border-bottom: 0; }
tbody th { font-weight: 600; }
.num { font-variant-numeric: tabular-nums; }
.rank, .muted { color: var(--text-muted); }
.barcell { min-width: 220px; position: relative; outline: none; }
.barcell { display: table-cell; }
.track { display: inline-block; vertical-align: middle; width: 140px; height: 12px; border-left: 1px solid var(--baseline); }
.bar { height: 12px; background: var(--series-1); border-radius: 0 4px 4px 0; }
.val { display: inline-block; vertical-align: middle; margin-left: 8px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.barcell:hover .bar, .barcell:focus .bar { filter: brightness(1.12); }
#tip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); opacity: 0; transition: opacity 80ms; max-width: 320px; white-space: normal; }
.notes { color: var(--text-secondary); font-size: 14px; margin-top: 24px; }
.notes ul { padding-left: 18px; color: var(--text-muted); }
a { color: inherit; }
</style>
</head>
<body class="viz-root">
<main>
  <h1>Sandbox cold starts</h1>
  <p class="sub">Time from <code>create()</code> to a usable sandbox, measured by <a href="https://github.com/gigialc/sandboxrouter">sandboxrouter bench</a>. ${reports.length} submission${reports.length === 1 ? "" : "s"}, ${esc(span)}.</p>
  <div class="card">
    <table>
      <thead><tr>
        <th>#</th><th>Provider</th><th>Cold start (median)</th><th>Exec round trip</th>
        <th>List price (size run)</th><th>Success</th><th>Submissions</th>
      </tr></thead>
      <tbody>
${body || `<tr><td colspan="7" class="muted">No results yet. Run <code>npx @sandboxrouter/sdk bench --share</code> and open a PR.</td></tr>`}
      </tbody>
    </table>
  </div>
  <div class="notes">
    <p>Sorted by cold start. Each bar column has its own scale. Cold start and exec are the median of each submission's medians, so one submitter can't dominate a provider. Latency includes the network between the submitter and each provider. Prices are list prices from each provider's pricing page (sources in <code>src/catalog.ts</code>); some bill active CPU only, so idle work costs less.</p>
    <p>Submissions:</p>
    <ul>${subs}</ul>
  </div>
</main>
<div id="tip" role="tooltip"></div>
<script>
  const tip = document.getElementById("tip");
  const show = (el, x, y) => { tip.textContent = el.dataset.tip; tip.style.left = (x + 14) + "px"; tip.style.top = (y + 14) + "px"; tip.style.opacity = 1; };
  for (const el of document.querySelectorAll("[data-tip]")) {
    el.addEventListener("mousemove", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("mouseleave", () => (tip.style.opacity = 0));
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); show(el, r.left, r.bottom - 8); });
    el.addEventListener("blur", () => (tip.style.opacity = 0));
  }
</script>
</body>
</html>
`;
}
