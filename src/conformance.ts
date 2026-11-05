import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "./catalog.js";
import { CHECK_STEPS, type CheckReport, type CheckStatus } from "./check.js";
import type { ProviderId } from "./types.js";

/** A `sandboxrouter check --save` file: one real run of every check step on one provider. */
export interface SavedCheck extends CheckReport {
  tool: "sandboxrouter-check";
  version: string;
  date: string;
  platform: string;
}

export interface ConformanceRow {
  provider: ProviderId;
  name: string;
  /** Null when nobody has saved a real run for this provider yet. */
  run: null | {
    date: string;
    version: string;
    passed: number;
    /** Steps that ran and failed, with why. */
    failed: { step: string; detail?: string }[];
    /** Steps that don't apply (pause on adapters without it). */
    skipped: string[];
    /** Steps added to `check` after this run, so not covered by it. */
    notRun: string[];
    /** Steps that passed with a caveat, e.g. output only arrives at the end. */
    notes: { step: string; detail?: string }[];
    steps: Record<string, CheckStatus | "not run">;
  };
}

/** Saved check runs in `dir` (default results/conformance), keyed by provider. */
export function loadConformance(dir = "results/conformance"): Map<ProviderId, SavedCheck> {
  const out = new Map<ProviderId, SavedCheck>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r?.tool === "sandboxrouter-check" && Array.isArray(r.results)) out.set(r.provider, r);
    } catch {
      // Not a check file.
    }
  }
  return out;
}

/** One row per sandbox provider in the catalog, scored against the current list of check steps. */
export function conformanceTable(saved = loadConformance()): ConformanceRow[] {
  return CATALOG.map((c) => {
    const r = saved.get(c.id);
    if (!r) return { provider: c.id, name: c.name, run: null };
    const by = new Map(r.results.map((x) => [x.step, x]));
    const steps = Object.fromEntries(CHECK_STEPS.map((s) => [s, by.get(s)?.status ?? ("not run" as const)]));
    const pick = (st: CheckStatus) => r.results.filter((x) => x.status === st);
    return {
      provider: c.id,
      name: c.name,
      run: {
        date: r.date,
        version: r.version,
        passed: pick("pass").length + pick("info").length,
        failed: pick("fail").map((x) => ({ step: x.step, detail: x.detail })),
        skipped: pick("skip").map((x) => x.step),
        // A failed create ends the run early; that's a failure, not missing coverage.
        notRun: by.get("create")?.status === "fail" ? [] : CHECK_STEPS.filter((s) => !by.has(s)),
        notes: pick("info").map((x) => ({ step: x.step, detail: x.detail })),
        steps,
      },
    };
  });
}
