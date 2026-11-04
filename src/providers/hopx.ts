import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes } from "../util.js";

type HopxModule = typeof import("@hopx-ai/sdk");
// Sandbox has a private constructor, so take the instance type from create().
type HopxSandbox = Awaited<ReturnType<HopxModule["Sandbox"]["create"]>>;
type HopxStreamMessage = import("@hopx-ai/sdk").StreamMessage;

/** Public template used when spec.image.hopx is not set. */
const DEFAULT_TEMPLATE = "code-interpreter";

/**
 * HOPX via `@hopx-ai/sdk`. Auth: HOPX_API_KEY. vCPU and memory come from the template, not the
 * create call (HOPX does not take custom resources at create). Set image.hopx to a template name
 * (or a numeric template id) to start from your own; default is the public "code-interpreter".
 */
export class HopxProvider implements Provider {
  readonly id = "hopx" as const;

  constructor(private apiKey = process.env.HOPX_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<HopxModule>("@hopx-ai/sdk", "hopx");
    const image = spec.image?.hopx ?? DEFAULT_TEMPLATE;
    try {
      const sbx = await Sandbox.create({
        ...(/^\d+$/.test(image) ? { templateId: image } : { template: image }),
        apiKey: this.apiKey,
        timeoutSeconds: Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)),
        envVars: spec.env,
      });
      return new HopxBox(sbx);
    } catch (err) {
      throw fail(err);
    }
  }

  /** Reattach; the SDK resumes a paused sandbox. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<HopxModule>("@hopx-ai/sdk", "hopx");
    try {
      return new HopxBox(await Sandbox.connect(nativeId, this.apiKey));
    } catch (err) {
      throw fail(err);
    }
  }
}

class HopxBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: HopxSandbox) {
    this.nativeId = sbx.sandboxId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (opts.onStdout || opts.onStderr) return this.execStreaming(cmd, opts);
    const t0 = Date.now();
    try {
      const r = await this.sbx.commands.run(cmd, {
        timeout: opts.timeoutSeconds ?? 60,
        workingDir: opts.cwd,
        env: opts.env,
      });
      // A nonzero exit comes back as a normal response with exit_code set.
      return { exitCode: r.exit_code ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs: Date.now() - t0 };
    } catch (err) {
      throw fail(err);
    }
  }

  /** Streams over the agent's WebSocket (/execute/stream) with the code run as bash. */
  private async execStreaming(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = opts.timeoutSeconds ?? 60;
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const run = async () => {
      const stream = this.sbx.runCodeStream(cmd, {
        language: "bash",
        timeout: seconds,
        workingDir: opts.cwd,
        env: opts.env,
      });
      for await (const m of stream as AsyncIterable<HopxStreamMessage>) {
        if (m.type === "stdout") {
          stdout += m.data;
          opts.onStdout?.(m.data);
        } else if (m.type === "stderr") {
          stderr += m.data;
          opts.onStderr?.(m.data);
        } else if (m.type === "result") {
          exitCode = m.exit_code;
        } else if (m.type === "error") {
          const msg = m.code === "EXECUTION_TIMEOUT" ? `command timed out after ${seconds}s` : m.error;
          throw new ProviderError("hopx", msg);
        }
      }
    };
    try {
      // The agent enforces the timeout; the extra grace covers a stream that never closes.
      const graceMs = (seconds + 30) * 1000;
      const timedOut = await Promise.race([run().then(() => false), sleep(graceMs).then(() => true)]);
      if (timedOut) throw new ProviderError("hopx", `command timed out after ${seconds}s`);
      if (exitCode === undefined) throw new ProviderError("hopx", "stream closed before the command finished");
      return { exitCode, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (err) {
      throw fail(err);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    try {
      await this.sbx.files.writeBytes(path, Buffer.from(toBytes(content)));
    } catch (err) {
      throw fail(err);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sbx.files.readBytes(path));
    } catch (err) {
      throw fail(err);
    }
  }

  /** Pause with memory and disk kept. router.get() (Sandbox.connect) resumes it. */
  async pause(): Promise<void> {
    try {
      await this.sbx.pause();
    } catch (err) {
      throw fail(err);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.sbx.kill();
    } catch (err) {
      throw fail(err);
    }
  }
}

/** HTTP status for SDK errors that drop it (only APIError keeps statusCode). */
const STATUS_BY_NAME: Record<string, number> = {
  AuthenticationError: 401,
  TokenExpiredError: 401,
  RateLimitError: 429,
  NotFoundError: 404,
  TemplateNotFoundError: 404,
  FileNotFoundError: 404,
  SandboxExpiredError: 410,
};

function fail(err: any): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = err?.statusCode ?? err?.response?.status ?? STATUS_BY_NAME[err?.name];
  return new ProviderError("hopx", err?.message ?? String(err), status);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
