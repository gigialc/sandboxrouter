import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes } from "../util.js";

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

  async connect(nativeId: string): Promise<ProviderSandbox> {
    return new DaytonaBox(await (await this.daytona()).get(nativeId));
  }
}

class DaytonaBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: DaytonaSandbox) {
    this.nativeId = sbx.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    try {
      const r = await this.sbx.process.executeCommand(cmd, opts.cwd, opts.env, opts.timeoutSeconds ?? 60);
      // Daytona merges stdout and stderr into `result`.
      return { exitCode: r.exitCode, stdout: r.result, stderr: "", durationMs: Date.now() - t0 };
    } catch (err: any) {
      throw new ProviderError("daytona", err?.message ?? String(err));
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.fs.uploadFile(Buffer.from(toBytes(content)), path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.sbx.fs.downloadFile(path));
  }

  async kill(): Promise<void> {
    await this.sbx.delete();
  }
}
