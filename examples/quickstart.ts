// npx tsx examples/quickstart.ts   (needs at least one provider key in env)
import { Router } from "../src/index.js";

const router = new Router();

console.log("Route plan:");
for (const c of router.plan()) console.log(`  ${c.provider.padEnd(9)} $${c.estimatedHourlyUsd}/hr ${c.skip ?? ""}`);

const sbx = await router.create({ vcpu: 2, memoryGb: 4, timeoutMinutes: 10 });
try {
  console.log(`\nStarted ${sbx.id} (~$${sbx.estimatedHourlyUsd}/hr)`);
  for (const a of sbx.attempts.filter((a) => !a.ok)) console.log(`  fell back from ${a.provider}: ${a.error}`);

  await sbx.writeFile("/tmp/fib.py", "a,b=0,1\nfor _ in range(20): a,b=b,a+b\nprint(a)\n");
  const r = await sbx.exec("python3 /tmp/fib.py");
  console.log(`fib(20) = ${r.stdout.trim()}  (exit ${r.exitCode}, ${r.durationMs} ms)`);
} finally {
  await sbx.kill();
}
