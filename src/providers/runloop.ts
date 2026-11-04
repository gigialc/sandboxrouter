import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes, wrapCommand } from "../util.js";

type RunloopModule = typeof import("@runloop/api-client");
type RunloopClient = InstanceType<RunloopModule["RunloopSDK"]>;
type RunloopDevbox = ReturnType<RunloopClient["devbox"]["fromId"]>;

/** Longest lifetime Runloop accepts for keep_alive_time_seconds (48 h). */
const MAX_KEEP_ALIVE_SECONDS = 172_800;

/**
 * Runloop devboxes via `@runloop/api-client`. Auth: RUNLOOP_API_KEY. Default Runloop image;
 * set image.runloop to a blueprint name (or a `bpt_` blueprint id) to start from your own.
 */
export class RunloopProvider implements Provider {
  readonly id = "runloop" as const;
  private client?: RunloopClient;

  constructor(private apiKey = process.env.RUNLOOP_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private async runloop(): Promise<RunloopClient> {
    if (!this.client) {
      const { RunloopSDK } = await optionalImport<RunloopModule>("@runloop/api-client", "runloop");
      this.client = new RunloopSDK({ bearerToken: this.apiKey });
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const rl = await this.runloop();
    const { cpu, memory } = size(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB);
    const image = spec.image?.runloop;
    try {
      const box = await rl.devbox.create({
        ...(image ? (image.startsWith("bpt_") ? { blueprint_id: image } : { blueprint_name: image }) : {}),
        environment_variables: spec.env,
        metadata: spec.metadata,
        launch_parameters: {
          resource_size_request: "CUSTOM_SIZE",
          custom_cpu_cores: cpu,
          custom_gb_memory: memory,
          keep_alive_time_seconds: Math.min(MAX_KEEP_ALIVE_SECONDS, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60))),
        },
      });
      return new RunloopBox(box);
    } catch (err: any) {
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
  }

  /** Reattach; a suspended devbox is resumed. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = (await this.runloop()).devbox.fromId(nativeId);
    try {
      const { status } = await box.getInfo();
      if (status === "suspending") await box.awaitSuspended();
      if (status === "suspending" || status === "suspended") await box.resume();
      else if (status === "resuming" || status === "provisioning" || status === "initializing" || status === "queued" || status === "scheduled") {
        await box.awaitRunning();
      } else if (status === "shutdown" || status === "failure") {
        throw new ProviderError("runloop", `devbox ${nativeId} is ${status}`);
      }
      return new RunloopBox(box);
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
  }
}

class RunloopBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private box: RunloopDevbox) {
    this.nativeId = box.id;
  }

  /** Runloop's exec has no cwd/env/timeout, so cwd/env are wrapped into the command and the timeout is enforced here. */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const limit = (opts.timeoutSeconds ?? 60) * 1000;
    let execution;
    try {
      execution = await this.box.cmd.execAsync(wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }), {
        stdout: opts.onStdout,
        stderr: opts.onStderr,
      });
    } catch (err: any) {
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
    try {
      const r = await execution.result({ longPoll: { timeoutMs: limit } });
      // Read the output from the result, not the stream, so a dropped stream can't lose output.
      const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
      return { exitCode: r.exitCode ?? -1, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      if (Date.now() - t0 >= limit) {
        await execution.kill().catch(() => {});
        throw new ProviderError("runloop", `command timed out after ${limit / 1000}s`);
      }
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const { toFile } = await optionalImport<RunloopModule>("@runloop/api-client", "runloop");
    const name = path.slice(path.lastIndexOf("/") + 1) || "file";
    try {
      await this.box.file.upload({ path, file: await toFile(Buffer.from(toBytes(content)), name) });
    } catch (err: any) {
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      const res = await this.box.file.download({ path });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err: any) {
      throw new ProviderError("runloop", err?.message ?? String(err), err?.status);
    }
  }

  /** Suspend and snapshot the disk. router.get() resumes it. */
  async pause(): Promise<void> {
    await this.box.suspend();
    await this.box.awaitSuspended();
  }

  async kill(): Promise<void> {
    await this.box.shutdown();
  }
}

/**
 * Snap a request to Runloop's CUSTOM_SIZE grid: CPU 0.5, 1 or a multiple of 2 (max 16);
 * memory 1 or a multiple of 2 GiB (max 64); memory between 2x and 8x the CPU count.
 */
function size(vcpu: number, memoryGb: number): { cpu: number; memory: number } {
  const cpu = vcpu <= 0.5 ? 0.5 : vcpu <= 1 ? 1 : Math.min(16, 2 * Math.ceil(vcpu / 2));
  const m = Math.min(8 * cpu, Math.max(2 * cpu, memoryGb));
  const memory = Math.min(64, m <= 1 ? 1 : 2 * Math.ceil(m / 2));
  return { cpu, memory };
}
