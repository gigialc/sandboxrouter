#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, arch } from "node:os";
import { bench, benchMarkdown } from "./bench.js";
import { checkProvider } from "./check.js";
import { gc, listOpen } from "./gc.js";
import { loadReports, makeReport, renderLeaderboard } from "./leaderboard.js";
import { CATALOG, hourlyCost } from "./catalog.js";
import { Router } from "./router.js";
import { createApp } from "./server.js";
import { RouterError, type Capability, type ProviderId, type SandboxSpec, type Strategy } from "./types.js";

const HELP = `sandboxrouter: one API for every sandbox provider

Usage:
  sandboxrouter providers [--vcpu N] [--memory GB]   price table + which keys are set
  sandboxrouter route     [spec flags] [route flags] dry run: the order providers would be tried
  sandboxrouter run "<cmd>" [spec flags] [route flags] [--keep]
  sandboxrouter check     --provider ID[,ID] | --all [--json] [--save [dir]]
                          test providers for real: exec, env, UTF-8, streaming, files, timeout, pause,
                          kill; exits 1 if any step fails. --all = every configured provider;
                          --save writes results/conformance/<id>.json for the compatibility table
  sandboxrouter ls        [--json]                       sandboxes this machine started that weren't killed
  sandboxrouter gc        [--all | --older-than MIN] [--dry-run]
                          kill leaked sandboxes: by default those past their lifetime
  sandboxrouter bench     [--runs 3] [--provider a,b] [--json] [--share [--label "where you ran it"]]
  sandboxrouter leaderboard [results-dir] [--out leaderboard.html]
  sandboxrouter desktop   [--os linux|windows|android|ios] [--user ID] [--control]
                          get or create a computer and print a link to watch (or take over) its screen
  sandboxrouter screenshot <provider:id> [--out screen.png]
  sandboxrouter serve     [--port 8787] [--host 127.0.0.1] [--cors https://site.example,http://localhost:3000]

Spec flags:   --vcpu N  --memory GB  --gpu T4  --timeout MIN
Route flags:  --provider e2b[,modal,...]  --strategy cheapest|fastest
              --no-fallback  --require gpu,custom-image

Keys: one env var group per provider; "sandboxrouter providers" lists them and shows which are set.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vcpu: { type: "string" },
    memory: { type: "string" },
    gpu: { type: "string" },
    timeout: { type: "string" },
    provider: { type: "string" },
    strategy: { type: "string" },
    "no-fallback": { type: "boolean" },
    require: { type: "string" },
    keep: { type: "boolean" },
    runs: { type: "string" },
    json: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h" },
    os: { type: "string" },
    user: { type: "string" },
    control: { type: "boolean" },
    out: { type: "string" },
    share: { type: "boolean" },
    cors: { type: "string" },
    label: { type: "string" },
    all: { type: "boolean" },
    save: { type: "boolean" },
    "older-than": { type: "string" },
    "dry-run": { type: "boolean" },
  },
});

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const num = (s?: string) => (s === undefined ? undefined : Number(s));

const spec: SandboxSpec = {
  vcpu: num(values.vcpu),
  memoryGb: num(values.memory),
  gpu: values.gpu,
  timeoutMinutes: num(values.timeout),
};
const providers = list(values.provider) as ProviderId[] | undefined;
const route = {
  provider: providers,
  strategy: values.strategy as Strategy | undefined,
  fallback: values["no-fallback"] ? false : undefined,
  require: list(values.require) as Capability[] | undefined,
};

async function main() {
  const [cmd, ...rest] = positionals;
  const router = new Router();

  if (!cmd || values.help) return console.log(HELP);

  if (cmd === "providers") {
    const rows = CATALOG.map((c) => ({
      provider: c.name,
      id: c.id,
      "$/hr": `$${hourlyCost(c.id, spec).toFixed(4)}`,
      configured: router.isConfigured(c.id) ? "yes" : "no",
      capabilities: c.capabilities.join(", ") || "-",
    }));
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`Estimated list price for ${spec.vcpu ?? 2} vCPU, ${spec.memoryGb ?? 4} GB while running:\n`);
    console.table(rows);
    return;
  }

  if (cmd === "route") {
    const plan = router.plan(spec, route);
    if (values.json) return console.log(JSON.stringify(plan, null, 2));
    let n = 0;
    for (const c of plan) {
      const mark = c.skip ? "  -" : `${++n}.`.padStart(3);
      console.log(`${mark} ${c.provider.padEnd(11)} $${c.estimatedHourlyUsd.toFixed(4)}/hr${c.skip ? `  (skipped: ${c.skip})` : ""}`);
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
    const reports = [];
    for (const p of ids) {
      if (!values.json) console.log(`\n${p}`);
      const report = await checkProvider(router, p, {
        spec,
        onStep: (r) => {
          if (!values.json) console.log(`  ${mark[r.status]}  ${r.step.padEnd(32)} ${String(r.ms).padStart(6)} ms  ${r.detail ?? ""}`);
        },
      });
      reports.push(report);
      if (saveDir) {
        mkdirSync(saveDir, { recursive: true });
        const saved = { tool: "sandboxrouter-check", version, date: new Date().toISOString(), platform: `${platform()}-${arch()}`, ...report };
        writeFileSync(`${saveDir}/${p}.json`, JSON.stringify(saved, null, 2) + "\n");
      }
    }
    if (values.json) console.log(JSON.stringify(reports, null, 2));
    else console.log(`\n${reports.filter((r) => r.ok).length}/${reports.length} passed`);
    if (reports.some((r) => !r.ok)) process.exitCode = 1;
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

  if (cmd === "bench") {
    const rows = await bench({
      router,
      providers,
      runs: num(values.runs) ?? 3,
      spec: { ...spec, timeoutMinutes: spec.timeoutMinutes ?? 5 },
      onProgress: (m) => console.error(m),
    });
    if (rows.length === 0) return console.error("No providers configured. Set at least one API key (see --help).");
    if (values.json) return console.log(JSON.stringify(rows, null, 2));
    console.log(`\nsandboxrouter bench: ${new Date().toISOString().slice(0, 10)}, ${rows[0].runs} runs each\n`);
    console.log(benchMarkdown(rows));
    for (const r of rows.filter((r) => r.lastError)) console.error(`\n${r.provider} last error: ${r.lastError}`);
    if (values.share) {
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
      const report = makeReport(rows, { version, runs: rows[0].runs, spec, label: values.label });
      const file = values.out ?? `sandboxrouter-bench-${report.date.slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      console.log(`\nwrote ${file}. Add it to results/ in a PR to github.com/gigialc/sandboxrouter to put it on the leaderboard.`);
    }
    return;
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
    createApp(router, undefined, origins).listen(port, host, () => {
      console.log(`sandboxrouter listening on http://${host}:${port}`);
      if (origins?.length) console.log(`browser access allowed from: ${origins.join(", ")}`);
      if (!process.env.SANDBOXROUTER_TOKEN) console.log("warning: SANDBOXROUTER_TOKEN is not set, so the API is unauthenticated");
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
