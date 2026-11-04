import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes } from "../util.js";

type E2BModule = typeof import("e2b");
type E2BSandbox = InstanceType<E2BModule["Sandbox"]>;

/** E2B via the official `e2b` SDK. vCPU and memory come from the template, not the create call. */
export class E2BProvider implements Provider {
  readonly id = "e2b" as const;

  constructor(private apiKey = process.env.E2B_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "e2b");
    const opts = {
      apiKey: this.apiKey,
      timeoutMs: (spec.timeoutMinutes ?? 30) * 60_000,
      envs: spec.env,
      metadata: spec.metadata,
    };
    const sbx = spec.image?.e2b ? await Sandbox.create(spec.image.e2b, opts) : await Sandbox.create(opts);
    return new E2BBox(sbx);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "e2b");
    return new E2BBox(await Sandbox.connect(nativeId, { apiKey: this.apiKey }));
  }
}

class E2BBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: E2BSandbox) {
    this.nativeId = sbx.sandboxId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    try {
      const r = await this.sbx.commands.run(cmd, {
        cwd: opts.cwd,
        envs: opts.env,
        timeoutMs: (opts.timeoutSeconds ?? 60) * 1000,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      // The SDK throws CommandExitError for a nonzero exit; that's a result, not a failure.
      if (err?.name === "CommandExitError" || typeof err?.exitCode === "number") {
        return { exitCode: err.exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? "", durationMs: Date.now() - t0 };
      }
      throw new ProviderError("e2b", err?.message ?? String(err));
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.files.write(path, toBytes(content));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await this.sbx.files.read(path, { format: "bytes" });
  }

  /** Snapshot memory and disk. Sandbox.connect (router.get) resumes it. */
  async pause(): Promise<void> {
    await this.sbx.pause();
  }

  async kill(): Promise<void> {
    await this.sbx.kill();
  }
}
