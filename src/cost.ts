import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarksPublishable, fittingSpec, hourlyCost } from "./catalog.js";
import { Router } from "./router.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * Real-cost check: does what a provider bills match what the catalog predicts?
 *
 * `costRun` starts one sandbox per provider at a known size, measures the size it really got
 * (nproc, MemTotal), keeps every core busy for a fixed time (some providers bill active CPU only),
 * kills it, and records the predicted cost from list price × wall time. `settle` later reads what
 * the provider actually charged for that sandbox from its usage API, where it has one. Billing
 * lags (Blaxel minutes, Daytona up to 48 h), so settle can be run again until every row has a bill.
 */

export interface Delivered {
  vcpu: number;
  memoryMb: number;
}

export interface Bill {
  /** What the provider says it charged for this sandbox, USD. Undefined when it can't be read. */
  usd?: number;
  /** Seconds the provider billed, when it reports them. */
  seconds?: number;
  /** Where the number came from, or why there is none. */
  source: string;
  at: string;
}

export interface CostEntry {
  provider: ProviderId;
  sandboxId?: string;
  requested: { vcpu: number; memoryGb: number };
  delivered?: Delivered;
  startedAt?: string;
  endedAt?: string;
  /** Wall time from the create call until kill returned. */
  seconds?: number;
  /** Catalog list price for the requested size. */
  listUsdHour: number;
  predictedUsd?: number;
  /** Catalog list price for the size the sandbox really had. */
  deliveredUsdHour?: number;
  error?: string;
  bill?: Bill;
}

export interface CostRun {
  tool: "sandboxrouter-cost";
  version: string;
  date: string;
  minutes: number;
  load: boolean;
  /** GitHub username of whoever ran it, from `--by`. */
  by?: string;
  entries: CostEntry[];
}

/**
 * The size the sandbox really has, as "<vcpus> <memoryMb>". nproc and MemTotal can show the whole host
 * (Daytona's containers report 64 CPUs and 755 GB while limited to 1 vCPU and 1 GB), so the cgroup limits
 * win when they're set: cgroup v2 cpu.max / memory.max, or v1 cfs quota / memory limit. vCPUs can be
 * fractional (a 50% quota is 0.5).
 */
export const PROBE = [
  `n=$(nproc); m=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)`,
  `q=; p=; l=`,
  `if [ -r /sys/fs/cgroup/cpu.max ]; then read q p < /sys/fs/cgroup/cpu.max; elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us); p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us); fi`,
  `if [ -r /sys/fs/cgroup/memory.max ]; then l=$(cat /sys/fs/cgroup/memory.max); elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then l=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes); fi`,
  `awk -v n="$n" -v m="$m" -v q="$q" -v p="$p" -v l="$l" 'BEGIN { c = n; if (q ~ /^[0-9]+$/ && p ~ /^[0-9]+$/ && p > 0 && q / p < c) c = q / p; if (l ~ /^[0-9]+$/ && l / 1048576 < m) m = int(l / 1048576); printf "%s %d\\n", (c == int(c) ? c : sprintf("%.2f", c)), m }'`,
].join("; ");
// One `yes` per core, detached so the exec returns; they die with the sandbox.
const LOAD = `nohup sh -c 'for i in $(seq $(nproc)); do yes > /dev/null & done; wait' > /dev/null 2>&1 &`;

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export async function costRun(opts: {
  providers: ProviderId[];
  minutes: number;
  spec?: SandboxSpec;
  load?: boolean;
  router?: Router;
  version: string;
  by?: string;
  onProgress?: (msg: string) => void;
}): Promise<CostRun> {
  const router = opts.router ?? new Router();
  const load = opts.load ?? true;
  const log = opts.onProgress ?? (() => {});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const one = async (provider: ProviderId): Promise<CostEntry> => {
    // Asked-for size, or else one the provider can take: its default size if that's fixed.
    const sized = opts.spec?.vcpu !== undefined || opts.spec?.memoryGb !== undefined;
    const { vcpu, memoryGb } = sized ? { vcpu: opts.spec?.vcpu ?? 2, memoryGb: opts.spec?.memoryGb ?? 4 } : fittingSpec(provider);
    const entry: CostEntry = { provider, requested: { vcpu, memoryGb }, listUsdHour: hourlyCost(provider, { vcpu, memoryGb }) };
    let box;
    const t0 = Date.now();
    try {
      entry.startedAt = new Date(t0).toISOString();
      box = await router.create({ vcpu, memoryGb, timeoutMinutes: opts.minutes + 10 }, { provider, fallback: false });
      entry.sandboxId = box.nativeId;
      const [cpus, mem] = (await box.exec(PROBE)).stdout.trim().split(/\s+/).map(Number);
      if (cpus > 0 && mem > 0) {
        entry.delivered = { vcpu: cpus, memoryMb: mem };
        entry.deliveredUsdHour = round(hourlyCost(provider, { vcpu: cpus, memoryGb: mem / 1024 }));
      }
      if (load) await box.exec(LOAD);
      log(`${provider}: running ${box.nativeId} for ${opts.minutes} min`);
      await sleep(opts.minutes * 60_000 - (Date.now() - t0));
    } catch (err) {
      entry.error = (err as Error).message.slice(0, 300);
      log(`${provider}: ${entry.error}`);
    } finally {
      if (box) {
        await box.kill().catch((e) => (entry.error = `kill failed: ${(e as Error).message.slice(0, 200)}`));
        const t1 = Date.now();
        entry.endedAt = new Date(t1).toISOString();
        entry.seconds = Math.round((t1 - t0) / 1000);
        entry.predictedUsd = round((entry.listUsdHour * entry.seconds) / 3600);
      }
    }
    return entry;
  };

  const entries = await Promise.all(opts.providers.map(one));
  return { tool: "sandboxrouter-cost", version: opts.version, date: new Date().toISOString(), minutes: opts.minutes, load, ...(opts.by ? { by: opts.by } : {}), entries };
}

type Reader = (e: CostEntry) => Promise<Omit<Bill, "at">>;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const hourFloor = (iso: string) => new Date(Math.floor(Date.parse(iso) / 3_600_000) * 3_600_000).toISOString();
const hourCeil = (iso: string) => new Date(Math.ceil(Date.parse(iso) / 3_600_000 + 1) * 3_600_000).toISOString();

/** Per-provider readers of the real charge for one sandbox. */
export const BILL_READERS: Partial<Record<ProviderId, Reader>> = {
  async daytona(e) {
    const h = { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}` };
    const api = process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
    const { organizationId } = await getJson(`${api}/api-keys/current`, h);
    const q = new URLSearchParams({ from: hourFloor(e.startedAt!), to: hourCeil(e.endedAt!) });
    const rows: any[] = await getJson(`https://analytics.app.daytona.io/organization/${organizationId}/usage/sandbox?${q}`, h);
    const row = rows.find((r) => r.sandboxId === e.sandboxId);
    if (!row) return { source: "daytona usage API: not posted yet (can take up to 48 h)" };
    const seconds = row.firstStart && row.lastEnd ? Math.round((Date.parse(row.lastEnd) - Date.parse(row.firstStart)) / 1000) : undefined;
    return { usd: round(row.totalPrice), seconds, source: "daytona analytics /usage/sandbox totalPrice" };
  },

  async blaxel(e) {
    const h: Record<string, string> = { Authorization: `Bearer ${process.env.BL_API_KEY}` };
    if (process.env.BL_WORKSPACE) h["X-Blaxel-Workspace"] = process.env.BL_WORKSPACE;
    const [acct] = await getJson("https://api.blaxel.ai/v0/accounts", h);
    const q = new URLSearchParams({ startTime: hourFloor(e.startedAt!), endTime: hourCeil(e.endedAt!), groupBy: "resource_name" });
    const j = await getJson(`https://api.blaxel.ai/v0/accounts/${acct.metadata.id}/metrics?${q}`, h);
    const row = (j.data ?? []).find((d: any) => d.resourceName === e.sandboxId);
    if (!row) return { source: "blaxel metrics API: not posted yet (lags a few minutes)" };
    return { usd: round(row.summary?.cost ?? 0), source: "blaxel /metrics cost (USD)" };
  },

  async maritime(e) {
    const h = { Authorization: `Bearer ${process.env.MARITIME_API_KEY}` };
    const api = process.env.MARITIME_API_URL ?? "https://api.maritime.sh";
    const j = await getJson(`${api}/api/billing/metered-usage`, h);
    const days: any[] = j.byMachineDay?.[`sandbox:${e.sandboxId}`] ?? [];
    if (!days.length) return { source: "maritime metered-usage: not posted yet" };
    const cents = days.reduce((n, d) => n + (d.cents ?? 0), 0);
    const seconds = days.reduce((n, d) => n + (d.seconds ?? 0), 0);
    const model = j.plan ? `plan ${j.plan}` : "no usage plan on this account";
    return { usd: round(cents / 100), seconds: Math.round(seconds), source: `maritime metered-usage (integer cents; ${model})` };
  },

  async sail(e) {
    const h = { Authorization: `Bearer ${process.env.SAIL_API_KEY}` };
    const api = (process.env.SAILBOX_API_URL ?? "https://sailbox-api.sailresearch.com").replace(/\/+$/, "").replace(/\/v1$/, "");
    const q = new URLSearchParams({ from: hourFloor(e.startedAt!), to: hourCeil(e.endedAt!), sailbox_id: e.sandboxId! });
    const j = await getJson(`${api}/v1/sailboxes/spend?${q}`, h);
    const row = (j.sailboxes ?? []).find((s: any) => s.sailbox_id === e.sandboxId);
    if (!row) return { source: "sail /sailboxes/spend: not posted yet (a few minutes)" };
    const fees = j.creation_fees_waived ? "creation fee waived" : `${row.creation_count ?? 0} creation charge`;
    return {
      usd: round((row.cost_usd_nanos ?? 0) / 1e9),
      seconds: Math.round(row.running_seconds ?? 0),
      source: `sail /sailboxes/spend cost_usd_nanos (estimate at list rates; ${fees}; ${Math.round(row.vcpu_seconds ?? 0)} vCPU-s, ${Math.round(row.memory_gib_seconds ?? 0)} GiB-s)`,
    };
  },

  async e2b() {
    return { source: "no billing API: compare the console usage tab (console.e2b.dev, Usage)" };
  },

  async openscale() {
    return { source: "no billing HTTP API: `openscale balance` before and after, or the dashboard" };
  },
};

export async function settle(run: CostRun): Promise<CostRun> {
  for (const e of run.entries) {
    if (!e.sandboxId || !e.startedAt || !e.endedAt) continue;
    if (e.bill?.usd !== undefined) continue;
    const read = BILL_READERS[e.provider];
    const at = new Date().toISOString();
    if (!read) {
      e.bill = { source: "no reader for this provider yet", at };
      continue;
    }
    try {
      e.bill = { ...(await read(e)), at };
    } catch (err) {
      e.bill = { source: `could not read: ${(err as Error).message.slice(0, 200)}`, at };
    }
  }
  return run;
}

const usd = (n?: number) => (n === undefined ? "n/a" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);

export function costMarkdown(run: CostRun): string {
  const lines = [
    "| Provider | Asked for | Got | Ran | Predicted (list × time) | Billed | Billed ÷ predicted | Source |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const e of run.entries) {
    const got = e.delivered ? `${e.delivered.vcpu} vCPU / ${(e.delivered.memoryMb / 1024).toFixed(1)} GB` : "n/a";
    const ratio = e.bill?.usd !== undefined && e.predictedUsd ? `${((e.bill.usd / e.predictedUsd) * 100).toFixed(0)}%` : "n/a";
    const ran = e.seconds !== undefined ? `${e.seconds} s${e.bill?.seconds !== undefined ? ` (billed ${e.bill.seconds} s)` : ""}` : "n/a";
    lines.push(
      `| ${e.provider} | ${e.requested.vcpu} vCPU / ${e.requested.memoryGb} GB | ${got} | ${ran} | ${usd(e.predictedUsd)} | ${usd(e.bill?.usd)} | ${ratio} | ${e.error ? `error: ${e.error}` : (e.bill?.source ?? "not settled")} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Billed / predicted per provider, from the saved cost runs in `dir` (default results/cost): the latest
 * entry whose bill is precise enough to compare. A bill rounded to whole cents only counts when the
 * prediction is at least $1, so rounding can't move the ratio by more than 1%. Providers whose terms
 * forbid publishing benchmarks are left out, like everywhere else results are published.
 */
export function billedVsList(dir = "results/cost"): { provider: ProviderId; ratio: number; date: string }[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const latest = new Map<ProviderId, { ratio: number; date: string }>();
  for (const f of files) {
    let run: CostRun;
    try {
      run = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (run?.tool !== "sandboxrouter-cost" || !Array.isArray(run.entries)) continue;
    for (const e of run.entries) {
      const usd = e.bill?.usd;
      const predicted = e.predictedUsd;
      if (!usd || !predicted || usd <= 0 || predicted <= 0 || !benchmarksPublishable(e.provider)) continue;
      if (/integer cents/i.test(e.bill!.source) && predicted < 1) continue;
      const date = run.date.slice(0, 10);
      const prev = latest.get(e.provider);
      if (!prev || date >= prev.date) latest.set(e.provider, { ratio: Math.round((usd / predicted) * 1000) / 1000, date });
    }
  }
  return [...latest].map(([provider, v]) => ({ provider, ...v })).sort((a, b) => a.provider.localeCompare(b.provider));
}
