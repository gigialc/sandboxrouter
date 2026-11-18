// Generates web/src/data/site.json from the library itself, so the website can't drift from the code.
// Run from the repo root: node --import tsx scripts/site-data.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { accountStartFees, benchmarksPublishable, billingRules, CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, fittingSpec, hourlyCost, planLabel, planOnlyStartFee, unfit, withOwnImages } from "../src/catalog.js";
import type { SpreadResult } from "../src/burst.js";
import { agentTable, aggregate, burstTable, loadAgentReports, loadBursts, loadReports, taskOutcomes, taskTable } from "../src/leaderboard.js";
import { TASKS } from "../src/task.js";
import { priceIndex } from "../src/price-index.js";
import { computerCatalog } from "../src/computers.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable, liveStatus } from "../src/conformance.js";
import { BILLED_VS_LIST } from "../src/billing.js";
import { billKind, billResolutionUsd, type CostRun, type HostedLedgerRun } from "../src/cost.js";
import { Router, rankUsd, runHours, type Size } from "../src/router.js";
import { VERIFIED } from "../src/verified.js";
import type { PublishedData, PublishedLoad } from "../src/recommend.js";
import type { Capability, Provider, ProviderId, SandboxSpec } from "../src/types.js";

const SHAPES = [
  { vcpu: 1, memoryGb: 2 },
  { vcpu: 2, memoryGb: 4 },
  { vcpu: 4, memoryGb: 8 },
  { vcpu: 8, memoryGb: 16 },
  { vcpu: 16, memoryGb: 32 },
  { vcpu: 32, memoryGb: 128 },
];

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Providers whose terms forbid publishing benchmarks are dropped from every report before anything is computed.
const reports = loadReports("results").map((r) => ({ ...r, rows: r.rows.filter((x) => benchmarksPublishable(x.provider)) }));
const standardSize = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
const smallerSizes = new Map<string, Size>();
for (const { spec } of reports) {
  const { vcpu = DEFAULT_VCPU, memoryGb = DEFAULT_MEMORY_GB } = spec ?? {};
  if (vcpu <= DEFAULT_VCPU && memoryGb <= DEFAULT_MEMORY_GB && (vcpu < DEFAULT_VCPU || memoryGb < DEFAULT_MEMORY_GB)) {
    smallerSizes.set(`${vcpu}x${memoryGb}`, { vcpu, memoryGb });
  }
}
const benchmarkSizes = [standardSize, ...[...smallerSizes.values()].sort((a, b) => b.vcpu - a.vcpu || b.memoryGb - a.memoryGb)];

/** Prefer standard measurements. Show another cohort only for a provider without a measurement at that size. */
function benchmarkRows<T extends { provider: ProviderId }>(read: (size: Size) => T[], measured: (row: T) => boolean): T[] {
  const chosen = new Map<ProviderId, T>();
  for (const size of benchmarkSizes) {
    for (const row of read(size)) {
      const prior = chosen.get(row.provider);
      if (!prior || (!measured(prior) && measured(row))) chosen.set(row.provider, row);
    }
  }
  return [...chosen.values()];
}
const rows = new Map(conformanceTable().map((r) => [r.provider, r]));
const conformance = new Map([...rows].map(([id, r]) => [id, r.run]));
const names = new Map(CATALOG.map((c) => [c.id, c.name]));

/** Saved vendor usage and hosted credit ledger checks, newest first. */
const COST_DIR = "results/cost";
const costRuns = (existsSync(COST_DIR) ? readdirSync(COST_DIR).filter((f) => f.endsWith(".json")) : [])
  .map((file) => ({ file, run: JSON.parse(readFileSync(`${COST_DIR}/${file}`, "utf8")) as CostRun | HostedLedgerRun }))
  .sort((a, b) => b.run.date.localeCompare(a.run.date));
const costRows = costRuns.flatMap(({ file, run }) => run.tool === "sandboxrouter-cost" ?
  run.entries.filter((e) => benchmarksPublishable(e.provider)).map((e) => ({
    provider: e.provider,
    name: names.get(e.provider) ?? e.provider,
    date: run.date,
    minutes: run.minutes,
    load: run.load,
    by: run.by ?? null,
    requested: e.requested,
    delivered: e.delivered ? { vcpu: e.delivered.vcpu, memoryGb: Math.round((e.delivered.memoryMb / 1024) * 10) / 10 } : null,
    seconds: e.seconds ?? null,
    predictedUsd: e.predictedUsd ?? null,
    billedUsd: e.bill?.usd ?? null,
    billedSeconds: e.bill?.seconds ?? null,
    billSource: e.bill?.source ?? null,
    billKind: billKind(e.bill) ?? null,
    billResolutionUsd: billResolutionUsd(e.bill) ?? null,
    settledAt: e.bill?.at ?? null,
    file,
    error: e.error ? "Sandbox run did not complete" : null,
  })) : [],
);
const hostedCosts = costRuns.flatMap(({ file, run }) => run.tool === "sandboxrouter-hosted-ledger" ?
  run.entries.filter((entry) => benchmarksPublishable(entry.provider)).map((entry) => ({
    ...entry,
    name: names.get(entry.provider) ?? entry.provider,
    date: run.date,
    file,
  })) : []);

/**
 * The best providers for common jobs, ranked the way the router ranks them: what that run would really be
 * billed (minimum charge, billing increment, per-sandbox charge), list price corrected by measured bills.
 * Only providers that passed the real-account check. No speed tie-break: that depends on where you run.
 */
const USE_CASES: { id: string; title: string; blurb: string; spec: SandboxSpec; require?: Capability[] }[] = [
  { id: "quick", title: "Quick tool calls", blurb: "Run a snippet and throw the sandbox away: about 10 seconds.", spec: { vcpu: 2, memoryGb: 4, expectedSeconds: 10 } },
  {
    id: "session",
    title: "30-minute agent session",
    blurb: "A coding agent working for 30 minutes, mostly waiting on the model.",
    spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 30, cpuUtilization: 0.1 },
  },
  { id: "long", title: "Long jobs", blurb: "Evals, crawls or builds that run for 4 hours.", spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 240 } },
  { id: "big", title: "Big machines", blurb: "8 vCPU / 16 GB for an hour: heavy builds and test suites.", spec: { vcpu: 8, memoryGb: 16, timeoutMinutes: 60 } },
  { id: "pause", title: "Pause and resume", blurb: "Keep the disk, stop paying for CPU, pick it up later (30 minutes running).", spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 30 }, require: ["pause"] },
  { id: "image", title: "Your own image", blurb: "Start from your own container image (30 minutes).", spec: { vcpu: 2, memoryGb: 4, timeoutMinutes: 30 }, require: ["custom-image"] },
];
// Stand-ins with every key "set": ranking reads only the catalog, never a provider.
const stub = (id: ProviderId): Provider => ({
  id,
  configured: () => true,
  create: () => Promise.reject(new Error("site data never starts sandboxes")),
  connect: () => Promise.reject(new Error("site data never starts sandboxes")),
});
const ranker = new Router({ providers: Object.keys(VERIFIED).map((id) => stub(id as ProviderId)), ledger: false, requireVerified: true });
const useCases = USE_CASES.map((u) => {
  const hours = runHours(u.spec);
  const top = ranker
    .plan(withOwnImages(u.spec), { strategy: "cheapest", require: u.require })
    .filter((c) => !c.skip)
    .map((c) => ({
      provider: c.provider,
      name: names.get(c.provider) ?? c.provider,
      // A fee only one plan pays is left out and noted, like start fees above an allowance.
      runUsd: rankUsd(c, hours) * hours - planOnlyStartFee(c.provider),
      runHourlyUsd: rankUsd(c, hours) - planOnlyStartFee(c.provider) / hours,
      hourlyUsd: c.estimatedHourlyUsd,
      perSandboxUsd: (c.perSandboxUsd ?? 0) - planOnlyStartFee(c.provider),
      minimumSeconds: billingRules(c.provider).minSeconds,
      // Its default image is smaller: this size needs your own image or template.
      ownImage: CATALOG.find((x) => x.id === c.provider)?.defaultSize !== undefined,
    }))
    .sort((a, b) => a.runUsd - b.runUsd);
  return { id: u.id, title: u.title, blurb: u.blurb, spec: u.spec, require: u.require ?? [], runSeconds: Math.round(hours * 3600), top };
});

// The at-scale proof on the homepage: the newest spread report (N at once over several providers, with spillover),
// compared with the recorded standalone tests in the same location at the same burst size.
const scale = (() => {
  const spreads = readdirSync("results")
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`results/${f}`, "utf8")))
    .filter((j) => j?.tool === "sandboxrouter-spread")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const s: (SpreadResult & { date: string; label?: string }) | undefined = spreads[0];
  if (!s) return null;
  const singles = loadBursts("results")
    .filter((b) => b.n === s.n && !b.task && b.label === s.label)
    .flatMap((b) => b.rows.map((r) => ({ provider: r.provider, ok: r.ok })))
    .sort((a, b) => b.ok - a.ok);
  const best = singles[0];
  return {
    date: s.date,
    n: s.n,
    ok: s.ok,
    poolSize: s.byProvider.length,
    wallMs: s.wallMs,
    standaloneProviders: new Set(singles.map((r) => r.provider)).size,
    byProvider: s.byProvider
      .filter((b) => b.ok > 0)
      .map((b) => ({ provider: b.provider, name: CATALOG.find((c) => c.id === b.provider)?.name ?? b.provider, ok: b.ok, spilledIn: b.spilledIn })),
    bestSingle: best ? { provider: best.provider, name: CATALOG.find((c) => c.id === best.provider)?.name ?? best.provider, ok: best.ok } : null,
  };
})();

// Provider icons fetched by scripts/fetch-logos.py: id -> file under /logos/.
const LOGOS: Record<string, string> = Object.fromEntries(
  (existsSync("web/public/logos") ? readdirSync("web/public/logos") : []).map((f) => [f.replace(/\.[a-z]+$/, ""), `/logos/${f}`]),
);

const data = {
  logos: LOGOS,
  scale,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  shapes: SHAPES.map((s) => `${s.vcpu}x${s.memoryGb}`),
  providers: CATALOG.map((c) => ({
    id: c.id,
    name: c.name,
    local: c.local ?? false,
    capabilities: c.capabilities,
    limits: c.limits,
    credentials: c.credentials,
    docs: c.docs,
    pricing: c.pricing,
    access: c.access ?? null,
    billing: c.billing,
    plan: c.plan ?? null,
    noBenchmarks: c.noBenchmarks ?? null,
    planLabel: c.local ? "none" : planLabel(c.id),
    // The default image's size and its list price at that size.
    defaultSize: c.defaultSize ? { vcpu: c.defaultSize.vcpu, memoryGb: c.defaultSize.memoryGb, usd: round4(hourlyCost(c.id)) } : null,
    check: conformance.get(c.id) ?? null,
    live: liveStatus(rows.get(c.id)!),
    billedVsList: BILLED_VS_LIST[c.id] ?? null,
    computers: Object.keys(computerCatalog().find((d) => d.id === c.id)?.os ?? {}),
    prices: Object.fromEntries(
      SHAPES.map((s) => {
        const reason = unfit(c.id, s);
        // A size above the default image's, within the provider's limits: priced at that size, which needs your own image.
        if (reason?.startsWith("default image") && c.capabilities.includes("custom-image") && !unfit(c.id, withOwnImages(s)))
          return [`${s.vcpu}x${s.memoryGb}`, { usd: round4(hourlyCost(c.id, withOwnImages(s))), unfit: null, ownImage: true }];
        return [`${s.vcpu}x${s.memoryGb}`, { usd: round4(hourlyCost(c.id, s)), unfit: reason }];
      }),
    ),
  })),
  checkSteps: CHECK_STEPS,
  desktops: computerCatalog(),
  leaderboard: benchmarkRows((size) => aggregate(reports, size), (row) => row.medianCreateMs !== undefined)
    .sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity)),
  tasks: {
    kinds: (
      [
        // Titles match the job names in the site's provider finder.
        ["short", "Short CPU job", "One hash, then two concurrent hashes, then a disk write."],
        ["long", "Long job", "The short job 40 times in a row: minutes of steady work."],
        ["python", "Quick Python run", "A Python script, like a code-interpreter call."],
        ["download", "Download", "A 53 MB download from nodejs.org."],
        ["agent", "Agent session", "10 turns of a 6 s model wait and a short Python tool call: about a minute, mostly idle."],
        ["repo", "Coding agent on a repo", "What a coding agent does first: fetch Node and a real TypeScript project, npm ci, typecheck."],
      ] as const
    )
      .map(([id, title, blurb]) => {
        const { version, repeat, phases, cpuUtilization } = TASKS[id];
        const selected = benchmarkRows((size) => {
          const completed = new Map(taskTable(reports, version, size).map((row) => [row.provider, row]));
          return taskOutcomes(reports, version, size).map((outcome) => ({
            provider: outcome.provider,
            outcome,
            row: completed.get(outcome.provider),
          }));
        }, (entry) => entry.row !== undefined);
        return {
          id, title, blurb, version, repeat,
          // The CPU share the hourly column is priced at, when the job is mostly idle.
          cpuUtilization: cpuUtilization ?? null,
          phases: phases.map((p) => ({ id: p.id, label: p.label })),
          rows: selected.flatMap(({ row }) => row ? [row] : []).sort((a, b) => a.taskUsd - b.taskUsd),
          outcomes: selected.map(({ outcome }) => outcome),
        };
      })
      .filter((k) => k.outcomes.length),
  },
  useCases,
  // Under load: N sandboxes at once, alone, each running the quick Python job, or the agent loop (parallel agents).
  load: (() => {
    const bursts = loadBursts("results");
    // Two request sizes; all recorded outcomes survive, including providers that never got ready.
    const jobs = [
      { job: "start", task: undefined, title: "Start only", blurb: "each answering one command" },
      { job: "rl", task: TASKS.python.version, title: "Quick Python runs", blurb: "each running the 1 to 2 second Python job, like a batch of code-interpreter calls" },
      { job: "agents", task: TASKS.agent.version, title: "Parallel agents", blurb: "each running the minute-long agent loop, mostly waiting on the model" },
    ] as const;
    return [10, 100].flatMap((n) =>
      jobs
        .map((j) => ({ id: `${j.job}-${n}`, n, job: j.job, title: j.title, blurb: `${n} sandboxes at once, ${j.blurb}.`, rows: burstTable(bursts, j.task, n)
          .map((r) => (r.usd !== undefined && planOnlyStartFee(r.provider) ? { ...r, usd: Math.max(0, r.usd - planOnlyStartFee(r.provider) * r.ok) } : r))
          // Reports that didn't record a size ran each provider at the size it takes as-is.
          .map((r) => ({ ...r, size: r.size ?? fittingSpec(r.provider) })) }))
        .filter((k) => k.rows.length),
    );
  })(),
  // A real agent (Gemini) doing the same task in a sandbox on each provider.
  agent: agentTable(loadAgentReports("results")),
  // Today's price index, and how it has moved (scripts/price-index.json, recorded daily when it changes).
  priceIndex: {
    lines: priceIndex(),
    history: existsSync("scripts/price-index.json") ? JSON.parse(readFileSync("scripts/price-index.json", "utf8")) : [],
  },
  costRuns: costRows,
  hostedCosts,
  submissions: reports.map((r) => ({
    date: r.date,
    label: r.label ?? null,
    by: r.by ?? null,
    platform: r.platform,
    runs: r.runs,
    providers: r.rows.length,
    ids: r.rows.map((x) => x.provider),
  })),
};

writeFileSync("web/src/data/site.json", JSON.stringify(data, null, 2) + "\n");

// The same numbers in the shape the SDK's routing, `recommend()`, /benchmarks.json and the MCP tool read.
// Deterministic (no generation time), so CI can check it matches the results.
const dates: string[] = [];
const seen = <T extends { measuredAt: string }>(x: T) => (dates.push(x.measuredAt), x);
const published: PublishedData = {
  schema: 1,
  dataThrough: "",
  conditionalStartFees: accountStartFees(),
  start: Object.fromEntries(
    data.leaderboard
      .filter((r) => r.medianCreateMs !== undefined)
      .map((r) => [r.provider, seen({
        name: r.name, size: r.size, medianCreateMs: r.medianCreateMs!, medianReadyMs: r.medianReadyMs,
        successRate: r.successRate, runs: r.runs, hourlyUsd: r.hourlyUsd, measuredAt: r.measuredAt,
      })]),
  ),
  jobs: Object.fromEntries(
    data.tasks.kinds.map((k) => [
      k.id,
      Object.fromEntries(
        k.rows.map((r) => [
          r.provider,
          seen({
            name: r.name,
            size: { vcpu: r.size.vcpu, memoryGb: r.size.memoryGb },
            createMs: r.createMs,
            taskMs: r.taskMs,
            taskUsd: r.taskUsd,
            reusedUsd: r.reusedUsd,
            successRate: r.successRate,
            runs: r.runs,
            ok: r.ok,
            limited: r.limited,
            ...(r.minimumSeconds ? { minimumSeconds: r.minimumSeconds } : {}),
            ...(r.perSandboxUsd ? { perSandboxUsd: r.perSandboxUsd } : {}),
            measuredAt: r.measuredAt,
          }),
        ]),
      ),
    ]),
  ),
  load: data.load.map(
    (k): PublishedLoad => ({
      n: k.n,
      job: k.job,
      rows: Object.fromEntries(
        k.rows.map((r) => [
          r.provider,
          seen({
            name: r.name,
            n: r.n,
            ok: r.ok,
            limited: r.limited ?? 0,
            size: r.size,
            createFailures: r.createFailures,
            commandFailures: r.commandFailures,
            taskFailures: r.taskFailures,
            cleanupFailures: r.cleanupFailures,
            ...(r.p50Ms !== undefined ? { p50Ms: r.p50Ms } : {}),
            ...(r.p99Ms !== undefined ? { p99Ms: r.p99Ms } : {}),
            wallMs: r.wallMs,
            ...(r.usd !== undefined && r.ok ? { usdPer100: Math.round((r.usd / r.ok) * 100 * 1e6) / 1e6 } : {}),
            measuredAt: r.measuredAt,
          }),
        ]),
      ),
    }),
  ),
};
published.dataThrough = dates.sort().at(-1) ?? "";
writeFileSync("web/src/data/published.json", JSON.stringify(published, null, 2) + "\n");
writeFileSync(
  "src/published.ts",
  `// Generated by scripts/site-data.ts from results/; don't edit by hand.
// The published benchmark numbers (sandboxrouter.ai/benchmarks), carried by the SDK so routing and recommend()
// work from measured data before you've run any benchmarks of your own.
import type { PublishedData } from "./recommend.js";

export const PUBLISHED: PublishedData = ${JSON.stringify(published, null, 2)};
`,
);
// The website answers recommendations with the same code as the SDK.
writeFileSync(
  "web/src/lib/recommend.ts",
  "// Generated by scripts/site-data.ts: a copy of src/recommend.ts. Edit that file, not this one.\n" + readFileSync("src/recommend.ts", "utf8"),
);
console.log(`site.json: ${data.providers.length} providers, ${data.desktops.length} desktop providers, ${reports.length} reports`);
