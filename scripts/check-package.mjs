import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");
const dir = mkdtempSync(join(tmpdir(), "sandboxrouter-package-"));
// Keep provider keys and local Docker out of the consumer process.
const env = { SANDBOXROUTER_HOME: dir, SANDBOXROUTER_DOCKER_BIN: join(dir, "no-docker") };

try {
  const [tarball] = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--json", "--pack-destination", dir], { encoding: "utf8" }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sdk-consumer-smoke", private: true, type: "module" }));
  execFileSync(process.execPath, [
    npm, "install", "--ignore-scripts", "--no-audit", "--no-fund",
    join(dir, tarball.filename), "typescript@5.2.2", "@types/node@20.19.43",
  ], { cwd: dir, stdio: "inherit" });

  // Deliberately omit optional adapter packages, which the core declaration graph must not require.
  writeFileSync(join(dir, "consumer.mts"), `
import { Client, Router, type RoutedComputer } from "@sandboxrouter/sdk";
new Router({ ledger: false }).plan();
export const screenshot = (computer: RoutedComputer): Promise<Uint8Array> => computer.screenshot();
await using box = new Client().sandbox("e2b:mock");
`);
  execFileSync(process.execPath, [
    "node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2022",
    "--lib", "ES2022,ESNext.Disposable", "--types", "node", "consumer.mts",
  ], { cwd: dir, stdio: "inherit" });

  const cli = "node_modules/@sandboxrouter/sdk/dist/cli.js";
  const cliOutput = execFileSync(process.execPath, [cli, "route", "--json"], { cwd: dir, env, encoding: "utf8" });
  assert.ok(JSON.parse(cliOutput).length > 0);
  for (const args of [["check", "--all", "--json"], ["agentbench", "--json"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 1, `${args[0]} should fail when it cannot run`);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.match(result.stderr, /No providers configured|needs GEMINI_API_KEY/);
  }
  const missingPeer = spawnSync(process.execPath, [cli, "check", "--provider", "e2b", "--json"], {
    cwd: dir, env: { ...env, E2B_API_KEY: "test-placeholder" }, encoding: "utf8",
  });
  assert.equal(missingPeer.status, 1, "An inconclusive check should not pass when it ran no tests");
  assert.match(JSON.parse(missingPeer.stdout)[0].inconclusive, /"e2b" package/);

  // A local E2B SDK stand-in exercises the published adapter without a credential or cloud call.
  const e2b = join(dir, "node_modules", "e2b");
  mkdirSync(e2b);
  writeFileSync(join(e2b, "package.json"), JSON.stringify({ name: "e2b", type: "module", exports: "./index.js" }));
  writeFileSync(join(e2b, "index.js"), `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
export class Sandbox {
  static async create({ apiKey, timeoutMs }) {
    assert.equal(apiKey, "test-placeholder");
    assert.equal(timeoutMs, 600_000);
    const events = ["create"];
    return {
      sandboxId: "mock",
      commands: { async run(cmd) {
        assert.equal(cmd, "python3 -c 'print(6*7)'");
        events.push("exec");
        return { wait: async () => ({ exitCode: 0, stdout: "42", stderr: "" }) };
      } },
      async kill() {
        events.push("kill");
        writeFileSync("e2b-events.json", JSON.stringify(events));
      },
    };
  }
}
`);
  const readme = readFileSync(join(dir, "node_modules", "@sandboxrouter", "sdk", "README.md"), "utf8");
  assert.ok(readme.includes("npm i @sandboxrouter/sdk e2b"), "The E2B quickstart must install both packages");
  const snippet = readme.match(/```js\r?\n([\s\S]+?)```/)?.[1];
  assert.ok(snippet, "Expected a JavaScript quickstart in the packaged README");
  writeFileSync(join(dir, "agent.mjs"), snippet);
  const result = execFileSync(process.execPath, ["agent.mjs"], { cwd: dir, env: { ...env, E2B_API_KEY: "test-placeholder" }, encoding: "utf8" });
  assert.match(result, /42.*e2b/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "e2b-events.json"), "utf8")), ["create", "exec", "kill"]);
  console.log(`Packed SDK passed strict TypeScript 5.2, CLI and mocked E2B quickstart checks in a clean install (Node ${process.version}).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
