import { ProviderError, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport } from "../util.js";
import { E2BBox, type E2BLikeSandbox } from "./e2b.js";

/**
 * Novita AI Agent Sandbox via the official `novita-sandbox` SDK (2.x), a fork of E2B's SDK with
 * the same surface (Sandbox.create/connect, commands.run with onStdout/onStderr, files.read/write,
 * pause, kill), so the E2B box wrapper is reused as-is.
 *
 * Why not the `e2b` SDK with Novita's domain: that was Novita's documented route for its v1
 * cluster (sandbox.novita.ai), but since the 2026-06-08 SDK 2.0 release the E2B-compatible page
 * is a "Legacy SDKs & CLI" page for the 1.x line, the default cluster moved to
 * us-phx-1.sandbox.novita.ai, and the docs only describe `novita-sandbox` for it.
 *
 * Auth: NOVITA_API_KEY (sent as X-API-KEY by the SDK). NOVITA_DOMAIN optionally picks the cluster
 * (default us-phx-1.sandbox.novita.ai; sandbox.novita.ai is the legacy v1 cluster). Resources are
 * not shared between clusters.
 * Size: vCPU and memory come from the template (set at template build time: cpuCount/memoryMB),
 * not from the create call, exactly like E2B. image.novita = template name or ID (default "base").
 * Pause keeps memory and disk; Sandbox.connect resumes it. Billing is per second for CPU and RAM
 * while running; paused sandboxes pay only persistent storage beyond 60 GB free.
 *
 * Docs: https://docs.novita.ai/guides/sandbox-overview.md (regions/domains)
 *       https://docs.novita.ai/guides/sandbox-your-first-agent-sandbox.md (NOVITA_API_KEY, SDK)
 *       https://docs.novita.ai/guides/sandbox-metadata.md (create: template, timeoutMs, envs, metadata)
 *       https://docs.novita.ai/guides/sandbox-persistence.md (pause / connect resumes)
 *       https://docs.novita.ai/guides/sandbox-quota-limit.md (vCPU/memory/session limits)
 *       https://docs.novita.ai/guides/sandbox-pricing.md
 *       https://docs.novita.ai/changelog/08-06-26 (SDK 2.0, new default cluster)
 *       https://docs.novita.ai/guides/sandbox-legacy-e2b-compatible (legacy 1.x / E2B route)
 */
const ID = "novita" as const;

/** `novita-sandbox` is an optional peer dependency and not installed here, so its types are local. */
interface NovitaModule {
  Sandbox: {
    create(template: string, opts: Record<string, unknown>): Promise<E2BLikeSandbox>;
    create(opts: Record<string, unknown>): Promise<E2BLikeSandbox>;
    connect(sandboxId: string, opts: Record<string, unknown>): Promise<E2BLikeSandbox>;
  };
}

export class NovitaProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.NOVITA_API_KEY,
    private domain = process.env.NOVITA_DOMAIN,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private conn(): Record<string, unknown> {
    if (!this.apiKey) throw new ProviderError(ID, "NOVITA_API_KEY is not set");
    return { apiKey: this.apiKey, ...(this.domain ? { domain: this.domain } : {}) };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<NovitaModule>("novita-sandbox", "novita");
    const opts = {
      ...this.conn(),
      timeoutMs: (spec.timeoutMinutes ?? 30) * 60_000,
      envs: spec.env,
      metadata: spec.metadata,
    };
    const template = spec.image?.novita;
    try {
      const sbx = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
      return new E2BBox(sbx, ID);
    } catch (err: any) {
      throw wrap(err);
    }
  }

  /** Reattach by sandbox id; a paused sandbox is resumed. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<NovitaModule>("novita-sandbox", "novita");
    try {
      return new E2BBox(await Sandbox.connect(nativeId, this.conn()), ID);
    } catch (err: any) {
      throw wrap(err);
    }
  }
}

function wrap(err: any): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = err?.name === "SandboxNotFoundError" || err?.name === "NotFoundError" ? 404 : err?.name === "AuthenticationError" ? 401 : undefined;
  return new ProviderError(ID, err?.message ?? String(err), status);
}
