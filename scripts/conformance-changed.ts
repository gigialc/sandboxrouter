// Exits 0 when any saved check in results/conformance differs from the committed one in a step's
// result (new provider, a step passing or failing differently), 1 when only dates and timings moved.
// Used by the nightly live-check workflow so it commits only real changes.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const DIR = "results/conformance";
const shape = (json: string) => JSON.stringify((JSON.parse(json).results ?? []).map((r: { step: string; status: string }) => [r.step, r.status]));

let changed = false;
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let before: string;
  try {
    before = execFileSync("git", ["show", `HEAD:${DIR}/${f}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    console.log(`${f}: new`);
    changed = true;
    continue;
  }
  if (shape(before) !== shape(readFileSync(`${DIR}/${f}`, "utf8"))) {
    console.log(`${f}: results changed`);
    changed = true;
  }
}
process.exit(changed ? 0 : 1);
