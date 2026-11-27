export type ProviderId =
  | "maritime"
  | "e2b"
  | "daytona"
  | "modal"
  | "vercel"
  | "morph"
  | "sprites"
  | "blaxel"
  | "tensorlake"
  | "runloop"
  | "hopx"
  | "cloudflare"
  | "northflank"
  | "boat"
  | "exedev"
  | "docker"
  | "novita"
  | "langsmith"
  | "alibaba"
  | "upstash"
  | "koyeb"
  | "freestyle"
  | "deno"
  | "beam"
  | "codesandbox"
  | "azure"
  | "agentcore"
  | "lambda"
  | "dedalus"
  | "agent37"
  | "superserve"
  | "instabox"
  | "openscale"
  | "sail"
  | "digitalocean"
  | "google"
  | "runcloud";

/** Things a caller can require of a provider. The router skips providers that lack one. */
export type Capability =
  | "gpu" // GPU attached to the sandbox
  | "pause" // pause() keeps the sandbox's disk; the next call or router.get() resumes it
  | "ports" // URL for an HTTP server listening inside the sandbox
  | "background" // Start and stop a command independently of exec()
  | "custom-image"; // start from your own image/template via spec.image

/** What the caller wants. Every field is optional; providers map it to their own knobs. */
export interface SandboxSpec {
  /**
   * vCPUs. Leave vcpu and memoryGb out to take any provider at the size it starts by default: most give
   * 2 vCPU / 4 GB, but some only run a fixed, smaller image (E2B 2 vCPU / 0.5 GB, Daytona 1 / 1). Set
   * either one and only providers that can give that size are tried. `Candidate.size` and
   * `RoutedSandbox.size` say what you get.
   */
  vcpu?: number;
  /** Memory in GB. See `vcpu`. */
  memoryGb?: number;
  /** GPU type, e.g. "T4", "A100". Only providers with the "gpu" capability accept it. */
  gpu?: string;
  /** Env vars set for every command. */
  env?: Record<string, string>;
  /** HTTP ports to make available for previews. Some providers need these when the sandbox is created. */
  ports?: number[];
  /** Hard lifetime in minutes (default 30). */
  timeoutMinutes?: number;
  /**
   * How long you expect to use the sandbox, in seconds. Only a ranking hint: the sandbox still lives
   * until you kill it or `timeoutMinutes` runs out. Without it, ranking assumes the whole lifetime.
   * With it, providers are ranked by what that run would really be billed, minimum charge, billing
   * increment and per-sandbox fee included, so a provider that bills per second can beat one that is
   * cheaper per hour but charges a full minute.
   */
  expectedSeconds?: number;
  /**
   * How busy the CPU will be, 0 to 1 (default 1). Only a pricing hint: providers that bill CPU only
   * while it's busy (Vercel, Cloudflare, Tensorlake, AgentCore, DigitalOcean, Sail, Sprites, Deno, Upstash) are priced
   * at this share of their CPU plus their full memory, never below a provider's CPU floor. An agent that
   * mostly waits on model calls uses about 0.1; a build or test run is close to 1.
   */
  cpuUtilization?: number;
  /**
   * Provider-specific image/template, keyed by provider, e.g.
   * { maritime: "python", e2b: "code-interpreter-v1", modal: "python:3.13-slim" }.
   */
  image?: Partial<Record<ProviderId, string>>;
  /** Free-form tags stored on the sandbox where the provider supports it. */
  metadata?: Record<string, string>;
}

/**
 * "balanced" (and "default", the same thing): cheapest first by effective price (list price x what the
 * provider really billed, where measured; `BILLED_VS_LIST`), with providers within 10% of each other on
 * price ordered by speed (this router's own recent create times, else your `bench` file). Providers
 * whose last real-account check failed (`FAILING`) go last.
 * "verified": providers that passed the real-account check first (`VERIFIED`), then the rest; cheapest
 * list price first within each.
 * "cheapest": lowest cost for the run (priced as in "balanced": minimum charge, billing increment and
 * per-sandbox charge over `expectedSeconds`), strictly by price: no speed tie-break, and providers whose
 * last check failed aren't moved last. Ties alphabetical.
 * "fastest": lowest median create time (this router's own, else your `bench` file), then cheapest.
 */
export type Strategy = "default" | "balanced" | "verified" | "cheapest" | "fastest";

export interface RouteOptions {
  /** Pin to one provider, or give an ordered list to try. Omit to let the router choose. */
  provider?: ProviderId | ProviderId[];
  /** How to order candidates when no explicit list is given. Default: "balanced" (cheapest real cost, speed breaks near-ties). */
  strategy?: Strategy;
  /**
   * Seconds the whole create may take, over every provider it tries (default 240, under the 300 s an
   * HTTP client usually waits). When it runs out, create stops trying and throws a RouterError with
   * code "timeout"; a provider still starting is killed when it answers.
   */
  deadlineSeconds?: number;
  /**
   * What to do when a create fails. `true` (default): try the next candidate when the provider
   * looks unavailable (timeout, network error, 429, 5xx, or an error without a status) or can't bill
   * (402: no balance, plan needed), but stop on a setup error (400, 401, 403, 404, 422: a bad key, a
   * bad image or request), so a mistake isn't hidden by quietly moving the work to another, maybe
   * pricier, provider. Every failed attempt is on `sandbox.attempts`.
   * `"any"`: try the next candidate on every error. `false`: only the first candidate.
   */
  fallback?: boolean | "any";
  /** Seconds to wait for each provider's create before moving on (default 120). */
  createTimeoutSeconds?: number;
  /** Capabilities every candidate must have. */
  require?: Capability[];
  /**
   * An estimated effective hourly price limit for routing, in USD. A provider is skipped when this run
   * is estimated to cost more there: hourly price, minimum charge and billing increment over
   * `expectedSeconds` (else `timeoutMinutes`, default 30), plus any per-sandbox charge, divided by the
   * run's hours. This does not stop the sandbox or enforce a budget. Requests with unpriced GPU
   * charges cannot use this limit. Omit for no cap.
   */
  maxHourlyUsd?: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Per-command timeout in seconds (default 60). */
  timeoutSeconds?: number;
  /** Called with each chunk of stdout as it arrives. The full output is still returned. */
  onStdout?: (chunk: string) => void;
  /** Called with each chunk of stderr as it arrives. */
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** A background command uses the sandbox lifetime and returns once the provider starts it. */
export type StartOptions = Pick<ExecOptions, "cwd" | "env">;

export interface ProviderProcess {
  kill(): Promise<void>;
}

/** A background command started by a routed sandbox. */
export interface SandboxProcess extends ProviderProcess {
  readonly id: string;
}

/** A live sandbox as one provider sees it. Adapters implement this. */
export interface ProviderSandbox {
  readonly nativeId: string;
  /**
   * The provider SDK's own sandbox object (an E2B Sandbox, a Daytona Sandbox, a Modal Sandbox, ...), for features
   * the router doesn't cover. Undefined for providers driven over plain HTTP: use `nativeId` with their API.
   */
  readonly native?: unknown;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  kill(): Promise<void>;
  /** Present only on adapters with the "pause" capability. */
  pause?(): Promise<void>;
  /** Present on adapters with the "ports" capability. */
  url?(port: number): string | Promise<string>;
  /** Present on adapters with the "background" capability. */
  start?(cmd: string, opts?: StartOptions): Promise<ProviderProcess>;
}

export interface Provider {
  readonly id: ProviderId;
  /** True when the credentials this adapter needs are present. */
  configured(): boolean;
  create(spec: SandboxSpec): Promise<ProviderSandbox>;
  connect(nativeId: string): Promise<ProviderSandbox>;
}

export interface Attempt {
  /** A sandbox provider, or a computer provider (some sell only computers). */
  provider: ProviderId | (string & {});
  ok: boolean;
  ms: number;
  error?: string;
  /** HTTP status of the failure, when the provider gave one (402: the account can't pay). */
  status?: number;
}

/**
 * Why the router couldn't do what was asked. Each maps to one HTTP status in the server.
 * - bad_request (400): an invalid spec, route option or sandbox id
 * - unsupported (400): the sandbox's provider can't do this (e.g. pause)
 * - no_provider (422): no provider you have keys for can take this sandbox (`plan()` says why for each)
 * - setup (502): a provider refused the request or the key (400/401/403/404/422 from it); fix the key,
 *   image or request rather than retrying
 * - all_failed (503): every provider tried was down, busy or out of credit; retrying later can work
 * - timeout (504): the create ran out of `deadlineSeconds`
 */
export type RouterErrorCode = "bad_request" | "unsupported" | "no_provider" | "setup" | "all_failed" | "timeout";

export class RouterError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[] = [],
    readonly code: RouterErrorCode = "all_failed",
  ) {
    super(message);
    this.name = "RouterError";
  }
}

/** Thrown by adapters for HTTP failures so the router can report status codes. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId | (string & {}),
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

/**
 * A problem with local setup, such as a provider SDK that isn't installed or a missing setting:
 * something to fix here, not a provider being down. The router stops on it instead of falling back, unless it
 * was made with `accountErrors: "fallback"`.
 */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}
