#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, arch } from "node:os";
import { ACCOUNT_ERROR, bench, benchMarkdown, NETWORK_ERROR } from "./bench.js";
import { TASKS, type TaskKind } from "./task.js";
import { submitReport } from "./submit.js";
import { burst } from "./burst.js";
import { agentBench, AGENT_TASK_VERSION } from "./agent-bench.js";

/** Errors that mean the network between here and the provider failed, not the provider. */
import { costMarkdown, costRun, settle, type CostRun } from "./cost.js";
import { checkProvider, type CheckReport } from "./check.js";
import { gc, listOpen } from "./gc.js";
import { contributor, publishableCheck } from "./results.js";
import { loadReports, makeReport, renderLeaderboard } from "./leaderboard.js";
import { CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, accessLabel, benchmarksPublishable, hourlyCost, listingOrder, planLabel, unfit } from "./catalog.js";
import { Router, rankUsd, runHours } from "./router.js";
import { createApp } from "./server.js";
import { PUBLISHED } from "./published.js";
import { recommend, type RecJob, type RecPriority } from "./recommend.js";
import { RouterError, type Capability, type ProviderId, type RouteOptions, type SandboxSpec, type Strategy } from "./types.js";

const HELP = `sandboxrouter: one API for every sandbox provider

Usage:
  sandboxrouter providers [--vcpu N] [--memory GB]   price table + which keys are set
  sandboxrouter route     [spec flags] [route flags] dry run: the order providers would be tried
  sandboxrouter quote     [spec/route flags] [--json]  where a create would land and what the run would cost
  sandboxrouter recommend [--job short|long|python|download|agent|repo|start] [--count N] [--priority value|cost|speed]
                          [--reuse] [--provider a,b] [--json]
                          which provider for a job, from the published benchmarks: per successful run, with start
                          times under load for --count 10 and up; --provider limits it to the ones you name
  sandboxrouter run "<cmd>" [spec flags] [route flags] [--keep]
  sandboxrouter check     --provider ID[,ID] | --all [--json] [--save [dir]] [--retry] [--out FILE] [--by GITHUB_USER]
                          test providers for real: exec, env, UTF-8, streaming, files, timeout, pause,
                          kill; exits 1 if any step fails. --all = every configured provider;
                          --save writes results/conformance/<id>.json for the compatibility table;
                          --retry runs a failed provider once more and keeps that result;
                          --out writes every report as JSON (with the first try's failure, if retried)
  sandboxrouter ls        [--json]                       sandboxes this machine started that weren't killed
  sandboxrouter gc        [--all | --older-than MIN] [--dry-run]
                          kill leaked sandboxes: by default those past their lifetime
  sandboxrouter bench     [--runs 3] [--provider a,b] [--task [--long]] [--parallel N] [--json] [--share [--label "where you ran it"] [--by GITHUB_USER] [--submit]]
                          --task also runs the same fixed job in each sandbox (hash 512 MB on 1 core,
                          then on 2, write 256 MB to disk) and prices it with each provider's billing rules;
                          --long runs that job 40 times in a row (minutes); --job python (a pure-Python script)
                          or --job download (53 MB over HTTPS) runs another job. --parallel benches N providers at once
  sandboxrouter burst     [--n 100] [--provider a,b] [--job python|agent] [--parallel 1] [--share [--label PLACE] [--by GITHUB_USER] [--submit]]
                          start --n sandboxes at once on each provider (time to interactive at p50/p95/p99, how many
                          started); --job runs a standard job in each: python for RL-style rollouts, agent for parallel agents
  sandboxrouter agentbench [--runs 5] [--provider a,b] [--model gemini-3.5-flash] [--parallel 4] [--share ...]
                          a real agent (Gemini, GEMINI_API_KEY) does the same task in a sandbox on each provider;
                          the key stays here and only its shell commands run in the sandbox
  sandboxrouter cost run  [--provider a,b] [--minutes 10] [--vcpu 2 --memory 4] [--no-load] [--out FILE] [--by GITHUB_USER]
                          start one sandbox per provider for a fixed time with every core busy, record
                          the size it really got and the list-price prediction
  sandboxrouter cost settle FILE
                          read what each provider actually billed for those sandboxes (rerun until all
                          bills have posted) and print predicted vs billed
  sandboxrouter leaderboard [results-dir] [--out leaderboard.html]
  sandboxrouter desktop   [--os linux|windows|android|ios] [--user ID] [--control]
                          get or create a computer and print a link to watch (or take over) its screen
  sandboxrouter screenshot <provider:id> [--out screen.png]
  sandboxrouter serve     [--port 8787] [--host 127.0.0.1] [--cors https://site.example,http://localhost:3000]

Spec flags:   --vcpu N  --memory GB  --gpu T4  --timeout MIN  --expect SEC (how long you'll use it; ranks by the real bill)
              --cpu 0.1 (how busy the CPU is, 0-1; lowers providers that bill active CPU)
Route flags:  --provider e2b[,modal,...]  --strategy balanced|verified|cheapest|fastest (default balanced: cheapest real cost, speed breaks near-ties)
              --max-price USD (per hour, for this run: skip providers that would cost more)
              --no-fallback  --fallback-any (also on setup errors like a bad key)
              --create-timeout SEC (per provider, default 120)  --require gpu,custom-image

Keys: one env var group per provider; "sandboxrouter providers" lists them and shows which are set.
--by puts your GitHub username on a saved result, so the website can credit it.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vcpu: { type: "string" },
    memory: { type: "string" },
    gpu: { type: "string" },
    timeout: { type: "string" },
    expect: { type: "string" },
    cpu: { type: "string" },
    provider: { type: "string" },
    strategy: { type: "string" },
    "max-price": { type: "string" },
    "no-fallback": { type: "boolean" },
    "fallback-any": { type: "boolean" },
    "create-timeout": { type: "string" },
    require: { type: "string" },
    keep: { type: "boolean" },
    runs: { type: "string" },
    task: { type: "boolean" },
    long: { type: "boolean" },
    job: { type: "string" },
    count: { type: "string" },
    priority: { type: "string" },
    reuse: { type: "boolean" },
    parallel: { type: "string" },
    n: { type: "string" },
    model: { type: "string" },
    json: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
    os: { type: "string" },
    user: { type: "string" },
    control: { type: "boolean" },
    out: { type: "string" },
    share: { type: "boolean" },
    submit: { type: "boolean" },
    cors: { type: "string" },
    label: { type: "string" },
    all: { type: "boolean" },
    save: { type: "boolean" },
    retry: { type: "boolean" },
    "older-than": { type: "string" },
    "dry-run": { type: "boolean" },
    minutes: { type: "string" },
    "no-load": { type: "boolean" },
    by: { type: "string" },
  },
});

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

/** Plain left-aligned columns, two spaces apart; the last column isn't padded. */
function textTable(head: string[], rows: string[][]): string {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((v, i) => (i === r.length - 1 ? v : v.padEnd(width[i]))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}
const num = (s?: string) => (s === undefined ? undefined : Number(s));

const spec: SandboxSpec = {
  vcpu: num(values.vcpu),
  memoryGb: num(values.memory),
  gpu: values.gpu,
  timeoutMinutes: num(values.timeout),
  expectedSeconds: num(values.expect),
  cpuUtilization: num(values.cpu),
};
const providers = list(values.provider) as ProviderId[] | undefined;
const by = (() => {
  try {
    return contributor(values.by);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(2);
  }
})();
const route: RouteOptions = {
  provider: providers,
  strategy: values.strategy as Strategy | undefined,
  fallback: values["no-fallback"] ? false : values["fallback-any"] ? "any" : undefined,
  createTimeoutSeconds: num(values["create-timeout"]),
  require: list(values.require) as Capability[] | undefined,
  maxHourlyUsd: num(values["max-price"]),
};

async function main() {
  const [cmd, ...rest] = positionals;
  const router = new Router();

  if (!cmd || values.help) return console.log(HELP);

  if (cmd === "providers") {
    // The table is for a size, so ask for the default one explicitly when no flags are given.
    const size: SandboxSpec = { ...spec, vcpu: spec.vcpu ?? DEFAULT_VCPU, memoryGb: spec.memoryGb ?? DEFAULT_MEMORY_GB };
    const rows = listingOrder(size).map((c) => ({
      provider: c.name,
      id: c.id,
      "$/hr": unfit(c.id, size) ?? `${c.billing === "active-cpu" ? "up to " : ""}$${hourlyCost(c.id, size).toFixed(4)}`,
      plan: c.local ? "none" : planLabel(c.id),
      configured: router.isConfigured(c.id) ? "yes" : "no",
      capabilities: c.capabilities.join(", ") || "-",
      "sign-up": accessLabel(c.id) ?? "open",
    }));
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`${size.vcpu} vCPU / ${size.memoryGb} GB: estimated list price while running, cheapest first.\n`);
    const cells = listingOrder(size).map((c) => {
      const why = unfit(c.id, size);
      const usd = c.local ? "free" : why ? "skipped" : `${c.billing === "active-cpu" ? "≤ " : ""}$${hourlyCost(c.id, size).toFixed(4)}`;
      const note = [why, accessLabel(c.id), c.local ? "local; only used when named" : null].filter(Boolean).join("; ");
      const name = c.name.length > 30 ? `${c.name.slice(0, 29)}…` : c.name;
      return [c.id, name, usd, c.local ? "none" : planLabel(c.id), router.isConfigured(c.id) ? "set" : "-", c.capabilities.join(", ") || "-", note];
    });
    console.log(textTable(["ID", "PROVIDER", "$/HR", "PLAN", "KEY", "SUPPORTS", "NOTE"], cells));
    console.log(
      [
        "",
        "≤        billed on busy CPU only; the price with every core busy",
        "PLAN     monthly plan the API needs before it creates sandboxes (credited = paid back as usage)",
        "KEY      set = this provider's env vars are set here",
        "skipped  can't take this size. A provider skipped for its default image's size still takes",
        "         a create() that names no size, at that image's size.",
      ].join("\n"),
    );
    return;
  }

  if (cmd === "recommend") {
    const jobs = ["start", "short", "long", "python", "download", "agent", "repo"] as const;
    const priorities = ["value", "cost", "speed"] as const;
    const job = (values.job ?? "short") as RecJob;
    const priority = (values.priority ?? "value") as RecPriority;
    if (!jobs.includes(job)) throw new RouterError(`--job must be one of ${jobs.join(", ")}`);
    if (!priorities.includes(priority)) throw new RouterError(`--priority must be one of ${priorities.join(", ")}`);
    const count = values.count === undefined ? 1 : Number(values.count);
    if (!Number.isInteger(count) || count < 1) throw new RouterError("--count must be a whole number, 1 or more");
    const r = recommend(PUBLISHED, { job, count, priority, reuse: !!values.reuse, providers: values.provider?.split(",").map((s) => s.trim()) });
    if (values.json) return console.log(JSON.stringify(r, null, 2));
    const secs = (s: number) => (s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);
    const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toPrecision(2)}`);
    console.log(r.basis);
    console.log(`Data through ${r.dataThrough.slice(0, 10)}; sandboxrouter.ai/methodology explains how it's measured.\n`);
    for (const x of r.results.slice(0, 10)) {
      const cost = job === "start" ? `${money(x.hourlyUsd)}/h` : count > 1 ? `${money(x.usdTotal)} for ${count}` : money(x.usdEach);
      console.log(`${String(x.rank).padStart(2)}. ${x.name.padEnd(34)} ${secs(x.secondsEach).padStart(6)}  ${cost.padStart(14)}  value ${x.valueScore.toFixed(2)}${x.notes.length ? `  · ${x.notes.join(" · ")}` : ""}`);
    }
    return;
  }

  if (cmd === "quote") {
    const q = router.quote(spec, route);
    if (values.json) return console.log(JSON.stringify({ ...q, candidates: undefined }, null, 2));
    const rules = [
      q.minimumSeconds ? `at least ${q.minimumSeconds} s billed` : "",
      q.billedInSecondsOf ? `billed in steps of ${q.billedInSecondsOf} s` : "",
      q.perSandboxUsd ? `$${q.perSandboxUsd} per sandbox` : "",
    ].filter(Boolean);
    console.log(`${q.provider}, ${q.size.vcpu} vCPU / ${q.size.memoryGb} GB`);
    console.log(`price     $${q.hourlyUsd.toFixed(4)}/hr${rules.length ? ` (${rules.join(", ")})` : ""}`);
    console.log(`this run  ${q.runSeconds} s ≈ $${q.estimatedUsd.toFixed(6)} ($${q.runHourlyUsd.toFixed(4)}/hr)`);
    const next = q.candidates.filter((c) => !c.skip && c.provider !== q.provider).slice(0, 3).map((c) => c.provider);
    if (next.length) console.log(`fallback  ${next.join(" → ")}`);
    return;
  }

  if (cmd === "route") {
    const plan = router.plan(spec, route);
    if (values.json) return console.log(JSON.stringify(plan, null, 2));
    let n = 0;
    for (const c of plan) {
      const mark = c.skip ? "  -" : `${++n}.`.padStart(3);
      const tested = c.failing ? "check failed" : c.verified ? "tested" : "";
      // The list price only shows where a measured bill moved the estimate off it.
      const list = c.listHourlyUsd !== c.estimatedHourlyUsd ? ` (list $${c.listHourlyUsd.toFixed(4)})` : "";
      const size = `${c.size.vcpu} vCPU / ${c.size.memoryGb} GB`;
      const speed = c.medianCreateMs !== undefined ? `${c.medianCreateMs} ms` : "";
      const fee = c.perSandboxUsd ? ` + $${c.perSandboxUsd}/sandbox` : "";
      // With --expect, what that run would be billed (minimum charge and fee included): what it's ranked by.
      const hours = runHours(spec);
      const run = spec.expectedSeconds ? `  ≈ $${(rankUsd(c, hours) * hours).toFixed(6)} for ${Math.round(hours * 3600)} s` : "";
      const cols = [`$${c.estimatedHourlyUsd.toFixed(4)}/hr${list}${fee}${run}`, size, speed, tested].filter(Boolean).join("  ");
      console.log(`${mark} ${c.provider.padEnd(11)} ${cols}${c.skip ? `  (skipped: ${c.skip})` : ""}`);
    }
    return;
  }

  if (cmd === "run") {
    const command = rest.join(" ");
    if (!command) throw new RouterError('usage: sandboxrouter run "<cmd>"');
    const sbx = await router.create(spec, route);
    // Ctrl-C: kill the sandbox before exiting instead of leaving it billing.
    const stop = () => {
      console.error(`\n> interrupted, killing ${sbx.id}`);
      sbx.kill().finally(() => process.exit(130));
    };
    if (!values.keep) process.once("SIGINT", stop);
    for (const a of sbx.attempts.filter((a) => !a.ok)) console.error(`! ${a.provider} failed, fell back: ${a.error}`);
    console.error(`> ${sbx.id} on ${sbx.provider} (~$${sbx.estimatedHourlyUsd}/hr, started in ${sbx.attempts.at(-1)?.ms} ms)`);
    try {
      const r = await sbx.exec(command, {
        timeoutSeconds: 600,
        onStdout: (c) => process.stdout.write(c),
        onStderr: (c) => process.stderr.write(c),
      });
      process.exitCode = r.exitCode;
    } finally {
      if (values.keep) console.error(`> kept alive: ${sbx.id}`);
      else await sbx.kill();
    }
    return;
  }

  if (cmd === "check") {
    const ids = values.all ? router.registered().filter((id) => router.isConfigured(id)) : providers;
    if (!ids?.length) {
      if (values.all) return console.log("No providers configured: set at least one provider's keys (sandboxrouter providers lists them).");
      throw new RouterError("usage: sandboxrouter check --provider <id>[,<id>...] | --all");
    }
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const saveDir = values.save ? (rest[0] ?? "results/conformance") : undefined;
    const mark = { pass: "ok  ", fail: "FAIL", skip: "skip", info: "note" } as const;
    const reports: (CheckReport & { firstTry?: string })[] = [];
    const run = (p: ProviderId) =>
      checkProvider(router, p, {
        spec,
        onStep: (r) => {
          if (!values.json) console.log(`  ${mark[r.status]}  ${r.step.padEnd(32)} ${String(r.ms).padStart(6)} ms  ${r.detail ?? ""}`);
        },
      });
    for (const p of ids) {
      if (!values.json) console.log(`\n${p}`);
      let report: CheckReport & { firstTry?: string } = await run(p);
      if (values.retry && !report.ok && !report.inconclusive) {
        const failed = report.results.find((r) => r.status === "fail");
        if (!values.json) console.log(`  failed; trying ${p} once more`);
        report = { ...(await run(p)), firstTry: failed ? `${failed.step}: ${failed.detail ?? "failed"}` : "failed" };
      }
      reports.push(report);
      if (report.inconclusive) {
        if (!values.json) console.log(`  not saved: ${report.inconclusive}; ${p} keeps its last saved result`);
        continue;
      }
      if (saveDir) {
        mkdirSync(saveDir, { recursive: true });
        const { firstTry: _, ...result } = report;
        const saved = publishableCheck({ tool: "sandboxrouter-check", version, date: new Date().toISOString(), platform: `${platform()}-${arch()}`, ...(by ? { by } : {}), ...result });
        writeFileSync(`${saveDir}/${p}.json`, JSON.stringify(saved, null, 2) + "\n");
      }
    }
    if (values.out) writeFileSync(values.out, JSON.stringify(reports, null, 2) + "\n");
    if (values.json) console.log(JSON.stringify(reports, null, 2));
    else {
      const unpaid = reports.filter((r) => r.inconclusive).length;
      const ran = reports.length - unpaid;
      console.log(`\n${reports.filter((r) => r.ok).length}/${ran} passed${unpaid ? `; ${unpaid} not run (the account can't pay, or the provider's package isn't installed)` : ""}`);
    }
    if (reports.some((r) => !r.ok && !r.inconclusive)) process.exitCode = 1;
    return;
  }

  if (cmd === "ls") {
    if (!router.ledger) return console.log("The sandbox ledger is off (SANDBOXROUTER_LEDGER=off), so there is nothing to list.");
    const open = listOpen(router);
    if (values.json) return console.log(JSON.stringify(open, null, 2));
    if (!open.length) return console.log(`No open sandboxes in ${router.ledger.file}.`);
    for (const s of open) {
      const left = Math.round((Date.parse(s.expiresAt) - Date.now()) / 60_000);
      const when = s.expired ? `past its lifetime by ${-left} min` : `${left} min of lifetime left`;
      console.log(`${s.id.padEnd(40)} up ${String(s.ageMinutes).padStart(5)} min  ${when.padEnd(28)} ~$${s.estimatedUsdSoFar.toFixed(4)} so far`);
    }
    const expired = open.filter((s) => s.expired).length;
    console.log(`\n${open.length} open, ${expired} past their lifetime. "sandboxrouter gc" kills those; "gc --all" kills every one.`);
    return;
  }

  if (cmd === "gc") {
    if (!router.ledger) return console.log("The sandbox ledger is off (SANDBOXROUTER_LEDGER=off), so there is nothing to clean up.");
    const results = await gc(router, { all: values.all, olderThanMinutes: num(values["older-than"]), dryRun: values["dry-run"] });
    if (values.json) return console.log(JSON.stringify(results, null, 2));
    if (!results.length) return console.log("Nothing to clean up.");
    for (const r of results) console.log(`${r.action.padEnd(10)} ${r.id}${r.detail ? `  (${r.detail})` : ""}`);
    if (results.some((r) => r.action === "failed")) process.exitCode = 1;
    return;
  }

  if (cmd === "agentbench") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return console.error("agentbench needs GEMINI_API_KEY (it stays on this machine; only shell commands reach the sandbox)");
    const model = values.model ?? "gemini-3.5-flash";
    const ids = providers ?? router.registered().filter((id) => router.isConfigured(id));
    const rows = await agentBench({ router, providers: ids, runs: num(values.runs) ?? 5, apiKey, model, parallel: num(values.parallel), onProgress: (m) => console.error(m) });
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`\nsandboxrouter agentbench: ${model}, ${num(values.runs) ?? 5} runs each\n`);
    console.log("| Provider | Done right | Wall | Waiting on model | Sandbox CPU | Turns | Sandbox cost |\n|---|---|---|---|---|---|---|");
    const s = (v?: number) => (v === undefined ? "n/a" : `${(v / 1000).toFixed(1)} s`);
    for (const r of rows) console.log(`| ${r.provider} | ${r.ok}/${r.runs} | ${s(r.medianWallMs)} | ${s(r.medianModelMs)} | ${s(r.medianCpuMs)} | ${r.medianTurns ?? "n/a"} | ${r.medianUsd === undefined ? "n/a" : `$${r.medianUsd.toFixed(6)}`} |`);
    if (values.share || values.submit) {
      const started = rows.filter((r) => r.medianWallMs !== undefined);
      if (rows.length - started.length >= 3) {
        console.error(`\nnot writing a report: ${rows.length - started.length} providers never started a session, which looks like this machine lost its connection. Run it again.`);
        process.exitCode = 1;
        return;
      }
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
      const report = {
        tool: "sandboxrouter-agent",
        version,
        date: new Date().toISOString(),
        ...(values.label ? { label: values.label } : {}),
        ...(by ? { by } : {}),
        task: AGENT_TASK_VERSION,
        model,
        runs: num(values.runs) ?? 5,
        node: process.version,
        platform: `${platform()}-${arch()}`,
        rows: started.filter((r) => benchmarksPublishable(r.provider)),
      };
      const file = values.out ?? `sandboxrouter-agent-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      if (values.submit) {
        try {
          console.log(`\nwrote ${file} and opened ${submitReport(file, `Real agent (${model}) on ${report.rows.length} providers, from ${report.label ?? "an unlabelled location"}.`)}`);
        } catch (err) {
          console.error(`\nwrote ${file}, but couldn't open the pull request: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      } else console.log(`\nwrote ${file}`);
    }
    return;
  }

  if (cmd === "burst") {
    const n = num(values.n) ?? 100;
    const job = values.job as TaskKind | undefined;
    if (job && !(job in TASKS)) return console.error(`--job must be one of: ${Object.keys(TASKS).join(", ")}`);
    const ids = providers ?? router.registered().filter((id) => router.isConfigured(id));
    const rows = await burst({ router, providers: ids, n, task: job, parallel: num(values.parallel), onProgress: (m) => console.error(m) });
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`\nsandboxrouter burst: ${n} at once${job ? `, each running the ${job} job` : ""}\n`);
    console.log("| Provider | Started | p50 | p95 | p99 | All done | Burst cost |\n|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const ms = (v?: number) => (v === undefined ? "n/a" : `${v} ms`);
      console.log(`| ${r.provider} | ${r.ok}/${r.n}${r.limited ? ` (${r.limited} limited)` : ""} | ${ms(r.p50Ms)} | ${ms(r.p95Ms)} | ${ms(r.p99Ms)} | ${(r.wallMs / 1000).toFixed(1)} s | ${r.usd === undefined ? "n/a" : `$${r.usd.toFixed(4)}`} |`);
    }
    if (values.share || values.submit) {
      // As with bench: nothing from a run where this machine lost its connection, and no provider that never answered.
      const shared = rows.filter((r) => r.ok > 0 || r.limited > 0);
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
      const report = {
        tool: "sandboxrouter-burst",
        version,
        date: new Date().toISOString(),
        ...(values.label ? { label: values.label } : {}),
        ...(by ? { by } : {}),
        n,
        ...(job ? { task: TASKS[job].version } : {}),
        node: process.version,
        platform: `${platform()}-${arch()}`,
        rows: shared.filter((r) => benchmarksPublishable(r.provider)),
      };
      if (rows.length - shared.length >= 3) {
        console.error(`\nnot writing a report: ${rows.length - shared.length} providers started nothing, which looks like this machine lost its connection. Run it again.`);
        process.exitCode = 1;
        return;
      }
      const file = values.out ?? `sandboxrouter-burst-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      if (values.submit) {
        try {
          console.log(`\nwrote ${file} and opened ${submitReport(file, `Burst of ${n}${job ? ` running the ${job} job` : ""} on ${report.rows.length} providers, from ${report.label ?? "an unlabelled location"}.`)}`);
        } catch (err) {
          console.error(`\nwrote ${file}, but couldn't open the pull request: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      } else console.log(`\nwrote ${file}`);
    }
    return;
  }

  if (cmd === "bench") {
    const job = (values.long ? "long" : values.job ?? "short") as TaskKind;
    if (!(job in TASKS)) return console.error(`--job must be one of: ${Object.keys(TASKS).join(", ")}`);
    const rows = await bench({
      router,
      providers,
      runs: num(values.runs) ?? 3,
      task: values.task ? job : undefined,
      parallel: num(values.parallel),
      spec: { ...spec, timeoutMinutes: spec.timeoutMinutes ?? 5 },
      onProgress: (m) => console.error(m),
    });
    if (rows.length === 0) return console.error("No providers configured. Set at least one API key (see --help).");
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`\nsandboxrouter bench: ${new Date().toISOString().slice(0, 10)}, ${rows[0].runs} runs each\n`);
    console.log(benchMarkdown(rows));
    for (const r of rows.filter((r) => r.lastError)) console.error(`\n${r.provider} last error: ${r.lastError}`);
    // Several providers all failing on the network at once is this machine's connection, not theirs: a
    // report from it would mark them down. Refuse to write one.
    const offline = rows.filter((r) => r.failures === r.runs && r.lastError && NETWORK_ERROR.test(r.lastError));
    if ((values.share || values.submit) && offline.length >= 3) {
      console.error(`\nnot writing a report: ${offline.length} providers failed with network errors (${offline.map((r) => r.provider).join(", ")}), which looks like this machine lost its connection. Run it again.`);
      process.exitCode = 1;
    } else if (values.share || values.submit) {
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
      // A provider whose every run failed on the submitter's own account (bad key, no credit, a limit hit) says
      // nothing about the provider: leave it out of what's shared, and say so.
      const account = rows.filter((r) => r.failures === r.runs && r.lastError && ACCOUNT_ERROR.test(r.lastError));
      if (account.length) console.error(`\nleft out of the shared report, every run failed on your account: ${account.map((r) => r.provider).join(", ")}`);
      const report = makeReport(rows.filter((r) => !account.includes(r)), { version, runs: rows[0].runs, spec: { ...spec, vcpu: spec.vcpu ?? DEFAULT_VCPU, memoryGb: spec.memoryGb ?? DEFAULT_MEMORY_GB }, label: values.label, by, task: values.task ? TASKS[job].version : undefined });
      const left = rows.filter((r) => !benchmarksPublishable(r.provider)).map((r) => r.provider);
      if (left.length) console.log(`\nleft out of the shared report: ${left.join(", ")} (their terms don't allow publishing benchmarks)`);
      const file = values.out ?? `sandboxrouter-bench-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      if (values.submit) {
        const summary = `${report.rows.length} providers, ${report.runs} runs each${report.task ? `, job ${report.task}` : ""}, from ${report.label ?? "an unlabelled location"} (${report.platform}).`;
        try {
          console.log(`\nwrote ${file} and opened ${submitReport(file, summary)}`);
        } catch (err) {
          console.error(`\nwrote ${file}, but couldn't open the pull request: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      } else {
        console.log(`\nwrote ${file}. Add it to results/ in a PR to github.com/gigialc/sandboxrouter to put it on the leaderboard, or run again with --submit to open the PR for you.`);
      }
    }
    return;
  }

  if (cmd === "cost") {
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    if (rest[0] === "run") {
      const ids = providers ?? (router.registered().filter((id) => router.isConfigured(id) && id !== "docker") as ProviderId[]);
      if (!ids.length) return console.error("No providers configured. Set at least one API key (see --help).");
      const run = await costRun({
        router,
        providers: ids,
        minutes: num(values.minutes) ?? 10,
        spec,
        load: !values["no-load"],
        version,
        by,
        onProgress: (m) => console.error(m),
      });
      const file = values.out ?? `results/cost/cost-${run.date.slice(0, 16).replace(/[:T]/g, "-")}.json`;
      mkdirSync(file.replace(/\/[^/]*$/, "") || ".", { recursive: true });
      const settled = await settle(run);
      const left = settled.entries.filter((e) => !benchmarksPublishable(e.provider)).map((e) => e.provider);
      writeFileSync(file, JSON.stringify({ ...settled, entries: settled.entries.filter((e) => benchmarksPublishable(e.provider)) }, null, 2) + "\n");
      if (left.length) console.log(`left out of ${file}: ${left.join(", ")} (their terms don't allow publishing benchmarks; the table above is the only copy)`);
      console.log(costMarkdown(run));
      console.log(`\nwrote ${file}. Bills post late on some providers: run "sandboxrouter cost settle ${file}" again later.`);
      return;
    }
    if (rest[0] === "settle" && rest[1]) {
      const run = (await settle(JSON.parse(readFileSync(rest[1], "utf8")) as CostRun)) as CostRun;
      writeFileSync(rest[1], JSON.stringify(run, null, 2) + "\n");
      console.log(costMarkdown(run));
      return;
    }
    return console.error('Usage: sandboxrouter cost run [...] | sandboxrouter cost settle FILE');
  }

  if (cmd === "leaderboard") {
    const dir = rest[0] ?? "results";
    const reports = loadReports(dir);
    const out = values.out ?? "leaderboard.html";
    writeFileSync(out, renderLeaderboard(reports));
    console.log(`wrote ${out} from ${reports.length} report${reports.length === 1 ? "" : "s"} in ${dir}/`);
    return;
  }

  if (cmd === "desktop") {
    const os = (values.os ?? "linux") as "linux" | "windows" | "android";
    const c = await router.computer({ os, externalUserId: values.user }, { provider: providers });
    const info = await c.info();
    const link = await c.viewer(values.control ? "control" : "watch");
    console.log(`${c.id}  ${info.os}  ${info.status}${info.screen ? `  ${info.screen.width}x${info.screen.height}` : ""}`);
    console.log(`${values.control ? "take over" : "watch"}: ${link.url}  (expires ${link.expiresAt})`);
    return;
  }

  if (cmd === "screenshot") {
    const id = rest[0];
    if (!id) throw new RouterError("usage: sandboxrouter screenshot <provider:id> [--out screen.png]");
    const img = await (await router.getComputer(id)).screenshot();
    const out = values.out ?? "screen.png";
    (await import("node:fs")).writeFileSync(out, img);
    console.log(`wrote ${out} (${img.byteLength} bytes)`);
    return;
  }

  if (cmd === "serve") {
    const port = num(values.port) ?? Number(process.env.PORT ?? 8787);
    const host = values.host ?? "127.0.0.1";
    const origins = list(values.cors);
    const loopback = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host);
    if (!process.env.SANDBOXROUTER_TOKEN && !loopback) {
      throw new RouterError(`refusing to listen on ${host} without SANDBOXROUTER_TOKEN: anyone who can reach it could start sandboxes on your keys`);
    }
    createApp(router, undefined, origins).listen(port, host, () => {
      console.log(`sandboxrouter listening on http://${host}:${port}`);
      if (origins?.length) console.log(`browser access allowed from: ${origins.join(", ")}`);
      if (!process.env.SANDBOXROUTER_TOKEN) console.log("note: SANDBOXROUTER_TOKEN is not set; any program on this machine can use the API");
    });
    return;
  }

  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
