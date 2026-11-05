import { ProviderError, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport } from "../util.js";
import { E2BBox, type E2BLikeSandbox } from "./e2b.js";

type E2BModule = typeof import("e2b");

/**
 * OpenScale Sandboxes (YC S22) through their E2B-compatible API, driven with the official `e2b`
 * SDK pointed at OpenScale's domain:
 *   API URL  https://api.sandbox.openscale.so   (the SDK's https://api.<domain> default)
 *   domain   sandbox.openscale.so                (data plane: <port>-<sandboxId>.<domain>)
 * OpenScale's own instructions are E2B_DOMAIN=sandbox.openscale.so plus the OpenScale key as
 * E2B_API_KEY. This adapter does not read E2B_API_KEY, so a real E2B key is never sent to
 * OpenScale (and an OpenScale key never to E2B): it reads OPENSCALE_API_KEY (the name OpenScale's
 * model docs use) and passes key, domain and apiUrl explicitly, so a stray E2B_DOMAIN or
 * E2B_API_URL can't redirect calls. E2B_SANDBOX_URL would still override the data plane, so don't
 * set it alongside this adapter.
 *
 * Auth: a pay-as-you-go OpenScale key (sk-openscale-...), the same account and credits as their
 * model API. Plan (subscription) keys are refused: the API answers 401 "Use a pay-as-you-go
 * OpenScale API key; plan keys don't run sandboxes". A new key can take ~30 s to start working.
 * Region: Singapore only for now.
 *
 * Size: vCPU and memory come from the template, as with E2B (1-8 vCPU, up to 16 GB, 25 GB disk
 * included, no GPU). image.openscale = template name or ID; default "base", the template the
 * quick start says a sandbox starts from. Custom templates are built with the E2B template
 * builder or CLI (Dockerfile) against the same domain.
 * Lifetime: timeoutMs as given; OpenScale advertises no session time limit or 24 h cap, so no cap
 * is applied here.
 * Pause/resume is advertised as built in (memory and files kept, paused sandboxes are free), so
 * the box offers pause(); Sandbox.connect resumes. Not supported yet per OpenScale: volumes,
 * secrets, fork, snapshots API.
 *
 * Docs: https://openscale.so/sandboxes (setup, limits, pricing, FAQ)
 *       https://openscale.so/app/sandboxes (keys and quick start, signed in)
 *       https://openscale.so/docs (API keys: pay-as-you-go vs plan keys)
 */
const ID = "openscale" as const;

export const OPENSCALE_DOMAIN = "sandbox.openscale.so";
const DEFAULT_TEMPLATE = "base";

export class OpenScaleProvider implements Provider {
  readonly id = ID;

  constructor(private apiKey = process.env.OPENSCALE_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal Connection options for the e2b SDK. */
  conn(): { apiKey: string; domain: string; apiUrl: string } {
    if (!this.apiKey) throw new ProviderError(ID, "OPENSCALE_API_KEY is not set");
    return { apiKey: this.apiKey, domain: OPENSCALE_DOMAIN, apiUrl: `https://api.${OPENSCALE_DOMAIN}` };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const conn = this.conn();
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "openscale");
    const timeoutMs = Math.max(1, spec.timeoutMinutes ?? 30) * 60_000;
    try {
      const sbx = await Sandbox.create(spec.image?.openscale ?? DEFAULT_TEMPLATE, {
        ...conn,
        timeoutMs,
        envs: spec.env,
        metadata: spec.metadata,
      });
      return new E2BBox(sbx as unknown as E2BLikeSandbox, ID);
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reattach by sandbox id; a paused sandbox is resumed. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const conn = this.conn();
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "openscale");
    try {
      return new E2BBox((await Sandbox.connect(nativeId, conn)) as unknown as E2BLikeSandbox, ID);
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
