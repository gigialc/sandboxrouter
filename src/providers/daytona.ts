import { randomUUID } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes, wrapCommand } from "../util.js";

type DaytonaModule = typeof import("@daytonaio/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;
type DaytonaSandbox = Awaited<ReturnType<DaytonaClient["get"]>>;

/** Daytona via `@daytonaio/sdk`. Default snapshot; set image.daytona to start from an image. */
export class DaytonaProvider implements Provider {
  readonly id = "daytona" as const;
  private client?: DaytonaClient;

  constructor(private apiKey = process.env.DAYTONA_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private async daytona(): Promise<DaytonaClient> {
    if (!this.client) {
      const { Daytona } = await optionalImport<DaytonaModule>("@daytonaio/sdk", "daytona");
      this.client = new Daytona({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const d = await this.daytona();
    const base = {
      envVars: spec.env,
      labels: spec.metadata,
      // Minutes of inactivity before Daytona stops it; delete right after stop.
      autoStopInterval: Math.max(1, Math.round(spec.timeoutMinutes ?? 30)),
      autoDeleteInterval: 0,
    };
    const sbx = spec.image?.daytona
      ? await d.create({
          ...base,
          image: spec.image.daytona,
          resources: { cpu: spec.vcpu, memory: spec.memoryGb },
        })
      : await d.create(base);
    return new DaytonaBox(sbx);
  }

  /** Reattach; a paused (stopped) sandbox is started again. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const sbx = await (await this.daytona()).get(nativeId);
    if (sbx.state === "stopped") await sbx.start();
    return new DaytonaBox(sbx);
  }
}

class DaytonaBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: DaytonaSandbox) {
    this.nativeId = sbx.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (opts.onStdout || opts.onStderr) return this.execStreaming(cmd, opts);
    const t0 = Date.now();
    try {
      const r = await this.sbx.process.executeCommand(cmd, opts.cwd, opts.env, opts.timeoutSeconds ?? 60);
      // Daytona merges stdout and stderr into `result` here.
      return { exitCode: r.exitCode, stdout: r.result, stderr: "", durationMs: Date.now() - t0 };
    } catch (err: any) {
      throw new ProviderError("daytona", err?.message ?? String(err));
    }
  }

  /** Streaming goes through a throwaway session, which also keeps stdout and stderr apart. */
  private async execStreaming(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const t0 = Date.now();
    const session = `sbr-${randomUUID()}`;
    const proc = this.sbx.process;
    let stdout = "";
    let stderr = "";
    try {
      await proc.createSession(session);
      const { cmdId } = await proc.executeSessionCommand(session, {
        command: wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }),
        runAsync: true,
      });
      const logs = proc.getSessionCommandLogs(
        session,
        cmdId,
        (c) => {
          stdout += c;
          opts.onStdout?.(c);
        },
        (c) => {
          stderr += c;
          opts.onStderr?.(c);
        },
      );
      const limit = (opts.timeoutSeconds ?? 60) * 1000;
      const timedOut = await Promise.race([logs.then(() => false), sleep(limit).then(() => true)]);
      if (timedOut) throw new ProviderError("daytona", `command timed out after ${limit / 1000}s`);
      const done = await proc.getSessionCommand(session, cmdId);
      return { exitCode: done.exitCode ?? -1, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("daytona", err?.message ?? String(err));
    } finally {
      await proc.deleteSession(session).catch(() => {});
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.fs.uploadFile(Buffer.from(toBytes(content)), path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.sbx.fs.downloadFile(path));
  }

  /** Stop and keep the disk until kill(). router.get() starts it again. */
  async pause(): Promise<void> {
    await this.sbx.setAutoDeleteInterval(-1);
    await this.sbx.stop();
  }

  async kill(): Promise<void> {
    await this.sbx.delete();
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
