import { createHash } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * Freestyle VMs over the public REST API (no SDK needed). Auth: Authorization: Bearer
 * <FREESTYLE_API_KEY>, base https://api.freestyle.sh. Errors are {code, message}.
 *   POST   /v5/vms                {snapshotId, firewall:{rules}, ttlSeconds, metadata}  -> Vm (201, booting)
 *   GET    /v5/vms/:id            -> Vm {id, state: starting|running|pausing|paused|stopped, resources}
 *   POST   /v5/vms/:id/exec-await {command, env, timeoutMs} -> {statusCode|null, stdout, stderr}
 *   PUT    /v5/vms/:id/fs/write?path=P&sha256=H   raw bytes, atomic (204)
 *   GET    /v5/vms/:id/fs/read?path=P             raw bytes (404 when missing; works while paused)
 *   POST   /v5/vms/:id/fs/mkdir   {path}  (creates parents)
 *   POST   /v5/vms/:id/pause, POST /v5/vms/:id/start, POST /v5/vms/:id/resize {cpu, memory(MiB)}
 *   DELETE /v5/vms/:id
 * Long calls: with `x-freestyle-background-after-secs: N` a request still running after N s
 * answers 202 {requestId} and GET /v5/background-requests/:id replays its response once done (202
 * while pending). That is what lets exec run past the 5-minute inline cap (up to 24 h).
 * Sizes come from the base snapshot (FREESTYLE_SIZES): the adapter boots the smallest
 * freestyle/ubuntu-* that fits. A custom image.freestyle (snapshot id/slug) boots at its own size
 * and is grown with resize when the spec asks for more. A VM gets no network unless allowed, so the
 * adapter opens outbound Internet, like other providers' defaults. exec has no streaming (output
 * streams only over PTY WebSockets), so onStdout/onStderr get the whole output once it finishes.
 * pause() keeps memory and disk; connect() and a paused exec start the VM again.
 * Docs: https://www.freestyle.sh/docs/vms, https://www.freestyle.sh/docs/vms/lifecycle,
 *       https://www.freestyle.sh/docs/vms/files, https://www.freestyle.sh/docs/vms/base-snapshots,
 *       https://www.freestyle.sh/docs/vms/pricing-and-limits, https://www.freestyle.sh/openapi.json
 */
const ID = "freestyle" as const;
const BACKGROUND_AFTER_SECS = "5";
const READY_TIMEOUT_MS = 3 * 60_000;
const MAX_EXEC_MS = 86_400_000;
const OUTBOUND_INTERNET = { rules: [{ action: "allow", source: {}, destination: { public: true } }] };

/**
 * Freestyle's Ubuntu base snapshots (hardware is baked into each), from
 * https://www.freestyle.sh/docs/vms/base-snapshots, priced at the list rates on
 * https://www.freestyle.sh/docs/vms/pricing-and-limits ($0.04032/vCPU-h, $0.0129/GiB-h memory,
 * $0.000086/GiB-h disk), checked 2026-11-04. Free tops out at `ubuntu`, Hobby at `ubuntu-lg`,
 * Pro at `ubuntu-2xl`.
 */
export const FREESTYLE_SIZES = [
  { snapshot: "freestyle/ubuntu-sm", vcpu: 2, memoryGb: 4, diskGb: 16 },
  { snapshot: "freestyle/ubuntu", vcpu: 4, memoryGb: 8, diskGb: 32 },
  { snapshot: "freestyle/ubuntu-lg", vcpu: 8, memoryGb: 16, diskGb: 64 },
  { snapshot: "freestyle/ubuntu-xl", vcpu: 16, memoryGb: 32, diskGb: 128 },
  { snapshot: "freestyle/ubuntu-2xl", vcpu: 32, memoryGb: 64, diskGb: 128 },
].map((s) => ({ ...s, usdHour: round(s.vcpu * 0.04032 + s.memoryGb * 0.0129 + s.diskGb * 0.000086) }));

/** Smallest Ubuntu base snapshot with at least the requested vCPU and memory, or undefined. */
export function freestyleSize(vcpu: number, memoryGb: number): (typeof FREESTYLE_SIZES)[number] | undefined {
  return FREESTYLE_SIZES.find((s) => s.vcpu >= vcpu && s.memoryGb >= memoryGb);
}

interface FreestyleVm {
  id: string;
  state?: string;
  resources?: { cpu: number; memory: number; storage: number };
}

interface ExecResponse {
  statusCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

export class FreestyleProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.FREESTYLE_API_KEY,
    private baseUrl = process.env.FREESTYLE_API_URL ?? "https://api.freestyle.sh",
    /** How often to poll a backgrounded request or a booting VM. */
    private pollMs = 2000,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /**
   * @internal One API call. With `background`, a call still running after 5 s comes back as 202
   * and is polled at /v5/background-requests/:id until its own response is ready.
   */
  async request(
    method: string,
    path: string,
    init: { json?: unknown; bytes?: Uint8Array; background?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (!this.apiKey) throw new ProviderError(ID, "FREESTYLE_API_KEY is not set");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (init.background) headers["x-freestyle-background-after-secs"] = BACKGROUND_AFTER_SECS;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      body = init.bytes as BodyInit;
    }
    let res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: init.signal });
    if (init.background && res.status === 202) {
      const accepted = (await res.json().catch(() => ({}))) as { requestId?: string; resultUrl?: string };
      const requestId = res.headers.get("x-freestyle-background-request-id") ?? accepted.requestId;
      const resultPath = accepted.resultUrl ?? (requestId ? `/v5/background-requests/${encodeURIComponent(requestId)}` : undefined);
      if (!resultPath) throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> 202 without a background request id`, 202);
      for (;;) {
        await sleep(this.pollMs, init.signal);
        res = await fetch(resultPath.startsWith("http") ? resultPath : `${this.baseUrl}${resultPath}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: init.signal,
        });
        if (res.status !== 202) break;
        await res.body?.cancel().catch(() => {});
      }
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j?.message) detail = `${j.code ? `${j.code}: ` : ""}${j.message}`;
      } catch {
        /* plain-text body */
      }
      throw new ProviderError(ID, `${method} ${path.split("?")[0]} -> ${res.status} ${detail}`, res.status);
    }
    return res;
  }

  /** @internal JSON call. */
  async json<T>(method: string, path: string, init: { json?: unknown; background?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const text = await (await this.request(method, path, init)).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const vcpu = spec.vcpu ?? 2;
    const memoryGb = spec.memoryGb ?? 4;
    const custom = spec.image?.freestyle;
    const size = freestyleSize(vcpu, memoryGb);
    if (!custom && !size) throw new ProviderError(ID, `no Freestyle size has ${vcpu} vCPU / ${memoryGb} GB (max ubuntu-2xl: 32 vCPU / 64 GiB)`);
    const body: Record<string, unknown> = {
      snapshotId: custom ?? size!.snapshot,
      firewall: OUTBOUND_INTERNET,
      ttlSeconds: Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)),
    };
    if (spec.metadata) body.metadata = spec.metadata;
    const vm = await this.json<FreestyleVm>("POST", "/v5/vms", { json: body, background: true });
    const box = new FreestyleBox(this, vm.id, spec.env);
    try {
      const ready = await box.waitRunning();
      // A custom snapshot boots at its own size; grow it (resize is grow-only) when the spec wants more.
      const res = ready.resources;
      if (custom && res && (res.cpu < Math.ceil(vcpu) || res.memory < Math.ceil(memoryGb * 1024))) {
        await this.json("POST", `/v5/vms/${encodeURIComponent(vm.id)}/resize`, {
          json: { cpu: Math.max(res.cpu, Math.ceil(vcpu)), memory: Math.max(res.memory, Math.ceil(memoryGb * 1024)) },
          background: true,
        });
      }
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  /** Reattach by VM id (or slug); a paused or stopped VM is started again. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new FreestyleBox(this, nativeId);
    await box.waitRunning();
    return box;
  }

  /** @internal */
  get poll(): number {
    return this.pollMs;
  }
}

class FreestyleBox implements ProviderSandbox {
  constructor(
    private p: FreestyleProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  private get path() {
    return `/v5/vms/${encodeURIComponent(this.nativeId)}`;
  }

  /** Wait until the VM runs, starting it when it is paused or stopped. */
  async waitRunning(): Promise<FreestyleVm> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let started = false;
    for (;;) {
      const vm = await this.p.json<FreestyleVm>("GET", this.path);
      if (vm.state === "running") return vm;
      if ((vm.state === "paused" || vm.state === "stopped") && !started) {
        await this.p.json("POST", `${this.path}/start`, { background: true });
        started = true;
        continue;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `VM ${this.nativeId} still ${vm.state} after ${READY_TIMEOUT_MS / 1000}s`);
      await sleep(Math.min(this.p.poll, 500));
    }
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const body: Record<string, unknown> = {
      command: wrapCommand(cmd, { cwd: opts.cwd }),
      timeoutMs: Math.min(MAX_EXEC_MS, Math.max(1, Math.round(secs * 1000))),
    };
    const env = { ...this.env, ...opts.env };
    if (Object.keys(env).length) body.env = env;
    let r: ExecResponse;
    try {
      r = await this.p.json<ExecResponse>("POST", `${this.path}/exec-await`, { json: body, background: true });
    } catch (err) {
      // 409 also means "stopped responding mid-command" (VM_NON_RESPONSIVE): never re-run that one.
      if (!(err instanceof ProviderError) || err.status !== 409 || /VM_NON_RESPONSIVE/.test(err.message)) throw err;
      const vm = await this.p.json<FreestyleVm>("GET", this.path);
      if (vm.state === "running") throw err;
      await this.waitRunning();
      r = await this.p.json<ExecResponse>("POST", `${this.path}/exec-await`, { json: body, background: true });
    }
    if (r.statusCode === null || r.statusCode === undefined) throw new ProviderError(ID, `command timed out after ${secs}s`);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { exitCode: r.statusCode, stdout, stderr, durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = toBytes(content);
    // The file API runs as root, so a folder it creates belongs to root and commands (which run as
    // the image's user) can't write in it. Make the folder with a command instead, as that user;
    // fall back to the file API where the user can't (e.g. under /root). Best effort: the write
    // itself reports any real problem.
    const dir = dirname(path);
    if (dir !== "/") {
      const r = await this.p
        .json<ExecResponse>("POST", `${this.path}/exec-await`, { json: { command: `mkdir -p ${shq(dir)}`, timeoutMs: 30_000 }, background: true })
        .catch(() => undefined);
      if (r?.statusCode !== 0) await this.p.request("POST", `${this.path}/fs/mkdir`, { json: { path: dir }, background: true }).catch(() => {});
    }
    const q = new URLSearchParams({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
    await this.p.request("PUT", `${this.path}/fs/write?${q}`, { bytes, background: true });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.p.request("GET", `${this.path}/fs/read?${new URLSearchParams({ path })}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async pause(): Promise<void> {
    await this.p.request("POST", `${this.path}/pause`, { background: true });
  }

  async kill(): Promise<void> {
    await this.p.request("DELETE", this.path);
  }
}

function round(n: number) {
  return Math.round(n * 1e5) / 1e5;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    // Not unref'd: between polls nothing else may keep the process alive.
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
