import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * Maritime over plain REST (no SDK needed).
 * Control plane: https://api.maritime.sh  (Bearer mk_ key)
 * Data plane:    sandbox.dataPlaneUrl      (X-Maritime-Token: sandbox.secret)
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

  private async call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const detail = json?.code ? `${json.code}: ${json.message ?? ""}` : (json?.detail ? JSON.stringify(json.detail) : text.slice(0, 300));
      throw new ProviderError(this.id, `${method} ${new URL(url).pathname} -> ${res.status} ${detail}`, res.status);
    }
    return json as T;
  }

  private auth() {
    if (!this.apiKey) throw new ProviderError(this.id, "MARITIME_API_KEY is not set");
    return { Authorization: `Bearer ${this.apiKey}` };
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
    const sbx = await this.call<MaritimeSandboxObject>("POST", `${this.baseUrl}/api/sandboxes/ephemeral`, body, this.auth());
    return new MaritimeSandbox(this, sbx);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const sbx = await this.call<MaritimeSandboxObject>("GET", `${this.baseUrl}/v1/sandboxes/${encodeURIComponent(nativeId)}`, undefined, this.auth());
    if (!sbx.dataPlaneUrl || !sbx.secret) throw new ProviderError(this.id, `sandbox ${nativeId} has no data plane (state: ${sbx.state})`);
    return new MaritimeSandbox(this, sbx);
  }

  /** @internal */
  dataPlane<T>(sbx: MaritimeSandboxObject, path: string, body: unknown): Promise<T> {
    return this.call<T>("POST", `${sbx.dataPlaneUrl}${path}`, body, { "X-Maritime-Token": sbx.secret! });
  }

  /** @internal */
  end(id: string): Promise<unknown> {
    return this.call("DELETE", `${this.baseUrl}/api/sandboxes/ephemeral/${encodeURIComponent(id)}`, undefined, this.auth());
  }
}

interface MaritimeSandboxObject {
  id: string;
  state?: string;
  dataPlaneUrl?: string;
  secret?: string;
}

interface MaritimeCommand {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

// Keep each command body well under typical request limits.
const CHUNK_B64 = 96 * 1024;

class MaritimeSandbox implements ProviderSandbox {
  readonly nativeId: string;

  constructor(
    private provider: MaritimeProvider,
    private sbx: MaritimeSandboxObject,
  ) {
    this.nativeId = sbx.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      cmd: wrapCommand(cmd, { env: opts.env }),
      timeoutSeconds: opts.timeoutSeconds ?? 60,
    };
    if (opts.cwd) body.cwd = opts.cwd;
    const r = await this.provider.dataPlane<MaritimeCommand>(this.sbx, "/commands", body);
    return { exitCode: r.exitCode ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs: Date.now() - t0 };
  }

  // The public data plane documents /commands only, so files move as base64 through the shell.
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    const tmp = `${path}.sbr-${Date.now()}`;
    await this.must(`mkdir -p ${shq(dirname(path))} && : > ${shq(tmp)}`);
    for (let i = 0; i < b64.length; i += CHUNK_B64) {
      await this.must(`printf %s ${shq(b64.slice(i, i + CHUNK_B64))} >> ${shq(tmp)}`);
    }
    await this.must(`base64 -d < ${shq(tmp)} > ${shq(path)} && rm -f ${shq(tmp)}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.must(`base64 < ${shq(path)} | tr -d '\\n'`);
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  async kill(): Promise<void> {
    await this.provider.end(this.nativeId);
  }

  private async must(cmd: string): Promise<ExecResult> {
    const r = await this.exec(cmd);
    if (r.exitCode !== 0) throw new ProviderError("maritime", `command failed (${r.exitCode}): ${r.stderr.slice(0, 300)}`);
    return r;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
