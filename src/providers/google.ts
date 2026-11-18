import { randomBytes } from "node:crypto";
import { GOOGLE_SHELL_SIZE } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, killedByTimeout, optionalImport, timeoutError, wrapCommand } from "../util.js";
import { ShellFiles } from "./shell-files.js";

/**
 * Gemini Enterprise Agent Platform shell sandboxes, using the Agent Platform regional REST API.
 * Reuse a default shell template so that creating a sandbox does not leave behind a new template.
 * The optional google-auth-library package supplies Application Default Credentials.
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/shell-sandbox-quickstart
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/manage-templates
 * Wire reference: https://github.com/googleapis/python-aiplatform/blob/main/agentplatform/_genai/sandboxes.py
 */
const ID = "google" as const;
const ENGINE_NAME = /^projects\/([\w-]+)\/locations\/([\w-]+)\/reasoningEngines\/[\w-]+$/;
const RESOURCE_NAME = /^(?:[\w-]+\/)*[\w-]+$/;
const OPERATION_TIMEOUT_MS = 110_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface GoogleCredentials {
  getRequestHeaders(url: string): Promise<Headers>;
}

interface GoogleAuthModule {
  GoogleAuth: new (options: { scopes: string[] }) => GoogleCredentials;
}

interface SandboxResource {
  name: string;
  state?: string;
}

interface Operation {
  name?: string;
  done?: boolean;
  response?: SandboxResource;
  error?: { code?: number; message?: string };
}

interface Chunk {
  mimeType: string;
  data: string;
}

function dataChunk(mimeType: string, text: string): Chunk {
  return { mimeType, data: Buffer.from(text).toString("base64") };
}

export class GoogleAgentPlatformProvider implements Provider {
  readonly id = ID;
  private auth?: Promise<GoogleCredentials>;

  constructor(
    private engine = process.env.GOOGLE_SANDBOX_ENGINE,
    private template = process.env.GOOGLE_SANDBOX_TEMPLATE,
    private token = process.env.GOOGLE_SANDBOX_ACCESS_TOKEN,
    private baseUrl?: string,
  ) {}

  configured(): boolean {
    return !!this.engine && !!this.template;
  }

  private engineName() {
    if (!this.engine || !ENGINE_NAME.test(this.engine) || !this.template || !RESOURCE_NAME.test(this.template)) {
      throw new ProviderError(ID, "set GOOGLE_SANDBOX_ENGINE to projects/PROJECT/locations/LOCATION/reasoningEngines/ID and GOOGLE_SANDBOX_TEMPLATE to a shell template resource name");
    }
    return this.engine;
  }

  private async headers(url: string): Promise<Headers> {
    if (this.token) return new Headers({ Authorization: `Bearer ${this.token}` });
    this.auth ??= optionalImport<GoogleAuthModule>("google-auth-library", ID).then(
      ({ GoogleAuth }) => new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
    );
    return new Headers(await (await this.auth).getRequestHeaders(url));
  }

  /** @internal */
  async request<T>(method: string, resource: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const engine = this.engineName();
    const [, project, location] = ENGINE_NAME.exec(engine)!;
    const prefix = `projects/${project}/locations/${location}/`;
    // Limit both user-supplied IDs and returned operation names to this project and region.
    if (!resource.startsWith(prefix) || !RESOURCE_NAME.test(resource.replace(/\/:(?:execute|pause|resume)$/, ""))) {
      throw new ProviderError(ID, "resource is outside the configured Agent Platform location");
    }
    const host = this.baseUrl ?? `https://${location}-aiplatform.googleapis.com`;
    const url = `${host.replace(/\/$/, "")}/v1beta1/${resource}`;
    const headers = await this.headers(url);
    headers.set("Accept", "application/json");
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 280);
      try { detail = (JSON.parse(text) as { error?: { message: string } }).error?.message ?? detail; } catch { /* non-JSON error */ }
      throw new ProviderError(ID, `${method}: HTTP ${response.status} ${detail}`, response.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private sandboxName(id: string): string {
    const parent = `${this.engineName()}/sandboxEnvironments/`;
    if (!id.startsWith(parent) || !/^[\w-]+$/.test(id.slice(parent.length))) {
      throw new ProviderError(ID, "invalid sandbox name for the configured Agent Platform instance", 404);
    }
    return id;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const engine = this.engineName();
    if ((spec.vcpu ?? 0) > GOOGLE_SHELL_SIZE.vcpu || (spec.memoryGb ?? 0) > GOOGLE_SHELL_SIZE.memoryGb) {
      throw new ProviderError(ID, "the standard shell sandbox is 1 vCPU / 2 GiB");
    }

    const { response } = await this.wait(await this.request<Operation>("POST", `${engine}/sandboxEnvironments`, {
      displayName: `sbr-${randomBytes(8).toString("hex")}`,
      spec: { shellEnvironment: {} },
      sandboxEnvironmentTemplate: this.template,
      ttl: `${Math.max(60, Math.ceil((spec.timeoutMinutes ?? 30) * 60))}s`,
    }));
    if (!response?.name) throw new ProviderError(ID, "create operation returned no sandbox name");
    const name = this.sandboxName(response.name);
    try {
      const resource = await this.request<SandboxResource>("GET", name);
      if (resource.state !== "STATE_RUNNING") throw new ProviderError(ID, `sandbox is ${resource.state ?? "not running"}`);
      return new GoogleBox(this, name, spec.env);
    } catch (err) {
      await this.remove(name).catch(() => {});
      throw err;
    }
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const name = this.sandboxName(nativeId);
    const sandbox = await this.request<SandboxResource>("GET", name);
    if (sandbox.state === "STATE_PAUSED") await this.action(name, "resume");
    else if (sandbox.state !== "STATE_RUNNING") throw new ProviderError(ID, `sandbox is ${sandbox.state ?? "not running"}`);
    return new GoogleBox(this, name);
  }

  /** @internal */
  async action(name: string, action: "pause" | "resume"): Promise<void> {
    await this.wait(await this.request<Operation>("POST", `${this.sandboxName(name)}/:${action}`, {}));
  }

  /** @internal */
  async remove(name: string): Promise<void> {
    try {
      await this.wait(await this.request<Operation>("DELETE", this.sandboxName(name)));
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 404) throw err;
    }
  }

  private async wait(operation: Operation): Promise<Operation> {
    // Some delete responses have an empty body.
    const until = Date.now() + OPERATION_TIMEOUT_MS;
    while (!operation.done && operation.name && Date.now() < until) {
      await delay(500);
      operation = await this.request<Operation>("GET", operation.name);
    }
    if (operation.error) {
      const status = ({ 5: 404, 7: 403, 8: 429, 16: 401 } as Record<number, number>)[operation.error.code ?? 0];
      throw new ProviderError(ID, operation.error.message ?? "sandbox operation failed", status);
    }
    if (operation.name && !operation.done) throw new ProviderError(ID, "sandbox operation timed out", 504);
    return operation;
  }
}

interface CommandResult {
  stdout?: string;
  stderr?: string;
  returncode?: number;
  duration_ms?: number;
}

class GoogleBox implements ProviderSandbox {
  private files = new ShellFiles(ID, (command) => this.exec(command));

  constructor(
    private provider: GoogleAgentPlatformProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = Math.max(1, Math.ceil(opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S));
    const cmd = wrapCommand(command, { env: { ...this.env, ...opts.env } });
    const inputs = [
      dataChunk("application/x.sandbox-request-uri", "/exec"),
      dataChunk("application/x.sandbox-request-port", "8080"),
      dataChunk("application/json", JSON.stringify({ command: cmd, cwd: opts.cwd, timeout: seconds })),
    ];
    let result: { outputs?: Chunk[] };
    try {
      result = await this.provider.request("POST", `${this.nativeId}/:execute`, { inputs }, (seconds + 15) * 1000);
    } catch (err) {
      // Agent Platform wraps confirmed guest command kills in a 400 DEADLINE_EXCEEDED response.
      if (
        err instanceof ProviderError &&
        err.status === 400 &&
        /\bDEADLINE_EXCEEDED\b/.test(err.message) &&
        /\bcommand exceeded \d+(?:\.\d+)?s and was killed\b/i.test(err.message)
      ) {
        throw timeoutError(ID, seconds);
      }
      throw err;
    }

    const out = result.outputs?.find((chunk) => chunk.data)?.data;
    if (!out) throw new ProviderError(ID, "shell sandbox returned no output");
    const { returncode, stdout = "", stderr = "", duration_ms } = JSON.parse(Buffer.from(out, "base64").toString("utf8")) as CommandResult;
    if (typeof returncode !== "number" || !Number.isInteger(returncode)) throw new ProviderError(ID, "shell sandbox returned no exit code");
    const durationMs = duration_ms ?? Date.now() - t0;
    if (killedByTimeout(returncode, durationMs, seconds)) throw timeoutError(ID, seconds);
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { stdout, stderr, exitCode: returncode, durationMs };
  }

  readFile(path: string) { return this.files.readFile(path); }
  writeFile(path: string, data: string | Uint8Array) { return this.files.writeFile(path, data); }
  pause() { return this.provider.action(this.nativeId, "pause"); }
  kill() { return this.provider.remove(this.nativeId); }
}
