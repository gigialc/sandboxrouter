import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, toBytes, wrapCommand } from "../util.js";

type VercelModule = typeof import("@vercel/sandbox");
type VercelSandbox = Awaited<ReturnType<VercelModule["Sandbox"]["get"]>>;

/**
 * Vercel Sandbox via `@vercel/sandbox`. Auth: VERCEL_OIDC_TOKEN (from `vercel env pull`), or
 * VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID. Memory is fixed at 2 GB per vCPU.
 */
export class VercelProvider implements Provider {
  readonly id = "vercel" as const;

  configured(): boolean {
    const e = process.env;
    return !!e.VERCEL_OIDC_TOKEN || (!!e.VERCEL_TOKEN && !!e.VERCEL_TEAM_ID && !!e.VERCEL_PROJECT_ID);
  }

  private creds() {
    const e = process.env;
    return e.VERCEL_TOKEN && e.VERCEL_TEAM_ID && e.VERCEL_PROJECT_ID
      ? { token: e.VERCEL_TOKEN, teamId: e.VERCEL_TEAM_ID, projectId: e.VERCEL_PROJECT_ID }
      : {};
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<VercelModule>("@vercel/sandbox", "vercel");
    const vcpus = Math.min(8, Math.max(spec.vcpu ?? DEFAULT_VCPU, Math.ceil((spec.memoryGb ?? DEFAULT_MEMORY_GB) / 2)));
    const sbx = await Sandbox.create({
      ...this.creds(),
      runtime: spec.image?.vercel ?? "node22",
      timeout: (spec.timeoutMinutes ?? 30) * 60_000,
      resources: { vcpus },
      env: spec.env,
      tags: spec.metadata,
    });
    return new VercelBox(sbx);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<VercelModule>("@vercel/sandbox", "vercel");
    return new VercelBox(await Sandbox.get({ ...this.creds(), name: nativeId }));
  }
}

class VercelBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: VercelSandbox) {
    this.nativeId = sbx.name;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const signal = AbortSignal.timeout((opts.timeoutSeconds ?? 60) * 1000);
    try {
      const r = await this.sbx.runCommand({
        cmd: "sh",
        args: ["-c", wrapCommand(cmd)],
        cwd: opts.cwd,
        env: opts.env,
        signal,
      });
      const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
      return { exitCode: r.exitCode, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      throw new ProviderError("vercel", err?.message ?? String(err));
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.writeFiles([{ path, content: Buffer.from(toBytes(content)) }]);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const buf = await this.sbx.readFileToBuffer({ path });
    if (!buf) throw new ProviderError("vercel", `no such file: ${path}`);
    return new Uint8Array(buf);
  }

  async kill(): Promise<void> {
    await this.sbx.stop();
  }
}
