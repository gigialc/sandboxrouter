import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, killedByTimeout, timeoutError, toBytes } from "../util.js";

/**
 * Run Cloud Linux sandboxes over plain REST. Firecracker microVMs, billed per second on the reserved
 * CPU and memory; CPU and memory used above the reservation bill at the same rates.
 *
 * https://api.run.cloud, Authorization: Bearer <RUN_CLOUD_API_KEY>:
 *   POST   /run-cloud/sandboxes {image, cpu, cpuLimit, memory, timeoutSeconds, onTimeout, tags, wait:false}
 *                                  -> {id, state, last_error, ...}   cpu is the vCPU reservation, cpuLimit
 *                                     the vCPUs it may burst to, memory MiB
 *   GET    /run-cloud/sandboxes/:id -> {id, state, last_error, ...}
 *   POST   /run-cloud/sandboxes/:id/exec {cmd:[argv], cwd, env, timeout_seconds}
 *                                  -> {exit_code, stdout, stderr}; a command past its timeout has its
 *                                     whole process group killed (exit_code -1)
 *   POST   /run-cloud/sandboxes/:id/fs {op:"read", path, offset, length}
 *                                  -> {content (base64), eof, next_offset, size} or {error}
 *   POST   /run-cloud/sandboxes/:id/fs {op:"write", path, offset, content (base64), truncate}
 *                                  -> {next_offset} or {error}; parent directories are created
 *   POST   /run-cloud/sandboxes/:id/pause, POST /run-cloud/sandboxes/:id/resume {wait:false}
 *                                  (202 while the sandbox moves to a host with room; repeat until running)
 *   POST   /run-cloud/sandboxes/:id/tunnels {port} -> {url, expiresAt, ...}
 *   DELETE /run-cloud/sandboxes/:id
 * States: pending, starting, building_image (first start from a new image), running, paused, stopped,
 * archived, interrupted, destroying, destroyed. The API boots in the background and ends a boot that has
 * not finished after 10 minutes. Live output streams only over a WebSocket (/exec/stream), which needs an
 * Authorization header that Node's built-in WebSocket cannot send, so this adapter uses the buffered /exec.
 * Docs: https://docs.run.cloud/sandboxes, https://docs.run.cloud/sandboxes/run-sandbox
 */
const ID = "runcloud" as const;
const DEFAULT_IMAGE = "runcloud/agent-base";
const START_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 500;
/** The guest's own file chunk size. */
const FILE_CHUNK = 512 * 1024;
const STARTING = new Set(["pending", "starting", "building_image"]);
const RESUMABLE = new Set(["paused", "stopped", "archived"]);
const GONE = new Set(["destroying", "destroyed"]);

interface Sandbox {
  id?: string;
  state?: string;
  last_error?: string;
}

interface FSResponse {
  error?: string;
  content?: string;
  eof?: boolean;
  next_offset?: number;
  size?: number;
}

export class RunCloudProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.RUN_CLOUD_API_KEY,
    private baseUrl = (process.env.RUN_CLOUD_API_URL ?? "https://api.run.cloud").replace(/\/+$/, ""),
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async api<T>(method: string, path: string, json?: unknown, timeoutMs = 60_000): Promise<{ status: number; body: T }> {
    if (!this.apiKey) throw new ProviderError(ID, "RUN_CLOUD_API_KEY is not set");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        const msg = j?.detail ?? j?.message ?? j?.error;
        if (typeof msg === "string") detail = j?.code ? `${j.code}: ${msg}` : msg;
      } catch {
        /* plain-text body */
      }
      throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    // Run Cloud bills the larger of the reserved CPU and the CPU used, and `cpuLimit` lets a sandbox burst
    // above its reservation to the full size. With cpuUtilization below 1, only that share is reserved
    // (at least 1/8 vCPU, the platform default), so CPU is billed about as used.
    const vcpu = spec.vcpu ?? 2;
    const share = Math.min(1, spec.cpuUtilization ?? 1);
    const reserved = share < 1 ? Math.min(vcpu, Math.max(0.125, Math.round(vcpu * share * 1000) / 1000)) : vcpu;
    const { body } = await this.api<Sandbox>("POST", "/run-cloud/sandboxes", {
      image: spec.image?.runcloud ?? DEFAULT_IMAGE,
      cpu: reserved,
      ...(reserved < vcpu ? { cpuLimit: vcpu } : {}),
      memory: Math.round((spec.memoryGb ?? 4) * 1024),
      // A hard lifetime: destroy at the end instead of parking a resumable snapshot.
      timeoutSeconds: Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)),
      onTimeout: "destroy",
      ...(spec.metadata && Object.keys(spec.metadata).length ? { tags: spec.metadata } : {}),
      wait: false,
    });
    if (!body.id) throw new ProviderError(ID, "create returned no sandbox id");
    const box = new RunCloudBox(this, body.id, spec.env ?? {});
    try {
      await box.waitRunning(false);
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new RunCloudBox(this, nativeId, {});
    await box.waitRunning(true);
    return box;
  }
}

class RunCloudBox implements ProviderSandbox {
  private tunnels = new Map<number, { url: string; expiresAt: number }>();

  constructor(
    private p: RunCloudProvider,
    readonly nativeId: string,
    private env: Record<string, string>,
  ) {}

  private get path() {
    return `/run-cloud/sandboxes/${encodeURIComponent(this.nativeId)}`;
  }

  /** Poll until the sandbox runs; with `resume`, wake a paused or stopped one on the way. */
  async waitRunning(resume: boolean): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const { body: s } = await this.p.api<Sandbox>("GET", this.path);
      const state = s.state ?? "";
      if (state === "running") return;
      if (GONE.has(state)) throw new ProviderError(ID, `sandbox ${this.nativeId} is ${state}`, 404);
      if (resume && RESUMABLE.has(state)) {
        await this.p.api("POST", `${this.path}/resume`, { wait: false });
      } else if (!STARTING.has(state)) {
        const why = s.last_error ?? "";
        // No room on the fleet: a capacity error, so the router tries the next provider.
        const status = /no host with capacity/i.test(why) ? 409 : 502;
        throw new ProviderError(ID, `sandbox ${this.nativeId} is ${state || "in an unknown state"}${why ? `: ${why}` : ""}`, status);
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `sandbox ${this.nativeId} not running after ${START_TIMEOUT_MS / 1000}s (${state})`, 504);
      await sleep(POLL_MS);
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const secs = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const env = { ...this.env, ...opts.env };
    const t0 = Date.now();
    let r: { exit_code?: number; stdout?: string; stderr?: string };
    try {
      ({ body: r } = await this.p.api<typeof r>(
        "POST",
        `${this.path}/exec`,
        {
          cmd: ["/bin/sh", "-c", cmd],
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          timeout_seconds: secs,
        },
        // The guest kills the command at `secs`; this only bounds a request that never answers.
        secs * 1000 + 30_000,
      ));
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError") throw timeoutError(ID, secs);
      throw err;
    }
    const durationMs = Date.now() - t0;
    if (typeof r.exit_code !== "number") throw new ProviderError(ID, "exec returned no exit code");
    if (killedByTimeout(r.exit_code, durationMs, secs)) throw timeoutError(ID, secs);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { exitCode: r.exit_code, stdout, stderr, durationMs };
  }

  private async fs(req: Record<string, unknown>): Promise<FSResponse> {
    const { body } = await this.p.api<FSResponse>("POST", `${this.path}/fs`, req, 120_000);
    if (body.error) {
      const missing = /no such file|not found|ENOENT/i.test(body.error);
      throw new ProviderError(ID, `${req.op} ${req.path}: ${body.error}`, missing ? 404 : undefined);
    }
    return body;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = toBytes(content);
    for (let offset = 0; offset === 0 || offset < bytes.byteLength; offset += FILE_CHUNK) {
      const chunk = bytes.subarray(offset, offset + FILE_CHUNK);
      const r = await this.fs({ op: "write", path, offset, content: Buffer.from(chunk).toString("base64"), truncate: offset === 0 });
      if (chunk.byteLength > 0 && r.next_offset !== offset + chunk.byteLength) {
        throw new ProviderError(ID, `write ${path}: chunk at ${offset} was not acknowledged`);
      }
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const r = await this.fs({ op: "read", path, offset, length: FILE_CHUNK });
      const chunk = Buffer.from(r.content ?? "", "base64");
      parts.push(chunk);
      offset += chunk.byteLength;
      if (r.eof || chunk.byteLength === 0 || (r.size !== undefined && offset >= r.size)) break;
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  /** A public tunnel to the port. Tunnels expire, so a new one is opened once the last is near its end. */
  async url(port: number): Promise<string> {
    const cached = this.tunnels.get(port);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.url;
    const { body } = await this.p.api<{ url?: string; expiresAt?: string }>("POST", `${this.path}/tunnels`, { port });
    if (!body.url) throw new ProviderError(ID, `tunnel for port ${port} returned no url`);
    const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : NaN;
    this.tunnels.set(port, { url: body.url, expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt });
    return body.url;
  }

  async pause(): Promise<void> {
    await this.p.api("POST", `${this.path}/pause`, {});
  }

  async kill(): Promise<void> {
    try {
      await this.p.api("DELETE", this.path);
    } catch (err) {
      if ((err as ProviderError).status !== 404) throw err;
    }
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
