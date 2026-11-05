import { randomBytes } from "node:crypto";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU, UPSTASH_SIZES, upstashSize } from "../catalog.js";
export { UPSTASH_SIZES, upstashSize };
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * Upstash Box over plain HTTPS (no SDK). Each sandbox is an *ephemeral* box: exec + files only,
 * ready on the create response (no polling), deleted automatically after `ttl` seconds.
 *
 * Upstash documents the Box API through its SDKs (`@upstash/box`, `upstash-box`). The ephemeral
 * create body is documented; the other routes and field names below are the ones the official
 * TypeScript SDK (@upstash/box 0.7.10, MIT) sends, so they are not invented but are not in the
 * public docs either.
 *   base     https://us-east-1.box.upstash.com (UPSTASH_BOX_BASE_URL), header X-Box-Api-Key
 *   POST   /v2/box                    {ephemeral:true, ttl, size, runtime?, env_vars?}  (documented)
 *   GET    /v2/box/{id}               box data ({id, status, size, expires_at, ...})
 *   POST   /v2/box/{id}/exec          {command:["sh","-c",cmd]} -> {output, error, exit_code}
 *   POST   /v2/box/{id}/exec-stream   same body; raw output, then "event: exit\ndata: {exit_code}"
 *                                     (or "event: error\ndata: {error}")
 *   GET    /v2/box/{id}/files/read?path=P&encoding=base64 -> {content}
 *   POST   /v2/box/{id}/files/write   {path, content, encoding:"base64"}
 *   DELETE /v2/box/{id}
 *   errors: JSON {error: "..."} with the HTTP status
 * Sizes are fixed: small 2 vCPU / 4 GB, medium 4 / 8, large 8 / 16; the smallest that fits the
 * spec is used. TTL max 259 200 s (3 days). image.upstash = runtime: node, python, golang, ruby,
 * rust or their -alpine variants (Debian by default); custom images are "coming soon".
 * No pause: ephemeral boxes don't expose it (an idle one is auto-paused by Upstash and resumed by
 * the next exec or file call). Commands get no per-request timeout from the API, so they run
 * under `timeout`, as the docs recommend.
 * exec-stream does not say whether stderr is included or how, so streaming commands send stderr to
 * a temp file and deliver it (onStderr) once the command ends; stdout streams live.
 * Pricing: active CPU only (memory free), see https://upstash.com/pricing/box.
 *
 * Docs: https://upstash.com/docs/box/overall/ephemeral-box.md
 *       https://upstash.com/docs/box/overall/how-it-works.md (sizes, lifecycle, runtimes)
 *       https://upstash.com/docs/box/overall/shell.md
 *       https://upstash.com/docs/box/overall/files.md
 *       https://upstash.com/docs/box/overall/quickstart.md (UPSTASH_BOX_API_KEY)
 *       https://upstash.com/pricing/box.md
 *       https://github.com/upstash/box (SDK source the routes above come from)
 */
const ID = "upstash" as const;


const MAX_TTL_SECONDS = 259_200;
const RUNTIME = /^(node|python|golang|ruby|rust)(-alpine)?$/;

interface BoxData {
  id: string;
  status?: string;
  size?: string;
  expires_at?: number;
}


export class UpstashProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.UPSTASH_BOX_API_KEY,
    private baseUrl = (process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com").replace(/\/$/, ""),
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal One API call; JSON in and out. Non-2xx becomes a ProviderError with the status. */
  async request(method: string, path: string, body?: unknown, timeoutMs = 600_000, raw = false): Promise<any> {
    if (!this.apiKey) throw new ProviderError(ID, "UPSTASH_BOX_API_KEY is not set");
    const headers: Record<string, string> = { "X-Box-Api-Key": this.apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      const what = err?.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : (err?.message ?? String(err));
      throw new ProviderError(ID, `${method} ${path.split("?")[0]}: ${what}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300) || res.statusText;
      try {
        const j = JSON.parse(text);
        if (typeof j?.error === "string") detail = j.error;
      } catch {
        /* not JSON */
      }
      throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { size } = upstashSize(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB);
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)));
    const body: Record<string, unknown> = { ephemeral: true, ttl, size };
    const runtime = spec.image?.upstash;
    if (runtime) {
      if (!RUNTIME.test(runtime)) throw new ProviderError(ID, `unknown runtime "${runtime}" (node, python, golang, ruby, rust, optionally -alpine)`);
      body.runtime = runtime;
    }
    if (spec.env && Object.keys(spec.env).length) body.env_vars = spec.env;
    const data = (await this.request("POST", "/v2/box", body)) as BoxData;
    if (!data?.id) throw new ProviderError(ID, "create returned no box id");
    if (data.status === "error") throw new ProviderError(ID, `box ${data.id} failed to start`);
    return new UpstashBox(this, data.id);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const data = (await this.request("GET", `/v2/box/${encodeURIComponent(nativeId)}`)) as BoxData;
    if (data.status === "deleted" || data.status === "error") throw new ProviderError(ID, `box ${nativeId} is ${data.status}`, 404);
    return new UpstashBox(this, data.id ?? nativeId);
  }
}

class UpstashBox implements ProviderSandbox {
  constructor(
    private p: UpstashProvider,
    readonly nativeId: string,
  ) {}

  private get base() {
    return `/v2/box/${encodeURIComponent(this.nativeId)}`;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = Math.max(1, Math.round(opts.timeoutSeconds ?? 60));
    const script = shq(wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }));
    const guarded = `if command -v timeout >/dev/null 2>&1; then timeout ${secs} sh -c ${script}; else sh -c ${script}; fi`;
    const requestMs = (secs + 30) * 1000;
    let r: ExecResult;
    if (opts.onStdout || opts.onStderr) {
      r = await this.stream(guarded, requestMs, opts, t0);
    } else {
      const j = await this.p.request("POST", `${this.base}/exec`, { command: ["sh", "-c", guarded] }, requestMs);
      r = { exitCode: Number(j.exit_code ?? 0), stdout: j.output ?? "", stderr: j.error ?? "", durationMs: Date.now() - t0 };
    }
    if (r.exitCode === 124 && r.durationMs >= secs * 1000) throw new ProviderError(ID, `command timed out after ${secs}s`);
    return r;
  }

  /** exec-stream with stderr parked in a temp file, so the stream carries stdout only. */
  private async stream(guarded: string, requestMs: number, opts: ExecOptions, t0: number): Promise<ExecResult> {
    const errFile = `/tmp/.sbr-err-${randomBytes(6).toString("hex")}`;
    const res: Response = await this.p.request(
      "POST",
      `${this.base}/exec-stream`,
      { command: ["sh", "-c", `{ ${guarded} ; } 2>${errFile}`] },
      requestMs,
      true,
    );
    let stdout = "";
    let exitCode: number | undefined;
    for await (const ev of parseExecStream(res)) {
      if (ev.type === "output") {
        stdout += ev.data;
        opts.onStdout?.(ev.data);
      } else if (ev.type === "error") {
        throw new ProviderError(ID, `exec-stream: ${ev.message}`);
      } else {
        exitCode = ev.exitCode;
      }
    }
    if (exitCode === undefined) throw new ProviderError(ID, "exec-stream ended without an exit code");
    const e = await this.p.request("POST", `${this.base}/exec`, { command: ["sh", "-c", `cat ${errFile} 2>/dev/null; rm -f ${errFile}`] });
    const stderr: string = e.output ?? "";
    if (stderr) opts.onStderr?.(stderr);
    return { exitCode, stdout, stderr, durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const parent = dirname(path);
    if (parent !== "/") {
      const m = await this.p.request("POST", `${this.base}/exec`, { command: ["mkdir", "-p", parent] });
      if (Number(m.exit_code ?? 0) !== 0) throw new ProviderError(ID, `writeFile ${path}: ${m.error || m.output || `mkdir exit ${m.exit_code}`}`);
    }
    await this.p.request("POST", `${this.base}/files/write`, {
      path,
      content: Buffer.from(toBytes(content)).toString("base64"),
      encoding: "base64",
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const j = await this.p.request("GET", `${this.base}/files/read?path=${encodeURIComponent(path)}&encoding=base64`);
    if (typeof j?.content !== "string") throw new ProviderError(ID, `readFile ${path}: no content in response`);
    return new Uint8Array(Buffer.from(j.content, "base64"));
  }

  async kill(): Promise<void> {
    await this.p.request("DELETE", this.base);
  }
}

type StreamEvent = { type: "output"; data: string } | { type: "exit"; exitCode: number } | { type: "error"; message: string };

const EXIT = "event: exit\n";
const ERROR = "event: error\n";

/** Longest tail of `buf` that could be the start of an event marker split across reads. */
function heldBack(buf: string): number {
  for (let n = Math.min(buf.length, EXIT.length - 1); n > 0; n--) {
    const tail = buf.slice(-n);
    if (EXIT.startsWith(tail) || ERROR.startsWith(tail)) return n;
  }
  return 0;
}

/**
 * The exec-stream body as the official SDK reads it: raw output text, then a trailing SSE event
 * `event: exit\ndata: {"exit_code":N,...}` (or `event: error\ndata: {"error":"..."}`).
 * @internal exported for tests
 */
export async function* parseExecStream(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) throw new ProviderError(ID, "exec-stream response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buf += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
    for (const marker of [ERROR, EXIT]) {
      const i = buf.indexOf(marker);
      if (i === -1) continue;
      if (i > 0) yield { type: "output", data: buf.slice(0, i) };
      buf = buf.slice(i);
      const m = buf.slice(marker.length).match(/^data:\s*(.+?)\r?(\n|$)/);
      // Wait for the whole data line (it can arrive in a later read).
      if (!m || (!m[2] && !done)) break;
      let payload: any = {};
      try {
        payload = JSON.parse(m[1]);
      } catch {
        /* keep defaults */
      }
      await reader.cancel().catch(() => {});
      if (marker === ERROR) yield { type: "error", message: typeof payload.error === "string" ? payload.error : "stream error" };
      else yield { type: "exit", exitCode: Number(payload.exit_code ?? 0) };
      return;
    }
    if (buf.includes(EXIT) || buf.includes(ERROR)) continue;
    const keep = done ? 0 : heldBack(buf);
    if (buf.length > keep) {
      yield { type: "output", data: buf.slice(0, buf.length - keep) };
      buf = buf.slice(buf.length - keep);
    }
  }
}
