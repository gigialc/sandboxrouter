import { randomUUID } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, guardTimeout, killedByTimeout, timeoutError, toBytes, wrapCommand } from "../util.js";

/**
 * Sail Research Sailboxes over the plain HTTPS API: persistent Linux VMs billed on observed
 * usage (CPU time, RAM held, disk), with pause (memory kept) and sleep (to disk).
 *
 * Header Authorization: Bearer <SAIL_API_KEY> on both hosts.
 *   POST https://api.sailresearch.com/v1/apps/find {name, mint_if_missing} -> {id}: every Sailbox
 *        belongs to an app; the adapter uses one named "sandboxrouter" (SAIL_APP overrides).
 * Sailbox API https://sailbox-api.sailresearch.com/v1:
 *   POST /sailboxes {app_id, name, image:{base}, vcpu_count, memory_limit_gib, env, max_lifetime_seconds}
 *        + Idempotency-Key -> {sailbox_id, status, error_message}. Blocks until the box is up; a box
 *        that can't come up still answers 200 with status failed/create_failed.
 *   GET  /sailboxes/:id -> {sailbox_id, status: creating|running|paused|sleeping|terminating|terminated|
 *        failed|create_failed|interrupted_restorable|interrupted_unsafe_to_retry} (an open set)
 *   POST /sailboxes/:id/exec {command, env, timeout} -> application/x-ndjson:
 *        {type:"started", exec_request_id} {type:"stdout"|"stderr", data:<base64>, seq} {type:"heartbeat"}
 *        {type:"exit", status, return_code} | {type:"error", error_code, message}.
 *        A string command runs under /bin/sh -lc. If the stream drops before exit,
 *        POST /exec/:exec_id/wait returns {status, return_code, timed_out}.
 *   POST /sailboxes/:id/exec/:exec_id/cancel {force}
 *   PUT  /sailboxes/:id/files?path=P&mode=420 (octet-stream, parents created) / GET ?path=P -> raw bytes
 *   POST /sailboxes/:id/pause | /resume -> {resume_state: running|already_running|terminal_unavailable}
 *   POST /sailboxes/:id/terminate (idempotent)
 * Errors are {error:{message, type, code}}. A paused Sailbox answers commands and files with 409
 * until it is resumed; a sleeping one wakes on its own.
 * Size: vcpu_count is 1 to 64 and memory_limit_gib 16 to 512, both limits rounded up to a power of
 * two by Sail. Billing is on what the box actually uses (CPU time, RAM held including page cache,
 * disk), not on the limits, so the adapter sets vCPUs to the request and memory to the request's
 * floor of 16 GiB.
 * Timeouts: at the exec `timeout` Sail ends the stream with {type:"exit", status:"timed_out",
 * return_code:124, timed_out:true} (seen on a real account 2026-11-06). Commands also run under
 * guardTimeout, which kills the whole command at the deadline, and Sail's own timeout sits 10 s later
 * as a backstop.
 * Lifetime: spec.timeoutMinutes becomes max_lifetime_seconds, which counts paused and sleeping time too.
 * Docs: https://docs.sailresearch.com/sailboxes-http-api.md, https://docs.sailresearch.com/sailbox-openapi.json,
 *       https://docs.sailresearch.com/sailboxes-billing.md, https://docs.sailresearch.com/sailboxes-pricing.md
 */
const ID = "sail" as const;
const MIN_MEMORY_LIMIT_GIB = 16;
const MAX_VCPU = 64;
const BASE_IMAGES: Record<string, string> = { debian: "BASE_IMAGE_DEBIAN", devbox: "BASE_IMAGE_DEVBOX" };
const READY_TIMEOUT_MS = 5 * 60_000;
const PAUSE_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 500;
/** Extra time past the command timeout before the client gives up on its own. */
const CLIENT_GRACE_MS = 30_000;
/** The API's own timeout sits past guardTimeout's (which kills at the deadline, SIGKILL 5 s later). */
const SERVER_TIMEOUT_EXTRA_S = 10;
const GONE = new Set(["terminating", "terminated", "failed", "create_failed", "interrupted_unsafe_to_retry"]);
const ASLEEP = new Set(["paused", "sleeping", "interrupted_restorable"]);

interface Status {
  sailbox_id?: string;
  status?: string;
  error_message?: string;
  resume_state?: string;
}

interface ExecEvent {
  type?: string;
  exec_request_id?: string;
  data?: string;
  status?: string;
  return_code?: number;
  timed_out?: boolean;
  error_code?: string;
  message?: string;
}

export class SailProvider implements Provider {
  readonly id = ID;
  /** @internal Sailbox API, with /v1. */
  readonly sailboxApi: string;
  /** @internal Main API (apps), with /v1. */
  readonly mainApi: string;
  private appId?: Promise<string>;

  /**
   * @param sailboxUrl Sailbox API (SAILBOX_API_URL, as the SDKs read it), default https://sailbox-api.sailresearch.com
   * @param apiUrl main API for apps (SAIL_API_URL), default https://api.sailresearch.com; defaults to
   *        sailboxUrl when only that is given, so one mock or proxy serves both
   * @param appName the app new Sailboxes go in (SAIL_APP), created if missing
   */
  constructor(
    private apiKey = process.env.SAIL_API_KEY,
    sailboxUrl = process.env.SAILBOX_API_URL,
    apiUrl = process.env.SAIL_API_URL,
    private appName = process.env.SAIL_APP || "sandboxrouter",
  ) {
    const v1 = (u: string) => `${u.trim().replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
    this.sailboxApi = v1(sailboxUrl?.trim() || "https://sailbox-api.sailresearch.com");
    this.mainApi = v1(apiUrl?.trim() || sailboxUrl?.trim() || "https://api.sailresearch.com");
  }

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal One request; throws a ProviderError carrying the HTTP status on failure. */
  async request(
    method: string,
    url: string,
    init: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (!this.apiKey) throw new ProviderError(ID, "SAIL_API_KEY is not set");
    const res = await fetch(url, {
      method,
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.body !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as BodyInit | undefined),
    });
    if (!res.ok) throw apiError(method, url, res.status, await res.text());
    return res;
  }

  /** @internal JSON call on the Sailbox API. */
  async api<T>(method: string, path: string, json?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await this.request(method, `${this.sailboxApi}${path}`, { json, headers });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private app(): Promise<string> {
    this.appId ??= (async () => {
      const res = await this.request("POST", `${this.mainApi}/apps/find`, { json: { name: this.appName, mint_if_missing: true } });
      const { id } = (await res.json()) as { id?: string };
      if (!id) throw new ProviderError(ID, `apps/find returned no id for app "${this.appName}"`);
      return id;
    })().catch((err) => {
      this.appId = undefined;
      throw err;
    });
    return this.appId;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const choice = spec.image?.sail;
    const base = choice === undefined ? BASE_IMAGES.debian : BASE_IMAGES[choice];
    if (!base) {
      throw new ProviderError(ID, `image.sail must be "debian" or "devbox"; images with your own packages are built with Sail's SDK first`, 400);
    }
    const vcpu = Math.min(MAX_VCPU, Math.max(1, Math.ceil(spec.vcpu ?? 2)));
    const memory = Math.max(MIN_MEMORY_LIMIT_GIB, Math.ceil(spec.memoryGb ?? 4));
    const minutes = spec.timeoutMinutes ?? 30;
    const created = await this.api<Status>(
      "POST",
      "/sailboxes",
      {
        app_id: await this.app(),
        name: `sbr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        image: { base },
        vcpu_count: vcpu,
        memory_limit_gib: memory,
        max_lifetime_seconds: Math.max(60, Math.round(minutes * 60)),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
      },
      { "Idempotency-Key": randomUUID() },
    );
    const id = created.sailbox_id;
    if (!id) throw new ProviderError(ID, "create returned no sailbox_id");
    const box = new SailBox(this, id);
    try {
      let s = created;
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (s.status === "creating") {
        if (Date.now() > deadline) throw new ProviderError(ID, `sailbox ${id} still creating after ${READY_TIMEOUT_MS / 1000}s`);
        await sleep(POLL_MS);
        s = await this.api<Status>("GET", `/sailboxes/${encodeURIComponent(id)}`);
      }
      if (s.status && GONE.has(s.status)) {
        // No HTTP status: a machine that didn't come up is the provider's problem, so the router may fall back.
        throw new ProviderError(ID, `sailbox ${id} ${s.status}${s.error_message ? `: ${s.error_message}` : ""}`);
      }
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  /** Reach an existing Sailbox, resuming it if it is paused or asleep. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new SailBox(this, nativeId);
    const s = await this.api<Status>("GET", `/sailboxes/${encodeURIComponent(nativeId)}`);
    if (s.status && GONE.has(s.status)) throw new ProviderError(ID, `sailbox ${nativeId} is ${s.status}`, 404);
    if (s.status && ASLEEP.has(s.status)) await box.resume();
    return box;
  }
}

class SailBox implements ProviderSandbox {
  constructor(
    private p: SailProvider,
    readonly nativeId: string,
  ) {}

  private get path() {
    return `/sailboxes/${encodeURIComponent(this.nativeId)}`;
  }

  private url(sub: string) {
    return `${this.p.sailboxApi}${this.path}${sub}`;
  }

  async resume(): Promise<void> {
    const r = await this.p.api<Status>("POST", `${this.path}/resume`);
    if (r.resume_state === "terminal_unavailable") {
      throw new ProviderError(ID, `sailbox ${this.nativeId} can't resume${r.error_message ? `: ${r.error_message}` : ""}`, 404);
    }
  }

  /** Run a request, resuming once if the Sailbox is paused (409). */
  private async live(send: () => Promise<Response>): Promise<Response> {
    try {
      return await send();
    } catch (err) {
      if ((err as ProviderError).status !== 409) throw err;
      await this.resume();
      return send();
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const ctl = new AbortController();
    let clientTimedOut = false;
    const timer = setTimeout(() => {
      clientTimedOut = true;
      ctl.abort();
    }, secs * 1000 + CLIENT_GRACE_MS);
    const out = new TextDecoder();
    const err = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let execId: string | undefined;
    let final: ExecEvent | undefined;
    const take = (which: "stdout" | "stderr", text: string) => {
      if (!text) return;
      if (which === "stdout") {
        stdout += text;
        opts.onStdout?.(text);
      } else {
        stderr += text;
        opts.onStderr?.(text);
      }
    };
    try {
      const res = await this.live(() =>
        this.p.request("POST", this.url("/exec"), {
          signal: ctl.signal,
          json: {
            command: guardTimeout(wrapCommand(cmd, { cwd: opts.cwd }), secs),
            ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
            timeout: Math.ceil(secs) + SERVER_TIMEOUT_EXTRA_S,
          },
        }),
      );
      for await (const line of readLines(res)) {
        let e: ExecEvent;
        try {
          e = JSON.parse(line) as ExecEvent;
        } catch {
          continue;
        }
        if (e.type === "started") execId = e.exec_request_id;
        else if (e.type === "stdout" || e.type === "stderr") {
          const bytes = Buffer.from(e.data ?? "", "base64");
          take(e.type, (e.type === "stdout" ? out : err).decode(bytes, { stream: true }));
        } else if (e.type === "exit" || e.type === "error") {
          final = e;
          break;
        }
      }
    } catch (e) {
      if (clientTimedOut) {
        await this.cancel(execId);
        throw timeoutError(ID, secs);
      }
      // Once the command has started, a dropped stream isn't the end: /wait below has the result.
      if (!execId) throw e;
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    take("stdout", out.decode());
    take("stderr", err.decode());
    // The stream dropped before the exit event: ask for the authoritative result.
    if (!final && execId) {
      final = await this.p
        .api<ExecEvent>("POST", `${this.path}/exec/${encodeURIComponent(execId)}/wait`)
        .then((w) => ({ ...w, type: "exit" }))
        .catch(() => undefined);
    }
    const durationMs = Date.now() - t0;
    if (!final) throw new ProviderError(ID, "command stream ended without an exit event (connection dropped?)");
    if (final.type === "error") {
      if (/time(d)?[ _-]?out|deadline/i.test(`${final.error_code ?? ""} ${final.message ?? ""}`)) throw timeoutError(ID, secs);
      throw new ProviderError(ID, `exec failed${final.error_code ? ` (${final.error_code})` : ""}${final.message ? `: ${final.message}` : ""}`);
    }
    if (final.timed_out || /time(d)?[ _-]?out/i.test(final.status ?? "")) throw timeoutError(ID, secs);
    const exitCode = final.return_code ?? (final.status === "succeeded" ? 0 : -1);
    if (killedByTimeout(exitCode, durationMs, secs)) throw timeoutError(ID, secs);
    return { exitCode, stdout, stderr, durationMs };
  }

  private async cancel(execId?: string): Promise<void> {
    if (!execId) return;
    await this.p.api("POST", `${this.path}/exec/${encodeURIComponent(execId)}/cancel`, { force: true }).catch(() => {});
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const q = new URLSearchParams({ path, mode: "420" });
    const res = await this.live(() => this.p.request("PUT", this.url(`/files?${q}`), { body: toBytes(content) }));
    await res.arrayBuffer().catch(() => {});
  }

  async readFile(path: string): Promise<Uint8Array> {
    const q = new URLSearchParams({ path });
    const res = await this.live(() => this.p.request("GET", this.url(`/files?${q}`)));
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Pause in memory (no compute billed) and wait until it lands, so connect() can resume it. */
  async pause(): Promise<void> {
    let s = await this.p.api<Status>("POST", `${this.path}/pause`);
    const deadline = Date.now() + PAUSE_TIMEOUT_MS;
    while (s.status !== "paused") {
      if (s.status && GONE.has(s.status)) throw new ProviderError(ID, `sailbox ${this.nativeId} ${s.status} while pausing`);
      if (Date.now() > deadline) throw new ProviderError(ID, `sailbox ${this.nativeId} not paused after ${PAUSE_TIMEOUT_MS / 1000}s (${s.status ?? "unknown"})`);
      await sleep(POLL_MS);
      s = await this.p.api<Status>("GET", this.path);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.p.api("POST", `${this.path}/terminate`);
    } catch (err) {
      if ((err as ProviderError).status !== 404) throw err;
    }
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

function apiError(method: string, url: string, status: number, text: string): ProviderError {
  let detail = text.slice(0, 300);
  try {
    const e = JSON.parse(text)?.error;
    if (e && typeof e === "object") detail = `${e.type ? `${e.type}: ` : ""}${e.message ?? ""}`.trim();
    else if (typeof e === "string") detail = e;
  } catch {
    /* plain-text body */
  }
  const path = new URL(url).pathname.replace(/^\/v1/, "");
  return new ProviderError(ID, `${method} ${path} -> ${status} ${detail}`, status);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
