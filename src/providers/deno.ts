import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, optionalImport, toBytes } from "../util.js";

/**
 * Deno Sandbox (Linux microVMs on Deno Deploy) via the official `@deno/sandbox` SDK. The SDK is
 * required: sandboxes are driven over an SDK-private WebSocket RPC protocol that Deno does not
 * document, so there is no plain REST path. Optional peer dependency: `@deno/sandbox` (>=0.13 <0.14,
 * a 0.x API; verified against 0.13.2).
 * Auth: DENO_DEPLOY_TOKEN, an organization token (ddo_...), or a personal token (ddp_...) plus
 * DENO_DEPLOY_ORG. Sandboxes need a paid Deploy plan (Pro or Builder).
 * Fixed limits (https://docs.deno.com/sandbox/#limits): 2 vCPU, 768-4096 MB memory (default
 * 1280), 10 GB disk, lifetime up to 30 minutes, regions `ord` and `ams`. Outbound network is open
 * unless allowNet is set. image.deno is a snapshot or volume id/slug used as the root filesystem.
 * The default timeout ("session") would end the VM when this process disconnects, so the adapter
 * always passes a duration, which is what lets connect() reattach. exec streams stdout/stderr from
 * a spawned `/bin/sh -c`. No pause.
 * Docs: https://docs.deno.com/sandbox/, https://docs.deno.com/sandbox/create/,
 *       https://docs.deno.com/sandbox/timeouts/, https://docs.deno.com/sandbox/security/,
 *       https://deno.com/sandbox (pricing), https://jsr.io/@deno/sandbox
 */
const ID = "deno" as const;
const MIN_MEMORY_MB = 768;
const MAX_MEMORY_MB = 4096;
const MAX_LIFETIME_MIN = 30;
export const DENO_VCPU = 2;

/** The parts of `@deno/sandbox` this adapter uses (local types: the package is optional). */
interface DenoChild {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  status: Promise<{ code: number; signal: string | null; success: boolean }>;
  kill(signal?: string): Promise<void>;
}
interface DenoSdkSandbox {
  readonly id: string;
  spawn(command: string, options?: Record<string, unknown>): Promise<DenoChild>;
  fs: {
    writeFile(path: string, data: Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
  kill(): Promise<void>;
  close(): Promise<void>;
}
export interface DenoSdk {
  Sandbox: {
    create(options?: Record<string, unknown>): Promise<DenoSdkSandbox>;
    connect(options: Record<string, unknown> & { id: string }): Promise<DenoSdkSandbox>;
  };
}

export class DenoProvider implements Provider {
  readonly id = ID;

  constructor(
    private token = process.env.DENO_DEPLOY_TOKEN,
    private org = process.env.DENO_DEPLOY_ORG,
    private region = process.env.DENO_SANDBOX_REGION,
    /** @internal Loads the SDK; tests pass a fake. */
    private load: () => Promise<DenoSdk> = () => optionalImport<DenoSdk>("@deno/sandbox", "deno"),
  ) {}

  configured(): boolean {
    return !!this.token && (this.token.startsWith("ddo_") || !!this.org);
  }

  private auth(): Record<string, unknown> {
    if (!this.token) throw new ProviderError(ID, "DENO_DEPLOY_TOKEN is not set");
    if (!this.token.startsWith("ddo_") && !this.org) throw new ProviderError(ID, "a personal DENO_DEPLOY_TOKEN needs DENO_DEPLOY_ORG");
    return { token: this.token, ...(this.org ? { org: this.org } : {}) };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const vcpu = spec.vcpu ?? 2;
    if (vcpu > DENO_VCPU) throw new ProviderError(ID, `Deno Sandbox has ${DENO_VCPU} vCPU, not ${vcpu}`);
    const memoryMb = Math.ceil((spec.memoryGb ?? 4) * 1024);
    if (memoryMb > MAX_MEMORY_MB) throw new ProviderError(ID, `Deno Sandbox memory is at most ${MAX_MEMORY_MB} MB, not ${memoryMb}`);
    const minutes = Math.min(MAX_LIFETIME_MIN, Math.max(1, Math.ceil(spec.timeoutMinutes ?? 30)));
    const options: Record<string, unknown> = {
      ...this.auth(),
      memory: `${Math.max(MIN_MEMORY_MB, memoryMb)}MiB`,
      timeout: `${minutes}m`,
    };
    if (this.region) options.region = this.region;
    if (spec.env) options.env = spec.env;
    if (spec.metadata) options.labels = spec.metadata;
    if (spec.image?.deno) options.root = spec.image.deno;
    const { Sandbox } = await this.load();
    return new DenoBox(await sdk(() => Sandbox.create(options)));
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await this.load();
    return new DenoBox(await sdk(() => Sandbox.connect({ ...this.auth(), id: nativeId })));
  }
}

class DenoBox implements ProviderSandbox {
  readonly nativeId: string;

  constructor(private sbx: DenoSdkSandbox) {
    this.nativeId = sbx.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? 60;
    const child = await sdk(() =>
      this.sbx.spawn("/bin/sh", {
        args: ["-c", cmd],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }),
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL").catch(() => {});
    }, secs * 1000);
    try {
      const [stdout, stderr, status] = await Promise.all([
        drain(child.stdout, opts.onStdout),
        drain(child.stderr, opts.onStderr),
        sdk(() => child.status),
      ]);
      if (timedOut) throw new ProviderError(ID, `command timed out after ${secs}s`);
      // A signal-terminated process reports no useful code; use the shell convention 128+n.
      const exitCode = status.signal && !status.code ? 128 + (SIGNALS[status.signal] ?? 0) : status.code;
      return { exitCode, stdout, stderr, durationMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const dir = dirname(path);
    if (dir !== "/" && dir !== path) await sdk(() => this.sbx.fs.mkdir(dir, { recursive: true }));
    await sdk(() => this.sbx.fs.writeFile(path, toBytes(content)));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await sdk(() => this.sbx.fs.readFile(path)));
  }

  async kill(): Promise<void> {
    await sdk(() => this.sbx.kill());
  }
}

/** Read a byte stream to a string, passing each decoded chunk on as it arrives. */
async function drain(stream: ReadableStream<Uint8Array> | null, on?: (chunk: string) => void): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
    if (text) {
      out += text;
      on?.(text);
    }
    if (done) return out;
  }
}

/** Run an SDK call, turning its errors into ProviderErrors with an HTTP-like status where known. */
async function sdk<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    const msg = err?.message ?? String(err);
    let status: number | undefined = typeof err?.status === "number" ? err.status : undefined;
    if (status === undefined && (err?.name === "NotFound" || err?.code === "ENOENT" || /not found|no such file/i.test(msg))) status = 404;
    throw new ProviderError(ID, `${err?.name && err.name !== "Error" ? `${err.name}: ` : ""}${msg}`, status);
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };
