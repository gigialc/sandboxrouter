import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { toBytes } from "../util.js";
import { readSSE } from "../sse.js";

/**
 * Maritime over plain REST (no SDK needed).
 * Control plane: https://api.maritime.sh  (Bearer mk_ key)
 * Data plane:    sandbox.dataPlaneUrl      (X-Maritime-Token: sandbox.secret)
 *   POST /commands         run; with Accept: text/event-stream it streams stdout/stderr events
 *   GET|PUT /files?path=   raw bytes
 * Any data plane call resumes a paused sandbox.
 * Docs: https://maritime.sh/docs/ephemeral-sandboxes
 */
export class MaritimeProvider implements Provider {
  readonly id = "maritime" as const;

  constructor(
    private apiKey = process.env.MARITIME_API_KEY,
    private baseUrl = process.env.MARITIME_API_URL ?? "https://api.maritime.sh",
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async request(method: string, url: string, init: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      body = init.bytes as unknown as BodyInit;
    }
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j?.code ? `${j.code}: ${j.message ?? ""}` : j?.detail ? JSON.stringify(j.detail) : detail;
      } catch {
        /* non-JSON body */
      }
      throw new ProviderError(this.id, `${method} ${new URL(url).pathname} -> ${res.status} ${detail}`, res.status);
    }
    return res;
  }

  /** @internal */
  async json<T>(method: string, url: string, init: { json?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const text = await (await this.request(method, url, init)).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** @internal */
  control<T>(method: string, path: string, json?: unknown): Promise<T> {
    if (!this.apiKey) throw new ProviderError(this.id, "MARITIME_API_KEY is not set");
    return this.json<T>(method, `${this.baseUrl}${path}`, { json, headers: { Authorization: `Bearer ${this.apiKey}` } });
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const timeLimit = clamp(Math.round(spec.timeoutMinutes ?? 30), 5, 1440);
    const body: Record<string, unknown> = {
      from: spec.image?.maritime ?? "base",
      vcpu: clamp(Math.round(spec.vcpu ?? DEFAULT_VCPU), 1, 16),
      memoryMib: clamp(Math.ceil(spec.memoryGb ?? DEFAULT_MEMORY_GB), 1, 64) * 1024,
      timeLimitMinutes: timeLimit,
      // The router promises a hard lifetime, so don't let the idle timer end it much earlier.
      idleMinutes: clamp(timeLimit, 1, 60),
    };
    if (spec.env) body.env = spec.env;
    if (spec.metadata) body.metadata = spec.metadata;
    return new MaritimeSandbox(this, await this.control<MaritimeSandboxObject>("POST", "/api/sandboxes/ephemeral", body));
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const sbx = await this.control<MaritimeSandboxObject>("GET", `/v1/sandboxes/${encodeURIComponent(nativeId)}`);
    if (!sbx.dataPlaneUrl || !sbx.secret) throw new ProviderError(this.id, `sandbox ${nativeId} has no data plane (state: ${sbx.state})`);
    return new MaritimeSandbox(this, sbx);
  }
}

interface MaritimeSandboxObject {
  id: string;
  state?: string;
  dataPlaneUrl?: string;
  secret?: string | null;
}

interface MaritimeCommand {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

class MaritimeSandbox implements ProviderSandbox {
  readonly nativeId: string;

  constructor(
    private p: MaritimeProvider,
    private sbx: MaritimeSandboxObject,
  ) {
    this.nativeId = sbx.id;
  }

  /** Data plane call; on 401 re-reads the sandbox once in case the secret was rotated. */
  private async data(method: string, path: string, init: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}) {
    const go = () =>
      this.p.request(method, `${this.sbx.dataPlaneUrl}${path}`, {
        ...init,
        headers: { ...init.headers, "X-Maritime-Token": this.sbx.secret ?? "" },
      });
    try {
      return await go();
    } catch (err) {
      if (!(err instanceof ProviderError && err.status === 401)) throw err;
      this.sbx = await this.p.control<MaritimeSandboxObject>("GET", `/v1/sandboxes/${encodeURIComponent(this.nativeId)}`);
      return go();
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const body = { cmd, cwd: opts.cwd, env: opts.env, timeoutSeconds: opts.timeoutSeconds ?? 60 };
    const streaming = !!(opts.onStdout || opts.onStderr);
    const res = await this.data("POST", "/commands", {
      json: body,
      headers: streaming ? { Accept: "text/event-stream" } : {},
    });

    let result: MaritimeCommand | undefined;
    if (streaming && res.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const ev of readSSE(res)) {
        const payload = JSON.parse(ev.data);
        if (ev.event === "stdout") opts.onStdout?.(payload);
        else if (ev.event === "stderr") opts.onStderr?.(payload);
        else if (ev.event === "result") result = payload;
        else if (ev.event === "error") throw new ProviderError("maritime", `${payload?.code ?? "error"}: ${payload?.message ?? ev.data}`);
      }
      if (!result) throw new ProviderError("maritime", "output stream closed before the command finished");
    } else {
      result = JSON.parse(await res.text()) as MaritimeCommand;
      // Server answered without streaming: deliver the output in one chunk.
      if (result.stdout) opts.onStdout?.(result.stdout);
      if (result.stderr) opts.onStderr?.(result.stderr);
    }
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.data("PUT", `/files?path=${encodeURIComponent(path)}`, { bytes: toBytes(content) });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.data("GET", `/files?path=${encodeURIComponent(path)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async pause(): Promise<void> {
    await this.p.control("POST", `/v1/sandboxes/${encodeURIComponent(this.nativeId)}/pause`);
  }

  async kill(): Promise<void> {
    await this.p.control("DELETE", `/api/sandboxes/ephemeral/${encodeURIComponent(this.nativeId)}`);
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
