import { ProviderError, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport } from "../util.js";
import { E2BCompatBox, type E2BLikeSandbox } from "./e2b.js";

type E2BModule = typeof import("e2b");

/**
 * Alibaba Cloud Agent Sandbox (Flash Edition) through its E2B-compatible API, driven with the
 * official `e2b` SDK pointed at Alibaba's regional endpoints:
 *   API URL  https://api.<region>.sandbox.aliyuncs.com
 *   domain   <region>.sandbox.aliyuncs.com   (data plane: <port>-<sandboxId>.<domain>, the SDK's default)
 * Documented regions: cn-beijing, cn-shanghai, cn-hangzhou, cn-shenzhen, cn-hongkong,
 * ap-southeast-1, us-east-1, us-west-1. The API key, region, template and sandbox must all belong
 * to the same account and region. Default region here: ap-southeast-1 (Singapore).
 *
 * Auth: ALIBABA_SANDBOX_API_KEY, created in the Agent Sandbox console (Function Compute and
 * Agent Sandbox Flash Edition must be activated first). ALIBABA_SANDBOX_REGION picks the region.
 * apiUrl is passed explicitly (it equals the SDK's https://api.<domain> default) so a stray
 * E2B_API_URL in the environment can't redirect calls; E2B_SANDBOX_URL would still override the
 * data plane, so don't set it alongside this adapter.
 *
 * Size: vCPU and memory come from the template, as with E2B. image.alibaba = template name or ID;
 * default "code-interpreter-v1", the only official template the docs name (2 vCPU / 2048 MiB in
 * the CLI docs' sample listing, which is labelled as format-only).
 * Lifetime: timeoutMs, max 86 400 s (24 h) in the active state.
 * Pause/resume exists but "is currently available only to allowlisted accounts", so this adapter
 * does not offer pause.
 * Not supported by Alibaba's E2B layer: snapshots, volumes, team/API-key management, E2B MCP gateway.
 *
 * Docs: https://www.alibabacloud.com/help/en/agent-sandbox/e2b-sdk-integration-parameter-description
 *       https://www.alibabacloud.com/help/en/agent-sandbox/e2b-sdk-compatible-api-list
 *       https://www.alibabacloud.com/help/en/agent-sandbox/using-the-cloud-sandbox-via-the-sdk
 *       https://www.alibabacloud.com/help/en/agent-sandbox/create-a-sandbox
 *       https://www.alibabacloud.com/help/en/agent-sandbox/lifecycle
 *       https://www.alibabacloud.com/help/en/agent-sandbox/create-api-key
 *       https://www.alibabacloud.com/help/en/agent-sandbox/usage-constraints-of-fc-agent-sandbox
 *       https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview
 */
const ID = "alibaba" as const;

export const ALIBABA_REGIONS = [
  "cn-beijing",
  "cn-shanghai",
  "cn-hangzhou",
  "cn-shenzhen",
  "cn-hongkong",
  "ap-southeast-1",
  "us-east-1",
  "us-west-1",
] as const;

const DEFAULT_REGION = "ap-southeast-1";
const DEFAULT_TEMPLATE = "code-interpreter-v1";
/** Longest single active period Flash Edition allows. */
const MAX_TIMEOUT_MS = 86_400_000;

export class AlibabaProvider implements Provider {
  readonly id = ID;

  constructor(
    private apiKey = process.env.ALIBABA_SANDBOX_API_KEY,
    private region = process.env.ALIBABA_SANDBOX_REGION || DEFAULT_REGION,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal Connection options for the e2b SDK. */
  conn(): { apiKey: string; domain: string; apiUrl: string } {
    if (!this.apiKey) throw new ProviderError(ID, "ALIBABA_SANDBOX_API_KEY is not set");
    // Unlisted regions are allowed (new ones get added), but the value becomes a hostname.
    if (!/^[a-z]{2}(-[a-z0-9]+)+$/.test(this.region)) throw new ProviderError(ID, `invalid region: ${this.region}`);
    const domain = `${this.region}.sandbox.aliyuncs.com`;
    return { apiKey: this.apiKey, domain, apiUrl: `https://api.${domain}` };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const conn = this.conn();
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "alibaba");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, spec.timeoutMinutes ?? 30) * 60_000);
    try {
      const sbx = await Sandbox.create(spec.image?.alibaba ?? DEFAULT_TEMPLATE, {
        ...conn,
        timeoutMs,
        envs: spec.env,
        metadata: spec.metadata,
      });
      return new E2BCompatBox(sbx as unknown as E2BLikeSandbox, ID);
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reattach by sandbox id (a paused sandbox is resumed on connect, per Alibaba's lifecycle docs). */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const conn = this.conn();
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "alibaba");
    try {
      return new E2BCompatBox((await Sandbox.connect(nativeId, conn)) as unknown as E2BLikeSandbox, ID);
    } catch (err) {
      throw wrap(err);
    }
  }
}

function wrap(err: any): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = err?.name === "SandboxNotFoundError" || err?.name === "NotFoundError" ? 404 : err?.name === "AuthenticationError" ? 401 : undefined;
  return new ProviderError(ID, err?.message ?? String(err), status);
}
