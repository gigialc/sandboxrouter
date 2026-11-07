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
  /** vCPUs (default 2). */
  vcpu?: number;
  /** Memory in GB (default 4). */
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
 * "cheapest" (and "default", the same thing): lowest list price for the spec, ties alphabetical.
 * "fastest": lowest median cold start you measured with `bench`, then cheapest.
 */
export type Strategy = "default" | "cheapest" | "fastest";

export interface RouteOptions {
  /** Pin to one provider, or give an ordered list to try. Omit to let the router choose. */
  provider?: ProviderId | ProviderId[];
  /** How to order candidates when no explicit list is given. Default: cheapest. */
  strategy?: Strategy;
  /**
   * What to do when a create fails. `true` (default): try the next candidate when the provider
   * looks unavailable (timeout, network error, 429, 5xx, or an error without a status), but stop on
   * a setup error (400, 401, 402, 403, 404, 422: a bad key, no billing, a bad image or request), so
   * a mistake isn't hidden by quietly moving the work to another, maybe pricier, provider.
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
  provider: ProviderId;
  ok: boolean;
  ms: number;
  error?: string;
}

export class RouterError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[] = [],
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
