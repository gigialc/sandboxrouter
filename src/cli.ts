#!/usr/bin/env node
import { parseArgs } from "node:util";
import { bench, benchMarkdown } from "./bench.js";
import { CATALOG, hourlyCost } from "./catalog.js";
import { Router } from "./router.js";
import { createApp } from "./server.js";
import { RouterError, type Capability, type ProviderId, type SandboxSpec, type Strategy } from "./types.js";

const HELP = `sandboxrouter: one API for every sandbox provider

Usage:
  sandboxrouter providers [--vcpu N] [--memory GB]   price table + which keys are set
  sandboxrouter route     [spec flags] [route flags] dry run: the order providers would be tried
  sandboxrouter run "<cmd>" [spec flags] [route flags] [--keep]
  sandboxrouter bench     [--runs 3] [--provider a,b] [--json]
  sandboxrouter desktop   [--os linux|windows|android] [--user ID] [--control]
                          get or create a computer and print a link to watch (or take over) its screen
  sandboxrouter screenshot <provider:id> [--out screen.png]
  sandboxrouter serve     [--port 8787] [--host 127.0.0.1]

Spec flags:   --vcpu N  --memory GB  --gpu T4  --timeout MIN
Route flags:  --provider maritime[,e2b,...]  --strategy default|cheapest|fastest
              --no-fallback  --require gpu,custom-image

Keys: MARITIME_API_KEY, E2B_API_KEY, DAYTONA_API_KEY, MODAL_TOKEN_ID+MODAL_TOKEN_SECRET,
      VERCEL_OIDC_TOKEN (or VERCEL_TOKEN+VERCEL_TEAM_ID+VERCEL_PROJECT_ID)`;

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
      configured: router.provider(c.id).configured() ? "yes" : "no",
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
      console.log(`${mark} ${c.provider.padEnd(9)} $${c.estimatedHourlyUsd.toFixed(4)}/hr${c.skip ? `  (skipped: ${c.skip})` : ""}`);
    }
    return;
  }

  if (cmd === "run") {
    const command = rest.join(" ");
    if (!command) throw new RouterError('usage: sandboxrouter run "<cmd>"');
    const sbx = await router.create(spec, route);
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
    createApp(router).listen(port, host, () => {
      console.log(`sandboxrouter listening on http://${host}:${port}`);
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
