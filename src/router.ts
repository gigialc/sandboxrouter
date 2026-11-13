import { CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, accessLabel, fixedSize, hourlyCost, unfit } from "./catalog.js";
import {
  type ComputerRoute,
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
import { DEFAULT_EXEC_TIMEOUT_S, SETUP_ERRORS, errorStatus, timeoutError, withDeadline } from "./util.js";
import { BILLED_VS_LIST } from "./billing.js";
import { FAILING, VERIFIED } from "./verified.js";
import { validate } from "./validate.js";
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
import { SailProvider } from "./providers/sail.js";
import { InstaboxProvider } from "./providers/instabox.js";
import { NovitaProvider } from "./providers/novita.js";
import { LangSmithProvider } from "./providers/langsmith.js";
import { UpstashProvider } from "./providers/upstash.js";
import { OrgoProvider } from "./providers/orgo.js";
import { MobilerunProvider } from "./providers/mobilerun.js";
import { LimrunProvider } from "./providers/limrun.js";
import { WorkspacesAgentProvider } from "./providers/workspaces.js";
import {
  ProviderError,
  SetupError,
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

/** vCPUs and memory a sandbox gets. */
export interface Size {
  vcpu: number;
  memoryGb: number;
}

export interface Candidate {
  provider: ProviderId;
  /**
   * What the sandbox is expected to cost, USD/hour: the provider's list price for this size, times what
   * it really billed against list price where we measured that (`billedVsList`). The default strategy
   * ranks by this, and a service reselling sandboxes should charge from it.
   */
  estimatedHourlyUsd: number;
  /** The provider's published list price for this size, USD/hour. */
  listHourlyUsd: number;
  /** Billed / list-price ratio behind `estimatedHourlyUsd`, when measured (`BILLED_VS_LIST`). */
  billedVsList?: number;
  /**
   * The size the sandbox gets: the provider's fixed default image size where it has one, else what was
   * asked for (2 vCPU / 4 GB when nothing was). Some providers round up to their next size.
   */
  size: Size;
  /** Median create time: this router's own recent creates when it has a few, else your `bench` file. */
  medianCreateMs?: number;
  /** Passed the real-account check (as of this release, or `RouterOptions.verified`). */
  verified: boolean;
  /** Failed a step of its last real-account check (as of this release, or `RouterOptions.failing`). */
  failing: boolean;
  /** Why this provider won't be tried, if it won't. */
  skip?: string;
}

/** Providers within this share of the cheapest remaining price count as a tie, broken by speed. */
export const PRICE_TIE = 0.1;
/** Creates this router must have seen for a provider before its own timings replace the bench file's. */
const LIVE_MIN_SAMPLES = 3;
/** Recent creates kept per provider for the live median. */
const LIVE_SAMPLES = 20;

export interface RouterOptions {
  /** Replace the built-in adapters (tests, custom providers). */
  providers?: Provider[];
  /** Path of the bench results file: start times for the speed tie-break and strategy "fastest". */
  benchFile?: string;
  /** Desktop-only computer providers (sandbox providers that also sell computers are found automatically). */
  computers?: ComputerProvider[];
  /**
   * Record created sandboxes so leaks can be found and killed (`sandboxrouter ls` / `gc`).
   * Default: ~/.sandboxrouter/sandboxes.jsonl (or $SANDBOXROUTER_HOME); a path for another file;
   * false to keep no record. SANDBOXROUTER_LEDGER=off also turns it off.
   */
  ledger?: string | false;
  /**
   * Providers that passed the real-account check: tried first by strategy "verified", and the only ones
   * used with `requireVerified`. Default: those that passed as of this release (`VERIFIED`). Pass your own
   * list, e.g. after running `check` yourself.
   */
  verified?: ProviderId[];
  /** Providers whose last real-account check failed. The default strategy tries them last. Default: `FAILING`. */
  failing?: ProviderId[];
  /**
   * Only route to providers in `verified`; the rest are skipped. For services that run sandboxes on their own
   * accounts, where a provider that misbehaves without failing (keeps billing after kill, garbles output)
   * costs money. Default false.
   */
  requireVerified?: boolean;
  /** Billed / list-price ratio per provider, behind `estimatedHourlyUsd`. Default: the ratios in `BILLED_VS_LIST`, from saved cost runs. */
  billedVsList?: Partial<Record<ProviderId, number>>;
  /**
   * When a create runs well past a provider's usual start time, try the next provider sooner than
   * `createTimeoutSeconds`. The wait becomes `factor` x the provider's median start time (or 1.5x the
   * slowest of its recent starts, if longer), at least `minSeconds`. It applies only when the caller
   * didn't set `createTimeoutSeconds`, the router has a start time for the provider (3 of its own creates,
   * or the bench file), and another provider is left to try. Default `{ factor: 5, minSeconds: 10 }`;
   * `false` always waits the full `createTimeoutSeconds`.
   */
  quickFallback?: false | { factor?: number; minSeconds?: number };
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
    new LangSmithProvider(),
    new OpenScaleProvider(),
    new SuperserveProvider(),
    new SailProvider(),
    new UpstashProvider(),
    new DockerProvider(),
  ];
}

export class Router {
  private providers: Map<ProviderId, Provider>;
  private benchFile?: string;
  private readonly verified: Set<ProviderId>;
  private readonly failing: Set<ProviderId>;
  private readonly requireVerified: boolean;
  private readonly billed: Partial<Record<ProviderId, number>>;
  /** Create times this router measured, most recent last. */
  private readonly live = new Map<ProviderId, number[]>();
  private computerOnly: ComputerProvider[];
  private readonly quick: false | { factor: number; minSeconds: number };
  /** The local record of sandboxes this router created, or undefined when turned off. */
  readonly ledger?: Ledger;

  constructor(opts: RouterOptions = {}) {
    const file = opts.ledger === false ? null : (opts.ledger ?? defaultLedgerFile());
    if (file) this.ledger = new Ledger(file);
    this.providers = new Map((opts.providers ?? defaultProviders()).map((p) => [p.id, p]));
    this.benchFile = opts.benchFile;
    this.verified = new Set(opts.verified ?? (Object.keys(VERIFIED) as ProviderId[]));
    this.failing = new Set(opts.failing ?? (Object.keys(FAILING) as ProviderId[]));
    this.requireVerified = opts.requireVerified ?? false;
    this.billed =
      opts.billedVsList ?? Object.fromEntries(Object.entries(BILLED_VS_LIST).map(([id, b]) => [id, b!.ratio]));
    this.computerOnly = opts.computers ?? (opts.providers ? [] : defaultComputerProviders());
    this.quick = opts.quickFallback === false ? false : { factor: 5, minSeconds: 10, ...opts.quickFallback };
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
    if (!p) throw new RouterError(`unknown provider: ${id}`, [], "bad_request");
    return p;
  }

  /** The ordered list of providers a create would try, with the reason any are skipped. */
  plan(spec: SandboxSpec = {}, route: RouteOptions = {}): Candidate[] {
    validate(spec, route);
    const explicit = route.provider ? ([] as ProviderId[]).concat(route.provider) : null;
    // Local providers (Docker) are never picked automatically: they always "cost" $0 and isolate
    // less than a cloud micro-VM. Name them explicitly to use them.
    const ids = explicit ?? CATALOG.filter((c) => !c.local && this.providers.has(c.id)).map((c) => c.id);
    const strategy = route.strategy ?? "default";
    const speed = strategy === "default" || strategy === "balanced" || strategy === "fastest";
    const bench = speed ? loadBench(this.benchFile) : {};

    const list: Candidate[] = ids.map((id) => {
      // An id the catalog has never heard of (a typo in an explicit list) has no price to look up.
      if (!CATALOG.some((c) => c.id === id)) {
        return { provider: id, estimatedHourlyUsd: 0, listHourlyUsd: 0, size: { vcpu: 0, memoryGb: 0 }, verified: false, failing: false, skip: "unknown provider" };
      }
      const p = this.providers.get(id);
      const list = round(hourlyCost(id, spec));
      const ratio = this.billed[id];
      const live = this.live.get(id);
      const c: Candidate = {
        provider: id,
        estimatedHourlyUsd: round(list * (ratio ?? 1)),
        listHourlyUsd: list,
        ...(ratio !== undefined ? { billedVsList: ratio } : {}),
        size: sizeOf(id, spec),
        medianCreateMs: speed ? (live && live.length >= LIVE_MIN_SAMPLES ? median(live) : median(bench[id]?.createMs)) : undefined,
        verified: this.verified.has(id),
        failing: this.failing.has(id),
      };
      if (!p) c.skip = "no adapter registered";
      else {
        const gated = accessLabel(id);
        c.skip =
          unfit(id, spec, route.require) ??
          (p.configured() ? undefined : gated ? `not configured; ${gated}` : "not configured") ??
          (this.requireVerified && !c.verified ? "not tested (this router only uses providers that passed the real-account check)" : undefined);
      }
      return c;
    });

    // Neutral by construction: the same rule for every provider, ties alphabetical by id. Nothing here
    // depends on who the provider is, only on its price, what it really billed, how fast it started for
    // this router and whether its last real-account check failed. An explicit list keeps the caller's order.
    if (!explicit) {
      const byCost = (a: Candidate, b: Candidate) => a.estimatedHourlyUsd - b.estimatedHourlyUsd || a.provider.localeCompare(b.provider);
      const byList = (a: Candidate, b: Candidate) => a.listHourlyUsd - b.listHourlyUsd || a.provider.localeCompare(b.provider);
      if (strategy === "fastest") {
        list.sort((a, b) => (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity) || byCost(a, b));
      } else if (strategy === "cheapest") {
        list.sort(byList);
      } else if (strategy === "verified") {
        list.sort((a, b) => Number(b.verified) - Number(a.verified) || byCost(a, b));
      } else {
        return balanced(list);
      }
    }
    return list;
  }

  /**
   * Why a create has nowhere to go, leading with what the caller can fix: no keys at all, or why the
   * providers they do have keys for were skipped.
   */
  private whyNone(plan: Candidate[], explicit: boolean): string {
    if (plan.length === 0) return "no provider can take this sandbox: none registered";
    // Providers the caller named: say what each one needs.
    if (explicit) {
      const why = plan.map((c) => {
        const vars = CATALOG.find((x) => x.id === c.provider)?.credentials.map((g) => g.join(" + ")).join(" or ");
        return `${c.provider} (${c.skip}${vars && c.skip?.startsWith("not configured") ? `: set ${vars}` : ""})`;
      });
      return `no provider can take this sandbox: ${why.join(", ")}`;
    }
    const keyed = plan.filter((c) => this.isConfigured(c.provider));
    if (keyed.length === 0)
      return (
        "no provider keys found: set the API key for at least one provider (the README's Env table lists each provider's variables); " +
        "`npx @sandboxrouter/sdk providers` shows which are set"
      );
    const rest = plan.length - keyed.length;
    const small = keyed.filter((c) => c.skip?.startsWith("default image"));
    return (
      `none of the providers you have keys for can take this sandbox: ${keyed.map((c) => `${c.provider} (${c.skip})`).join(", ")}` +
      (rest ? `; ${rest} other provider${rest === 1 ? " has" : "s have"} no key set` : "") +
      (small.length
        ? `. To use ${small.map((c) => c.provider).join(" or ")}, leave out vcpu and memoryGb to get the default image's size, ` +
          `or pass image: { ${small[0].provider}: "<template>" } with a template built at the size you need`
        : "")
    );
  }

  /** Start a sandbox on the best available provider, falling back down the list on failure. */
  async create(spec: SandboxSpec = {}, route: RouteOptions = {}): Promise<RoutedSandbox> {
    const plan = this.plan(spec, route);
    const usable = plan.filter((c) => !c.skip);
    if (usable.length === 0) throw new RouterError(this.whyNone(plan, !!route.provider), [], "no_provider");
    // Pinned with no fallback: the first provider named, or nothing. Never a different one.
    if (route.provider && route.fallback === false && plan[0].skip) {
      throw new RouterError(`${plan[0].provider} can't take this sandbox: ${plan[0].skip}`, [], "no_provider");
    }

    const attempts: Attempt[] = [];
    const tries = route.fallback === false ? usable.slice(0, 1) : usable;
    const deadline = Date.now() + (route.deadlineSeconds ?? DEFAULT_CREATE_DEADLINE_S) * 1000;
    for (const [i, c] of tries.entries()) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new RouterError(
          `create ran out of time (deadlineSeconds) after trying ${attempts.map((a) => a.provider).join(", ")}: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`,
          attempts,
          "timeout",
        );
      }
      const t0 = Date.now();
      const pending = this.provider(c.provider).create(spec);
      const { limitS, typicalMs } = this.waitFor(c.provider, route, i === tries.length - 1);
      const waitS = Math.min(limitS, left / 1000);
      const price: SandboxPrice = { estimatedHourlyUsd: c.estimatedHourlyUsd, listHourlyUsd: c.listHourlyUsd, size: c.size };
      let timedOut = false;
      try {
        const box = await withDeadline(pending, waitS * 1000, () => {
          timedOut = true;
          const usual = typicalMs !== undefined && waitS < (route.createTimeoutSeconds ?? DEFAULT_CREATE_TIMEOUT_S) ? `; it usually starts in ${Number((typicalMs / 1000).toFixed(1))}s` : "";
          return new ProviderError(c.provider, `create timed out after ${Number(waitS.toFixed(1))}s${usual}`);
        });
        attempts.push({ provider: c.provider, ok: true, ms: Date.now() - t0 });
        this.observe(c.provider, Date.now() - t0);
        const sbx = new RoutedSandbox(c.provider, box, attempts, price, this.ledger);
        this.record(sbx, price, spec.timeoutMinutes);
        return sbx;
      } catch (err) {
        // A create that answers after we gave up still made a sandbox: record it, then kill it,
        // so it can't bill unseen. If the kill fails, the ledger entry is left for `gc`.
        if (timedOut) pending.then((late) => this.discard(c.provider, late, price, spec.timeoutMinutes), () => {});
        const status = errorStatus(err);
        attempts.push({ provider: c.provider, ok: false, ms: Date.now() - t0, error: (err as Error).message, ...(status ? { status } : {}) });
        const setup = err instanceof SetupError || (status !== undefined && SETUP_ERRORS.has(status));
        if (route.fallback !== "any" && setup) {
          const msg = (err as Error).message.replace(/[.\s]+$/, "");
          throw new RouterError(
            `${msg.startsWith(c.provider) ? msg : `${c.provider}: ${msg}`}. This looks like a setup problem with ${c.provider} (key, image, request or a missing package), ` +
              `so the router stopped instead of moving the work to another provider; pass fallback: "any" to fall back on every error`,
            attempts,
            "setup",
          );
        }
      }
    }
    throw new RouterError(
      `all providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`,
      attempts,
      "all_failed",
    );
  }

  /**
   * Seconds to wait for this provider's create: the caller's `createTimeoutSeconds`, or (see
   * `quickFallback`) a few times its usual start time when another provider is left to try.
   */
  private waitFor(id: ProviderId, route: RouteOptions, last: boolean): { limitS: number; typicalMs?: number } {
    const full = route.createTimeoutSeconds ?? DEFAULT_CREATE_TIMEOUT_S;
    if (!this.quick || last || route.createTimeoutSeconds !== undefined) return { limitS: full };
    const live = this.live.get(id);
    const samples = live && live.length >= LIVE_MIN_SAMPLES ? live : loadBench(this.benchFile)[id]?.createMs;
    const typicalMs = median(samples);
    if (typicalMs === undefined || !samples?.length) return { limitS: full };
    const s = Math.max(this.quick.factor * typicalMs, 1.5 * Math.max(...samples)) / 1000;
    return { limitS: Math.min(full, Math.max(this.quick.minSeconds, s)), typicalMs };
  }

  /** Remember a successful create's time, for the speed tie-break and strategy "fastest". */
  private observe(id: ProviderId, ms: number) {
    const xs = this.live.get(id) ?? [];
    xs.push(ms);
    if (xs.length > LIVE_SAMPLES) xs.shift();
    this.live.set(id, xs);
  }

  private record(sbx: RoutedSandbox, price: SandboxPrice, timeoutMinutes?: number) {
    const now = Date.now();
    this.ledger?.open({
      id: sbx.id,
      provider: sbx.provider,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (timeoutMinutes ?? 30) * 60_000).toISOString(),
      usdHour: price.estimatedHourlyUsd,
      listUsdHour: price.listHourlyUsd,
      size: price.size,
    });
  }

  private discard(provider: ProviderId, box: ProviderSandbox, price: SandboxPrice, timeoutMinutes?: number) {
    const sbx = new RoutedSandbox(provider, box, [], price, this.ledger);
    this.record(sbx, price, timeoutMinutes);
    return sbx.kill().catch(() => {});
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
  /** Start a desktop or phone, routed like a sandbox (see createComputer). */
  computer(spec: ComputerSpec = {}, route: ComputerRoute = {}): Promise<RoutedComputer> {
    const prefer = route.provider ? ([] as ComputerProviderId[]).concat(route.provider) : undefined;
    return createComputer(this.computerProviders(), spec, prefer, { ...route, ledger: this.ledger });
  }

  async getComputer(id: string): Promise<RoutedComputer> {
    const i = id.indexOf(":");
    if (i <= 0) throw new RouterError(`bad computer id "${id}": expected provider:id`, [], "bad_request");
    const provider = id.slice(0, i);
    const p = this.computerProviders().find((c) => c.id === provider);
    if (!p) throw new RouterError(`${provider} does not offer computers`, [], "bad_request");
    const e = this.ledger?.list().find((x) => x.id === id);
    return new RoutedComputer(provider, await p.connectComputer(id.slice(i + 1)), [], e?.usdHour, this.ledger);
  }

  /** Reattach to a sandbox by its routed id (`provider:nativeId`). */
  async get(id: string): Promise<RoutedSandbox> {
    const { provider, nativeId } = parseId(id);
    const box = await this.provider(provider).connect(nativeId);
    // The price and size come from this machine's ledger when it started the sandbox; otherwise
    // they're unknown (a guess at the default size would be wrong for anything bigger).
    const e = this.ledger?.list().find((x) => x.id === id);
    const price = e && e.listUsdHour !== undefined && e.size ? { estimatedHourlyUsd: e.usdHour, listHourlyUsd: e.listUsdHour, size: e.size } : undefined;
    return new RoutedSandbox(provider, box, [], price, this.ledger);
  }
}

/** What a sandbox costs and its size, as the router priced it when it was created. */
export interface SandboxPrice {
  /** Expected cost, USD/hour: list price x what the provider really billed against it, where measured. */
  estimatedHourlyUsd: number;
  /** The provider's published list price for this size, USD/hour. */
  listHourlyUsd: number;
  size: Size;
}

export class RoutedSandbox {
  /** Stable id across processes: `provider:nativeId`. */
  readonly id: string;
  /** Expected cost, USD/hour (see `Candidate.estimatedHourlyUsd`). Undefined for a handle from `get()` this machine didn't create. */
  readonly estimatedHourlyUsd?: number;
  /** The provider's list price for this size, USD/hour. */
  readonly listHourlyUsd?: number;
  /** The size it was created at (see `Candidate.size`). */
  readonly size?: Size;

  constructor(
    readonly provider: ProviderId,
    private box: ProviderSandbox,
    /** Every create attempt, including failed fallbacks. */
    readonly attempts: Attempt[],
    price?: SandboxPrice,
    private ledger?: Ledger,
  ) {
    this.id = `${provider}:${box.nativeId}`;
    this.estimatedHourlyUsd = price?.estimatedHourlyUsd;
    this.listHourlyUsd = price?.listHourlyUsd;
    this.size = price?.size;
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
    if (!this.box.pause) throw new RouterError(`${this.provider} does not support pause; create with require: ["pause"]`, [], "unsupported");
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
  if (i <= 0) throw new RouterError(`bad sandbox id "${id}": expected provider:id`, [], "bad_request");
  const provider = id.slice(0, i) as ProviderId;
  if (!CATALOG.some((c) => c.id === provider)) throw new RouterError(`unknown provider in id: ${provider}`, [], "bad_request");
  return { provider, nativeId: id.slice(i + 1) };
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}

/**
 * The default order. Providers whose last real-account check failed go last. The rest go cheapest
 * first by effective price (list price x what the provider really billed, where measured), except that
 * providers within PRICE_TIE of the cheapest remaining one count as a tie and go fastest first (by
 * median create time; unknown speed after known), then cheapest, then alphabetical.
 */
export function balanced(list: Candidate[]): Candidate[] {
  const byCost = (a: Candidate, b: Candidate) => a.estimatedHourlyUsd - b.estimatedHourlyUsd || a.provider.localeCompare(b.provider);
  const bySpeed = (a: Candidate, b: Candidate) =>
    (a.medianCreateMs ?? Infinity) - (b.medianCreateMs ?? Infinity) || byCost(a, b);
  const order = (group: Candidate[]) => {
    const rest = [...group].sort(byCost);
    const out: Candidate[] = [];
    while (rest.length) {
      const limit = rest[0].estimatedHourlyUsd * (1 + PRICE_TIE);
      // Always take at least the cheapest, so the loop ends whatever the prices are.
      const tie = rest.filter((c, i) => i === 0 || c.estimatedHourlyUsd <= limit);
      out.push(...tie.sort(bySpeed));
      rest.splice(0, tie.length);
    }
    return out;
  };
  return [...order(list.filter((c) => !c.failing)), ...order(list.filter((c) => c.failing))];
}

/** Seconds to wait for one provider's create before trying the next (RouteOptions.createTimeoutSeconds). */
export const DEFAULT_CREATE_TIMEOUT_S = 120;

/** Seconds a whole create may take over every provider it tries (RouteOptions.deadlineSeconds). */
export const DEFAULT_CREATE_DEADLINE_S = 240;


/** Seconds past a command's timeout before the router stops waiting for the adapter. */
export const EXEC_GRACE_S = 30;


/** The size a provider gives for a spec: its fixed default image size, else what was asked for. */
export function sizeOf(id: ProviderId, spec: SandboxSpec = {}): Size {
  return fixedSize(id, spec) ?? { vcpu: spec.vcpu ?? DEFAULT_VCPU, memoryGb: spec.memoryGb ?? DEFAULT_MEMORY_GB };
}
