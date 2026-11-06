import { CATALOG, accessLabel, hourlyCost, unfit } from "./catalog.js";
import {
  RoutedComputer,
  createComputer,
  planComputer,
  type ComputerOs,
  type ComputerProvider,
  type ComputerProviderId,
  type ComputerSpec,
} from "./computers.js";
import { loadBench, median } from "./bench-store.js";
import { Ledger, defaultLedgerFile } from "./ledger.js";
import { DEFAULT_EXEC_TIMEOUT_S, timeoutError } from "./util.js";
import { DaytonaProvider } from "./providers/daytona.js";
import { E2BProvider } from "./providers/e2b.js";
import { MaritimeProvider } from "./providers/maritime.js";
import { ModalProvider } from "./providers/modal.js";
import { VercelProvider } from "./providers/vercel.js";
import { MorphProvider } from "./providers/morph.js";
import { SpritesProvider } from "./providers/sprites.js";
import { BlaxelProvider } from "./providers/blaxel.js";
import { TensorlakeProvider } from "./providers/tensorlake.js";
import { RunloopProvider } from "./providers/runloop.js";
import { DockerProvider } from "./providers/docker.js";
import { HopxProvider } from "./providers/hopx.js";
import { CloudflareProvider } from "./providers/cloudflare.js";
import { NorthflankProvider } from "./providers/northflank.js";
import { BoatProvider } from "./providers/boat.js";
import { ExeDevProvider } from "./providers/exedev.js";
import { AgentCoreProvider } from "./providers/agentcore.js";
import { AzureSessionsProvider } from "./providers/azure.js";
import { LambdaMicrovmProvider } from "./providers/lambda.js";
import { AlibabaProvider } from "./providers/alibaba.js";
import { BeamProvider } from "./providers/beam.js";
import { CodeSandboxProvider } from "./providers/codesandbox.js";
import { DenoProvider } from "./providers/deno.js";
import { FreestyleProvider } from "./providers/freestyle.js";
import { KoyebProvider } from "./providers/koyeb.js";
import { DedalusProvider } from "./providers/dedalus.js";
import { Agent37Provider } from "./providers/agent37.js";
import { OpenScaleProvider } from "./providers/openscale.js";
import { SuperserveProvider } from "./providers/superserve.js";
import { InstaboxProvider } from "./providers/instabox.js";
import { NovitaProvider } from "./providers/novita.js";
import { UpstashProvider } from "./providers/upstash.js";
import { OrgoProvider } from "./providers/orgo.js";
import { MobilerunProvider } from "./providers/mobilerun.js";
import { LimrunProvider } from "./providers/limrun.js";
import { WorkspacesAgentProvider } from "./providers/workspaces.js";
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
  /** Desktop-only computer providers (sandbox providers that also sell computers are found automatically). */
  computers?: ComputerProvider[];
  /**
   * Record created sandboxes so leaks can be found and killed (`sandboxrouter ls` / `gc`).
   * Default: ~/.sandboxrouter/sandboxes.jsonl (or $SANDBOXROUTER_HOME); a path for another file;
   * false to keep no record. SANDBOXROUTER_LEDGER=off also turns it off.
   */
  ledger?: string | false;
}

/** Desktop-only providers. Filled in as adapters are added. */
export function defaultComputerProviders(): ComputerProvider[] {
  return [new OrgoProvider(), new MobilerunProvider(), new LimrunProvider(), new WorkspacesAgentProvider()];
}

export function defaultProviders(): Provider[] {
  return [
    new MaritimeProvider(),
    new E2BProvider(),
    new DaytonaProvider(),
    new ModalProvider(),
    new VercelProvider(),
    new MorphProvider(),
    new SpritesProvider(),
    new BlaxelProvider(),
    new TensorlakeProvider(),
    new RunloopProvider(),
    new HopxProvider(),
    new CloudflareProvider(),
    new NorthflankProvider(),
    new BoatProvider(),
    new ExeDevProvider(),
    new AgentCoreProvider(),
    new AzureSessionsProvider(),
    new LambdaMicrovmProvider(),
    new Agent37Provider(),
    new AlibabaProvider(),
    new BeamProvider(),
    new CodeSandboxProvider(),
    new DedalusProvider(),
    new DenoProvider(),
    new FreestyleProvider(),
    new InstaboxProvider(),
    new KoyebProvider(),
    new NovitaProvider(),
    new OpenScaleProvider(),
    new SuperserveProvider(),
    new UpstashProvider(),
    new DockerProvider(),
  ];
}

export class Router {
  private providers: Map<ProviderId, Provider>;
  private benchFile?: string;
  private computerOnly: ComputerProvider[];
  /** The local record of sandboxes this router created, or undefined when turned off. */
  readonly ledger?: Ledger;

  constructor(opts: RouterOptions = {}) {
    const file = opts.ledger === false ? null : (opts.ledger ?? defaultLedgerFile());
    if (file) this.ledger = new Ledger(file);
    this.providers = new Map((opts.providers ?? defaultProviders()).map((p) => [p.id, p]));
    this.benchFile = opts.benchFile;
    this.computerOnly = opts.computers ?? (opts.providers ? [] : defaultComputerProviders());
  }

  /** Registered and has credentials. False for providers this router doesn't know. */
  isConfigured(id: ProviderId): boolean {
    return this.providers.get(id)?.configured() ?? false;
  }

  /** Catalog ids this router has an adapter for, in catalog order. */
  registered(): ProviderId[] {
    return CATALOG.map((c) => c.id).filter((id) => this.providers.has(id));
  }

  provider(id: ProviderId): Provider {
    const p = this.providers.get(id);
    if (!p) throw new RouterError(`unknown provider: ${id}`);
    return p;
  }

  /** The ordered list of providers a create would try, with the reason any are skipped. */
  plan(spec: SandboxSpec = {}, route: RouteOptions = {}): Candidate[] {
    const explicit = route.provider ? ([] as ProviderId[]).concat(route.provider) : null;
    // Local providers (Docker) are never picked automatically: they always "cost" $0 and isolate
    // less than a cloud micro-VM. Name them explicitly to use them.
    const ids = explicit ?? CATALOG.filter((c) => !c.local && this.providers.has(c.id)).map((c) => c.id);
    const bench = route.strategy === "fastest" ? loadBench(this.benchFile) : {};

    const list: Candidate[] = ids.map((id) => {
      // An id the catalog has never heard of (a typo in an explicit list) has no price to look up.
      if (!CATALOG.some((c) => c.id === id)) return { provider: id, estimatedHourlyUsd: 0, skip: "unknown provider" };
      const p = this.providers.get(id);
      const c: Candidate = {
        provider: id,
        estimatedHourlyUsd: round(hourlyCost(id, spec)),
        medianCreateMs: median(bench[id]?.createMs),
      };
      if (!p) c.skip = "no adapter registered";
      else {
        const gated = accessLabel(id);
        c.skip = unfit(id, spec, route.require) ?? (p.configured() ? undefined : gated ? `not configured; ${gated}` : "not configured");
      }
      return c;
    });

    // Neutral by construction: price (or measured speed) decides, ties break alphabetically by id.
    // An explicit provider list keeps the caller's order.
    if (!explicit) {
      const byPrice = (a: Candidate, b: Candidate) => a.estimatedHourlyUsd - b.estimatedHourlyUsd || a.provider.localeCompare(b.provider);
      if (route.strategy === "fastest") {
        list.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity) || byPrice(a, b));
      } else {
        list.sort(byPrice);
      }
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
        const sbx = new RoutedSandbox(c.provider, box, attempts, c.estimatedHourlyUsd, this.ledger);
        const now = Date.now();
        this.ledger?.open({
          id: sbx.id,
          provider: c.provider,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + (spec.timeoutMinutes ?? 30) * 60_000).toISOString(),
          usdHour: c.estimatedHourlyUsd,
        });
        return sbx;
      } catch (err) {
        attempts.push({ provider: c.provider, ok: false, ms: Date.now() - t0, error: (err as Error).message });
      }
    }
    throw new RouterError(
      `all providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`,
      attempts,
    );
  }

  /** Every provider that sells computers (desktops/phones): sandbox providers that do, plus desktop-only ones. */
  computerProviders(): ComputerProvider[] {
    const fromSandboxes = [...this.providers.values()].filter((p): p is Provider & ComputerProvider => "createComputer" in p);
    return [...fromSandboxes, ...this.computerOnly];
  }

  /** The order a computer create would try for this OS. */
  planComputer(os: ComputerOs = "linux", opts: { provider?: ComputerProviderId | ComputerProviderId[] } = {}) {
    const prefer = opts.provider ? ([] as ComputerProviderId[]).concat(opts.provider) : undefined;
    return planComputer(this.computerProviders(), os, prefer);
  }

  /** Start a desktop or phone on the cheapest provider for its OS (ties alphabetical), with fallback. */
  computer(spec: ComputerSpec = {}, opts: { provider?: ComputerProviderId | ComputerProviderId[] } = {}): Promise<RoutedComputer> {
    const prefer = opts.provider ? ([] as ComputerProviderId[]).concat(opts.provider) : undefined;
    return createComputer(this.computerProviders(), spec, prefer);
  }

  async getComputer(id: string): Promise<RoutedComputer> {
    const i = id.indexOf(":");
    if (i <= 0) throw new RouterError(`bad computer id "${id}": expected provider:id`);
    const provider = id.slice(0, i);
    const p = this.computerProviders().find((c) => c.id === provider);
    if (!p) throw new RouterError(`${provider} does not offer computers`);
    return new RoutedComputer(provider, await p.connectComputer(id.slice(i + 1)));
  }

  /** Reattach to a sandbox by its routed id (`provider:nativeId`). */
  async get(id: string): Promise<RoutedSandbox> {
    const { provider, nativeId } = parseId(id);
    const box = await this.provider(provider).connect(nativeId);
    return new RoutedSandbox(provider, box, [], round(hourlyCost(provider)), this.ledger);
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
    private ledger?: Ledger,
  ) {
    this.id = `${provider}:${box.nativeId}`;
  }

  get nativeId() {
    return this.box.nativeId;
  }

  /**
   * Run a command. If it outlives `opts.timeoutSeconds` the adapter stops it and this rejects with
   * `ProviderError("<provider>: command timed out after Ns")`. Should an adapter fail to notice its
   * own deadline, the router gives up `EXEC_GRACE_S` later with the same error, so callers can
   * always rely on the timeout being bounded and the message being the same on every provider.
   */
  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    return withDeadline(this.box.exec(cmd, opts), (seconds + EXEC_GRACE_S) * 1000, () => timeoutError(this.provider, seconds));
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

  async kill(): Promise<void> {
    await this.box.kill();
    this.ledger?.close(this.id);
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

/** Seconds past a command's timeout before the router stops waiting for the adapter. */
export const EXEC_GRACE_S = 30;

/** Resolve with `work`, or reject with `onExpire()` after `ms`. A late `work` rejection is swallowed. */
async function withDeadline<T>(work: Promise<T>, ms: number, onExpire: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onExpire()), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}
