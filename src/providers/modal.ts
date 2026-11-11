import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, killedByTimeout, optionalImport, timeoutError, toBytes } from "../util.js";

type ModalModule = typeof import("modal");
type ModalClient = InstanceType<ModalModule["ModalClient"]>;
type ModalSandbox = Awaited<ReturnType<ModalClient["sandboxes"]["fromId"]>>;

const APP_NAME = process.env.SANDBOXROUTER_MODAL_APP ?? "sandboxrouter";

/** Modal via the `modal` JS SDK. The only adapter here that takes `gpu`. */
export class ModalProvider implements Provider {
  readonly id = "modal" as const;
  private client?: ModalClient;

  configured(): boolean {
    return (!!process.env.MODAL_TOKEN_ID && !!process.env.MODAL_TOKEN_SECRET) || existsSync(join(homedir(), ".modal.toml"));
  }

  private async modal(): Promise<ModalClient> {
    if (!this.client) {
      const { ModalClient } = await optionalImport<ModalModule>("modal", "modal");
      this.client = new ModalClient();
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const modal = await this.modal();
    const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });
    const image = modal.images.fromRegistry(spec.image?.modal ?? "python:3.13-slim");
    const sb = await modal.sandboxes.create(app, image, {
      // Modal's cpu is physical cores (1 core = 2 vCPUs); the catalog and the spec count vCPUs.
      cpu: (spec.vcpu ?? DEFAULT_VCPU) / 2,
      memoryMiB: Math.round((spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024),
      gpu: spec.gpu,
      timeoutMs: (spec.timeoutMinutes ?? 30) * 60_000,
      env: spec.env,
    });
    return new ModalBox(sb);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    return new ModalBox(await (await this.modal()).sandboxes.fromId(nativeId));
  }
}

/** Read a text stream to the end, passing each chunk to `on`. */
async function drain(stream: ReadableStream<string>, on?: (chunk: string) => void): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += value;
    on?.(value);
  }
}

class ModalBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sb: ModalSandbox) {
    this.nativeId = sb.sandboxId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    try {
      // Modal kills the process at timeoutMs; the kill shows up as a signal exit code.
      const p = await this.sb.exec(["sh", "-c", cmd], {
        workdir: opts.cwd,
        env: opts.env,
        timeoutMs: seconds * 1000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([drain(p.stdout, opts.onStdout), drain(p.stderr, opts.onStderr), p.wait()]);
      const durationMs = Date.now() - t0;
      if (killedByTimeout(exitCode, durationMs, seconds)) throw timeoutError("modal", seconds);
      return { exitCode, stdout, stderr, durationMs };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const message = err?.message ?? String(err);
      // Newer SDKs end the output streams with "Deadline exceeded" at timeoutMs instead of a signal exit.
      if (/deadline exceeded/i.test(message) && killedByTimeout(-1, Date.now() - t0, seconds)) throw timeoutError("modal", seconds);
      throw new ProviderError("modal", message);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sb.filesystem.writeBytes(toBytes(content), path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await this.sb.filesystem.readBytes(path);
  }

  async kill(): Promise<void> {
    await this.sb.terminate();
  }
}
