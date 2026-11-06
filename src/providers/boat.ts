import { BOAT_SIZES } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, dirname, killedByTimeout, shq, timeoutError, toBytes, wrapCommand } from "../util.js";

/**
 * Boat (boat.dev) over plain REST. One host, one key: Authorization: Bearer boat_... (BOAT_API_KEY).
 *   POST   /sandboxes                         create (202, state "provisioning"); poll GET until ready
 *   GET    /sandboxes/{id}                    state: provisioning ... ready | idle | running | archived | error | cancelled
 *   POST   /sandboxes/{id}/commands           {command, timeoutSeconds<=600, stream}; stream: true answers NDJSON frames
 *   GET|PUT /sandboxes/{id}/files             JSON {path, content, encoding: base64}; 5 MiB; only under /home/user or /tmp
 *   POST   /sandboxes/{id}/files/folder       mkdir -p
 *   POST   /sandboxes/{id}/stop | /resume     stop keeps the disk as a snapshot; resume boots it again
 *   DELETE /sandboxes/{id}                    permanent; needs X-Ascii-Confirm-Delete: {id}
 * Docs: https://docs.boat.dev/llms.txt
 * API reference (OpenAPI 3.1): https://boat.dev/openapi.yaml  (server https://boat.dev/api/v1)
 * Sizes/pricing: https://docs.boat.dev/machines.md, https://docs.boat.dev/pricing.md
 * Limits: https://docs.boat.dev/limits.md
 */
const ID = "boat" as const;

export class BoatProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.BOAT_API_KEY,
    private baseUrl = process.env.BOAT_API_URL ?? "https://boat.dev/api/v1",
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async request(method: string, path: string, init: { json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!this.apiKey) throw new ProviderError(this.id, "BOAT_API_KEY is not set");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...init.headers };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      let code: string | undefined;
      try {
        // ErrorEnvelope: {ok:false, status, code, message, requestId, error:{code,message,status}}
        const j = JSON.parse(text);
        code = j?.code ?? j?.error?.code;
        const message = j?.message ?? j?.error?.message ?? "";
        if (code) detail = `${code}: ${message}`;
      } catch {
        /* non-JSON body */
      }
      throw new BoatError(`${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status, code);
    }
    return res;
  }

  /** @internal */
  async json<T>(method: string, path: string, json?: unknown, headers?: Record<string, string>): Promise<T> {
    const text = await (await this.request(method, path, { json, headers })).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** @internal Poll until the sandbox can take commands. Resumes it first when it is stopped. */
  async ready(id: string, timeoutMs = 300_000): Promise<BoatSandboxObject> {
    const deadline = Date.now() + timeoutMs;
    let resumed = false;
    for (;;) {
      const { sandbox } = await this.json<{ sandbox: BoatSandboxObject }>("GET", `/sandboxes/${encodeURIComponent(id)}`);
      const state = sandbox.state;
      if (READY.has(state)) return sandbox;
      if (state === "error" || state === "cancelled") {
        throw new ProviderError(this.id, `sandbox ${id} is ${state}${sandbox.error ? `: ${sandbox.error}` : ""}`);
      }
      if (STOPPED.has(state) && !resumed) {
        await this.json("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, {});
        resumed = true;
      }
      if (Date.now() > deadline) throw new ProviderError(this.id, `sandbox ${id} not ready after ${timeoutMs / 1000}s (state: ${state})`);
      await sleep(1000);
    }
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const body: Record<string, unknown> = {
      type: machineType(spec.vcpu ?? 2, spec.memoryGb ?? 4),
      // Auto-stop (archive) after the router's hard lifetime. Max 30 days.
      ttlSeconds: Math.min(2_592_000, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60))),
    };
    const from = spec.image?.boat;
    if (from) body.from = from; // a saved snapshot name or share code
    if (spec.env) body.env = spec.env;
    if (spec.metadata) body.labels = spec.metadata;
    const created = await this.json<{ sandbox: BoatSandboxObject }>("POST", "/sandboxes", body);
    const id = created.sandbox.id;
    try {
      await this.ready(id);
    } catch (err) {
      await this.request("DELETE", `/sandboxes/${encodeURIComponent(id)}`, { headers: { "X-Ascii-Confirm-Delete": id } }).catch(() => {});
      throw err;
    }
    return new BoatSandbox(this, id);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    await this.ready(nativeId);
    return new BoatSandbox(this, nativeId);
  }
}

class BoatError extends ProviderError {
  constructor(
    message: string,
    status?: number,
    readonly code?: string,
  ) {
    super(ID, message, status);
  }
}

const READY = new Set(["ready", "idle", "running"]);
const STOPPED = new Set(["archived", "stopped"]);

/** Boat has four fixed sizes (catalog.ts). Pick the smallest that covers the request. */
function machineType(vcpu: number, memoryGb: number): string {
  const fit = BOAT_SIZES.find((s) => s.vcpu >= vcpu && s.memoryGb >= memoryGb);
  if (!fit) throw new ProviderError(ID, `no Boat size has ${vcpu} vCPU / ${memoryGb} GB (max xlarge: 16 vCPU / 32 GB)`);
  return fit.type;
}

interface BoatSandboxObject {
  id: string;
  state: string;
  error?: string | null;
}

interface BoatCommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface BoatStreamFrame {
  type: "started" | "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
  message?: string;
}

/** The files API only reaches these two trees; anything else goes through a command with sudo. */
function filesApiPath(path: string): boolean {
  if (!path.startsWith("/")) return !path.split("/").includes("..");
  return /^\/(home\/user|tmp)(\/|$)/.test(path) && !path.split("/").includes("..");
}

class BoatSandbox implements ProviderSandbox {
  private base: string;

  constructor(
    private p: BoatProvider,
    readonly nativeId: string,
  ) {
    this.base = `/sandboxes/${encodeURIComponent(nativeId)}`;
  }

  /** Data call; when the sandbox is stopped (409 sandbox_not_ready) or still starting, wait/resume once and retry. */
  private async call(method: string, path: string, json?: unknown): Promise<Response> {
    try {
      return await this.p.request(method, `${this.base}${path}`, { json });
    } catch (err) {
      if (!(err instanceof BoatError && err.status === 409 && (err.code === "sandbox_not_ready" || err.code === "boat_starting"))) throw err;
      await this.p.ready(this.nativeId);
      return this.p.request(method, `${this.base}${path}`, { json });
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const streaming = !!(opts.onStdout || opts.onStderr);
    // Boat caps a command at 600 s; it stops the command at the deadline and flags it as timedOut.
    const seconds = Math.min(600, Math.max(1, Math.round(opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S)));
    const res = await this.call("POST", "/commands", {
      command: wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }),
      timeoutSeconds: seconds,
      stream: streaming,
    });

    let result: BoatCommandResult;
    if (streaming && res.headers.get("content-type")?.includes("ndjson")) {
      let stdout = "";
      let stderr = "";
      let exit: BoatStreamFrame | undefined;
      for await (const line of readLines(res)) {
        const frame = JSON.parse(line) as BoatStreamFrame;
        if (frame.type === "stdout") {
          stdout += frame.data ?? "";
          opts.onStdout?.(frame.data ?? "");
        } else if (frame.type === "stderr") {
          stderr += frame.data ?? "";
          opts.onStderr?.(frame.data ?? "");
        } else if (frame.type === "exit") exit = frame;
        else if (frame.type === "error") throw new ProviderError(ID, `${frame.error ?? "error"}: ${frame.message ?? ""}`);
      }
      if (!exit) throw new ProviderError(ID, "output stream closed before the command finished");
      result = { exitCode: exit.exitCode ?? null, stdout, stderr, timedOut: exit.timedOut };
    } else {
      result = (await res.json()) as BoatCommandResult;
      if (result.stdout) opts.onStdout?.(result.stdout);
      if (result.stderr) opts.onStderr?.(result.stderr);
    }
    const durationMs = Date.now() - t0;
    if (result.timedOut || killedByTimeout(result.exitCode ?? -1, durationMs, seconds)) throw timeoutError(ID, seconds);
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", durationMs };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    if (filesApiPath(path)) {
      const dir = dirname(path);
      if (path.includes("/") && !/^\/(home\/user|tmp)$/.test(dir)) await this.call("POST", "/files/folder", { path: dir });
      await this.call("PUT", "/files", { path, content: b64, encoding: "base64" });
      return;
    }
    // Outside /home/user and /tmp: passwordless sudo through a command.
    const r = await this.exec(
      `sudo mkdir -p ${shq(dirname(path))} && printf %s ${shq(b64)} | base64 -d | sudo tee ${shq(path)} > /dev/null`,
    );
    if (r.exitCode !== 0) throw new ProviderError(ID, `writeFile ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    if (filesApiPath(path)) {
      const res = await this.call("GET", `/files?path=${encodeURIComponent(path)}&encoding=base64`);
      const j = (await res.json()) as { content: string; encoding?: string };
      return j.encoding === "utf8" ? new TextEncoder().encode(j.content) : new Uint8Array(Buffer.from(j.content, "base64"));
    }
    const r = await this.exec(`sudo base64 -w0 ${shq(path)}`);
    if (r.exitCode !== 0) throw new ProviderError(ID, `readFile ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  /** Stop: the disk is kept as a snapshot (>= 14 days), running processes end. connect() or the next call resumes it. */
  async pause(): Promise<void> {
    await this.p.request("POST", `${this.base}/stop`, { json: {} });
  }

  async kill(): Promise<void> {
    await this.p.request("DELETE", this.base, { headers: { "X-Ascii-Confirm-Delete": this.nativeId } });
  }
}

/** Newline-delimited JSON reader for a fetch Response. */
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
