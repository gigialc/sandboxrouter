import type { LedgerEntry } from "./ledger.js";
import type { Router } from "./router.js";
import { ProviderError } from "./types.js";

export interface OpenSandbox extends LedgerEntry {
  ageMinutes: number;
  /** True once its requested lifetime has run out. */
  expired: boolean;
  /** List price times how long it has been up, capped at its lifetime (most providers stop it there). */
  estimatedUsdSoFar: number;
}

export interface GcResult {
  id: string;
  action: "killed" | "gone" | "would kill" | "failed";
  detail?: string;
}

/** Every sandbox in the router's ledger that hasn't been seen killed. */
export function listOpen(router: Router, now = Date.now()): OpenSandbox[] {
  return (router.ledger?.list() ?? []).map((e) => {
    const created = Date.parse(e.createdAt);
    const expires = Date.parse(e.expiresAt);
    const upMs = Math.max(0, Math.min(now, expires) - created);
    return {
      ...e,
      ageMinutes: Math.round((now - created) / 60_000),
      expired: now >= expires,
      estimatedUsdSoFar: Math.round(e.usdHour * (upMs / 3_600_000) * 10_000) / 10_000,
    };
  });
}

/** Errors that mean the sandbox no longer exists, so there is nothing left to kill. */
export function isGone(err: unknown): boolean {
  if (err instanceof ProviderError && (err.status === 404 || err.status === 410)) return true;
  return /\b(404|410)\b|not found|no such|does not exist|doesn't exist|not exist|unknown sandbox|already (deleted|terminated|stopped)|\bgone\b/i.test(
    (err as Error)?.message ?? String(err),
  );
}

/**
 * Kill leaked sandboxes from the ledger. By default only those past their lifetime; `all` kills
 * every open one; `olderThanMinutes` kills those up at least that long. A sandbox that turns out
 * to be gone already is just dropped from the ledger.
 */
export async function gc(
  router: Router,
  opts: { all?: boolean; olderThanMinutes?: number; dryRun?: boolean; now?: number } = {},
): Promise<GcResult[]> {
  const open = listOpen(router, opts.now);
  const pick = open.filter((s) => opts.all || s.expired || (opts.olderThanMinutes !== undefined && s.ageMinutes >= opts.olderThanMinutes));
  const results: GcResult[] = [];
  for (const s of pick) {
    if (opts.dryRun) {
      results.push({ id: s.id, action: "would kill", detail: s.expired ? "past its lifetime" : `up ${s.ageMinutes} min` });
      continue;
    }
    try {
      // Both close the ledger entry.
      if (s.kind === "computer") await (await router.getComputer(s.id)).delete();
      else await (await router.get(s.id)).kill();
      results.push({ id: s.id, action: "killed" });
    } catch (err) {
      if (isGone(err)) {
        router.ledger?.close(s.id, "gone");
        results.push({ id: s.id, action: "gone", detail: (err as Error).message });
      } else {
        results.push({ id: s.id, action: "failed", detail: (err as Error)?.message ?? String(err) });
      }
    }
  }
  if (!opts.dryRun && results.length) router.ledger?.compact();
  return results;
}
