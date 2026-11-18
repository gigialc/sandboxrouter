import { randomBytes } from "node:crypto";
import { digitalOceanSize, DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, killedByTimeout, timeoutError, wrapCommand } from "../util.js";
import { ShellFiles } from "./shell-files.js";

/**
 * DigitalOcean Harness Runtime. Start a harness-free microVM from an Environment Config,
 * then use its session API to execute commands, pause, resume and delete. The temporary
 * config is soft-deleted after the session is created. The service exposes an idle pause
 * timeout rather than a wall-clock deletion deadline.
 * https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/how-to/run-sandbox/
 * https://docs.digitalocean.com/reference/api/reference/harness-runtime/
 */
const ID = "digitalocean" as const;
const API = "/v2/harness-runtime";
const BOOT_TIMEOUT_MS = 110_000;
const MAX_EXEC_SECONDS = 240;

interface Session {
  session_id: string;
  status?: string;
}

interface CommandResult {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  duration_ms?: number;
}

function statusOf(session: Session) {
  return session.status?.replace(/^SESSION_STATUS_/, "");
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DigitalOceanProvider implements Provider {
  readonly id = ID;

  constructor(
    private token = process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN,
    private baseUrl = process.env.DIGITALOCEAN_HARNESS_URL ?? "https://api.digitalocean.com",
  ) {}

  configured(): boolean {
    return !!this.token;
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.token) throw new ProviderError(ID, "DIGITALOCEAN_TOKEN is not set");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 280);
      try { detail = (JSON.parse(text) as { message?: string }).message ?? detail; } catch { /* non-JSON error */ }
      throw new ProviderError(ID, `${method} ${path}: HTTP ${response.status} ${detail}`, response.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const size = digitalOceanSize(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB);
    if (!size) throw new ProviderError(ID, "no Harness Runtime size can satisfy the requested vCPU and memory");
    const name = `sbr-${randomBytes(8).toString("hex")}`;
    // Keep the caller's env out of the durable config.
    const idleSeconds = Math.max(60, Math.ceil((spec.timeoutMinutes ?? 30) * 60));
    const manifest = [`name: ${name}`, "harness: none", `size: ${size.slug}`, `idle_timeout: ${idleSeconds}s`].join("\n");
    const { config } = await this.request<{ config?: { id: string } }>("POST", "/configs", {
      name,
      manifest_yaml: manifest,
    });
    if (!config?.id) throw new ProviderError(ID, "create config returned no config id");
    const configPath = `/configs/${encodeURIComponent(config.id)}`;

    let session: Session | undefined;
    try {
      const result = await this.request<{ session?: Session }>("POST", "/sessions", { name, config_id: config.id });
      session = result.session;
      if (!session?.session_id) throw new ProviderError(ID, "create session returned no session id");
      await this.waitReady(session);
      await this.remove(configPath);
      return new DigitalOceanBox(this, session.session_id, spec.env);
    } catch (err) {
      if (session?.session_id) await this.remove(sessionPath(session.session_id)).catch(() => {});
      await this.remove(configPath).catch(() => {});
      throw err;
    }
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const path = sessionPath(nativeId);
    const session = await this.getSession(path);
    if (statusOf(session) === "PAUSED") await this.request("POST", `${path}/resume`, undefined, BOOT_TIMEOUT_MS);
    await this.waitReady(statusOf(session) === "PAUSED" ? await this.getSession(path) : session);
    return new DigitalOceanBox(this, nativeId);
  }

  /** @internal */
  async remove(path: string): Promise<void> {
    try {
      await this.request("DELETE", path);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 404) throw err;
    }
  }

  private async getSession(path: string): Promise<Session> {
    const { session } = await this.request<{ session?: Session }>("GET", path);
    if (!session?.session_id) throw new ProviderError(ID, "session missing", 404);
    return session;
  }

  private async waitReady(session: Session): Promise<void> {
    const path = sessionPath(session.session_id);
    const until = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < until) {
      const status = statusOf(session);
      if (status === "READY") return;
      if (status === "FAILED" || status === "DESTROYED" || status === "PAUSED") {
        throw new ProviderError(ID, `session is ${status.toLowerCase()}`, status === "DESTROYED" ? 404 : undefined);
      }
      await delay(500);
      session = await this.getSession(path);
    }
    throw new ProviderError(ID, "session did not become ready", 504);
  }
}

function sessionPath(id: string) {
  return `/sessions/${encodeURIComponent(id)}`;
}

class DigitalOceanBox implements ProviderSandbox {
  private files = new ShellFiles(ID, (command) => this.exec(command));

  constructor(
    private provider: DigitalOceanProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = Math.min(MAX_EXEC_SECONDS, Math.max(1, Math.ceil(opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S)));
    const path = `${sessionPath(this.nativeId)}/sandbox/exec`;
    const cmd = wrapCommand(command, { env: { ...this.env, ...opts.env } });
    const result = await this.provider.request<CommandResult>("POST", path, {
      argv: ["sh", "-c", cmd],
      workdir: opts.cwd,
      timeout_seconds: seconds,
    }, (seconds + 15) * 1000);
    const { exit_code, stdout = "", stderr = "" } = result;
    if (typeof exit_code !== "number" || !Number.isInteger(exit_code)) throw new ProviderError(ID, "exec returned no exit code");
    const durationMs = result.duration_ms ?? Date.now() - t0;
    if (killedByTimeout(exit_code, durationMs, seconds)) throw timeoutError(ID, seconds);
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { stdout, stderr, exitCode: exit_code, durationMs };
  }

  readFile(path: string) { return this.files.readFile(path); }
  writeFile(path: string, data: string | Uint8Array) { return this.files.writeFile(path, data); }

  async pause(): Promise<void> {
    await this.provider.request("POST", `${sessionPath(this.nativeId)}/pause`, undefined, BOOT_TIMEOUT_MS);
  }

  async kill(): Promise<void> {
    await this.provider.remove(sessionPath(this.nativeId));
  }
}
