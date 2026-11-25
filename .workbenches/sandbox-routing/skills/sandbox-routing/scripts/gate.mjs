#!/usr/bin/env node
// gate: build, scan, run a real sandbox, check the ledger. Exit 0 is done.
// Usage: node gate.mjs [dir] [--next]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const next = args.includes("--next");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
process.chdir(dir);

const MANIFEST = "artifacts/evidence.json";
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "artifacts", ".venv", "venv", "__pycache__", ".workbenches", "coverage"]);
// Packages that are a sandbox provider's own SDK. The router loads these itself; project code imports the router.
const PROVIDER_SDKS = [
  "e2b", "@e2b/code-interpreter", "@e2b/desktop", "e2b_code_interpreter", "@daytonaio/sdk", "daytona", "daytona_sdk", "modal",
  "@blaxel/core", "blaxel", "@beam-cloud/beam-js", "beam", "@runloop/api-client", "runloop_api_client", "morphcloud",
  "@vercel/sandbox", "@cloudflare/sandbox", "@codesandbox/sdk", "novita-sandbox", "novita_sandbox", "@tensorlakeai/tensorlake",
  "tensorlake", "@hopx-ai/sdk", "hopx_ai", "@upstash/box", "@deno/sandbox", "@koyeb/sandbox-sdk", "koyeb", "@northflank/js-client",
  "freestyle-sandboxes", "@fly/sprites", "langsmith/experimental/sandbox",
];
// Shapes of provider keys. Only the name of the shape is ever printed, never the match.
const KEY_SHAPES = [
  ["an E2B key", /\be2b_[0-9a-f]{32,}\b/],
  ["a Daytona key", /\bdtn_[0-9a-f]{40,}\b/],
  ["a sandboxRouter key", /\bsr_(live|test)_[A-Za-z0-9]{24,}\b/],
  ["a Modal token secret", /\bas-[A-Za-z0-9]{20,}\b/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a key assigned as a literal", /\b[A-Z0-9_]*(API_KEY|TOKEN|SECRET)\b\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/],
];

const items = [];
const add = (name, pass, reason, extra = {}) => items.push({ name, pass, reason, ...extra });

function walk(start) {
  const found = [];
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(path);
      } else if (SOURCE.test(name) && stat.size < 2_000_000) found.push(relative(dir, path));
    }
  };
  visit(start);
  return found;
}

const importsOf = (text) =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm), ...text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]);
const usesRouter = (text) => /@sandboxrouter\/sdk|\bsandboxrouter\b/.test(text);
const createsSandbox = (text) => usesRouter(text) && /\.create\s*\(/.test(text);

// --- run number -------------------------------------------------------------------------------
mkdirSync("artifacts", { recursive: true });
let run = existsSync("artifacts/run") ? Number(readFileSync("artifacts/run", "utf8").trim()) || 1 : 1;
if (next) run += 1;
writeFileSync("artifacts/run", String(run));
const out = `artifacts/run-${run}`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const ledgerHome = resolve(out, "ledger");
mkdirSync(ledgerHome, { recursive: true });

function finish() {
  const failed = items.filter((i) => !i.pass);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ run, passed: failed.length === 0, items }, null, 2) + "\n");
  for (const i of items) console.log(`${i.pass ? "PASS" : "FAIL"} ${i.name}: ${i.reason}`);
  console.log(failed.length ? `gate: ${failed.length} of ${items.length} failed (run ${run}, ${out}/summary.json)` : `gate: all ${items.length} passed (run ${run})`);
  process.exit(failed.length ? 1 : 0);
}

// --- manifest ---------------------------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (error) {
  add("manifest", false, existsSync(MANIFEST) ? `${MANIFEST} is not valid JSON: ${error.message}` : `${MANIFEST} is missing`);
  finish();
}
const entries = Array.isArray(manifest.entries) ? manifest.entries.filter((e) => typeof e === "string") : [];
const allowDirect = Array.isArray(manifest.allowDirect) ? manifest.allowDirect : [];
const missing = entries.filter((e) => !existsSync(e));
const badAllow = allowDirect.filter((a) => !a || typeof a.file !== "string" || typeof a.package !== "string" || typeof a.reason !== "string" || a.reason.trim().length < 10);
if (!entries.length) add("manifest", false, "entries is empty: list every file that creates a sandbox");
else if (missing.length) add("manifest", false, `entries that do not exist: ${missing.join(", ")}`);
else if (typeof manifest.smoke !== "string" || !manifest.smoke.trim()) add("manifest", false, "smoke is missing: the command that starts a real sandbox");
else if (typeof manifest.build !== "string") add("manifest", false, 'build is missing: the build or typecheck command, or "" when the project has neither');
else if (badAllow.length) add("manifest", false, "every allowDirect item needs file, package and a reason of at least 10 characters");
else add("manifest", true, `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
if (!items[0].pass) finish();

// --- static checks ----------------------------------------------------------------------------
const files = walk(dir);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const creators = files.filter((f) => createsSandbox(text.get(f)));
const unlisted = creators.filter((f) => !entries.includes(f));
const idle = entries.filter((e) => text.has(e) && !usesRouter(text.get(e)));
if (unlisted.length) add("entries", false, `these create a sandbox and are not in entries: ${unlisted.join(", ")}`);
else if (idle.length) add("entries", false, `these entries never use the router: ${idle.join(", ")}`);
else add("entries", true, `${creators.length} file${creators.length === 1 ? " creates" : "s create"} a sandbox, all listed`);

const direct = [];
for (const [file, body] of text) {
  for (const pkg of importsOf(body)) {
    const hit = PROVIDER_SDKS.find((sdk) => pkg === sdk || pkg.startsWith(sdk + "/"));
    if (hit && !allowDirect.some((a) => a.file === file && a.package === hit)) direct.push(`${file} imports ${hit}`);
  }
}
const allowed = allowDirect.length ? ` (${allowDirect.length} allowed with a reason)` : "";
add("direct-sdk", direct.length === 0, direct.length ? [...new Set(direct)].join("; ") : `no provider SDK is imported directly${allowed}`);

const unkilled = entries.filter((e) => {
  const body = text.get(e) ?? "";
  return createsSandbox(body) && !/\.kill\s*\(|await\s+using\s|Symbol\.asyncDispose/.test(body);
});
add("kill", unkilled.length === 0, unkilled.length ? `these create a sandbox and never kill it: ${unkilled.join(", ")}` : "every entry that creates a sandbox kills it");

const keyed = [];
for (const [file, body] of text) for (const [what, shape] of KEY_SHAPES) if (shape.test(body)) keyed.push(`${file} contains what looks like ${what}`);
add("keys", keyed.length === 0, keyed.length ? keyed.join("; ") : "no key in source");

// --- build ------------------------------------------------------------------------------------
const sh = (cmd, log, env = process.env) => {
  const r = spawnSync("sh", ["-c", cmd], { cwd: dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 });
  writeFileSync(join(out, log), `$ ${cmd}\n${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}\n` : ""}`);
  return r;
};
if (manifest.build.trim()) {
  const b = sh(manifest.build, "build.log");
  add("build", b.status === 0, b.status === 0 ? `\`${manifest.build}\` exited 0` : `\`${manifest.build}\` exited ${b.status ?? "on a signal"}: see ${out}/build.log`);
} else add("build", true, "no build command declared: nothing was compiled or typechecked");

// --- smoke: a real sandbox, with its own ledger ------------------------------------------------
const ledgerFile = join(ledgerHome, "sandboxes.jsonl");
const ledger = () => {
  const opened = new Map();
  const closed = new Set();
  if (existsSync(ledgerFile)) {
    for (const line of readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean)) {
      try {
        const l = JSON.parse(line);
        if (l.op === "open") opened.set(l.id, l);
        else if (l.op === "close") closed.add(l.id);
      } catch {
        /* a torn line is not evidence either way */
      }
    }
  }
  return { opened: [...opened.values()], open: [...opened.values()].filter((e) => !closed.has(e.id)) };
};
const smokeEnv = { ...process.env, SANDBOXROUTER_HOME: ledgerHome, SANDBOXROUTER_LEDGER: "on" };
let smoke;
try {
  smoke = sh(manifest.smoke, "smoke.log", smokeEnv);
} finally {
  // Kill whatever the smoke left running, pass or fail, before judging it.
  const before = ledger();
  if (before.open.length) sh("npx --no-install sandboxrouter gc --all", "cleanup.log", smokeEnv);
  const hosted = !!process.env.SANDBOXROUTER_API_KEY;
  const ran = before.opened.map((e) => `${e.provider}${e.size ? ` ${e.size.vcpu} vCPU / ${e.size.memoryGb} GB` : ""}`);
  const detail = { sandboxes: ran, leftOpen: before.open.map((e) => e.id) };
  if (!smoke || smoke.status !== 0) add("smoke", false, `\`${manifest.smoke}\` exited ${smoke?.status ?? "on a signal"}: see ${out}/smoke.log`, detail);
  else if (before.open.length) add("smoke", false, `left ${before.open.length} sandbox${before.open.length === 1 ? "" : "es"} running (now killed): ${detail.leftOpen.join(", ")}`, detail);
  else if (before.opened.length) add("smoke", true, `ran on ${[...new Set(ran)].join(", ")}; none left open`, detail);
  else if (hosted) add("smoke", true, "exited 0 through the hosted key; the hosted service keeps the record, so leaks could not be checked here", detail);
  else add("smoke", false, "exited 0 but started no sandbox through the router: a smoke that mocks or skips the router proves nothing", detail);
}

finish();
