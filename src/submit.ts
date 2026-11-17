import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const UPSTREAM = "gigialc/sandboxrouter";

/** Runs the GitHub CLI and returns its trimmed output. Throws with gh's own message on failure. */
function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Sends a saved bench report to the public results as a pull request, with the GitHub CLI (`gh`): forks the
 * repo if needed, puts the file in results/ on a new branch, and opens the PR. Returns the PR's URL.
 * Nothing but the report file is sent; the report holds no keys (makeReport strips errors, and CI checks).
 */
export function submitReport(file: string, summary: string): string {
  try {
    gh(["--version"]);
  } catch {
    throw new Error("--submit needs the GitHub CLI: install it from https://cli.github.com and run `gh auth login`");
  }
  let login: string;
  try {
    login = gh(["api", "user", "-q", ".login"]);
  } catch {
    throw new Error("--submit needs you signed in to the GitHub CLI: run `gh auth login`");
  }
  const owner = UPSTREAM.split("/")[0];
  const target = login === owner ? UPSTREAM : `${login}/sandboxrouter`;
  if (target !== UPSTREAM) {
    // Idempotent: an existing fork is reused.
    try {
      gh(["repo", "fork", UPSTREAM, "--clone=false"]);
    } catch {
      /* already forked */
    }
  }
  const name = basename(file);
  const branch = `results-${name.replace(/\.json$/, "")}`;
  const base = gh(["api", `repos/${UPSTREAM}/git/ref/heads/main`, "-q", ".object.sha"]);
  // A fork shares the upstream's objects, so a branch can start at upstream main even if the fork is behind.
  gh(["api", `repos/${target}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${base}`]);
  gh([
    "api",
    "-X",
    "PUT",
    `repos/${target}/contents/results/${name}`,
    "-f",
    `message=Add benchmark results: ${name}`,
    "-f",
    `content=${readFileSync(file).toString("base64")}`,
    "-f",
    `branch=${branch}`,
  ]);
  return gh([
    "pr",
    "create",
    "--repo",
    UPSTREAM,
    "--head",
    target === UPSTREAM ? branch : `${login}:${branch}`,
    "--base",
    "main",
    "--title",
    `Benchmark results: ${name}`,
    "--body",
    `${summary}\n\nSent with \`sandboxrouter bench --submit\`.`,
  ]);
}
