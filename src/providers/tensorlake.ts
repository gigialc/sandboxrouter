import { randomUUID } from "node:crypto";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, shq, toBytes, wrapCommand } from "../util.js";

type TensorlakeModule = typeof import("@tensorlakeai/tensorlake");
type TensorlakeSandbox = InstanceType<TensorlakeModule["Sandbox"]>;

/** Tensorlake has no sandbox-level env, so spec.env lives in this file and every exec sources it. */
const ENV_FILE = "/tmp/.sandboxrouter.env";

/**
 * Tensorlake sandboxes via `@tensorlakeai/tensorlake`. Auth: TENSORLAKE_API_KEY.
 * Set image.tensorlake to start from your own sandbox image; spec.gpu maps to a GPU model.
 */
export class TensorlakeProvider implements Provider {
  readonly id = "tensorlake" as const;

  constructor(private apiKey = process.env.TENSORLAKE_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<TensorlakeModule>("@tensorlakeai/tensorlake", "tensorlake");
    const image = (spec.image as Partial<Record<string, string>> | undefined)?.tensorlake;
    let sbx: TensorlakeSandbox;
    try {
      sbx = await Sandbox.create({
        apiKey: this.apiKey,
        image,
        cpus: spec.vcpu ?? DEFAULT_VCPU,
        memoryMb: Math.round((spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024),
        timeoutSecs: Math.round((spec.timeoutMinutes ?? 30) * 60),
        ...(spec.gpu ? { gpuModel: spec.gpu } : {}),
      });
    } catch (err) {
      throw fail(err);
    }
    const box = new TensorlakeBox(sbx);
    if (spec.env && Object.keys(spec.env).length > 0) {
      try {
        await box.writeFile(ENV_FILE, wrapCommand(":", { env: spec.env }) + "\n");
      } catch (err) {
        await sbx.terminate().catch(() => {});
        throw err;
      }
    }
    return box;
  }

  /** Reattach; a suspended sandbox is resumed. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<TensorlakeModule>("@tensorlakeai/tensorlake", "tensorlake");
    try {
      const sbx = await Sandbox.connect({ sandboxId: nativeId, apiKey: this.apiKey });
      let status = await sbx.status();
      // resume() is rejected while a suspend is still in flight.
      for (let i = 0; status === "suspending" && i < 300; i++) {
        await sleep(1000);
        status = await sbx.status();
      }
      if (status === "suspended") await sbx.resume();
      return new TensorlakeBox(sbx);
    } catch (err) {
      throw fail(err);
    }
  }
}

class TensorlakeBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: TensorlakeSandbox) {
    this.nativeId = sbx.sandboxId;
  }

  /** `sh -c` so cmd is a shell line; spec.env is sourced first so per-call env wins. */
  private shellLine(cmd: string, opts: ExecOptions): string {
    return `[ -f ${shq(ENV_FILE)} ] && . ${shq(ENV_FILE)}; ${wrapCommand(cmd, { cwd: opts.cwd, env: opts.env })}`;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (opts.onStdout || opts.onStderr) return this.execStreaming(cmd, opts);
    const t0 = Date.now();
    const limit = opts.timeoutSeconds ?? 60;
    try {
      const r = await this.sbx.run("/bin/sh", { args: ["-c", this.shellLine(cmd, opts)], timeout: limit });
      if (r.timedOut) throw new ProviderError("tensorlake", `command timed out after ${limit}s`);
      // A nonzero exit is a result; the SDK only throws for transport/API failures.
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: Date.now() - t0 };
    } catch (err) {
      throw fail(err);
    }
  }

  /** Start the process, then follow its combined output stream until it exits. */
  private async execStreaming(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const t0 = Date.now();
    const limit = (opts.timeoutSeconds ?? 60) * 1000;
    const abort = new AbortController();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let pid: number | undefined;
    const timer = setTimeout(() => abort.abort(), limit);
    timer.unref();
    try {
      ({ pid } = await this.sbx.startProcess("/bin/sh", { args: ["-c", this.shellLine(cmd, opts)] }));
      try {
        for await (const ev of this.sbx.followOutput(pid, { signal: abort.signal })) {
          if (ev.stream === "stderr") {
            stderr.push(ev.line);
            opts.onStderr?.(ev.line + "\n");
          } else {
            stdout.push(ev.line);
            opts.onStdout?.(ev.line + "\n");
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) throw err;
      }
      if (abort.signal.aborted) {
        await this.sbx.killProcess(pid).catch(() => {});
        throw new ProviderError("tensorlake", `command timed out after ${limit / 1000}s`);
      }
      // The stream can close a moment before the daemon records the exit.
      let info = await this.sbx.getProcess(pid);
      for (let i = 0; info.status === "running" && i < 20; i++) {
        await sleep(250);
        info = await this.sbx.getProcess(pid);
      }
      const exitCode = info.exitCode ?? (info.signal != null ? -info.signal : -1);
      return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), durationMs: Date.now() - t0 };
    } catch (err) {
      throw fail(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    try {
      await this.sbx.writeFile(path, toBytes(content));
    } catch (err) {
      throw fail(err);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sbx.readFile(path));
    } catch (err) {
      throw fail(err);
    }
  }

  /**
   * Suspend, keeping memory and disk. Only named sandboxes can suspend, so an unnamed one is
   * named first. router.get() resumes it.
   */
  async pause(): Promise<void> {
    try {
      const info = await this.sbx.info();
      if (!info.name) await this.sbx.update({ name: `sbr-${randomUUID()}` });
      await this.sbx.suspend();
    } catch (err) {
      throw fail(err);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.sbx.terminate();
    } catch (err) {
      throw fail(err);
    }
  }
}

function fail(err: any): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = typeof err?.statusCode === "number" ? err.statusCode : undefined;
  return new ProviderError("tensorlake", err?.message ?? String(err), status);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
