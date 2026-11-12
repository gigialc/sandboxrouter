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
  | "sail";

/** Things a caller can require of a provider. The router skips providers that lack one. */
export type Capability =
  | "gpu" // GPU attached to the sandbox
  | "pause" // pause() keeps the sandbox's disk; the next call or router.get() resumes it
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
  /** Hard lifetime in minutes (default 30). */
  timeoutMinutes?: number;
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
 * "cheapest": lowest list price for the spec, tested or not, ties alphabetical.
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

/** A live sandbox as one provider sees it. Adapters implement this. */
export interface ProviderSandbox {
  readonly nativeId: string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  kill(): Promise<void>;
  /** Present only on adapters with the "pause" capability. */
  pause?(): Promise<void>;
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
 * something to fix here, not a provider being down. The router stops on it instead of falling back.
 */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}
