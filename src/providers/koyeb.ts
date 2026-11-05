import { randomBytes } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { readSSE } from "../sse.js";
import { shq, toBytes } from "../util.js";

/**
 * Koyeb Sandboxes over plain REST (no SDK needed). Koyeb Sandboxes are in public preview and need
 * a paid plan (Pro or Scale).
 *
 * A sandbox is a Koyeb service of type SANDBOX in its own app. The platform runs a command executor
 * next to the image (any public Docker image works; default `koyeb/sandbox`, Ubuntu 22.04 with
 * common runtimes), reachable over HTTPS with a per-sandbox secret that we mint and pass as the
 * SANDBOX_SECRET env var. This is the wire protocol of the official SDKs (@koyeb/sandbox-sdk and
 * koyeb-python-sdk's koyeb.sandbox), which is the only place Koyeb documents it.
 *
 * Control plane, https://app.koyeb.com, Authorization: Bearer <KOYEB_API_TOKEN>:
 *   POST   /v1/apps        {name, life_cycle:{delete_when_empty}}                      -> {app}
 *   POST   /v1/services    {app_id, definition:{type:"SANDBOX",docker,instance_types,
 *                           regions,ports,routes,env,scalings}, life_cycle:{delete_after_create}}
 *                                                                                      -> {service}
 *   GET    /v1/services/:id      -> {service:{app_id, active_deployment_id, latest_deployment_id}}
 *   GET    /v1/deployments/:id   -> {deployment:{status, definition.env, metadata.sandbox:{public_url, routing_key}}}
 *   GET    /v1/apps/:id          -> {app:{domains:[{name}]}}  (executor address on older deployments)
 *   DELETE /v1/apps/:id, DELETE /v1/services/:id
 * Errors are {status, code, message, fields}.
 * Executor, <public_url>/koyeb-sandbox, Authorization: Bearer <secret>, X-Routing-Key: <routing_key>:
 *   GET  /health                               200 once the executor answers
 *   POST /run_streaming {cmd, cwd, env}        SSE: `output` {stream, data, eol?} one line per event,
 *                                              `complete` {code, error}, `error` {error} (failed start)
 *   PUT  /files?path=P&parents=1               raw bytes in, {size, sha256} out (executor v0.0.24+)
 *   GET  /files?path=P                         raw bytes out, 404 when missing
 * Sizes are fixed instance types (KOYEB_INSTANCES); the adapter picks the smallest that fits.
 * No pause: Koyeb's sleep scales the instance to zero and loses its disk, so scale-to-zero is off.
 * Docs: https://www.koyeb.com/docs/sandboxes, https://www.koyeb.com/docs/sandboxes/sandbox-lifecycle,
 *       https://www.koyeb.com/docs/sandboxes/sandbox-run-commands,
 *       https://www.koyeb.com/docs/sandboxes/sandbox-file-operations,
 *       https://www.koyeb.com/docs/sandboxes/sandbox-default-image,
 *       https://www.koyeb.com/docs/reference/instances, https://www.koyeb.com/docs/api,
 *       https://github.com/koyeb/koyeb-sandbox-sdk-js (src/definition.ts, src/sandbox.ts,
 *       src/command-runner.ts, src/executor-gateway.ts),
 *       https://github.com/koyeb/koyeb-python-sdk/blob/main/docs/sandbox.md
 */
const ID = "koyeb" as const;
const DEFAULT_IMAGE = "koyeb/sandbox";
const READY_TIMEOUT_MS = 5 * 60_000;
/** life_cycle.delete_after_create bounds: 60 s to 24 h. */
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 86_400;
const READY = new Set(["HEALTHY", "DEGRADED"]);
const STARTING = new Set(["PENDING", "PROVISIONING", "SCHEDULED", "ALLOCATING", "STARTING"]);

/**
 * Koyeb Standard instance types, from https://www.koyeb.com/docs/reference/instances
 * (checked 2026-11-04). Billed per second for the whole instance.
 */
export const KOYEB_INSTANCES = [
  { type: "nano", vcpu: 0.25, memoryGb: 0.25, usdHour: 0.0036 },
  { type: "micro", vcpu: 0.5, memoryGb: 0.5, usdHour: 0.0072 },
  { type: "small", vcpu: 1, memoryGb: 1, usdHour: 0.0144 },
  { type: "medium", vcpu: 2, memoryGb: 2, usdHour: 0.0288 },
  { type: "large", vcpu: 4, memoryGb: 4, usdHour: 0.0576 },
  { type: "xlarge", vcpu: 8, memoryGb: 8, usdHour: 0.1152 },
  { type: "2xlarge", vcpu: 16, memoryGb: 16, usdHour: 0.2304 },
  { type: "3xlarge", vcpu: 24, memoryGb: 32, usdHour: 0.4608 },
  { type: "4xlarge", vcpu: 32, memoryGb: 64, usdHour: 0.9216 },
  { type: "5xlarge", vcpu: 40, memoryGb: 128, usdHour: 1.8432 },
] as const;

/** Smallest Standard instance with at least the requested vCPU and memory, or undefined. */
export function koyebInstance(vcpu: number, memoryGb: number): (typeof KOYEB_INSTANCES)[number] | undefined {
  return KOYEB_INSTANCES.find((t) => t.vcpu >= vcpu && t.memoryGb >= memoryGb);
}

interface KoyebDeployment {
  id?: string;
  status?: string;
  messages?: string[];
  definition?: { env?: { key?: string; value?: string }[] };
  metadata?: { sandbox?: { public_url?: string; routing_key?: string } };
}

interface KoyebService {
  id?: string;
  app_id?: string;
  active_deployment_id?: string;
  latest_deployment_id?: string;
}

export class KoyebProvider implements Provider {
  readonly id = ID;

  constructor(
    private token = process.env.KOYEB_API_TOKEN,
    private baseUrl = process.env.KOYEB_API_HOST ?? "https://app.koyeb.com",
    private region = process.env.KOYEB_REGION ?? "na",
  ) {}

  configured(): boolean {
    return !!this.token;
  }

  /** @internal Control-plane JSON call. */
  async api<T>(method: string, path: string, json?: unknown): Promise<T> {
    if (!this.token) throw new ProviderError(ID, "KOYEB_API_TOKEN is not set");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j?.message) detail = `${j.code ? `${j.code}: ` : ""}${j.message}${j.fields?.length ? ` (${j.fields.map((f: any) => `${f.field}: ${f.description}`).join("; ")})` : ""}`;
      } catch {
        /* plain-text body */
      }
      throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const vcpu = spec.vcpu ?? 2;
    const memoryGb = spec.memoryGb ?? 4;
    const instance = koyebInstance(vcpu, memoryGb);
    if (!instance) throw new ProviderError(ID, `no Koyeb instance has ${vcpu} vCPU / ${memoryGb} GB (max 5xlarge: 40 vCPU / 128 GB)`);
    const suffix = randomBytes(5).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const env = [{ key: "SANDBOX_SECRET", value: secret }];
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (key === "SANDBOX_SECRET") throw new ProviderError(ID, "SANDBOX_SECRET is reserved for the executor");
      env.push({ key, value });
    }
    const lifetime = Math.round((spec.timeoutMinutes ?? 30) * 60);

    const { app } = await this.api<{ app?: { id?: string } }>("POST", "/v1/apps", {
      name: `sbr-${suffix}`,
      life_cycle: { delete_when_empty: true },
    });
    if (!app?.id) throw new ProviderError(ID, "create app returned no id");
    let service: KoyebService | undefined;
    try {
      ({ service } = await this.api<{ service?: KoyebService }>("POST", "/v1/services", {
        app_id: app.id,
        definition: {
          name: `sbr-${suffix}`,
          type: "SANDBOX",
          docker: { image: spec.image?.koyeb ?? DEFAULT_IMAGE },
          instance_types: [{ type: instance.type }],
          regions: [this.region],
          // The executor listens on 3030 under /koyeb-sandbox/; 3031 is the port the sandbox may expose.
          ports: [
            { port: 3030, protocol: "http" },
            { port: 3031, protocol: "http" },
          ],
          routes: [
            { port: 3030, path: "/koyeb-sandbox/" },
            { port: 3031, path: "/" },
          ],
          env,
          mesh: "DEPLOYMENT_MESH_AUTO",
          // Always one instance: scale-to-zero would drop the sandbox's disk.
          scalings: [{ min: 1, max: 1 }],
        },
        life_cycle: { delete_after_create: Math.min(MAX_LIFETIME_S, Math.max(MIN_LIFETIME_S, lifetime)) },
      }));
      if (!service?.id) throw new ProviderError(ID, "create service returned no id");
    } catch (err) {
      await this.api("DELETE", `/v1/apps/${app.id}`).catch(() => {});
      throw err;
    }
    const box = new KoyebBox(this, service.id, app.id, secret, true);
    try {
      await box.waitReady(service.latest_deployment_id);
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  /** Reattach by service id. The executor secret is read back from the deployment's env. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { service } = await this.api<{ service?: KoyebService }>("GET", `/v1/services/${encodeURIComponent(nativeId)}`);
    const deploymentId = service?.active_deployment_id || service?.latest_deployment_id;
    if (!service?.app_id || !deploymentId) throw new ProviderError(ID, `service ${nativeId} has no deployment`, 404);
    const { deployment } = await this.api<{ deployment?: KoyebDeployment }>("GET", `/v1/deployments/${deploymentId}`);
    const secret = deployment?.definition?.env?.find((e) => e.key === "SANDBOX_SECRET")?.value;
    if (!secret) throw new ProviderError(ID, `service ${nativeId} has no SANDBOX_SECRET; it is not a Koyeb sandbox`);
    const box = new KoyebBox(this, nativeId, service.app_id, secret, false);
    await box.waitReady(deploymentId);
    return box;
  }
}

class KoyebBox implements ProviderSandbox {
  private base?: string;
  private routingKey?: string;

  constructor(
    private p: KoyebProvider,
    readonly nativeId: string,
    private appId: string,
    private secret: string,
    /** Created by this adapter in its own app: kill deletes the app, not just the service. */
    private ownsApp: boolean,
  ) {}

  /** Poll the deployment until HEALTHY, learn the executor address, then poll /health. */
  async waitReady(deploymentId?: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let id = deploymentId;
    for (;;) {
      if (!id) {
        const { service } = await this.p.api<{ service?: KoyebService }>("GET", `/v1/services/${this.nativeId}`);
        id = service?.active_deployment_id || service?.latest_deployment_id;
      }
      if (id) {
        const { deployment } = await this.p.api<{ deployment?: KoyebDeployment }>("GET", `/v1/deployments/${id}`);
        const status = deployment?.status ?? "";
        if (READY.has(status)) {
          await this.resolveExecutor(deployment!);
          break;
        }
        if (!STARTING.has(status)) {
          const why = deployment?.messages?.join("; ");
          throw new ProviderError(ID, `sandbox ${this.nativeId} deployment is ${status || "unknown"}${why ? `: ${why}` : ""}`);
        }
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `sandbox ${this.nativeId} not ready after ${READY_TIMEOUT_MS / 1000}s`);
      await sleep(500);
    }
    for (;;) {
      try {
        const res = await this.executor("GET", "/health", undefined, AbortSignal.timeout(5_000));
        await res.body?.cancel().catch(() => {});
        if (res.ok) return;
        if (res.status === 401 || res.status === 403) throw new ProviderError(ID, `executor rejected the sandbox secret (${res.status})`, res.status);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `sandbox ${this.nativeId} executor not answering after ${READY_TIMEOUT_MS / 1000}s`);
      await sleep(500);
    }
  }

  /** The executor lives at <public_url>/koyeb-sandbox; older deployments only expose the app domain. */
  private async resolveExecutor(deployment: KoyebDeployment): Promise<void> {
    const sb = deployment.metadata?.sandbox;
    if (sb?.public_url) {
      const url = sb.public_url.includes("://") ? sb.public_url : `https://${sb.public_url}`;
      this.base = `${url.replace(/\/+$/, "")}/koyeb-sandbox`;
      this.routingKey = sb.routing_key;
      return;
    }
    const { app } = await this.p.api<{ app?: { domains?: { name?: string }[] } }>("GET", `/v1/apps/${this.appId}`);
    const domain = app?.domains?.[0]?.name;
    if (!domain) throw new ProviderError(ID, `sandbox ${this.nativeId} has no public URL yet`);
    this.base = `https://${domain}/koyeb-sandbox`;
  }

  private executor(method: string, path: string, body?: { json?: unknown; bytes?: Uint8Array }, signal?: AbortSignal): Promise<Response> {
    if (!this.base) throw new ProviderError(ID, `sandbox ${this.nativeId} executor address unknown`);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secret}` };
    if (this.routingKey) headers["X-Routing-Key"] = this.routingKey;
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      payload = body.bytes as BodyInit;
    }
    return fetch(`${this.base}${path}`, { method, headers, body: payload, signal });
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error ?? j?.message ?? detail;
    } catch {
      /* plain-text body */
    }
    throw new ProviderError(ID, `${what} -> ${res.status} ${detail}`.trim(), res.status);
  }

  /**
   * POST /run_streaming. The executor has no timeout field, so the command runs under `timeout`
   * when the image has it, and the request is aborted 10 s after the deadline either way.
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const guarded = `if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 ${secs} /bin/sh -c ${shq(cmd)}; else exec /bin/sh -c ${shq(cmd)}; fi`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), secs * 1000 + 10_000);
    timer.unref();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    try {
      const res = await this.executor("POST", "/run_streaming", { json: { cmd: guarded, cwd: opts.cwd, env: opts.env } }, ctl.signal);
      if (!res.ok) await this.fail(res, "run_streaming");
      for await (const ev of readSSE(res)) {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          throw new ProviderError(ID, `unparseable ${ev.event} event: ${ev.data.slice(0, 200)}`);
        }
        if (ev.event === "output") {
          // One line per event without its line ending; `eol` carries it when the executor sends one.
          const chunk = `${data.data ?? ""}${typeof data.eol === "string" ? data.eol : "\n"}`;
          if (data.stream === "stderr") {
            stderr += chunk;
            opts.onStderr?.(chunk);
          } else {
            stdout += chunk;
            opts.onStdout?.(chunk);
          }
        } else if (ev.event === "complete") {
          if (typeof data.code === "number") exitCode = data.code;
          else if (typeof data.error === "string") throw new ProviderError(ID, `command failed to start: ${data.error}`);
          break;
        } else if (ev.event === "error") {
          throw new ProviderError(ID, `command failed to start: ${data.error ?? ev.data}`);
        }
      }
    } catch (err) {
      if (ctl.signal.aborted) throw new ProviderError(ID, `command timed out after ${secs}s`);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(ID, `run_streaming: ${(err as Error).message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
    if (exitCode === undefined) throw new ProviderError(ID, "command stream ended without an exit code");
    const durationMs = Date.now() - t0;
    if (durationMs >= secs * 1000 && [124, 137, 143].includes(exitCode)) throw new ProviderError(ID, `command timed out after ${secs}s`);
    return { exitCode, stdout, stderr, durationMs };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const q = new URLSearchParams({ path, parents: "1" });
    const res = await this.executor("PUT", `/files?${q}`, { bytes: toBytes(content) });
    if (!res.ok) await this.fail(res, `write ${path}`);
    await res.body?.cancel().catch(() => {});
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.executor("GET", `/files?${new URLSearchParams({ path })}`);
    if (!res.ok) await this.fail(res, `read ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async kill(): Promise<void> {
    if (this.ownsApp) await this.p.api("DELETE", `/v1/apps/${this.appId}`);
    else await this.p.api("DELETE", `/v1/services/${this.nativeId}`);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
