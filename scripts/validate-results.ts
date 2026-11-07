// Checks every file in results/ before it lands on the website. See src/results.ts for the rules.
//
// Run:  npm run results:check                    every file in results/
//       npm run results:check -- --against REF   also refuse edits to bench reports changed since REF
//                                                (CI passes the pull request's base commit)
import { execFileSync } from "node:child_process";
import { validateResults } from "../src/results.js";

const i = process.argv.indexOf("--against");
const ref = i > 0 ? process.argv[i + 1] : undefined;
const changed = ref
  ? execFileSync("git", ["diff", "--name-status", ref, "HEAD", "--", "results"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return { status: parts[0], path: parts[parts.length - 1] };
      })
  : undefined;

const issues = validateResults("results", { changed });
if (!issues.length) {
  console.log(`results/: every file checks out${changed ? ` (${changed.length} changed since ${ref})` : ""}`);
} else {
  for (const { file, problem } of issues) console.log(`${file}: ${problem}`);
  console.log(`\n${issues.length} problem${issues.length > 1 ? "s" : ""} in results/. See CONTRIBUTING.md, "Sending results".`);
  process.exitCode = 1;
}
