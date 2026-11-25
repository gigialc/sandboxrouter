// Starts one real sandbox through the router, runs the project's own check in it, and kills it.
// Copy to the project, then replace COMMAND with something that proves THIS project's sandbox works
// (its test command, its build, the script the agent runs). Exit 0 means it worked.
import { Router } from "@sandboxrouter/sdk";

const COMMAND = "node --version"; // replace: the placeholder proves the router, not the project

// Keep the ledger on (the default). The gate reads it to see what ran and whether anything leaked.
const router = new Router();
const started = Date.now();
const sbx = await router.create({ vcpu: 2, memoryGb: 4, timeoutMinutes: 10, expectedSeconds: 60 });
try {
  console.log(`sandbox on ${sbx.provider} (${sbx.size?.vcpu} vCPU / ${sbx.size?.memoryGb} GB) in ${Date.now() - started} ms`);
  for (const a of sbx.attempts) if (a.error) console.log(`tried ${a.provider} first: ${a.error}`);
  const r = await sbx.exec(COMMAND, { timeoutSeconds: 300, onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c) });
  if (r.exitCode !== 0) {
    console.error(`\`${COMMAND}\` exited ${r.exitCode}`);
    process.exitCode = 1;
  }
} finally {
  await sbx.kill();
}
