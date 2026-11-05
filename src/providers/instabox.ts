import { randomUUID } from "node:crypto";
import { readSSE } from "../sse.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { toBytes } from "../util.js";

/**
 * InstaBox (instabox.sh, by InsForge, YC P26) over plain REST. Full Linux (Debian 13, systemd,
 * sudo) Firecracker microVMs with a persistent /data disk; billed per second while running.
 *
 * https://api.instabox.sh, X-API-Key: <INSTABOX_API_KEY> (ibk_...; Authorization: Bearer also works):
 *   POST   /v1/machines {vcpus, memMiB, templateId|snapshotId, env, metadata, deleteAfterSeconds}
 *                                     -> 202 Operation {id, machineId, type, state, phase, error}
 *   GET    /v1/operations/:id?wait=25s   long poll; state queued | running | succeeded | failed
 *   GET    /v1/machines/:id            -> Machine {id, state, runtime:{ready}, operationId, lastError}
 *   POST   /v1/machines/:id/suspend {}  pause: memory and disk kept, compute billing stops
 *   POST   /v1/machines/:id/start {}    starts a stopped machine, or resumes a paused one
 *   DELETE /v1/machines/:id             needs X-Confirm-Delete: <id>
 *   POST   /v1/machines/:id/exec {cmd, cwd, envs, timeoutSeconds<=600}  runs `bash -lc cmd`, blocks;
 *          -> ExecResult {stdout, stderr, exitCode, timedOut, truncated} (1 MiB per stream), or with
 *          Accept: text/event-stream: `stdout`/`stderr` events {data}, then `exit` (ExecResult) or `error`
 *   PUT    /v1/machines/:id/files?path=&parents=true   raw body, any bytes, up to 5 GiB
 *   GET    /v1/machines/:id/files/content?path=        raw bytes
 * Create, start, suspend and delete need an Idempotency-Key header and answer an Operation.
 * Machine state: creating, starting, running, stopping, stopped, suspending, suspended, resuming,
 * deleting, deleted, error. Errors are {error:{code, message, retryable, retryAfterSeconds}}.
 * Sizes are fixed at 1 vCPU : 2 GiB (Pro 2/4, 4/8, 8/16; Builder to 16/32; Team to 32/64; Free 4/8
 * only). There is no lifetime timeout: deleteAfterSeconds (60-86400) deletes the machine in any state.
 * An idle machine pauses itself after 30 minutes and wakes on the next exec or file call.
 * Docs: https://instabox.sh/docs/api.md, https://instabox.sh/docs/machines.md,
 *       https://instabox.sh/docs/idle-suspend.md, https://instabox.sh/docs/limits.md,
 *       https://instabox.sh/docs/pricing.md, https://api.instabox.sh/v1/openapi.json
 */
const ID = "instabox" as const;
const READY_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 250;
const MAX_EXEC_SECONDS = 600;
const HOME = "/data/home";

/** Sizes on api.instabox.sh (vCPUs / GiB); which ones an org may use depends on its plan. */
export const INSTABOX_SIZES = [
  { vcpu: 2, memoryGb: 4 },
  { vcpu: 4, memoryGb: 8 },
  { vcpu: 8, memoryGb: 16 },
  { vcpu: 16, memoryGb: 32 },
  { vcpu: 32, memoryGb: 64 },
] as const;

/** The smallest size with at least the requested vCPUs and memory, or undefined if none fits. */
export function instaboxSize(vcpu: number, memoryGb: number) {
  return INSTABOX_SIZES.find((s) => s.vcpu >= vcpu && s.memoryGb >= memoryGb);
}

/** The default size, and the only one on the free plan. */
const DEFAULT_SIZE = INSTABOX_SIZES[1];

interface Operation {
  id?: string;
  machineId?: string;
  type?: string;
  state?: string;
  phase?: string;
  error?: { code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number } | null;
}

interface Machine {
  id?: string;
  state?: string;
  operationId?: string | null;
  runtime?: { ready?: boolean };
  lastError?: { code?: string; message?: string } | null;
  cooldownUntil?: string | null;
}

interface InstaboxExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  signal?: string;
}

class InstaboxError extends ProviderError {
  constructor(
    message: string,
    status?: number,
    readonly code?: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(ID, message, status);
  }
}

export class InstaboxProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.INSTABOX_API_KEY,
    private baseUrl = process.env.INSTABOX_API_URL ?? "https://api.instabox.sh",
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal Send a request; non-2xx answers throw InstaboxError. */
  async request(
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; idempotent?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    if (!this.apiKey) throw new ProviderError(ID, "INSTABOX_API_KEY is not set");
    const headers: Record<string, string> = { "X-API-Key": this.apiKey, ...init.headers };
    if (init.idempotent) headers["Idempotency-Key"] = randomUUID();
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers["Content-Type"] = "application/octet-stream";
      body = init.body as unknown as BodyInit;
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      let err: Operation["error"];
      try {
        err = JSON.parse(text)?.error;
        if (err?.code) detail = `${err.code}: ${err.message ?? ""}`;
      } catch {
        /* plain-text body */
      }
      const retryAfter = err?.retryAfterSeconds ?? (Number(res.headers.get("retry-after")) || undefined);
      throw new InstaboxError(`${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status, err?.code, !!err?.retryable, retryAfter);
    }
    return res;
  }

  /** @internal */
  async json<T>(method: string, path: string, json?: unknown, opts: { idempotent?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
    const text = await (await this.request(method, path, { json, ...opts })).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** @internal Follow an operation until it succeeds; a failed one throws. */
  async waitOperation(op: Operation, what: string): Promise<Operation> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (op.state !== "succeeded" && op.state !== "failed") {
      if (Date.now() > deadline) throw new ProviderError(ID, `${what} not done after ${READY_TIMEOUT_MS / 1000}s (${op.phase || op.state || "unknown"})`);
      if (!op.id) throw new ProviderError(ID, `${what} returned no operation id`);
      // Long poll: answers as soon as the state or phase changes, or after 25 s.
      op = await this.json<Operation>("GET", `/v1/operations/${encodeURIComponent(op.id)}?wait=25s`);
      if (op.state !== "succeeded" && op.state !== "failed") await sleep(POLL_MS);
    }
    if (op.state === "failed") {
      const e = op.error;
      throw new InstaboxError(`${what} failed: ${e?.code ? `${e.code}: ` : ""}${e?.message ?? "no reason given"}`, e?.code === "no_capacity" ? 503 : undefined, e?.code, !!e?.retryable);
    }
    return op;
  }

  /** @internal Wait until the machine runs and takes commands, starting or resuming it when it is stopped or paused. */
  async ensureRunning(id: string): Promise<void> {
    const path = `/v1/machines/${encodeURIComponent(id)}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const m = await this.json<Machine>("GET", path);
      const state = m.state ?? "";
      if (state === "running" && m.runtime?.ready) return;
      if (state === "deleting" || state === "deleted") throw new InstaboxError(`machine ${id} is ${state}`, 404, "not_found");
      if (state === "error") throw new InstaboxError(`machine ${id} is in error${m.lastError?.message ? `: ${m.lastError.message}` : ""}`, undefined, m.lastError?.code);
      if (Date.now() > deadline) throw new ProviderError(ID, `machine ${id} not ready after ${READY_TIMEOUT_MS / 1000}s (${state || "unknown"})`);
      if (state === "stopped" || state === "suspended") {
        try {
          await this.waitOperation(await this.json<Operation>("POST", `${path}/start`, {}, { idempotent: true }), `start of ${id}`);
        } catch (err) {
          // Another operation (an automatic resume, say) got there first: look again.
          if (!(err instanceof InstaboxError && err.code === "operation_conflict" && err.retryable)) throw err;
          await sleep(1000);
        }
        continue;
      }
      if (m.operationId) {
        // Creating, starting, resuming, stopping or pausing: follow that operation, then look again.
        await this.waitOperation({ id: m.operationId, state: "running" }, `operation on ${id}`).catch(() => {});
      } else {
        await sleep(POLL_MS);
      }
    }
  }

  private async createMachine(body: Record<string, unknown>): Promise<string> {
    const op = await this.json<Operation>("POST", "/v1/machines", body, { idempotent: true });
    const id = op.machineId;
    if (!id) throw new ProviderError(ID, "create returned no machineId");
    try {
      await this.waitOperation(op, `create of ${id}`);
      // A machine from a snapshot with storage is created stopped; this starts it.
      await this.ensureRunning(id);
    } catch (err) {
      await new InstaboxBox(this, id).kill().catch(() => {});
      throw err;
    }
    return id;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const vcpu = spec.vcpu ?? 2;
    const memoryGb = spec.memoryGb ?? 4;
    const size = instaboxSize(vcpu, memoryGb);
    if (!size) throw new ProviderError(ID, `no InstaBox size has ${vcpu} vCPU / ${memoryGb} GB (largest: 32 vCPU / 64 GiB, Team plan)`);
    const body: Record<string, unknown> = {
      vcpus: size.vcpu,
      memMiB: size.memoryGb * 1024,
      // There is no lifetime timeout; this deletes the machine (in any state) so a leaked one stops billing.
      deleteAfterSeconds: Math.min(86_400, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60))),
    };
    const image = spec.image?.instabox;
    if (image) {
      if (image.startsWith("snapshot:")) body.snapshotId = image.slice("snapshot:".length);
      else if (/^(sn|im)_/.test(image)) body.snapshotId = image;
      else body.templateId = image;
    }
    if (spec.env && Object.keys(spec.env).length) body.env = spec.env;
    if (spec.metadata && Object.keys(spec.metadata).length) body.metadata = spec.metadata;
    let id: string;
    try {
      id = await this.createMachine(body);
    } catch (err) {
      // The free plan offers only the default 4 vCPU / 8 GiB; a smaller request fits in it.
      const smaller = size.vcpu < DEFAULT_SIZE.vcpu;
      if (!(smaller && err instanceof InstaboxError && err.code === "spec_not_allowed")) throw err;
      id = await this.createMachine({ ...body, vcpus: DEFAULT_SIZE.vcpu, memMiB: DEFAULT_SIZE.memoryGb * 1024 });
    }
    return new InstaboxBox(this, id);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    await this.ensureRunning(nativeId);
    return new InstaboxBox(this, nativeId);
  }
}

class InstaboxBox implements ProviderSandbox {
  constructor(
    private p: InstaboxProvider,
    readonly nativeId: string,
  ) {}

  private get path() {
    return `/v1/machines/${encodeURIComponent(this.nativeId)}`;
  }

  /**
   * Retry calls the machine refused before doing anything: a paused or stopped machine is started,
   * a machine busy resuming or restarting is waited for.
   */
  private async whenRunning<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 120_000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof InstaboxError) || attempt >= 5 || Date.now() > deadline) throw err;
        if (err.code === "machine_not_running" && !err.retryable) {
          await this.p.ensureRunning(this.nativeId);
          continue;
        }
        const transient = ["machine_not_running", "operation_conflict", "host_unavailable", "quota_exceeded", "rate_limited"];
        if (!err.retryable || !transient.includes(err.code ?? "")) throw err;
        await sleep(Math.min(10, err.retryAfterSeconds ?? 2) * 1000);
      }
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = Math.min(MAX_EXEC_SECONDS, Math.max(1, Math.round(opts.timeoutSeconds ?? 60)));
    const body = {
      cmd,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env && Object.keys(opts.env).length ? { envs: opts.env } : {}),
      timeoutSeconds: secs,
    };
    const streaming = !!(opts.onStdout || opts.onStderr);
    const res = await this.whenRunning(() =>
      this.p.request("POST", `${this.path}/exec`, {
        json: body,
        headers: streaming ? { Accept: "text/event-stream" } : {},
        // The server kills the command at its timeout; allow for a wake in front of it.
        timeoutMs: secs * 1000 + 60_000,
      }),
    );
    let out: InstaboxExecResult;
    let stdout = "";
    let stderr = "";
    if (streaming && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      let exit: InstaboxExecResult | undefined;
      for await (const ev of readSSE(res)) {
        if (ev.event === "stdout" || ev.event === "stderr") {
          const chunk = String((JSON.parse(ev.data) as { data?: string }).data ?? "");
          if (!chunk) continue;
          if (ev.event === "stdout") {
            stdout += chunk;
            opts.onStdout?.(chunk);
          } else {
            stderr += chunk;
            opts.onStderr?.(chunk);
          }
        } else if (ev.event === "exit") {
          exit = JSON.parse(ev.data) as InstaboxExecResult;
        } else if (ev.event === "error") {
          const j = JSON.parse(ev.data);
          const e = j?.error ?? j;
          throw new InstaboxError(`exec: ${e?.code ? `${e.code}: ` : ""}${e?.message ?? ev.data.slice(0, 300)}`, undefined, e?.code, false);
        }
      }
      if (!exit) throw new ProviderError(ID, "exec stream ended without an exit event");
      out = exit;
    } else {
      out = (await res.json()) as InstaboxExecResult;
      stdout = out.stdout ?? "";
      stderr = out.stderr ?? "";
      if (stdout) opts.onStdout?.(stdout);
      if (stderr) opts.onStderr?.(stderr);
    }
    if (out.timedOut) throw new ProviderError(ID, `command timed out after ${secs}s`);
    if (typeof out.exitCode !== "number") throw new ProviderError(ID, "exec returned no exit code");
    return { exitCode: out.exitCode, stdout, stderr, durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const q = `?path=${encodeURIComponent(absolute(path))}&parents=true`;
    await this.whenRunning(() => this.p.request("PUT", `${this.path}/files${q}`, { body: toBytes(content), timeoutMs: 30 * 60_000 }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const q = `?path=${encodeURIComponent(absolute(path))}`;
    const res = await this.whenRunning(() => this.p.request("GET", `${this.path}/files/content${q}`, { timeoutMs: 30 * 60_000 }));
    return new Uint8Array(await res.arrayBuffer());
  }

  async pause(): Promise<void> {
    const op = await this.p.json<Operation>("POST", `${this.path}/suspend`, {}, { idempotent: true });
    await this.p.waitOperation(op, `pause of ${this.nativeId}`);
  }

  async kill(): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await this.p.request("DELETE", this.path, { idempotent: true, headers: { "X-Confirm-Delete": this.nativeId } });
        return;
      } catch (err) {
        if (err instanceof InstaboxError && err.status === 404) return; // already gone
        // A start or pause in progress blocks the delete until it ends.
        if (!(err instanceof InstaboxError && err.code === "operation_conflict" && Date.now() < deadline)) throw err;
        await sleep(1000);
      }
    }
  }
}

/** The files API takes absolute paths; relative ones are under HOME, where exec starts. */
function absolute(path: string): string {
  return path.startsWith("/") ? path : `${HOME}/${path.replace(/^\.\//, "")}`;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
