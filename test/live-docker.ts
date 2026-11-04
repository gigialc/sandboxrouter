// Live check of the Docker adapter against a real local Docker daemon (not part of `npm test`).
// Run: node --import tsx test/live-docker.ts
import { Router } from "../src/router.js";

const router = new Router();
if (!router.isConfigured("docker")) {
  console.error("Docker is not running");
  process.exit(1);
}

const t0 = Date.now();
const sbx = await router.create({ vcpu: 1, memoryGb: 1, timeoutMinutes: 5, env: { GREETING: "hi" } }, { provider: "docker" });
console.log("created", sbx.id, `${Date.now() - t0} ms`);

const chunks: string[] = [];
const r = await sbx.exec(`echo "$GREETING from $(uname -s)"; echo oops >&2; python3 -c 'print(6*7)'; exit 3`, {
  onStdout: (c) => chunks.push(c),
});
console.log("exec", JSON.stringify(r), "streamed chunks:", chunks.length);
if (r.exitCode !== 3 || !r.stdout.includes("hi from Linux") || !r.stdout.includes("42") || r.stderr.trim() !== "oops") throw new Error("exec mismatch");

const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
await sbx.writeFile("/tmp/deep/dir/blob.bin", bytes);
const back = await sbx.readFile("/tmp/deep/dir/blob.bin");
if (Buffer.compare(Buffer.from(bytes), Buffer.from(back)) !== 0) throw new Error("file round-trip mismatch");
console.log("files ok", back.byteLength, "bytes");

const cwd = await sbx.exec("pwd", { cwd: "/tmp/deep" });
if (cwd.stdout.trim() !== "/tmp/deep") throw new Error("cwd mismatch");

await sbx.pause();
const again = await router.get(sbx.id); // unpauses
console.log("resumed", (await again.exec("echo back")).stdout.trim());

await sbx.kill();
console.log("killed; all docker checks passed");
