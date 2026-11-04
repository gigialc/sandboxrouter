import { CLOUDFLARE_INSTANCES, DEFAULT_MEMORY_GB, DEFAULT_VCPU, cloudflareInstance } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { toBytes } from "../util.js";
import { readSSE } from "../sse.js";

/**
 * Cloudflare Sandboxes through a bridge Worker you deploy to your own account
 * (bridges/cloudflare in this repo). Cloudflare sandboxes are Containers started from a
 * Durable Object, so they can only be driven from inside a Worker; the bridge exposes them over HTTPS.
 *   POST   /sandboxes                 {env, instance, image?, timeoutMinutes} -> {id}
 *   GET    /sandboxes/:id             -> {id, running, expiresAt}
 *   POST   /sandboxes/:id/exec        with Accept: text/event-stream it streams stdout/stderr events
 *   GET|PUT /sandboxes/:id/files?path= raw bytes
 *   DELETE /sandboxes/:id
 * Auth: Authorization: Bearer CLOUDFLARE_SANDBOX_TOKEN (the bridge's BRIDGE_TOKEN secret).
 * Docs: https://developers.cloudflare.com/sandbox/
 */
export class CloudflareProvider implements Provider {
  readonly id = "cloudflare" as const;

  constructor(
    private baseUrl = process.env.CLOUDFLARE_SANDBOX_URL,
    private token = process.env.CLOUDFLARE_SANDBOX_TOKEN,
  ) {}

  configured(): boolean {
    return !!(this.baseUrl && this.token);
  }

  /** @internal */
  async request(method: string, path: string, init: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!this.baseUrl) throw new ProviderError(this.id, "CLOUDFLARE_SANDBOX_URL is not set");
    if (!this.token) throw new ProviderError(this.id, "CLOUDFLARE_SANDBOX_TOKEN is not set");
    const headers: Record<string, string> = { ...init.headers, Authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      body = init.bytes as unknown as BodyInit;
    }
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j?.code) detail = `${j.code}: ${j.message ?? ""}`;
      } catch {
        /* non-JSON body */
      }
      throw new ProviderError(this.id, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    return res;
  }

  /** @internal */
  async json<T>(method: string, path: string, json?: unknown): Promise<T> {
    const text = await (await this.request(method, path, { json })).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const body: Record<string, unknown> = {
      instance: instanceFor(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB),
      timeoutMinutes: clamp(Math.round(spec.timeoutMinutes ?? 30), 1, 1440),
    };
    if (spec.env) body.env = spec.env;
    // Names an entry under containers[].images in the bridge's wrangler.jsonc (default "sandbox").
    if (spec.image?.cloudflare) body.image = spec.image.cloudflare;
    const { id } = await this.json<{ id: string }>("POST", "/sandboxes", body);
    return new CloudflareSandbox(this, id);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const sbx = await this.json<{ id: string }>("GET", `/sandboxes/${encodeURIComponent(nativeId)}`);
    return new CloudflareSandbox(this, sbx.id);
  }
}

/**
 * Smallest predefined instance type that covers the request, else the largest.
 * https://developers.cloudflare.com/containers/platform/limits/#instance-types
 */
void CLOUDFLARE_INSTANCES; // instance types live in the catalog so pricing and sizing agree

function instanceFor(vcpu: number, memoryGb: number): string {
  return cloudflareInstance(vcpu, memoryGb).name;
}

interface CloudflareCommand {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

class CloudflareSandbox implements ProviderSandbox {
  private base: string;

  constructor(
    private p: CloudflareProvider,
    readonly nativeId: string,
  ) {
    this.base = `/sandboxes/${encodeURIComponent(nativeId)}`;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const body = { cmd, cwd: opts.cwd, env: opts.env, timeoutSeconds: opts.timeoutSeconds ?? 60 };
    const streaming = !!(opts.onStdout || opts.onStderr);
    const res = await this.p.request("POST", `${this.base}/exec`, {
      json: body,
      headers: streaming ? { Accept: "text/event-stream" } : {},
    });

    let result: CloudflareCommand | undefined;
    if (streaming && res.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const ev of readSSE(res)) {
        const payload = JSON.parse(ev.data);
        if (ev.event === "stdout") opts.onStdout?.(payload);
        else if (ev.event === "stderr") opts.onStderr?.(payload);
        else if (ev.event === "result") result = payload;
        else if (ev.event === "error") throw new ProviderError("cloudflare", `${payload?.code ?? "error"}: ${payload?.message ?? ev.data}`);
      }
      if (!result) throw new ProviderError("cloudflare", "output stream closed before the command finished");
    } else {
      result = JSON.parse(await res.text()) as CloudflareCommand;
      // Bridge answered without streaming: deliver the output in one chunk.
      if (result.stdout) opts.onStdout?.(result.stdout);
      if (result.stderr) opts.onStderr?.(result.stderr);
    }
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.p.request("PUT", `${this.base}/files?path=${encodeURIComponent(path)}`, { bytes: toBytes(content) });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.p.request("GET", `${this.base}/files?path=${encodeURIComponent(path)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async kill(): Promise<void> {
    await this.p.request("DELETE", this.base);
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
