import { ProviderError, SetupError, type ProviderId } from "./types.js";

/** Per-command timeout when ExecOptions.timeoutSeconds is not given. */
export const DEFAULT_EXEC_TIMEOUT_S = 60;

/** Single-quote a string for POSIX sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build `cd dir && export VAR=x && { cmd }` for providers whose exec API lacks cwd/env.
 *
 * Every step is chained with `&&`, so a missing cwd stops the command from running somewhere
 * else, and the shell exits with cd's status instead. The command itself is grouped so its own
 * `;` or `||` can't escape the chain; the newline before `}` keeps a trailing `#` comment in the
 * command from swallowing the brace.
 */
export function wrapCommand(cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const prelude: string[] = [];
  if (opts.cwd) prelude.push(`cd ${shq(opts.cwd)}`);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${k}`);
    prelude.push(`export ${k}=${shq(v)}`);
  }
  if (prelude.length === 0) return cmd;
  return `${prelude.join(" && ")} && {\n${cmd}\n}`;
}

/** The one error every adapter throws when a command outlives ExecOptions.timeoutSeconds. */
export function timeoutError(provider: ProviderId | (string & {}), seconds: number): ProviderError {
  return new ProviderError(provider, `command timed out after ${seconds}s`);
}

/**
 * True when an exit code is the one left behind by a timeout kill and the command really ran
 * for the whole timeout: 124 from coreutils `timeout`, 137 after SIGKILL, 143 after SIGTERM, or a
 * negative code (how some SDKs report a signal death, and what adapters use for "no exit code").
 * The elapsed check keeps a command that itself exits 124 quickly from being reported as a timeout.
 */
export function killedByTimeout(exitCode: number, elapsedMs: number, seconds: number): boolean {
  const killed = exitCode === 124 || exitCode === 137 || exitCode === 143 || exitCode < 0;
  return killed && elapsedMs >= seconds * 1000 - TIMEOUT_SLACK_MS;
}

/** Clocks on the two sides of an exec call differ by a little; a kill this close to the deadline still counts. */
const TIMEOUT_SLACK_MS = 250;

/**
 * Shell text that runs `cmd` and kills it after `seconds`, for exec APIs that cannot stop a
 * running command themselves. Prefers coreutils `timeout`, which stops the whole process group
 * (exit 124, then SIGKILL 5 s later, exit 137). When the image has none, a plain-sh watchdog
 * kills the command's shell and, where `pkill` exists, its children (exit 137). Callers detect
 * the kill with `killedByTimeout`.
 */
export function guardTimeout(cmd: string, seconds: number): string {
  const n = Math.max(1, Math.ceil(seconds));
  const inner = shq(cmd);
  return [
    `if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 ${n} sh -c ${inner}; fi`,
    `sh -c ${inner} & p=$!`,
    // Freeze the shell first so it can't run its next command while its children are being killed.
    `( sleep ${n}; kill -STOP $p; command -v pkill >/dev/null 2>&1 && pkill -KILL -P $p .; kill -9 $p ) >/dev/null 2>&1 & w=$!`,
    `wait $p; c=$?`,
    `kill $w >/dev/null 2>&1`,
    `exit $c`,
  ].join("\n");
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Load an optional peer dependency with a helpful error. */
export async function optionalImport<T>(pkg: string, provider: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Bundlers and test runners (Vite, esbuild) report a missing package without Node's error code.
    const missing = /Cannot find (module|package)|Could not resolve|Failed to (resolve|load url)/.test(String((err as Error)?.message));
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || missing) {
      throw new SetupError(`${provider} needs the "${pkg}" package: npm i ${pkg}`);
    }
    throw err;
  }
}

/** gRPC status codes (Modal's SDK) as the HTTP status they correspond to. */
const GRPC_TO_HTTP: Record<number, number> = { 3: 400, 5: 404, 7: 403, 8: 429, 14: 503, 16: 401 };

/**
 * The HTTP status an error stands for, read from the shapes provider SDKs use: `status`,
 * `statusCode` (Daytona), `status_code` (Blaxel), `response.status` (Vercel), AWS's
 * `$metadata.httpStatusCode`, gRPC codes (Modal), and error classes that only say it by name
 * (E2B's AuthenticationError, AWS's CredentialsProviderError). Undefined when there's none.
 */
export function errorStatus(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== "object" || depth > 3) return undefined;
  const e = err as any;
  for (const v of [e.status, e.statusCode, e.status_code, e.response?.status, e.$metadata?.httpStatusCode])
    if (typeof v === "number" && v >= 100 && v < 600) return v;
  if (e.name === "ClientError" && typeof e.code === "number" && GRPC_TO_HTTP[e.code]) return GRPC_TO_HTTP[e.code];
  const name = String(e.name && e.name !== "Error" ? e.name : (e.constructor?.name ?? ""));
  if (/AuthenticationError$/.test(name) || name === "CredentialsProviderError") return 401;
  if (/PermissionDenied|ForbiddenError$/.test(name)) return 403;
  if (/RateLimitError$/.test(name)) return 429;
  return errorStatus(e.cause, depth + 1);
}
