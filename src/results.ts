import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { benchmarksPublishable, CATALOG } from "./catalog.js";
import { CHECK_STEPS } from "./check.js";

/**
 * Checks for the files people submit to results/: bench reports, saved `check` runs and `cost` runs.
 *
 * Submissions are self-reported, so nothing here can prove a number is real. What it can do is keep
 * the obvious problems out before a maintainer reviews the PR: files that aren't one of the three
 * formats, unknown providers, impossible numbers, anything that looks like a key, and labels that
 * look like a home address or an email. CI runs it on every push and pull request
 * (`npm run results:check`), and on a pull request it also refuses edits to someone else's bench
 * report: a new run is a new file.
 */

export interface Issue {
  file: string;
  problem: string;
}

/** A GitHub handle, without the "@": what `--by` accepts and what reports store. */
export function contributor(by?: string): string | undefined {
  if (by === undefined) return undefined;
  const h = by.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(h)) {
    throw new Error(`--by takes a GitHub username, e.g. --by octocat (got "${by}")`);
  }
  return h;
}

const IDS = new Set<string>(CATALOG.map((c) => c.id));
/** A timing in a check step's note, e.g. "first output after 100 ms" or "threw after 3.0 s". */
const TIMING = /\d[\d,.]*\s?(?:ms|s|sec|seconds?)\b/i;

/**
 * A saved check as it may be published: for a provider whose terms forbid publishing benchmarks,
 * pass/fail stays and every timing goes (the per-step `ms`, and notes that quote a duration).
 */
export function publishableCheck<T extends { provider: string; results: { ms?: number; detail?: string }[] }>(saved: T): T {
  if (benchmarksPublishable(saved.provider)) return saved;
  return {
    ...saved,
    results: saved.results.map(({ ms: _ms, detail, ...r }) => ({ ...r, ...(detail && !TIMING.test(detail) ? { detail } : {}) })),
  };
}

const noBench = (id: unknown) => typeof id === "string" && IDS.has(id) && !benchmarksPublishable(id);
const NO_BENCH = "its terms don't allow publishing benchmarks (noBenchmarks in src/catalog.ts); leave it out of shared results";
const STEPS = new Set<string>(CHECK_STEPS);
const MAX_MS = 15 * 60_000;

/** Key and token shapes from the providers here and the usual suspects. Matches print as a prefix only. */
const SECRET_SHAPES: [string, RegExp][] = [
  ["Stripe-style or Sail key", /\bsk_(?:live_|test_)?[A-Za-z0-9]{16,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["sandboxrouter key", /\bsr_live_[A-Za-z0-9_-]{20,}/],
  ["E2B key", /\be2b_[A-Za-z0-9]{20,}/],
  ["Daytona key", /\bdtn_[A-Za-z0-9]{20,}/],
  ["LangSmith key", /\blsv2_(?:sk|pt)_[A-Za-z0-9_]{20,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\./],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["key=value secret", /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;
/** "12 Main Street", "Calle Mayor 5", "Apt 4B": a street or a flat, which a label never needs. */
const ADDRESS =
  /\b\d+[A-Za-z]?\s+(?:[A-Za-zÀ-ÿ'.-]+\s+){0,3}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|court|ct|place|pl|boulevard|blvd|terrace|close)\b\.?|\b(?:calle|carrer|rue|via|avenida|straße|strasse|str)\.?\s+[A-Za-zÀ-ÿ'.-]+(?:\s+[A-Za-zÀ-ÿ'.-]+){0,3}\s+\d+|\b(?:apt|apartment|flat|suite|unit|piso|puerta)\.?\s*#?\d+/i;

const isNum = (n: unknown, min = 0, max = Infinity) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;

function checkDate(iso: unknown, now: number): string | undefined {
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return "date is missing or not an ISO date";
  if (Date.parse(iso) > now + 86_400_000) return "date is in the future";
  if (Date.parse(iso) < Date.parse("2026-01-01")) return "date is before sandboxrouter existed";
}

function checkLabel(label: unknown): string | undefined {
  if (label === undefined || label === null) return;
  if (typeof label !== "string") return "label must be text";
  if (label.length > 80) return "label is longer than 80 characters";
  if (EMAIL.test(label)) return "label contains an email address";
  if (IPV4.test(label)) return "label contains an IP address";
  if (ADDRESS.test(label)) return 'label looks like a street address; use a city or cloud region, e.g. "Berlin" or "us-east-1"';
}

function checkBy(by: unknown): string | undefined {
  if (by === undefined) return;
  try {
    if (typeof by !== "string" || contributor(by) !== by) return 'by must be a GitHub username without the "@"';
  } catch (e) {
    return (e as Error).message;
  }
}

/** Problems with one parsed result file. `now` is injectable for tests. */
export function validateResult(j: any, now = Date.now()): string[] {
  const out: string[] = [];
  const add = (p?: string) => p && out.push(p);
  const provider = (id: unknown, where = "provider") => {
    if (typeof id !== "string" || !IDS.has(id)) out.push(`${where} "${String(id)}" is not in the catalog`);
  };
  if (!j || typeof j !== "object" || Array.isArray(j)) return ["not a result file: expected a JSON object with a \"tool\" field"];

  if (j.tool === "sandboxrouter") {
    add(checkDate(j.date, now));
    add(checkLabel(j.label));
    add(checkBy(j.by));
    if (!isNum(j.runs, 3, 1000)) out.push("runs must be at least 3");
    if (!Array.isArray(j.rows) || !j.rows.length) out.push("rows is empty");
    for (const r of Array.isArray(j.rows) ? j.rows : []) {
      provider(r?.provider, "row provider");
      if (noBench(r?.provider)) out.push(`${r.provider}: ${NO_BENCH}`);
      if (!isNum(r?.runs, 1, 1000)) out.push(`${r?.provider}: runs is not a positive number`);
      if (!isNum(r?.failures, 0, r?.runs ?? 0)) out.push(`${r?.provider}: failures must be between 0 and runs`);
      for (const k of ["medianCreateMs", "medianExecMs"] as const) {
        if (r?.[k] !== undefined && !isNum(r[k], 1, MAX_MS)) out.push(`${r?.provider}: ${k} must be between 1 ms and 15 min`);
      }
      if (r?.failures < r?.runs && r?.medianCreateMs === undefined) out.push(`${r?.provider}: successful runs but no medianCreateMs`);
      if ("lastError" in (r ?? {})) out.push(`${r?.provider}: lastError must not be shared (it can hold account details)`);
    }
  } else if (j.tool === "sandboxrouter-check") {
    add(checkDate(j.date, now));
    add(checkBy(j.by));
    provider(j.provider);
    if (!Array.isArray(j.results) || !j.results.length) out.push("results is empty");
    for (const r of Array.isArray(j.results) ? j.results : []) {
      if (!STEPS.has(r?.step)) out.push(`unknown check step "${r?.step}"`);
      if (!["pass", "fail", "skip", "info"].includes(r?.status)) out.push(`${r?.step}: unknown status "${r?.status}"`);
      if (r?.ms !== undefined && !isNum(r.ms, 0, MAX_MS)) out.push(`${r?.step}: ms must be between 0 and 15 min`);
      if (noBench(j.provider) && (r?.ms !== undefined || (typeof r?.detail === "string" && TIMING.test(r.detail)))) {
        out.push(`${r?.step}: has timings, but ${j.provider}'s terms don't allow publishing performance information; save with check --save`);
      }
    }
  } else if (j.tool === "sandboxrouter-cost") {
    add(checkDate(j.date, now));
    add(checkBy(j.by));
    if (!isNum(j.minutes, 1, 24 * 60)) out.push("minutes must be between 1 and 1440");
    if (!Array.isArray(j.entries) || !j.entries.length) out.push("entries is empty");
    for (const e of Array.isArray(j.entries) ? j.entries : []) {
      provider(e?.provider, "entry provider");
      if (noBench(e?.provider)) out.push(`${e.provider}: ${NO_BENCH}`);
      if (e?.seconds !== undefined && !isNum(e.seconds, 0, 2 * 24 * 3600)) out.push(`${e?.provider}: seconds is out of range`);
      if (e?.predictedUsd !== undefined && !isNum(e.predictedUsd, 0, 1000)) out.push(`${e?.provider}: predictedUsd is out of range`);
      if (e?.bill?.usd !== undefined && !isNum(e.bill.usd, 0, 1000)) out.push(`${e?.provider}: bill.usd is out of range`);
      if (e?.delivered && !(isNum(e.delivered.vcpu, 0.1, 1024) && isNum(e.delivered.memoryMb, 64, 4_194_304))) {
        out.push(`${e?.provider}: delivered size is out of range`);
      }
    }
  } else {
    out.push(`unknown tool "${String(j.tool)}": expected a bench report, a saved check or a cost run`);
  }
  return out;
}

/** Problems found anywhere in a file's raw text: secrets, emails, IP addresses. */
export function scanText(text: string): string[] {
  const out: string[] = [];
  for (const [what, re] of SECRET_SHAPES) {
    const m = text.match(re);
    if (m) out.push(`looks like a ${what} ("${m[0].slice(0, 6)}…"); never commit keys`);
  }
  const email = text.match(EMAIL);
  if (email) out.push(`contains an email address ("${email[0].replace(/^(.).*@/, "$1…@")}")`);
  const ip = text.match(IPV4);
  if (ip && !/^0\.|^127\./.test(ip[0])) out.push(`contains an IP address ("${ip[0]}")`);
  return out;
}

/** Files in results/ that aren't submissions: notes and the maintainers' price audits. */
const NOT_A_SUBMISSION = (rel: string) => /(^|\/)README\.md$/.test(rel) || /(^|\/)price-audit-[^/]+$/.test(rel);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Every problem in a results directory. `changed` is the PR's `git diff --name-status` against its
 * base, when there is one: a modified bench report means someone edited a run, which is refused.
 * Saved checks (one per provider, replaced by each new run) and cost runs (`cost settle` fills in the
 * bill later) may change.
 */
export function validateResults(
  dir = "results",
  opts: { changed?: { status: string; path: string }[]; previous?: (path: string) => string | undefined; now?: number } = {},
): Issue[] {
  const issues: Issue[] = [];
  for (const path of walk(dir)) {
    const rel = relative(".", path);
    if (NOT_A_SUBMISSION(relative(dir, path))) continue;
    if (path.endsWith(".DS_Store")) continue;
    if (!path.endsWith(".json")) {
      issues.push({ file: rel, problem: "only .json result files belong here" });
      continue;
    }
    const text = readFileSync(path, "utf8");
    for (const problem of scanText(text)) issues.push({ file: rel, problem });
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      issues.push({ file: rel, problem: "is not valid JSON" });
      continue;
    }
    for (const problem of validateResult(j, opts.now)) issues.push({ file: rel, problem });
  }
  for (const c of opts.changed ?? []) {
    const p = c.path;
    if (!p.startsWith(`${dir}/`) || NOT_A_SUBMISSION(p.slice(dir.length + 1))) continue;
    if (p.startsWith(`${dir}/conformance/`) || p.startsWith(`${dir}/cost/`)) continue;
    if (/^[MR]/.test(c.status) && !onlyDropsUnpublishable(opts.previous?.(p), p)) {
      issues.push({ file: p, problem: "edits an existing bench report; add your run as a new file instead" });
    }
    if (c.status.startsWith("D")) issues.push({ file: p, problem: "deletes a bench report; reports are only removed by a maintainer" });
  }
  return issues;
}

/**
 * True when a bench report's only change is removing rows for providers whose terms forbid publishing
 * benchmarks: the one edit to someone's report that's allowed, so those numbers can be taken down.
 */
function onlyDropsUnpublishable(before: string | undefined, path: string): boolean {
  if (before === undefined || !existsSync(path)) return false;
  try {
    const a = JSON.parse(before);
    const b = JSON.parse(readFileSync(path, "utf8"));
    const { rows: ra, ...restA } = a;
    const { rows: rb, ...restB } = b;
    if (JSON.stringify(restA) !== JSON.stringify(restB)) return false;
    const kept = (ra as { provider: string }[]).filter((r) => benchmarksPublishable(r.provider));
    return JSON.stringify(kept) === JSON.stringify(rb);
  } catch {
    return false;
  }
}
