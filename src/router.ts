import { CATALOG, hourlyCost, unfit } from "./catalog.js";
import { loadBench, median } from "./bench-store.js";
import { DaytonaProvider } from "./providers/daytona.js";
import { E2BProvider } from "./providers/e2b.js";
import { MaritimeProvider } from "./providers/maritime.js";
import { ModalProvider } from "./providers/modal.js";
import { VercelProvider } from "./providers/vercel.js";
import {
  RouterError,
  type Attempt,
  type ExecOptions,
  type ExecResult,
  type Provider,
  type ProviderId,
  type ProviderSandbox,
  type RouteOptions,
  type SandboxSpec,
} from "./types.js";

export interface Candidate {
  provider: ProviderId;
  estimatedHourlyUsd: number;
  medianCreateMs?: number;
  /** Why this provider won't be tried, if it won't. */
  skip?: string;
}

export interface RouterOptions {
  /** Replace the built-in adapters (tests, custom providers). */
  providers?: Provider[];
  /** Path of the bench results file used by strategy "fastest". */
  benchFile?: string;
}

export function defaultProviders(): Provider[] {
  return [new MaritimeProvider(), new E2BProvider(), new DaytonaProvider(), new ModalProvider(), new VercelProvider()];
}

export class Router {
  private providers: Map<ProviderId, Provider>;
  private benchFile?: string;

  constructor(opts: RouterOptions = {}) {
    this.providers = new Map((opts.providers ?? defaultProviders()).map((p) => [p.id, p]));
    this.benchFile = opts.benchFile;
  }

  provider(id: ProviderId): Provider {
    const p = this.providers.get(id);
    if (!p) throw new RouterError(`unknown provider: ${id}`);
    return p;
  }

  /** The ordered list of providers a create would try, with the reason any are skipped. */
  plan(spec: SandboxSpec = {}, route: RouteOptions = {}): Candidate[] {
    const explicit = route.provider ? ([] as ProviderId[]).concat(route.provider) : null;
    const ids = explicit ?? CATALOG.map((c) => c.id).filter((id) => this.providers.has(id));
    const bench = route.strategy === "fastest" ? loadBench(this.benchFile) : {};

    const list: Candidate[] = ids.map((id) => {
      const p = this.providers.get(id);
      const c: Candidate = {
        provider: id,
        estimatedHourlyUsd: round(hourlyCost(id, spec)),
        medianCreateMs: median(bench[id]?.createMs),
      };
      if (!p) c.skip = "unknown provider";
      else c.skip = unfit(id, spec, route.require) ?? (p.configured() ? undefined : "not configured");
      return c;
    });

    if (!explicit && route.strategy === "cheapest") {
      list.sort((a, b) => a.estimatedHourlyUsd - b.estimatedHourlyUsd);
    } else if (!explicit && route.strategy === "fastest") {
      list.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity));
    }
    return list;
  }

  /** Start a sandbox on the best available provider, falling back down the list on failure. */
  async create(spec: SandboxSpec = {}, route: RouteOptions = {}): Promise<RoutedSandbox> {
    const plan = this.plan(spec, route);
    const usable = plan.filter((c) => !c.skip);
    if (usable.length === 0) {
      const why = plan.map((c) => `${c.provider} (${c.skip})`).join(", ");
      throw new RouterError(`no provider can take this sandbox: ${why || "none registered"}`);
    }

    const attempts: Attempt[] = [];
    const tries = route.fallback === false ? usable.slice(0, 1) : usable;
    for (const c of tries) {
      const t0 = Date.now();
      try {
        const box = await this.provider(c.provider).create(spec);
        attempts.push({ provider: c.provider, ok: true, ms: Date.now() - t0 });
        return new RoutedSandbox(c.provider, box, attempts, c.estimatedHourlyUsd);
      } catch (err) {
        attempts.push({ provider: c.provider, ok: false, ms: Date.now() - t0, error: (err as Error).message });
      }
    }
    throw new RouterError(
      `all providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`,
      attempts,
    );
  }

  /** Reattach to a sandbox by its routed id (`provider:nativeId`). */
  async get(id: string): Promise<RoutedSandbox> {
    const { provider, nativeId } = parseId(id);
    const box = await this.provider(provider).connect(nativeId);
    return new RoutedSandbox(provider, box, [], round(hourlyCost(provider)));
  }
}

export class RoutedSandbox {
  /** Stable id across processes: `provider:nativeId`. */
  readonly id: string;

  constructor(
    readonly provider: ProviderId,
    private box: ProviderSandbox,
    /** Every create attempt, including failed fallbacks. */
    readonly attempts: Attempt[],
    readonly estimatedHourlyUsd: number,
  ) {
    this.id = `${provider}:${box.nativeId}`;
  }

  get nativeId() {
    return this.box.nativeId;
  }

  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.box.exec(cmd, opts);
  }

  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.box.writeFile(path, content);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.box.readFile(path);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.box.readFile(path));
  }

  kill(): Promise<void> {
    return this.box.kill();
  }

  /** Pause, keeping the disk. Resume with router.get(id) or, on Maritime, any call. */
  async pause(): Promise<void> {
    if (!this.box.pause) throw new RouterError(`${this.provider} does not support pause; create with require: ["pause"]`);
    await this.box.pause();
  }

  get canPause(): boolean {
    return typeof this.box.pause === "function";
  }

  async [Symbol.asyncDispose]() {
    await this.kill();
  }
}

export function parseId(id: string): { provider: ProviderId; nativeId: string } {
  const i = id.indexOf(":");
  if (i <= 0) throw new RouterError(`bad sandbox id "${id}": expected provider:id`);
  const provider = id.slice(0, i) as ProviderId;
  if (!CATALOG.some((c) => c.id === provider)) throw new RouterError(`unknown provider in id: ${provider}`);
  return { provider, nativeId: id.slice(i + 1) };
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
