import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hourlyCost, unfit } from "../src/catalog.js";
import { DigitalOceanProvider } from "../src/providers/digitalocean.js";
import { GoogleAgentPlatformProvider } from "../src/providers/google.js";
import { sizeOf } from "../src/router.js";
import { describeConformance } from "./conformance.js";

const root = mkdtempSync(join(tmpdir(), "sbr-cloud-"));
const engine = "projects/sbr-test/locations/us-central1/reasoningEngines/123";
const template = `${engine}/sandboxEnvironmentTemplates/456`;
const configIds = new Set<string>();
const instances = new Map<string, "running" | "paused">();
const seen: { method: string; path: string; body: any }[] = [];
let base = "";
let nextId = 0;
let failDoSession = false;
let failGoogleRead = false;

function runShell(command: string, cwd: string | undefined, timeout: number) {
  return new Promise<{ stdout: string; stderr: string; code: number; duration: number; timedOut: boolean }>((resolve, reject) => {
    const start = Date.now();
    const child = spawn("sh", ["-c", command], { cwd: cwd ?? root, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
    child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
    const timer = setTimeout(() => {
      if (child.pid) {
        timedOut = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }, timeout * 1000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 137, duration: Date.now() - start, timedOut });
    });
  });
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : undefined;
  const method = req.method!;
  const path = req.url!;
  seen.push({ method, path, body });

  const digitalocean = path.startsWith("/v2/harness-runtime/");
  if (req.headers.authorization !== `Bearer ${digitalocean ? "do-test" : "google-test"}`) return send(401);
  const doPath = path.replace("/v2/harness-runtime", "");
  const googlePath = path.replace(`/v1beta1/${engine}`, "");

  if (digitalocean && doPath === "/configs" && method === "POST") {
    const id = `config-${++nextId}`;
    configIds.add(id);
    return send(201, { config: { id } });
  }
  if (digitalocean && doPath.startsWith("/configs/") && method === "DELETE") {
    configIds.delete(doPath.split("/").at(-1)!);
    return send(204);
  }
  if (digitalocean && doPath === "/sessions" && method === "POST") {
    if (failDoSession) return send(503, { message: "guest creation failed" });
    if (!configIds.has(body.config_id)) return send(404, { message: "config missing" });
    const id = `session-${++nextId}`;
    instances.set(id, "running");
    return send(200, { session: { session_id: id, status: "SESSION_STATUS_READY" } });
  }
  if (!digitalocean && googlePath === "/sandboxEnvironments" && method === "POST") {
    const id = `sandbox-${++nextId}`;
    instances.set(id, "running");
    return send(200, { name: `${engine}/operations/${id}`, done: false });
  }
  if (!digitalocean && googlePath.startsWith("/operations/")) {
    const id = googlePath.split("/").at(-1);
    return send(200, { done: true, response: { name: `${engine}/sandboxEnvironments/${id}` } });
  }

  const [, id, action] = (digitalocean ? doPath : googlePath).split("/").slice(1);
  const state = instances.get(id);
  if (!state) return send(404);
  const resource = `${engine}/sandboxEnvironments/${id}`;
  if (method === "DELETE") {
    instances.delete(id);
    return digitalocean ? send(204) : send(200, { done: true });
  }
  if (method === "GET") {
    if (digitalocean) return send(200, { session: { session_id: id, status: state === "running" ? "SESSION_STATUS_READY" : "SESSION_STATUS_PAUSED" } });
    if (failGoogleRead) return send(503, { error: { message: "guest not readable" } });
    return send(200, { name: resource, state: `STATE_${state.toUpperCase()}` });
  }
  if (action === "pause" || action === ":pause") {
    instances.set(id, "paused");
    return send(200, { done: true });
  }
  if (action === "resume" || action === ":resume") {
    instances.set(id, "running");
    return send(200, { done: true });
  }
  if (state !== "running") return send(409);
  try {
    if (digitalocean && doPath.endsWith("/sandbox/exec")) {
      const result = await runShell(body.argv[2], body.workdir, body.timeout_seconds);
      return send(200, { stdout: result.stdout, stderr: result.stderr, exit_code: result.code, duration_ms: result.duration });
    }
    if (!digitalocean && action === ":execute") {
      const input = body.inputs.find((c: { mimeType: string }) => c.mimeType === "application/json");
      const decoded = JSON.parse(Buffer.from(input.data, "base64").toString());
      const result = await runShell(decoded.command, decoded.cwd, decoded.timeout);
      if (result.timedOut) {
        const message = 'Execution Failed. Error: DEADLINE_EXCEEDED on URL `https://shell.test/exec`. Error Details: ' +
          JSON.stringify({ detail: `command exceeded ${decoded.timeout}s and was killed` });
        return send(400, { error: { status: "INVALID_ARGUMENT", message } });
      }
      const json = JSON.stringify({ stdout: result.stdout, stderr: result.stderr, returncode: result.code, duration_ms: result.duration });
      return send(200, { outputs: [{ mimeType: "application/json", data: Buffer.from(json).toString("base64") }] });
    }
  } catch (error) {
    return send(400, { message: String(error) });
  }
  return send(404);
}

const server = createServer(handler);
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const digitalocean = () => new DigitalOceanProvider("do-test", base);
const google = () => new GoogleAgentPlatformProvider(engine, template, "google-test", base);
describeConformance("digitalocean", { provider: digitalocean, dir: root, noStreaming: "uses the buffered exec endpoint" });
describeConformance("google", { provider: google, dir: root, noStreaming: "uses the buffered execute endpoint" });

describe("provider wire contracts", () => {
  it("selects a sellable DigitalOcean size and prices the CPU separately from memory", async () => {
    const spec = { vcpu: 1, memoryGb: 2, cpuUtilization: 0.25 };
    const box = await digitalocean().create({ ...spec, env: { DEMO_TOKEN: "guest-only" } });
    try {
      const config = seen.findLast((r) => r.method === "POST" && r.path.endsWith("/configs"))!;
      expect(config.body.manifest_yaml).toContain("harness: none\nsize: mars-2vcpu-2gb\nidle_timeout: 1800s");
      expect(config.body.manifest_yaml).not.toContain("guest-only");
      expect(configIds.size).toBe(0);
      expect(sizeOf("digitalocean", spec)).toEqual({ vcpu: 2, memoryGb: 2 });
      expect(hourlyCost("digitalocean", spec)).toBeCloseTo(0.041);
      expect((await box.exec('printf "%s" "$DEMO_TOKEN"')).stdout).toBe("guest-only");
    } finally {
      await box.kill();
    }
  });

  it("removes the DigitalOcean config when sandbox creation fails", async () => {
    failDoSession = true;
    try {
      await expect(digitalocean().create({})).rejects.toMatchObject({ status: 503 });
      expect(configIds.size).toBe(0);
    } finally {
      failDoSession = false;
    }
  });

  it("uses Google's configured template and a fixed shape, and polls the create operation", async () => {
    const box = await google().create({ timeoutMinutes: 8 });
    try {
      const create = seen.findLast((r) => r.method === "POST" && r.path.endsWith("/sandboxEnvironments"))!;
      expect(create.body).toMatchObject({ sandboxEnvironmentTemplate: template, ttl: "480s", spec: { shellEnvironment: {} } });
      expect(seen.some((r) => r.method === "GET" && r.path.includes("/operations/"))).toBe(true);
      expect(sizeOf("google")).toEqual({ vcpu: 1, memoryGb: 2 });
      expect(unfit("google", {})).toBeNull();
      expect(hourlyCost("google", { cpuUtilization: 0.25 })).toBeCloseTo(0.103);
      const data = new Uint8Array(300_001).map((_, i) => i % 251);
      await box.writeFile(join(root, "with a quote's space.bin"), data);
      expect(await box.readFile(join(root, "with a quote's space.bin"))).toEqual(Buffer.from(data));
    } finally {
      await box.kill();
    }
  });

  it("deletes a Google sandbox when it can't verify readiness", async () => {
    failGoogleRead = true;
    try {
      await expect(google().create({})).rejects.toMatchObject({ status: 503 });
      expect(instances.size).toBe(0);
    } finally {
      failGoogleRead = false;
    }
  });
});
