import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes } from "../util.js";

type BlaxelModule = typeof import("@blaxel/core");
type BlaxelSandbox = InstanceType<BlaxelModule["SandboxInstance"]>;

/** Blaxel's public base image (the SDK's own default). Set image.blaxel for another image or a `bl deploy` template. */
const DEFAULT_IMAGE = "blaxel/base-image:latest";
/** Blaxel rejects a max-age ttl under 5 minutes. */
const MIN_TTL_MINUTES = 5;

/**
 * Blaxel sandboxes via `@blaxel/core`. Auth: BL_API_KEY + BL_WORKSPACE (or `bl login`).
 * Region: BL_REGION, else us-pdx-1. Blaxel sizes by memory only and gives 1 vCPU per 2 GB,
 * so memory is max(memoryGb, 2 × vcpu) GB. Idle sandboxes drop to standby on their own and
 * wake on the next call; pause() archives explicitly.
 */
export class BlaxelProvider implements Provider {
  readonly id = "blaxel" as const;
  private ready?: Promise<BlaxelModule>;

  constructor(
    private apiKey = process.env.BL_API_KEY,
    private workspace = process.env.BL_WORKSPACE,
    private region = process.env.BL_REGION ?? "us-pdx-1",
  ) {}

  configured(): boolean {
    return !!this.apiKey && !!this.workspace;
  }

  /** Load the SDK once and point its (global) settings at our credentials. */
  private sdk(): Promise<BlaxelModule> {
    this.ready ??= optionalImport<BlaxelModule>("@blaxel/core", "blaxel").then((m) => {
      if (this.apiKey && this.workspace) m.initialize({ apiKey: this.apiKey, workspace: this.workspace });
      return m;
    });
    return this.ready;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { SandboxInstance } = await this.sdk();
    const memoryGb = Math.max(spec.memoryGb ?? DEFAULT_MEMORY_GB, (spec.vcpu ?? DEFAULT_VCPU) * 2);
    const ttlMinutes = Math.max(MIN_TTL_MINUTES, Math.round(spec.timeoutMinutes ?? 30));
    try {
      const sbx = await SandboxInstance.create({
        image: spec.image?.blaxel ?? DEFAULT_IMAGE,
        memory: Math.round(memoryGb * 1024),
        region: this.region,
        envs: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
        labels: spec.metadata,
        // Max-age from creation, not an idle timeout.
        ttl: `${ttlMinutes}m`,
      });
      return new BlaxelBox(sbx);
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reattach by sandbox name; an archived (paused) sandbox is unarchived first. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { SandboxInstance } = await this.sdk();
    try {
      let sbx = await SandboxInstance.get(nativeId);
      if (sbx.status === "ARCHIVED" || sbx.status === "ARCHIVING") sbx = await SandboxInstance.unarchive(nativeId);
      return new BlaxelBox(sbx);
    } catch (err) {
      throw wrap(err);
    }
  }
}

class BlaxelBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: BlaxelSandbox) {
    const name = sbx.metadata.name;
    if (!name) throw new ProviderError("blaxel", "sandbox has no name");
    this.nativeId = name;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const timeoutSeconds = opts.timeoutSeconds ?? 60;
    let r;
    try {
      // With onStdout/onStderr the SDK streams logs from the same request as the command runs.
      r = await this.sbx.process.exec({
        command: cmd,
        workingDir: opts.cwd,
        env: opts.env,
        timeout: timeoutSeconds,
        waitForCompletion: true,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      if (r.status === "running") r = await this.sbx.process.wait(r.pid, { maxWait: timeoutSeconds * 1000 });
    } catch (err) {
      throw wrap(err);
    }
    if (r.status === "killed" || r.status === "stopped") {
      throw new ProviderError("blaxel", `command ${r.status} (timeout ${timeoutSeconds}s?)`);
    }
    // A nonzero exit is a result (status "failed"), not an error.
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs: Date.now() - t0 };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    try {
      await this.sbx.fs.writeBinary(path, toBytes(content));
    } catch (err) {
      throw wrap(err);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await (await this.sbx.fs.readBinary(path)).arrayBuffer());
    } catch (err) {
      throw wrap(err);
    }
  }

  /**
   * Archive: the filesystem is kept, memory and processes are lost. The max-age ttl is cleared
   * first so the archive survives until kill(). router.get() unarchives it.
   */
  async pause(): Promise<void> {
    const { SandboxInstance } = await optionalImport<BlaxelModule>("@blaxel/core", "blaxel");
    try {
      await SandboxInstance.updateTtl(this.nativeId, null);
      await this.sbx.archive();
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
  const status = typeof err?.status === "number" ? err.status : err?.response?.status;
  return new ProviderError("blaxel", err?.message ?? String(err), status);
}
