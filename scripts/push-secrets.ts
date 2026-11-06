// Uploads provider keys from a local file into this repo's GitHub Actions secrets, so the nightly
// real-account tests can use them. Values go to `gh secret set` on stdin: they are never printed,
// never passed as command-line arguments, and never leave this machine except to GitHub.
//
//   npm run secrets:push -- --init      write .env.providers (gitignored) with every key name, blank
//   # fill in the keys you have, leave the rest empty
//   npm run secrets:push -- --dry-run   show which names would be set, without uploading
//   npm run secrets:push                upload every filled-in key
//   npm run secrets:push -- --only e2b,daytona   upload just those providers' keys (e.g. leave out
//                                       accounts that aren't funded yet, so the nightly run doesn't
//                                       record them as failing)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CATALOG } from "../src/catalog.js";
import { COMPUTER_ENTRIES } from "../src/computers.js";

const FILE = new URL("../.env.providers", import.meta.url);
const FIRST = ["agent37", "instabox", "openscale", "boat", "maritime", "koyeb", "e2b", "daytona"];
const argv = process.argv.slice(2);
const args = new Set(argv);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? new Set((argv[onlyAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;

const sandboxes = CATALOG.filter((c) => !c.local).sort(
  (a, b) => (FIRST.indexOf(a.id) + 1 || 99) - (FIRST.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id),
);
const groups: { label: string; vars: string[][] }[] = [
  ...sandboxes.map((c) => ({ label: `${c.name} (${c.id})`, vars: c.credentials })),
  ...COMPUTER_ENTRIES.filter((c) => !sandboxes.some((s) => s.credentials.flat().join() === c.credentials.flat().join())).map((c) => ({
    label: `${c.id} (desktops/phones)`,
    vars: c.credentials,
  })),
];
// AWS_PROFILE only works on your own machine; CI needs access keys.
const known = new Set(groups.flatMap((g) => g.vars.flat()).filter((k) => k !== "AWS_PROFILE"));

if (args.has("--init")) {
  if (existsSync(FILE)) {
    console.error(".env.providers already exists; edit it, or delete it to start over.");
    process.exit(1);
  }
  const written = new Set<string>();
  const lines = [
    "# Provider keys for the nightly real-account tests. This file is gitignored: never commit it.",
    "# Fill in what you have and leave the rest blank, then run: npm run secrets:push",
    "# Start with the first 8 (the ones the router tries first).",
    "",
  ];
  for (const g of groups) {
    const vars = [...new Set(g.vars.flat())].filter((k) => k !== "AWS_PROFILE" && !written.has(k));
    if (!vars.length) continue;
    lines.push(`# ${g.label}${g.vars.length > 1 ? ` (either: ${g.vars.map((v) => v.filter((k) => k !== "AWS_PROFILE").join(" + ")).join("  or  ")})` : ""}`);
    for (const k of vars) {
      lines.push(`${k}=`);
      written.add(k);
    }
    lines.push("");
  }
  writeFileSync(FILE, lines.join("\n"), { mode: 0o600 });
  console.log(`Wrote .env.providers with ${written.size} key names. Fill it in, then run: npm run secrets:push`);
  process.exit(0);
}

if (!existsSync(FILE)) {
  console.error("No .env.providers yet. Run: npm run secrets:push -- --init");
  process.exit(1);
}

const values = new Map<string, string>();
for (const raw of readFileSync(FILE, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq < 1) continue;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!value) continue;
  if (!known.has(key)) {
    console.warn(`skip ${key}: not a key any provider reads`);
    continue;
  }
  values.set(key, value);
}
if (only) {
  const unknown = [...only].filter((id) => !sandboxes.some((c) => c.id === id) && !COMPUTER_ENTRIES.some((c) => c.id === id));
  if (unknown.length || !only.size) {
    console.error(`--only needs provider ids, e.g. --only e2b,daytona${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
    process.exit(1);
  }
  const wanted = new Set(
    [...sandboxes, ...COMPUTER_ENTRIES].filter((c) => only.has(c.id)).flatMap((c) => c.credentials.flat()),
  );
  for (const key of [...values.keys()]) if (!wanted.has(key)) values.delete(key);
}
if (!values.size) {
  console.log("Nothing to upload: every key in .env.providers is blank.");
  process.exit(0);
}

const dry = args.has("--dry-run");
let failed = 0;
for (const [key, value] of values) {
  if (dry) {
    console.log(`would set ${key}`);
    continue;
  }
  const r = spawnSync("gh", ["secret", "set", key], { input: value, encoding: "utf8" });
  if (r.status === 0) console.log(`set ${key}`);
  else {
    failed++;
    console.error(`failed ${key}: ${(r.stderr || r.error?.message || "").trim()}`);
  }
}

const ready = groups.filter((g) => g.vars.some((set) => set.every((k) => values.has(k)))).map((g) => g.label);
console.log(`\n${dry ? "Would make" : "Ready for nightly tests"}: ${ready.length ? ready.join(", ") : "none yet (some providers need more than one key)"}`);
if (failed) process.exitCode = 1;
