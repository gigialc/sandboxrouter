import { readSSE } from "../sse.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { toBytes } from "../util.js";

/**
 * Superserve (YC F26) over plain REST. Firecracker microVMs that pause (memory + disk kept,
 * compute billing stops) and resume where they left off.
 *
 * Control plane https://api.superserve.ai, header X-API-Key: <SUPERSERVE_API_KEY> (ss_live_...):
 *   POST   /sandboxes {name, from_template, env_vars, timeout_seconds, metadata}
 *                         -> 201 {id, status, vcpu_count, memory_mib, access_token, routing_hint}
 *   GET    /sandboxes/:id -> {id, status: starting|active|pausing|paused|resuming|migrating|failed}
 *   DELETE /sandboxes/:id -> 204
 *   POST   /sandboxes/:id/pause    -> 204 paused, or 202 {status:"pausing"} (then poll GET)
 *   POST   /sandboxes/:id/activate -> {...sandbox, access_token, routing_hint}: resumes a paused
 *                                      sandbox and always mints a fresh token; 409 sandbox_pausing
 *                                      with Retry-After while a pause is still landing
 * Data plane (one sandbox, header X-Access-Token from create/activate) on the shared host
 * https://sandbox.superserve.ai with X-Superserve-Sandbox-Id: <id> (what the Node SDK uses; the
 * per-box host boxd-<id>.sandbox.superserve.ai also works), plus X-Superserve-Routing-Hint if given:
 *   POST /exec/stream {command, env, working_dir, timeout_s} -> text/event-stream, each data: is
 *        {stdout} | {stderr} | {exit_code, finished:true} | {error, code, finished:true}.
 *        `command` runs under /bin/sh -c. At timeout_s the command is killed with exit code 124.
 *   GET  /files?path=P -> raw bytes;  POST /files?path=P (application/octet-stream) creates parents
 * A paused sandbox answers the data plane with 503 sandbox_unavailable, and a stale token with 401:
 * the adapter then calls /activate once and retries, as the SDK does (src/tokenRetry.ts).
 * Errors are {error:{code, message}}.
 * Size: a sandbox inherits vCPU / memory / disk from its template and cannot override them. Every
 * system template (superserve/base, superserve/python-3.11, ...) is 2 vCPU / 4 GiB / 8 GiB, so
 * specs up to 2 / 4 boot superserve/base and larger specs need image.superserve = a team template
 * built at that size (paid plans; Free allows 0 team templates).
 * Lifetime: spec.timeoutMinutes becomes timeout_seconds, an auto-pause (not delete) after that much
 * active time. A paused box bills storage only and stays until kill().
 * Regions: a key shaped ss_live_<region>_... picks that region's hosts (use, usw), like the SDK.
 * Docs: https://docs.superserve.ai/llms.txt, https://docs.superserve.ai/sandbox/lifecycle.md,
 *       https://docs.superserve.ai/templates/overview.md, https://docs.superserve.ai/sdk-reference/commands.md,
 *       https://raw.githubusercontent.com/superserve-ai/sandbox/refs/heads/main/api/openapi.yaml,
 *       @superserve/sdk 0.11.6 on npm (dist/index.js: config.ts, commands.ts, files.ts, tokenRetry.ts),
 *       https://superserve.ai/pricing
 */
const ID = "superserve" as const;
const DEFAULT_TEMPLATE = "superserve/base";
/** Shape of every superserve/* system template. */
const SYSTEM_SHAPE = { vcpu: 2, memoryGb: 4 };
const PAUSE_TIMEOUT_MS = 2 * 60_000;
const ACTIVATE_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 500;
/** Extra time past the command timeout before the client gives up on its own. */
const CLIENT_GRACE_MS = 30_000;
const TIMEOUT_EXIT = 124;

/** API host -> data-plane host, from the SDK's KNOWN_REGIONS / deriveSandboxHost. */
const REGIONS: Record<string, { api: string; sandbox: string }> = {
  use: { api: "https://api.superserve.ai", sandbox: "https://sandbox.superserve.ai" },
  usw: { api: "https://api-usw.superserve.ai", sandbox: "https://usw-sandbox.superserve.ai" },
};
const KNOWN_DATA_PLANES: Record<string, string> = {
  "api.superserve.ai": "https://sandbox.superserve.ai",
  "api-usw.superserve.ai": "https://usw-sandbox.superserve.ai",
  "api-staging.superserve.ai": "https://staging-sandbox.superserve.ai",
};

interface Sandbox {
  id?: string;
  status?: string;
  vcpu_count?: number;
  memory_mib?: number;
  access_token?: string;
  routing_hint?: string;
}

interface StreamEvent {
  stdout?: string;
  stderr?: string;
  finished?: boolean;
  exit_code?: number;
  error?: string;
  code?: string;
}

export class SuperserveProvider implements Provider {
  readonly id = ID;
  /** @internal */
  readonly base: string;
  /** @internal */
  readonly dataPlane: string;

  /**
   * @param baseUrl control-plane URL (SUPERSERVE_BASE_URL, as the SDK reads it); default from the key's region
   * @param sandboxUrl data-plane URL (SUPERSERVE_SANDBOX_URL); default the region's shared host, or
   *        baseUrl itself when baseUrl is not a known Superserve host (a mock or proxy)
   */
  constructor(
    private apiKey = process.env.SUPERSERVE_API_KEY,
    baseUrl = process.env.SUPERSERVE_BASE_URL,
    sandboxUrl = process.env.SUPERSERVE_SANDBOX_URL,
  ) {
    const region = /^ss_live_([a-z0-9]{1,17})_[A-Za-z0-9_-]{32}$/.exec(apiKey ?? "")?.[1];
    const fromKey = region ? REGIONS[region] : undefined;
    this.base = (baseUrl?.trim() || fromKey?.api || REGIONS.use.api).replace(/\/+$/, "");
    let host = "";
    try {
      host = new URL(this.base).hostname;
    } catch {
      /* invalid base URL: the first request reports it */
    }
    this.dataPlane = (sandboxUrl?.trim() || KNOWN_DATA_PLANES[host] || this.base).replace(/\/+$/, "");
  }

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal Control-plane call with the team API key. */
  async api<T>(method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; res: Response }> {
    if (!this.apiKey) throw new ProviderError(ID, "SUPERSERVE_API_KEY is not set");
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "X-API-Key": this.apiKey, ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw apiError(method, path, res.status, text);
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, res };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const template = spec.image?.superserve;
    const vcpu = spec.vcpu ?? SYSTEM_SHAPE.vcpu;
    const mem = spec.memoryGb ?? SYSTEM_SHAPE.memoryGb;
    if (!template && (vcpu > SYSTEM_SHAPE.vcpu || mem > SYSTEM_SHAPE.memoryGb)) {
      throw new ProviderError(
        ID,
        `system templates are fixed at ${SYSTEM_SHAPE.vcpu} vCPU / ${SYSTEM_SHAPE.memoryGb} GB; for ${vcpu} vCPU / ${mem} GB set image.superserve to a team template built at that size`,
      );
    }
    const minutes = spec.timeoutMinutes ?? 30;
    const { body: sb } = await this.api<Sandbox>("POST", "/sandboxes", {
      name: `sbr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from_template: template ?? DEFAULT_TEMPLATE,
      // Auto-pause after this much active time; compute billing stops, the box is kept.
      timeout_seconds: Math.min(604_800, Math.max(60, Math.round(minutes * 60))),
      ...(spec.env && Object.keys(spec.env).length ? { env_vars: spec.env } : {}),
      ...(spec.metadata && Object.keys(spec.metadata).length ? { metadata: spec.metadata } : {}),
    });
    if (!sb.id) throw new ProviderError(ID, "create returned no sandbox id");
    const box = new SuperserveBox(this, sb.id, sb.access_token, sb.routing_hint);
    if (!sb.access_token) {
      try {
        await box.activate();
      } catch (err) {
        await box.kill().catch(() => {});
        throw err;
      }
    }
    return box;
  }

  /** Resume (if paused) and fetch a fresh access token. 404 once the sandbox is deleted. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new SuperserveBox(this, nativeId);
    await box.activate();
    return box;
  }
}

class SuperserveBox implements ProviderSandbox {
  constructor(
    private p: SuperserveProvider,
    readonly nativeId: string,
    private token?: string,
    private routingHint?: string,
  ) {}

  private get path() {
    return `/sandboxes/${encodeURIComponent(this.nativeId)}`;
  }

  /** POST /activate, waiting out a pause that is still landing. */
  async activate(): Promise<void> {
    const deadline = Date.now() + ACTIVATE_TIMEOUT_MS;
    for (;;) {
      try {
        const { body } = await this.p.api<Sandbox>("POST", `${this.path}/activate`);
        if (!body.access_token) throw new ProviderError(ID, `activate ${this.nativeId} returned no access_token`);
        this.token = body.access_token;
        this.routingHint = body.routing_hint;
        return;
      } catch (err) {
        // A pause still landing (409 sandbox_pausing, Retry-After ~1 s) or a box mid-move: retry.
        const e = err as ProviderError;
        const busy = e instanceof ProviderError && (e.status === 409 || e.status === 503) && /sandbox_pausing|secret_change_in_progress|resuming|migrating|sandbox_unavailable/.test(e.message);
        if (!busy || Date.now() > deadline) throw err;
        await sleep(1_000);
      }
    }
  }

  /** Data-plane request; re-activates once on a stale token, a paused box, or a moved route. */
  private async data(method: string, path: string, init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal } = {}): Promise<Response> {
    if (!this.token) await this.activate();
    const send = () =>
      fetch(`${this.p.dataPlane}${path}`, {
        method,
        signal: init.signal,
        headers: {
          "X-Access-Token": this.token!,
          "X-Superserve-Sandbox-Id": this.nativeId,
          ...(this.routingHint ? { "X-Superserve-Routing-Hint": this.routingHint } : {}),
          ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(init.body !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as BodyInit | undefined),
      });
    let res = await send();
    if (!res.ok) {
      const text = await res.text();
      const code = errorCode(text);
      const resumable = res.status === 401 || res.status === 503 || (res.status === 404 && code === "sandbox_route_stale");
      if (!resumable) throw apiError(method, path, res.status, text);
      await this.activate();
      res = await send();
      if (!res.ok) throw apiError(method, path, res.status, await res.text());
    }
    return res;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const ctl = new AbortController();
    let clientTimedOut = false;
    const timer = setTimeout(() => {
      clientTimedOut = true;
      ctl.abort();
    }, secs * 1000 + CLIENT_GRACE_MS);
    let stdout = "";
    let stderr = "";
    let final: StreamEvent | undefined;
    try {
      const res = await this.data("POST", "/exec/stream", {
        signal: ctl.signal,
        json: {
          command: cmd,
          ...(opts.cwd ? { working_dir: opts.cwd } : {}),
          ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
          timeout_s: secs,
        },
      });
      for await (const ev of readSSE(res)) {
        let e: StreamEvent;
        try {
          e = JSON.parse(ev.data) as StreamEvent;
        } catch {
          continue;
        }
        if (e.stdout) {
          stdout += e.stdout;
          opts.onStdout?.(e.stdout);
        }
        if (e.stderr) {
          stderr += e.stderr;
          opts.onStderr?.(e.stderr);
        }
        if (e.finished || e.error) {
          final = e;
          break;
        }
      }
    } catch (err) {
      if (clientTimedOut) throw new ProviderError(ID, `command timed out after ${secs}s`);
      throw err;
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    const durationMs = Date.now() - t0;
    if (!final) throw new ProviderError(ID, "command stream ended without a finished event (connection dropped?)");
    if (final.error) {
      if (/time(d)?[ _-]?out|deadline/i.test(`${final.code ?? ""} ${final.error}`)) throw new ProviderError(ID, `command timed out after ${secs}s`);
      throw new ProviderError(ID, `exec failed${final.code ? ` (${final.code})` : ""}: ${final.error}`);
    }
    const exitCode = final.exit_code ?? 0;
    // The server kills the command at timeout_s and reports exit 124 (like coreutils `timeout`).
    if (exitCode === TIMEOUT_EXIT && durationMs >= secs * 1000 - 250) throw new ProviderError(ID, `command timed out after ${secs}s`);
    return { exitCode, stdout, stderr, durationMs };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const res = await this.data("POST", `/files?path=${encodeURIComponent(path)}`, { body: toBytes(content) });
    await res.arrayBuffer().catch(() => {});
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.data("GET", `/files?path=${encodeURIComponent(path)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Pause (memory + disk kept) and wait until it lands, so connect() can resume right away. */
  async pause(): Promise<void> {
    const { status } = await this.p.api("POST", `${this.path}/pause`);
    if (status !== 202) return;
    const deadline = Date.now() + PAUSE_TIMEOUT_MS;
    for (;;) {
      const { body } = await this.p.api<Sandbox>("GET", this.path);
      if (body.status === "paused") return;
      if (body.status === "failed") throw new ProviderError(ID, `sandbox ${this.nativeId} failed while pausing`);
      if (Date.now() > deadline) throw new ProviderError(ID, `sandbox ${this.nativeId} not paused after ${PAUSE_TIMEOUT_MS / 1000}s (${body.status ?? "unknown"})`);
      await sleep(POLL_MS);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.p.api("DELETE", this.path);
    } catch (err) {
      // Already gone is fine (the SDK's kill() swallows 404 too).
      if ((err as ProviderError).status !== 404) throw err;
    }
    this.token = undefined;
  }
}

function errorCode(text: string): string | undefined {
  try {
    return JSON.parse(text)?.error?.code;
  } catch {
    return undefined;
  }
}

function apiError(method: string, path: string, status: number, text: string): ProviderError {
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (e && typeof e === "object") detail = `${e.code ? `${e.code}: ` : ""}${e.message ?? ""}`.trim();
    else if (typeof e === "string") detail = e;
    else if (j?.message) detail = j.message;
  } catch {
    /* plain-text body */
  }
  return new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${status} ${detail}`, status);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
