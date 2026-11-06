import { randomBytes } from "node:crypto";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { timeoutError, wrapCommand } from "../util.js";
import { AwsClient, awsCredentialsHinted, type AwsCredentials } from "./agentcore.js";

/**
 * AWS Lambda MicroVMs (launched 2026-06-22): Firecracker VMs started from a snapshot of an image you
 * build, each with its own HTTPS endpoint, suspend/resume and up to 8 hours of life.
 *
 * Control plane (SigV4, signing name "lambda", host https://lambda.{region}.amazonaws.com, rest-json):
 *   POST   /2025-09-09/microvms                          RunMicrovm {imageIdentifier, imageVersion?, idlePolicy, maximumDurationInSeconds,
 *                                                        ingressNetworkConnectors, egressNetworkConnectors, executionRoleArn?, clientToken}
 *                                                        -> {microvmId, endpoint, state, ...}
 *   GET    /2025-09-09/microvms/{id}                     GetMicrovm -> {state: PENDING|RUNNING|SUSPENDING|SUSPENDED|TERMINATING|TERMINATED, endpoint, ...}
 *   POST   /2025-09-09/microvms/{id}/auth-token          CreateMicrovmAuthToken {expirationInMinutes, allowedPorts:[{port}]} -> {authToken: {"X-aws-proxy-auth": jwe}}
 *   POST   /2025-09-09/microvms/{id}/suspend | /resume   SuspendMicrovm / ResumeMicrovm
 *   DELETE /2025-09-09/microvms/{id}                     TerminateMicrovm
 * Data plane: https://{endpoint}/... with the auth-token entries as headers and X-aws-proxy-port.
 *
 * Lambda gives a MicroVM no exec or file API of its own: the endpoint reaches whatever server your image
 * runs. So the image must run the small server in LAMBDA_MICROVM_SERVER below (Node.js, no deps), which
 * speaks this adapter's protocol on port 8080:
 *   POST /sbr/v1/exec   {cmd, cwd?, env?, timeoutSeconds}  -> NDJSON {"stdout":b64} | {"stderr":b64} ... {"exitCode":N} | {"error":msg}
 *   PUT  /sbr/v1/files?path=/abs   raw body -> 204
 *   GET  /sbr/v1/files?path=/abs   -> raw bytes | 404
 *   GET  /sbr/v1/health            -> 200
 * It also answers the lifecycle hooks under /aws/lambda-microvms/runtime/v1/ with 200.
 *
 * Docs:
 *   https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html     (sizes, base images)
 *   https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html
 *   https://docs.aws.amazon.com/lambda/latest/microvm-api/API_Operations.html
 *   https://github.com/boto/botocore/blob/develop/botocore/data/lambda-microvms/2025-09-09/service-2.json (signing name, paths)
 *   https://aws.amazon.com/lambda/pricing/
 *   https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/
 *
 * Mapping:
 * - Size is a property of the image (resources[].minimumMemoryInMiB, 2 GB per vCPU, bursts to 4x), not
 *   of a run. Set LAMBDA_MICROVM_MEMORY_GB to the image's baseline and create() refuses specs above the
 *   4x burst so the router falls back; otherwise vcpu/memoryGb are not enforced.
 * - spec.image.lambda: run that image ARN/ID instead of LAMBDA_MICROVM_IMAGE ("custom-image").
 * - timeoutMinutes -> maximumDurationInSeconds (max 28800). pause() -> SuspendMicrovm (memory and disk
 *   kept); the next call resumes it.
 * - env: exported in front of each command (images take env only at build time).
 *
 * ## Setup (once per region; ARM64 only)
 *
 * 1. Write the server bundle and zip it:
 *      import { writeLambdaMicrovmBundle } from "./src/providers/lambda.js"; await writeLambdaMicrovmBundle("sbr-mvm")
 *      cd sbr-mvm && zip -r ../sbr-mvm.zip . && aws s3 cp ../sbr-mvm.zip s3://<bucket>/sbr-mvm.zip
 *    (Dockerfile: FROM public.ecr.aws/docker/library/node:22-bookworm-slim, CMD node /opt/sbr/server.mjs.
 *    Add whatever tools your agents need.)
 * 2. A build role Lambda can assume (lambda.amazonaws.com) with s3:GetObject on the zip.
 * 3. aws lambda-microvms list-managed-microvm-images   # base image ARN, e.g. arn:aws:lambda:<region>:aws:microvm-image:al2023-1
 *    aws lambda-microvms create-microvm-image --name sbr-sandbox \
 *      --code-artifact uri=s3://<bucket>/sbr-mvm.zip --base-image-arn <base-arn> --build-role-arn <role-arn> \
 *      --resources '[{"minimumMemoryInMiB":4096}]' --cpu-configurations '[{"architecture":"ARM_64"}]'
 *    Wait for the image state CREATED, then set LAMBDA_MICROVM_IMAGE=<image arn>, AWS_REGION, and
 *    LAMBDA_MICROVM_MEMORY_GB=4 (the baseline you chose). The caller needs lambda:RunMicrovm, GetMicrovm,
 *    CreateMicrovmAuthToken, SuspendMicrovm, ResumeMicrovm and TerminateMicrovm.
 */
const ID = "lambda" as const;
const API = "/2025-09-09/microvms";
const PORT = 8080;
const MICROVM_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface LambdaMicrovmOptions {
  region?: string;
  /** MicroVM image ARN or ID. */
  image?: string;
  imageVersion?: string;
  /** Baseline memory of the image in GB (0.5, 1, 2, 4, 8). Specs above 4x this are refused. */
  memoryGb?: number;
  executionRoleArn?: string;
  /** Egress connector ARNs; default the Lambda-provided INTERNET_EGRESS. Empty array: no egress. */
  egressConnectors?: string[];
  /** Override the control-plane base URL (tests). Default https://lambda.{region}.amazonaws.com. */
  endpoint?: string;
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** Seconds without endpoint traffic before Lambda suspends the VM (min 60, default 900). */
  idleSeconds?: number;
  pollMs?: number;
  readyTimeoutMs?: number;
}

interface Microvm {
  microvmId: string;
  endpoint?: string;
  state?: string;
  stateReason?: string;
}

export class LambdaMicrovmProvider implements Provider {
  readonly id = ID;
  readonly region?: string;
  readonly image?: string;
  /** @internal */ readonly opts: LambdaMicrovmOptions;
  private client?: AwsClient;

  constructor(opts: LambdaMicrovmOptions = {}) {
    this.opts = opts;
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.image = opts.image ?? process.env.LAMBDA_MICROVM_IMAGE;
  }

  configured(): boolean {
    return !!(this.region && this.image) && (!!this.opts.credentials || awsCredentialsHinted());
  }

  /** @internal */
  aws(): AwsClient {
    if (!this.region) throw new ProviderError(ID, "set AWS_REGION");
    this.client ??= new AwsClient(ID, "lambda", this.region, this.opts.credentials);
    return this.client;
  }

  /** @internal */
  url(path = ""): URL {
    const base = this.opts.endpoint ?? `https://lambda.${this.region}.amazonaws.com`;
    return new URL(`${base.replace(/\/+$/, "")}${API}${path}`);
  }

  /** @internal */
  get pollMs(): number {
    return this.opts.pollMs ?? 1000;
  }

  /** @internal GetMicrovm until it settles in RUNNING (or fails). */
  async waitRunning(id: string): Promise<Microvm> {
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 180_000);
    for (;;) {
      const vm = await this.aws().json<Microvm>("GET", this.url(`/${encodeURIComponent(id)}`));
      if (vm.state === "RUNNING") return vm;
      if (vm.state === "TERMINATING" || vm.state === "TERMINATED") throw new ProviderError(ID, `MicroVM ${id} is ${vm.state}${vm.stateReason ? `: ${vm.stateReason}` : ""}`, 404);
      if (Date.now() > deadline) throw new ProviderError(ID, `MicroVM ${id} still ${vm.state} after ${(this.opts.readyTimeoutMs ?? 180_000) / 1000}s`);
      await sleep(this.pollMs);
    }
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const image = spec.image?.lambda ?? this.image;
    if (!image) throw new ProviderError(ID, "set LAMBDA_MICROVM_IMAGE (see src/providers/lambda.ts for the one-time image build)");
    const base = this.opts.memoryGb ?? (process.env.LAMBDA_MICROVM_MEMORY_GB ? Number(process.env.LAMBDA_MICROVM_MEMORY_GB) : undefined);
    if (base) {
      const peakMem = base * 4;
      const peakCpu = (base / 2) * 4;
      if ((spec.memoryGb ?? 0) > peakMem || (spec.vcpu ?? 0) > peakCpu) {
        throw new ProviderError(ID, `image baseline ${base} GB bursts to ${peakCpu} vCPU / ${peakMem} GB; asked for ${spec.vcpu ?? "-"} vCPU / ${spec.memoryGb ?? "-"} GB`, 400);
      }
    }
    const maxDuration = Math.min(28_800, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)));
    const egress =
      this.opts.egressConnectors ??
      (process.env.LAMBDA_MICROVM_EGRESS_CONNECTORS !== undefined
        ? process.env.LAMBDA_MICROVM_EGRESS_CONNECTORS.split(",").map((s) => s.trim()).filter(Boolean)
        : [connector(this.region!, "INTERNET_EGRESS")]);
    const idle = Math.max(60, this.opts.idleSeconds ?? 900);
    const body: Record<string, unknown> = {
      imageIdentifier: image,
      ingressNetworkConnectors: [connector(this.region!, "HTTP_INGRESS")],
      egressNetworkConnectors: egress,
      maximumDurationInSeconds: maxDuration,
      idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: idle, suspendedDurationSeconds: maxDuration },
      clientToken: randomBytes(16).toString("hex"),
    };
    const version = this.opts.imageVersion ?? process.env.LAMBDA_MICROVM_IMAGE_VERSION;
    if (version && !spec.image?.lambda) body.imageVersion = version;
    const role = this.opts.executionRoleArn ?? process.env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN;
    if (role) body.executionRoleArn = role;

    const run = await this.aws().json<Microvm>("POST", this.url(), { json: body });
    if (!run.microvmId) throw new ProviderError(ID, "RunMicrovm returned no microvmId");
    const box = new LambdaMicrovm(this, run.microvmId, run.endpoint, spec.env);
    try {
      const vm = run.state === "RUNNING" && run.endpoint ? run : await this.waitRunning(run.microvmId);
      box.setEndpoint(vm.endpoint);
      await box.waitHealthy();
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    if (!MICROVM_ID.test(nativeId)) throw new ProviderError(ID, `invalid MicroVM id: ${nativeId}`);
    const box = new LambdaMicrovm(this, nativeId);
    await box.resumeIfNeeded();
    return box;
  }
}

class LambdaMicrovm implements ProviderSandbox {
  private token?: { headers: Record<string, string>; expiresAt: number };
  private paused = false;

  constructor(
    private p: LambdaMicrovmProvider,
    readonly nativeId: string,
    private endpoint?: string,
    private env?: Record<string, string>,
  ) {}

  /** @internal */
  setEndpoint(e?: string) {
    if (e) this.endpoint = e;
  }

  private base(): string {
    if (!this.endpoint) throw new ProviderError(ID, `MicroVM ${this.nativeId} has no endpoint`);
    return /^https?:\/\//.test(this.endpoint) ? this.endpoint.replace(/\/+$/, "") : `https://${this.endpoint.replace(/\/+$/, "")}`;
  }

  /** @internal Resume a suspended VM (and learn its endpoint). */
  async resumeIfNeeded(): Promise<void> {
    const vm = await this.p.aws().json<Microvm>("GET", this.p.url(`/${encodeURIComponent(this.nativeId)}`));
    if (vm.state === "TERMINATING" || vm.state === "TERMINATED") throw new ProviderError(ID, `MicroVM ${this.nativeId} is ${vm.state}`, 404);
    if (vm.state === "SUSPENDED" || vm.state === "SUSPENDING") {
      await this.p.aws().json("POST", this.p.url(`/${encodeURIComponent(this.nativeId)}/resume`), { json: {} });
    }
    this.setEndpoint((vm.state === "RUNNING" ? vm : await this.p.waitRunning(this.nativeId)).endpoint);
    this.paused = false;
  }

  /** Auth headers from CreateMicrovmAuthToken, cached until 5 minutes before they expire. */
  private async auth(): Promise<Record<string, string>> {
    if (this.paused) await this.resumeIfNeeded();
    if (!this.endpoint) await this.resumeIfNeeded();
    if (this.token && this.token.expiresAt > Date.now()) return this.token.headers;
    const minutes = 60;
    const r = await this.p.aws().json<{ authToken?: Record<string, string> }>("POST", this.p.url(`/${encodeURIComponent(this.nativeId)}/auth-token`), {
      json: { expirationInMinutes: minutes, allowedPorts: [{ port: PORT }] },
    });
    if (!r.authToken || !Object.keys(r.authToken).length) throw new ProviderError(ID, "CreateMicrovmAuthToken returned no token");
    this.token = { headers: { ...r.authToken, "X-aws-proxy-port": String(PORT) }, expiresAt: Date.now() + (minutes - 5) * 60_000 };
    return this.token.headers;
  }

  private async vmFetch(method: string, path: string, init: { body?: string | Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    const headers = { ...(await this.auth()), ...init.headers };
    try {
      return await fetch(`${this.base()}${path}`, {
        method,
        headers,
        body: init.body as BodyInit | undefined,
        signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
      });
    } catch (err) {
      throw new ProviderError(ID, `${method} ${path}: ${(err as Error).message}`);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let detail = text;
    try {
      detail = JSON.parse(text)?.error ?? text;
    } catch {
      /* plain text */
    }
    throw new ProviderError(ID, `${what} -> ${res.status} ${detail}`.trim(), res.status);
  }

  /** @internal The endpoint answers 502/503 until the server is up (and the /run hook has returned). */
  async waitHealthy(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        const res = await this.vmFetch("GET", "/sbr/v1/health", { timeoutMs: 10_000 });
        if (res.ok) return;
        if (res.status === 404) throw new ProviderError(ID, "the MicroVM image does not run the sandboxrouter server (GET /sbr/v1/health -> 404); see src/providers/lambda.ts", 404);
        last = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => {});
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) throw err;
        last = (err as Error).message;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `MicroVM ${this.nativeId} server not healthy after ${timeoutMs / 1000}s (${last})`);
      await sleep(this.p.pollMs);
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const timeout = Math.max(1, Math.round(opts.timeoutSeconds ?? 60));
    // cwd/env go through the shell wrapper so the server stays a dumb `bash -c`.
    const full = wrapCommand(cmd, { cwd: opts.cwd, env: { ...this.env, ...opts.env } });
    const res = await this.vmFetch("POST", "/sbr/v1/exec", {
      body: JSON.stringify({ cmd: full, timeoutSeconds: timeout }),
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      timeoutMs: (timeout + 60) * 1000,
    });
    if (!res.ok) await this.fail(res, "exec");
    const outDec = new TextDecoder();
    const errDec = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    for await (const line of readLines(res)) {
      const j = JSON.parse(line) as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; error?: string };
      if (j.timedOut) throw timeoutError(ID, timeout);
      if (j.stdout !== undefined) {
        const s = outDec.decode(Buffer.from(j.stdout, "base64"), { stream: true });
        if (s) (stdout += s), opts.onStdout?.(s);
      }
      if (j.stderr !== undefined) {
        const s = errDec.decode(Buffer.from(j.stderr, "base64"), { stream: true });
        if (s) (stderr += s), opts.onStderr?.(s);
      }
      if (j.error !== undefined) throw new ProviderError(ID, `exec: ${j.error}`);
      if (j.exitCode !== undefined) exitCode = j.exitCode;
    }
    const o = outDec.decode();
    const e = errDec.decode();
    if (o) (stdout += o), opts.onStdout?.(o);
    if (e) (stderr += e), opts.onStderr?.(e);
    if (exitCode === undefined) throw new ProviderError(ID, "exec: stream ended without an exit code");
    return { exitCode, stdout, stderr, durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const res = await this.vmFetch("PUT", `/sbr/v1/files?path=${encodeURIComponent(absolute(path))}`, {
      body: typeof content === "string" ? new TextEncoder().encode(content) : content,
      headers: { "content-type": "application/octet-stream" },
      timeoutMs: 300_000,
    });
    if (!res.ok) await this.fail(res, `writeFile ${path}`);
    await res.body?.cancel().catch(() => {});
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.vmFetch("GET", `/sbr/v1/files?path=${encodeURIComponent(absolute(path))}`, { timeoutMs: 300_000 });
    if (!res.ok) await this.fail(res, `readFile ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** SuspendMicrovm: memory and disk are kept, compute billing stops; the next call resumes. */
  async pause(): Promise<void> {
    await this.p.aws().json("POST", this.p.url(`/${encodeURIComponent(this.nativeId)}/suspend`), { json: {} });
    this.paused = true;
  }

  async kill(): Promise<void> {
    try {
      await this.p.aws().json("DELETE", this.p.url(`/${encodeURIComponent(this.nativeId)}`));
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return;
      throw err;
    }
  }
}

function connector(region: string, name: "HTTP_INGRESS" | "INTERNET_EGRESS"): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
}

function absolute(path: string): string {
  if (!path.startsWith("/")) throw new ProviderError(ID, `paths must be absolute: ${path}`);
  return path;
}

async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
    if (done) {
      if (buffer.trim()) yield buffer.trim();
      return;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** The in-VM server the MicroVM image must run (Node.js >= 18, built-ins only). */
export const LAMBDA_MICROVM_SERVER = String.raw`// sandboxrouter MicroVM server: exec + files over HTTP for src/providers/lambda.ts.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PORT = Number(process.env.SBR_PORT || 8080);
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (p.startsWith("/aws/lambda-microvms/runtime/v1/")) return json(res, 200, {});
    if (p === "/sbr/v1/health") return json(res, 200, { ok: true });
    if (p === "/sbr/v1/files") {
      const path = url.searchParams.get("path");
      if (!path || !path.startsWith("/")) return json(res, 400, { error: "absolute path required" });
      if (req.method === "PUT") {
        const data = await body(req);
        await mkdir(dirname(path), { recursive: true });
        const tmp = path + ".sbr-" + process.pid + "-" + Date.now();
        await writeFile(tmp, data);
        await rename(tmp, path);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET") {
        try {
          const data = await readFile(path);
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(data);
        } catch (e) {
          return json(res, e.code === "ENOENT" ? 404 : 500, { error: String(e.message) });
        }
      }
    }
    if (p === "/sbr/v1/exec" && req.method === "POST") {
      const j = JSON.parse((await body(req)).toString() || "{}");
      if (typeof j.cmd !== "string") return json(res, 400, { error: "cmd required" });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (o) => res.write(JSON.stringify(o) + "\n");
      const child = spawn("bash", ["-c", j.cmd], {
        cwd: j.cwd || process.env.HOME || "/",
        env: { ...process.env, ...(j.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let timedOut = false;
      let finished = false;
      const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
      const timer = j.timeoutSeconds > 0 ? setTimeout(() => { timedOut = true; killGroup(); }, j.timeoutSeconds * 1000) : null;
      res.on("close", () => { if (!finished) killGroup(); });
      child.stdout.on("data", (d) => line({ stdout: d.toString("base64") }));
      child.stderr.on("data", (d) => line({ stderr: d.toString("base64") }));
      child.on("error", (e) => { finished = true; if (timer) clearTimeout(timer); line({ error: String(e.message) }); res.end(); });
      child.on("close", (code, signal) => {
        finished = true;
        if (timer) clearTimeout(timer);
        // A timeout kill is reported as such, so the client can tell it from a command that exits 124 itself.
        const exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1);
        line(timedOut ? { exitCode: 124, timedOut: true } : { exitCode });
        res.end();
      });
      return;
    }
    json(res, 404, { error: "no route" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String((e && e.message) || e) });
    else res.end();
  }
}).listen(PORT, "0.0.0.0", () => console.log("sandboxrouter MicroVM server on :" + PORT));
`;

export const LAMBDA_MICROVM_DOCKERFILE = `FROM public.ecr.aws/docker/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 && rm -rf /var/lib/apt/lists/*
COPY server.mjs /opt/sbr/server.mjs
EXPOSE 8080
CMD ["node", "/opt/sbr/server.mjs"]
`;

/** Writes server.mjs + Dockerfile into dir, ready to zip and upload for create-microvm-image. */
export async function writeLambdaMicrovmBundle(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await fsWriteFile(join(dir, "server.mjs"), LAMBDA_MICROVM_SERVER);
  await fsWriteFile(join(dir, "Dockerfile"), LAMBDA_MICROVM_DOCKERFILE);
}
