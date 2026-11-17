// Generates web/src/data/site.json from the library itself, so the website can't drift from the code.
// Run from the repo root: node --import tsx scripts/site-data.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { benchmarksPublishable, billingRules, CATALOG, hourlyCost, planLabel, unfit } from "../src/catalog.js";
import { agentTable, aggregate, burstTable, loadAgentReports, loadBursts, loadReports, taskTable } from "../src/leaderboard.js";
import { TASKS } from "../src/task.js";
import { priceIndex } from "../src/price-index.js";
import { computerCatalog } from "../src/computers.js";
import { CHECK_STEPS } from "../src/check.js";
import { conformanceTable, liveStatus } from "../src/conformance.js";
import { BILLED_VS_LIST } from "../src/billing.js";
import type { CostRun } from "../src/cost.js";
import { Router, rankUsd, runHours } from "../src/router.js";
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

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Providers whose terms forbid publishing benchmarks are dropped from every report before anything is computed.
const reports = loadReports("results").map((r) => ({ ...r, rows: r.rows.filter((x) => benchmarksPublishable(x.provider)) }));
const rows = new Map(conformanceTable().map((r) => [r.provider, r]));
const conformance = new Map([...rows].map(([id, r]) => [id, r.run]));
const names = new Map(CATALOG.map((c) => [c.id, c.name]));

/** Every saved `cost run` (results/cost/*.json), newest first: list price × time against the provider's own bill. */
const COST_DIR = "results/cost";
const costRuns = (existsSync(COST_DIR) ? readdirSync(COST_DIR).filter((f) => f.endsWith(".json")) : [])
  .map((f) => JSON.parse(readFileSync(`${COST_DIR}/${f}`, "utf8")) as CostRun)
  .sort((a, b) => b.date.localeCompare(a.date));
const costRows = costRuns.flatMap((run) =>
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
    error: e.error ?? null,
  })),
);

/**
 * The best providers for common jobs, ranked the way the router ranks them: what that run would really be
 * billed (minimum charge, billing increment, per-sandbox charge), list price corrected by measured bills.
 * Only providers that passed the real-account check. No speed tie-break: that depends on where you run.
 */
const USE_CASES: { id: string; title: string; blurb: string; spec: SandboxSpec; require?: Capability[] }[] = [
  { id: "quick", title: "Quick tool calls", blurb: "Run a snippet and throw the sandbox away: about 10 seconds.", spec: { vcpu: 2, memoryGb: 4, expectedSeconds: 10 } },
  {
    id: "session",
    title: "Agent sessions",
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
    .plan(u.spec, { strategy: "cheapest", require: u.require })
    .filter((c) => !c.skip)
    .slice(0, 8)
    .map((c) => ({
      provider: c.provider,
      name: names.get(c.provider) ?? c.provider,
      runUsd: rankUsd(c, hours) * hours,
      runHourlyUsd: rankUsd(c, hours),
      hourlyUsd: c.estimatedHourlyUsd,
      perSandboxUsd: c.perSandboxUsd ?? 0,
      minimumSeconds: billingRules(c.provider).minSeconds,
    }));
  return { id: u.id, title: u.title, blurb: u.blurb, spec: u.spec, require: u.require ?? [], runSeconds: Math.round(hours * 3600), top };
});

const data = {
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
    defaultSize: c.defaultSize ? { vcpu: c.defaultSize.vcpu, memoryGb: c.defaultSize.memoryGb } : null,
    check: conformance.get(c.id) ?? null,
    live: liveStatus(rows.get(c.id)!),
    billedVsList: BILLED_VS_LIST[c.id] ?? null,
    computers: Object.keys(computerCatalog().find((d) => d.id === c.id)?.os ?? {}),
    prices: Object.fromEntries(
      SHAPES.map((s) => [`${s.vcpu}x${s.memoryGb}`, { usd: Math.round(hourlyCost(c.id, s) * 10000) / 10000, unfit: unfit(c.id, s) }]),
    ),
  })),
  checkSteps: CHECK_STEPS,
  desktops: computerCatalog(),
  leaderboard: aggregate(reports),
  tasks: {
    kinds: (
      [
        ["short", "Short job", "Hashing on one and two cores, then a disk write: a few seconds."],
        ["long", "Long job", "The short job 40 times in a row: minutes of steady work."],
        ["python", "Python", "A Python script, like a code-interpreter call."],
        ["download", "Download", "A 53 MB download from nodejs.org."],
        ["agent", "Agent loop", "10 turns of a 6 s model wait and a short Python tool call: about a minute, mostly idle."],
        ["repo", "Real repo", "What a coding agent does first: fetch Node and a real TypeScript project, npm ci, typecheck."],
      ] as const
    )
      .map(([id, title, blurb]) => ({
        id,
        title,
        blurb,
        version: TASKS[id].version,
        repeat: TASKS[id].repeat,
        phases: TASKS[id].phases.map((p) => ({ id: p.id, label: p.label })),
        rows: taskTable(reports, TASKS[id].version),
        // Benched with this job but never finished it (no python3, no internet, ...): worth saying, not hiding.
        couldNot: [
          ...new Set(
            reports
              .filter((r) => r.task === TASKS[id].version)
              .flatMap((r) => r.rows)
              .filter((x) => x.runs > x.failures && x.medianTaskMs === undefined)
              .map((x) => x.provider),
          ),
        ]
          .filter((p) => !taskTable(reports, TASKS[id].version).some((t) => t.provider === p))
          .map((p) => names.get(p) ?? p),
      }))
      .filter((k) => k.rows.length),
  },
  useCases,
  // Under load: N sandboxes at once, alone, each running a Python step (RL rollouts), or the agent loop (parallel agents).
  load: (() => {
    const bursts = loadBursts("results");
    // Two sizes: 10 at once, which every account allows, so everyone faces the same load; and 100 at once, which
    // shows how fast and steady each provider is at scale.
    const jobs = [
      { job: "start", task: undefined, title: "Start only", blurb: "each answering one command" },
      { job: "rl", task: TASKS.python.version, title: "RL rollouts", blurb: "each running a short Python step, like a batch of RL rollouts or evals" },
      { job: "agents", task: TASKS.agent.version, title: "Parallel agents", blurb: "each running the minute-long agent loop, mostly waiting on the model" },
    ] as const;
    return [10, 100].flatMap((n) =>
      jobs
        .map((j) => ({ id: `${j.job}-${n}`, n, job: j.job, title: j.title, blurb: `${n} sandboxes at once, ${j.blurb}.`, rows: burstTable(bursts, j.task, n) }))
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
  start: Object.fromEntries(
    data.leaderboard
      .filter((r) => r.medianCreateMs !== undefined)
      .map((r) => [r.provider, seen({ name: r.name, medianCreateMs: r.medianCreateMs!, successRate: r.successRate, runs: r.runs, hourlyUsd: r.hourlyUsd, measuredAt: r.measuredAt })]),
  ),
  jobs: Object.fromEntries(
    data.tasks.kinds.map((k) => [
      k.id,
      Object.fromEntries(
        k.rows.map((r) => [
          r.provider,
          seen({
            name: r.name,
            createMs: r.createMs,
            taskMs: r.taskMs,
            taskUsd: r.taskUsd,
            reusedUsd: r.reusedUsd,
            successRate: r.successRate,
            runs: r.runs,
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
