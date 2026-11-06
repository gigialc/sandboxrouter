import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport } from "../util.js";

/**
 * LangSmith Sandboxes (LangChain) via the official `langsmith` SDK's `langsmith/sandbox` module.
 *
 * Auth: LANGSMITH_API_KEY. LANGSMITH_ENDPOINT optionally picks the region, BYOC data plane or
 * self-hosted instance (the SDK reads it; default https://api.smith.langchain.com, GCP US).
 * Size: `vCpus` and `memBytes`. Memory is tied to 4 GiB per vCPU and must stay within 50% of that,
 * i.e. 2 to 6 GiB per vCPU, so a request outside that band is widened (more memory, or more vCPUs)
 * by `langsmithSize`, which the price estimate uses too.
 * Lifetime: there is no hard lifetime, only an idle stop. `timeoutMinutes` becomes `idleTtlSeconds`
 * (a multiple of 60), and a stopped sandbox is deleted a day later (`deleteAfterStopSeconds`)
 * instead of the server default of about 14 days, so a leak bills storage for a day at most.
 * Pause = `stop()`: compute is released and the filesystem kept; the next command wakes it.
 * Image: `image.langsmith` = a snapshot id (UUID) or snapshot name; default is LangSmith's runtime.
 * Streaming goes over a WebSocket, which needs the `ws` package (the SDK's own optional peer).
 *
 * Docs: https://docs.langchain.com/langsmith/sandboxes
 *       https://docs.langchain.com/langsmith/sandbox-cli (sizes, stop/wake, LANGSMITH_ENDPOINT)
 *       https://reference.langchain.com/javascript/langsmith/sandbox (SandboxClient, Sandbox)
 *       https://www.langchain.com/pricing (per-second vCPU, memory and storage rates)
 */
const ID = "langsmith" as const;
const GIB = 1024 ** 3;

/** The size LangSmith will actually run for a request: 2 to 6 GiB per vCPU. */
export function langsmithSize(vcpu: number, memoryGb: number): { vcpu: number; memoryGb: number } {
  let v = Math.max(1, Math.ceil(vcpu));
  if (memoryGb > v * 6) v = Math.ceil(memoryGb / 6);
  return { vcpu: v, memoryGb: Math.max(memoryGb, v * 2) };
}

/** The slice of `langsmith/sandbox` this adapter uses (it's an optional peer dependency). */
interface LsSandbox {
  readonly name: string;
  run(
    command: string,
    opts: {
      timeout?: number;
      runConfig?: { work_dir?: string; env_vars?: Record<string, string> };
      onStdout?: (s: string) => void;
      onStderr?: (s: string) => void;
    },
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  stop(): Promise<void>;
  delete(): Promise<void>;
}
interface LsModule {
  SandboxClient: new (config: { apiKey?: string; apiEndpoint?: string }) => {
    createSandbox(snapshotId: string | undefined, opts: Record<string, unknown>): Promise<LsSandbox>;
    getSandbox(name: string): Promise<LsSandbox>;
  };
}

export class LangSmithProvider implements Provider {
  readonly id = ID;

  constructor(private apiKey = process.env.LANGSMITH_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private async client() {
    if (!this.apiKey) throw new ProviderError(ID, "LANGSMITH_API_KEY is not set");
    const { SandboxClient } = await optionalImport<LsModule>("langsmith/sandbox", "langsmith");
    return new SandboxClient({ apiKey: this.apiKey });
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const client = await this.client();
    const size = langsmithSize(spec.vcpu ?? 2, spec.memoryGb ?? 4);
    const image = spec.image?.langsmith;
    const isId = !!image && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image);
    const opts: Record<string, unknown> = {
      vCpus: size.vcpu,
      memBytes: Math.round(size.memoryGb * GIB),
      idleTtlSeconds: Math.max(60, Math.ceil(spec.timeoutMinutes ?? 30) * 60),
      deleteAfterStopSeconds: 24 * 3600,
      ...(image && !isId ? { snapshotName: image } : {}),
      ...(spec.env ? { runConfig: { env_vars: spec.env } } : {}),
      ...(spec.metadata ? { labels: spec.metadata } : {}),
    };
    try {
      return new LangSmithBox(await client.createSandbox(isId ? image : undefined, opts));
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reattach by sandbox name; a stopped sandbox wakes on its next command. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const client = await this.client();
    try {
      return new LangSmithBox(await client.getSandbox(nativeId));
    } catch (err) {
      throw wrap(err);
    }
  }
}

class LangSmithBox implements ProviderSandbox {
  constructor(private sbx: LsSandbox) {}

  get nativeId(): string {
    return this.sbx.name;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const runConfig = opts.cwd || opts.env ? { ...(opts.cwd ? { work_dir: opts.cwd } : {}), ...(opts.env ? { env_vars: opts.env } : {}) } : undefined;
    try {
      const r = await this.sbx.run(cmd, {
        timeout: opts.timeoutSeconds ?? 60,
        ...(runConfig ? { runConfig } : {}),
        ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
        ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
      });
      return { exitCode: r.exit_code, stdout: r.stdout, stderr: r.stderr, durationMs: Date.now() - t0 };
    } catch (err) {
      throw wrap(err);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    try {
      await this.sbx.write(path, content);
    } catch (err) {
      throw wrap(err);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return await this.sbx.read(path);
    } catch (err) {
      throw wrap(err);
    }
  }

  async pause(): Promise<void> {
    try {
      await this.sbx.stop();
    } catch (err) {
      throw wrap(err);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.sbx.delete();
    } catch (err) {
      throw wrap(err);
    }
  }
}

function wrap(err: any): ProviderError {
  if (err instanceof ProviderError) return err;
  const status =
    err?.name === "LangSmithResourceNotFoundError"
      ? 404
      : err?.name === "LangSmithSandboxAuthenticationError"
        ? 401
        : err?.name === "LangSmithQuotaExceededError"
          ? 429
          : typeof err?.status === "number"
            ? err.status
            : undefined;
  return new ProviderError(ID, err?.message ?? String(err), status);
}
