import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * Agent37 (YC F26) instances over plain REST. gVisor containers that bill per minute while
 * running and only for disk while asleep. Fixed shapes, at most 4 vCPU. The workspace wallet is
 * prepaid, and create needs one day of the instance's running cost in it (402 otherwise).
 *
 * https://api.agent37.com, Authorization: Bearer <AGENT37_API_KEY> (sk_live_...):
 *   POST   /v1/instances {template, resources:{cpu, memory}, auto_sleep, idle_timeout_seconds, env, metadata}
 *                        201 with the instance once status is "running"
 *   GET    /v1/instances/:id           -> {id, status, status_reason, url, ...}
 *   POST   /v1/instances/:id/start, POST /v1/instances/:id/sleep, DELETE /v1/instances/:id
 *   POST   /v1/instances/:id/exec {command}   -> {exit_code, stdout, stderr, truncated}
 *          command runs under sh -c; body max 128 KB; stdout and stderr capped at 512 KB each;
 *          the call waits up to 780 s and the command keeps running if the call gives up.
 * Status: provisioning, running, stopping, stopped, starting, restarting, updating, sleeping,
 * waking, failed, deleting, deleted. Errors are {error:{code, message}}.
 * The files endpoints live on agent templates only, not agent37-base, so files go through exec as
 * base64, in chunks that fit the request and output caps. exec has no cwd/env/timeout fields, so
 * those are added to the shell command. No streaming: output arrives when the command ends.
 * Docs: https://www.agent37.com/docs/agents-api/overview, .../instances/create, .../exec,
 *       .../instance-sizing, .../instances/sleep, .../instances/object
 */
const ID = "agent37" as const;
const READY_TIMEOUT_MS = 5 * 60_000;
/** Base64 characters per write request, under the 128 KB body cap. */
const WRITE_CHUNK_B64 = 96 * 1024;
/** Raw bytes per read request; base64 of this stays under the 512 KB stdout cap. */
const READ_CHUNK = 256 * 1024;

/** Default-type shapes from https://www.agent37.com/docs/agents-api/instance-sizing (2026-11-05). */
export const AGENT37_SHAPES = [
  // usdHour = (monthly price at default disk - disk at $0.09/GB-month) / 730 h
  { vcpu: 2, memoryGb: 4, diskGb: 4, usdMonth: 4.76, usdHour: 4.4 / 730 },
  { vcpu: 4, memoryGb: 8, diskGb: 6, usdMonth: 9.34, usdHour: 8.8 / 730 },
  { vcpu: 4, memoryGb: 16, diskGb: 12, usdMonth: 15.48, usdHour: 14.4 / 730 },
  { vcpu: 4, memoryGb: 32, diskGb: 24, usdMonth: 27.76, usdHour: 25.6 / 730 },
] as const;

/** Smallest shape with at least this much CPU and memory, or undefined. */
export function agent37Shape(vcpu: number, memoryGb: number): (typeof AGENT37_SHAPES)[number] | undefined {
  return AGENT37_SHAPES.find((s) => s.vcpu >= vcpu && s.memoryGb >= memoryGb);
}

interface Instance {
  id?: string;
  status?: string;
  status_reason?: string;
}

export class Agent37Provider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.AGENT37_API_KEY,
    private baseUrl = process.env.AGENT37_API_URL ?? "https://api.agent37.com",
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async api<T>(method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.apiKey) throw new ProviderError(ID, "AGENT37_API_KEY is not set");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        const e = j?.error;
        detail = typeof e === "string" ? e : e?.code ? `${e.code}${e.message ? `: ${e.message}` : ""}` : (j?.message ?? detail);
      } catch {
        /* plain-text body */
      }
      throw new ProviderError(ID, `${method} ${path} -> ${res.status} ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const vcpu = spec.vcpu ?? 2;
    const memoryGb = spec.memoryGb ?? 4;
    const shape = agent37Shape(vcpu, memoryGb);
    if (!shape) throw new ProviderError(ID, `no Agent37 shape has ${vcpu} vCPU / ${memoryGb} GB (max 4 vCPU / 32 GB)`);
    const idle = Math.min(86_400, Math.max(300, Math.round((spec.timeoutMinutes ?? 30) * 60)));
    const inst = await this.api<Instance>("POST", "/v1/instances", {
      template: spec.image?.agent37 ?? "agent37-base",
      resources: { cpu: shape.vcpu, memory: shape.memoryGb },
      // Sleep (disk-only billing) once idle for the requested lifetime, so a leaked box stops costing compute.
      auto_sleep: true,
      idle_timeout_seconds: idle,
      ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    });
    if (!inst.id) throw new ProviderError(ID, "create returned no id");
    const box = new Agent37Box(this, inst.id);
    try {
      if (inst.status !== "running") await box.waitRunning();
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new Agent37Box(this, nativeId);
    await box.waitRunning();
    return box;
  }
}

class Agent37Box implements ProviderSandbox {
  constructor(
    private p: Agent37Provider,
    readonly nativeId: string,
  ) {}

  private get path() {
    return `/v1/instances/${encodeURIComponent(this.nativeId)}`;
  }

  /** Poll until running, starting the instance if it sleeps or is stopped. */
  async waitRunning(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let started = false;
    for (;;) {
      const inst = await this.p.api<Instance>("GET", this.path);
      const status = inst.status ?? "";
      if (status === "running") return;
      if (status === "failed" || status === "deleting" || status === "deleted") {
        throw new ProviderError(ID, `instance ${this.nativeId} is ${status}${inst.status_reason ? `: ${inst.status_reason}` : ""}`, status === "failed" ? undefined : 404);
      }
      if ((status === "sleeping" || status === "stopped") && !started) {
        await this.p.api("POST", `${this.path}/start`);
        started = true;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `instance ${this.nativeId} not running after ${READY_TIMEOUT_MS / 1000}s (${status || "unknown"})`);
      await sleep(500);
    }
  }

  private async call(command: string, waitSeconds: number): Promise<{ exit_code?: number; stdout?: string; stderr?: string }> {
    const send = () => this.p.api<{ exit_code?: number; stdout?: string; stderr?: string }>("POST", `${this.path}/exec`, { command }, AbortSignal.timeout(waitSeconds * 1000));
    try {
      return await send();
    } catch (err) {
      // A sleeping instance may refuse exec until started.
      if (err instanceof ProviderError && err.status === 400 && /sleep|stopp/i.test(err.message)) {
        await this.waitRunning();
        return send();
      }
      throw err;
    }
  }

  /** The exec API has no timeout field, so the command runs under `timeout` when the image has it. */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const inner = wrapCommand(cmd, { cwd: opts.cwd, env: opts.env });
    const guarded = `if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 ${secs} /bin/sh -c ${shq(inner)}; else exec /bin/sh -c ${shq(inner)}; fi`;
    let r: { exit_code?: number; stdout?: string; stderr?: string };
    try {
      r = await this.call(guarded, Math.min(secs + 20, 780));
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError") throw new ProviderError(ID, `command timed out after ${secs}s`);
      throw err;
    }
    const durationMs = Date.now() - t0;
    const exitCode = r.exit_code ?? -1;
    if (durationMs >= secs * 1000 && [124, 137, 143].includes(exitCode)) throw new ProviderError(ID, `command timed out after ${secs}s`);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { exitCode, stdout, stderr, durationMs };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    const tmp = `${path}.sbr-part`;
    let first = true;
    for (let i = 0; first || i < b64.length; i += WRITE_CHUNK_B64) {
      const part = b64.slice(i, i + WRITE_CHUNK_B64);
      const cmd = `${first ? `mkdir -p ${shq(dirname(path))} && ` : ""}printf %s ${shq(part)} | base64 -d ${first ? ">" : ">>"} ${shq(tmp)}`;
      const r = await this.call(cmd, 120);
      if (r.exit_code !== 0) throw new ProviderError(ID, `write ${path}: ${r.stderr?.trim() || `exit ${r.exit_code}`}`);
      first = false;
    }
    const r = await this.call(`mv -f ${shq(tmp)} ${shq(path)}`, 60);
    if (r.exit_code !== 0) throw new ProviderError(ID, `write ${path}: ${r.stderr?.trim() || `exit ${r.exit_code}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const size = await this.call(`wc -c < ${shq(path)}`, 60);
    if (size.exit_code !== 0) throw new ProviderError(ID, `read ${path}: ${size.stderr?.trim() || "no such file"}`, 404);
    const total = Number((size.stdout ?? "").trim());
    const parts: Buffer[] = [];
    for (let off = 0; off < total; off += READ_CHUNK) {
      const r = await this.call(`tail -c +${off + 1} ${shq(path)} | head -c ${READ_CHUNK} | base64`, 120);
      if (r.exit_code !== 0) throw new ProviderError(ID, `read ${path}: ${r.stderr?.trim() || `exit ${r.exit_code}`}`);
      parts.push(Buffer.from((r.stdout ?? "").replace(/\s+/g, ""), "base64"));
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  async pause(): Promise<void> {
    await this.p.api("POST", `${this.path}/sleep`);
  }

  async kill(): Promise<void> {
    await this.p.api("DELETE", this.path);
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
