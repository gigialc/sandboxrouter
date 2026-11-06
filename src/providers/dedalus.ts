import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes } from "../util.js";

/**
 * Dedalus Machines (Dedalus Labs, YC S25) over plain REST. Persistent Linux microVMs that sleep
 * when idle and bill compute only while awake. The Machines API was in private beta when this was
 * written: an org that has not been admitted gets a 403.
 *
 * https://dcs.dedaluslabs.ai, Authorization: Bearer <DEDALUS_API_KEY> (dsk_...):
 *   POST   /v1/machines {vcpu, memory_mib, storage_gib, autosleep}   -> {machine_id, phase, ...}
 *   GET    /v1/machines/:id         -> {machine_id, desired_state, status:{phase, reason, last_error}}
 *   POST   /v1/machines/:id/sleep, POST /v1/machines/:id/wake, DELETE /v1/machines/:id
 *   POST   /v1/machines/:id/executions {command:[argv], cwd, env, stdin, timeout_ms}
 *                                   -> {execution_id, status}
 *   GET    /v1/machines/:id/executions/:eid          -> {status, exit_code, signal, error_code, error_message}
 *   GET    /v1/machines/:id/executions/:eid/events?cursor=  -> {items:[{type, chunk, status, exit_code}], next_cursor}
 *   GET    /v1/machines/:id/executions/:eid/output   -> {stdout, stderr, stdout_truncated, stderr_truncated}
 * Execution status: wake_in_progress, queued, running, succeeded, failed, cancelled, expired.
 * Machine phase: accepted, placement_pending, starting, running, stopping, sleeping, destroying,
 * destroyed, failed. Errors are {error_code, message, retryable} or problem+json {title, detail}.
 * There is no file API, so files move through an execution's stdin and stdout as base64.
 * There is no image choice: every machine is the same Linux base.
 * Docs: https://docs.dedaluslabs.ai/dcs/dm/quickstart, https://docs.dedaluslabs.ai/dcs/dm/lifecycle,
 *       https://docs.dedaluslabs.ai/dcs/dm/executions, https://docs.dedaluslabs.ai/dcs/dm/pricing,
 *       https://docs.dedaluslabs.ai/dcs-openapi.json
 */
const ID = "dedalus" as const;
const READY_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 250;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
/** The API returns at most this much of each stream inline from /output; longer output is flagged truncated. */
const OUTPUT_CAP = 64 * 1024;
/** Raw bytes per readFile chunk: base64 with line breaks (45 KiB -> about 61 KiB) stays under OUTPUT_CAP. */
const READ_CHUNK = 45 * 1024;

interface Machine {
  machine_id?: string;
  phase?: string;
  desired_state?: string;
  status?: { phase?: string; reason?: string; last_error?: string };
}

interface Execution {
  execution_id?: string;
  status?: string;
  exit_code?: number;
  signal?: number;
  error_code?: string;
  error_message?: string;
}

export class DedalusProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.DEDALUS_API_KEY,
    private baseUrl = process.env.DEDALUS_MACHINES_URL ?? "https://dcs.dedaluslabs.ai",
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async api<T>(method: string, path: string, json?: unknown): Promise<T> {
    if (!this.apiKey) throw new ProviderError(ID, "DEDALUS_API_KEY is not set");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j?.message ? `${j.error_code ? `${j.error_code}: ` : ""}${j.message}` : (j?.detail ?? j?.title ?? detail);
      } catch {
        /* plain-text body */
      }
      throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const minutes = spec.timeoutMinutes ?? 30;
    const m = await this.api<Machine>("POST", "/v1/machines", {
      vcpu: spec.vcpu ?? 2,
      memory_mib: Math.round((spec.memoryGb ?? 4) * 1024),
      storage_gib: 10,
      // Sleep (compute billing stops, disk kept) once idle for the requested lifetime.
      autosleep: `${Math.max(60, Math.round(minutes * 60))}s`,
    });
    if (!m.machine_id) throw new ProviderError(ID, "create returned no machine_id");
    const box = new DedalusBox(this, m.machine_id, spec.env ?? {});
    try {
      await box.waitRunning();
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new DedalusBox(this, nativeId, {});
    await box.waitRunning();
    return box;
  }
}

class DedalusBox implements ProviderSandbox {
  constructor(
    private p: DedalusProvider,
    readonly nativeId: string,
    private env: Record<string, string>,
  ) {}

  private get path() {
    return `/v1/machines/${encodeURIComponent(this.nativeId)}`;
  }

  /** Poll until the machine runs, waking it if it sleeps. */
  async waitRunning(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let woke = false;
    for (;;) {
      const m = await this.p.api<Machine>("GET", this.path);
      const phase = m.status?.phase ?? m.phase ?? "";
      if (phase === "running") return;
      if (phase === "failed" || phase === "destroyed" || phase === "destroying") {
        const why = m.status?.last_error || m.status?.reason;
        throw new ProviderError(ID, `machine ${this.nativeId} is ${phase}${why ? `: ${why}` : ""}`, phase === "failed" ? undefined : 404);
      }
      if (phase === "sleeping" && !woke) {
        await this.p.api("POST", `${this.path}/wake`);
        woke = true;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `machine ${this.nativeId} not running after ${READY_TIMEOUT_MS / 1000}s (${phase || "unknown"})`);
      await sleep(POLL_MS);
    }
  }

  /** Run argv to completion, streaming stdout/stderr from the events feed. */
  private async run(
    command: string[],
    opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutSeconds?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void },
  ): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const env = { ...this.env, ...opts.env };
    const created = await this.p.api<Execution>("POST", `${this.path}/executions`, {
      command,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeout_ms: secs * 1000,
    });
    const eid = created.execution_id;
    if (!eid) throw new ProviderError(ID, "create execution returned no execution_id");
    const ex = `${this.path}/executions/${encodeURIComponent(eid)}`;
    // A wake can sit in front of the command, so allow extra time before giving up locally.
    const deadline = t0 + secs * 1000 + 30_000;
    let status = created.status ?? "";
    const streaming = !!(opts.onStdout || opts.onStderr);
    // Everything the events feed delivered so far, kept so output past the /output cap is still complete.
    let eventsOut = "";
    let eventsErr = "";
    let cursor: string | undefined;
    // A page may come back without next_cursor (it is optional); the next drain then re-reads the
    // same page, so remember how many of its items were already consumed.
    let consumedAtCursor = 0;
    /** Read every events page from the cursor on, passing output chunks to the callbacks. */
    const drain = async () => {
      for (;;) {
        const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const page = await this.p.api<{ items?: { type?: string; chunk?: string; status?: string }[] | null; next_cursor?: string }>("GET", `${ex}/events${q}`);
        const items = (page.items ?? []).slice(consumedAtCursor);
        for (const e of items) {
          if (e.type === "stdout" && e.chunk) (eventsOut += e.chunk), opts.onStdout?.(e.chunk);
          else if (e.type === "stderr" && e.chunk) (eventsErr += e.chunk), opts.onStderr?.(e.chunk);
          else if (e.type === "lifecycle" && e.status) status = e.status;
        }
        const next = page.next_cursor;
        if (!next || next === cursor) {
          consumedAtCursor += items.length;
          return;
        }
        cursor = next;
        consumedAtCursor = 0;
        if (!items.length) return;
      }
    };
    while (!TERMINAL.has(status)) {
      if (Date.now() > deadline) {
        await this.p.api("DELETE", ex).catch(() => {});
        throw new ProviderError(ID, `command timed out after ${secs}s`);
      }
      await sleep(POLL_MS);
      if (streaming) await drain();
      if (!TERMINAL.has(status)) status = (await this.p.api<Execution>("GET", ex)).status ?? status;
    }
    const final = await this.p.api<Execution>("GET", ex);
    // Deliver anything written between the last events page and the end.
    if (streaming) await drain();
    const durationMs = Date.now() - t0;
    const why = `${final.error_code ?? ""} ${final.error_message ?? ""}`;
    if (final.status === "expired" || /timeout|timed out|deadline/i.test(why) || (final.signal && durationMs >= secs * 1000)) {
      throw new ProviderError(ID, `command timed out after ${secs}s`);
    }
    if (final.exit_code === undefined || final.exit_code === null) {
      throw new ProviderError(ID, `command ${final.status ?? "ended"} without an exit code${why.trim() ? `: ${why.trim()}` : ""}`);
    }
    const out = await this.p.api<{ stdout?: string; stderr?: string; stdout_truncated?: boolean; stderr_truncated?: boolean }>("GET", `${ex}/output`);
    if (!out.stdout_truncated && !out.stderr_truncated) return { exitCode: final.exit_code, stdout: out.stdout ?? "", stderr: out.stderr ?? "", durationMs };
    // /output cut a stream at OUTPUT_CAP: the events feed has all of it.
    if (!streaming) await drain();
    return { exitCode: final.exit_code, stdout: eventsOut, stderr: eventsErr, durationMs };
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.run(["/bin/sh", "-c", cmd], opts);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    const r = await this.run(["/bin/sh", "-c", `mkdir -p ${shq(dirname(path))} && base64 -d > ${shq(path)}`], { stdin: b64, timeoutSeconds: 120 });
    if (r.exitCode !== 0) throw new ProviderError(ID, `write ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const size = await this.run(["/bin/sh", "-c", `wc -c < ${shq(path)}`], {});
    if (size.exitCode !== 0) throw new ProviderError(ID, `read ${path}: ${size.stderr.trim() || "no such file"}`, 404);
    const total = Number(size.stdout.trim());
    const parts: Buffer[] = [];
    for (let off = 0; off < total; off += READ_CHUNK) {
      const r = await this.run(["/bin/sh", "-c", `tail -c +${off + 1} ${shq(path)} | head -c ${READ_CHUNK} | base64`], { timeoutSeconds: 120 });
      if (r.exitCode !== 0) throw new ProviderError(ID, `read ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      parts.push(Buffer.from(r.stdout.replace(/\s+/g, ""), "base64"));
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  async pause(): Promise<void> {
    await this.p.api("POST", `${this.path}/sleep`);
  }

  async kill(): Promise<void> {
    await this.p.api("DELETE", `${this.path}?force=true`);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
