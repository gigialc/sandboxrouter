import { randomBytes } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * Azure Container Apps dynamic sessions, Shell session pools (plain REST, no Azure SDK).
 *
 * A Shell pool is a built-in ("code interpreter" type) pool whose sessions are Hyper-V isolated
 * Linux shells. A session is addressed by an identifier you choose; the first request with a new
 * identifier allocates a session from the pool's prewarmed set.
 *
 *   POST   {endpoint}/executions?api-version=2025-10-02-preview&identifier={id}
 *          {"shellCommand": "...", "timeoutInSeconds": N, "outputStreamsMaxLength": N}
 *          -> {"id", "identifier", "status": "0" | "Succeeded" | ..., "result": {"stdout", "stderr", "executionTimeInMilliseconds"}}
 *   POST   {endpoint}/files?api-version=...&identifier={id}          multipart field "file" (lands in /mnt/data, 128 MB max)
 *   GET    {endpoint}/files/{name}/content?api-version=...&identifier={id}
 *   GET    {endpoint}/session?api-version=...&identifier={id}        -> {identifier, expireAt, createdAt, lastAccessedAt, etag}
 *   DELETE {endpoint}/session?api-version=...&identifier={id}        -> 204
 * Auth: Authorization: Bearer <Entra token with aud https://dynamicsessions.io>, from an identity holding
 * "Azure ContainerApps Session Executor" on the pool.
 *
 * Docs:
 *   https://learn.microsoft.com/en-us/azure/container-apps/sessions-tutorial-shell
 *   https://learn.microsoft.com/en-us/azure/container-apps/session-pool
 *   https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage
 *   https://learn.microsoft.com/en-us/rest/api/data-plane/containerapps/code-execution/execute?view=rest-data-plane-containerapps-2025-10-02-preview
 *   https://learn.microsoft.com/en-us/rest/api/data-plane/containerapps/session-resource-files/upload?view=rest-data-plane-containerapps-2025-10-02-preview
 *   https://learn.microsoft.com/en-us/rest/api/data-plane/containerapps/session-management/delete?view=rest-data-plane-containerapps-2025-10-02-preview
 *   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
 *   Billing: https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions
 *
 * Custom container pools are not supported: their exec surface is whatever HTTP server your image
 * runs, so there is no API to adapt to.
 *
 * What the API does not let us honour, and how the adapter copes:
 * - Session size is fixed by the platform (not published); vcpu/memoryGb are ignored, and the catalog
 *   caps limits so bigger requests route elsewhere.
 * - Lifetime is the pool's cooldown (300-3600 s idle), not per session; timeoutMinutes is ignored. kill()
 *   deletes the session at once.
 * - No env API: spec.env and opts.env are exported in front of each command.
 * - stdout/stderr are capped per response (outputStreamsMaxLength, default 4096). exec writes output to
 *   files in the session and returns it inline when it fits, otherwise downloads the files. No streaming:
 *   onStdout/onStderr get the whole output once, at the end.
 *
 * ## Setup (once)
 *
 *   az extension add --name containerapp --upgrade --allow-preview true
 *   az provider register --namespace Microsoft.App
 *   # Shell pool via ARM (see the shell tutorial for deploy.json): "containerType": "Shell",
 *   # "poolManagementType": "Dynamic", lifecycleConfiguration {"lifecycleType": "Timed",
 *   # "cooldownPeriodInSeconds": 300}, sessionNetworkConfiguration {"status": "EgressEnabled"}
 *   az deployment group create -g <rg> --template-file deploy.json
 *   az containerapp sessionpool show -n <pool> -g <rg> --query properties.poolManagementEndpoint -o tsv
 *   az role assignment create --role "Azure ContainerApps Session Executor" \
 *     --assignee <principal-id> --scope <pool-resource-id>
 *
 * Then set AZURE_SESSIONS_POOL_ENDPOINT to the endpoint, and either AZURE_SESSIONS_TOKEN
 * (`az account get-access-token --resource https://dynamicsessions.io --query accessToken -o tsv`,
 * expires in about an hour) or a service principal: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.
 */
const ID = "azure" as const;
const AUDIENCE = "https://dynamicsessions.io";
const DEFAULT_API_VERSION = "2025-10-02-preview";
/** Identifier: 4-128 chars; we only ever generate [a-z0-9-]. */
const IDENTIFIER = /^[A-Za-z0-9|\-&^%$#(){}[\];<>]{4,128}$/;

export interface AzureSessionsOptions {
  /** Pool management endpoint, e.g. https://westus2.dynamicsessions.io/subscriptions/.../sessionPools/my-pool */
  endpoint?: string;
  /** A ready Entra access token for https://dynamicsessions.io. */
  token?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** Entra authority host (default https://login.microsoftonline.com). */
  authorityHost?: string;
  /** Data-plane api-version (default 2025-10-02-preview, the first with Shell pools). */
  apiVersion?: string;
  /** Where the files API puts uploads inside a session (default /mnt/data). */
  filesDir?: string;
  /** outputStreamsMaxLength sent with each execution (default 4096, the documented default). */
  outputCap?: number;
}

export class AzureSessionsProvider implements Provider {
  readonly id = ID;
  /** @internal */ readonly endpoint?: string;
  /** @internal */ readonly apiVersion: string;
  /** @internal */ readonly filesDir: string;
  /** @internal */ readonly outputCap: number;
  private readonly staticToken?: string;
  private readonly tenantId?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly authorityHost: string;
  private cached?: { token: string; expiresAt: number };

  constructor(opts: AzureSessionsOptions = {}) {
    this.endpoint = (opts.endpoint ?? process.env.AZURE_SESSIONS_POOL_ENDPOINT)?.replace(/\/+$/, "");
    this.staticToken = opts.token ?? process.env.AZURE_SESSIONS_TOKEN;
    this.tenantId = opts.tenantId ?? process.env.AZURE_TENANT_ID;
    this.clientId = opts.clientId ?? process.env.AZURE_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? process.env.AZURE_CLIENT_SECRET;
    this.authorityHost = (opts.authorityHost ?? process.env.AZURE_AUTHORITY_HOST ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion ?? process.env.AZURE_SESSIONS_API_VERSION ?? DEFAULT_API_VERSION;
    this.filesDir = (opts.filesDir ?? process.env.AZURE_SESSIONS_FILES_DIR ?? "/mnt/data").replace(/\/+$/, "");
    this.outputCap = opts.outputCap ?? 4096;
  }

  configured(): boolean {
    return !!this.endpoint && (!!this.staticToken || !!(this.tenantId && this.clientId && this.clientSecret));
  }

  /** @internal Bearer token: the static one, or a cached client-credentials token. */
  async token(): Promise<string> {
    if (this.staticToken) return this.staticToken;
    if (!(this.tenantId && this.clientId && this.clientSecret)) {
      throw new ProviderError(ID, "set AZURE_SESSIONS_TOKEN, or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET");
    }
    if (this.cached && this.cached.expiresAt - 300_000 > Date.now()) return this.cached.token;
    const res = await fetch(`${this.authorityHost}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: `${AUDIENCE}/.default`,
      }),
    });
    const text = await res.text();
    let j: { access_token?: string; expires_in?: number | string; error?: string; error_description?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || !j.access_token) {
      throw new ProviderError(ID, `Entra token -> ${res.status} ${j.error_description ?? j.error ?? text.slice(0, 200)}`, res.status);
    }
    this.cached = { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  /** @internal One data-plane call. Throws ProviderError on non-2xx. */
  async call(method: string, path: string, identifier: string, init: { json?: unknown; form?: FormData; timeoutMs?: number } = {}): Promise<Response> {
    if (!this.endpoint) throw new ProviderError(ID, "AZURE_SESSIONS_POOL_ENDPOINT is not set (see src/providers/azure.ts for the pool setup)");
    const qs = new URLSearchParams({ "api-version": this.apiVersion, identifier });
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    let body: string | FormData | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form; // fetch sets the multipart boundary
    }
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/${path}?${qs}`, {
        method,
        headers,
        body,
        signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
      });
    } catch (err) {
      throw new ProviderError(ID, `${method} ${path}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code = "";
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        code = j?.error?.code ?? "";
        detail = j?.error?.message ?? j?.message ?? detail;
      } catch {
        /* plain text */
      }
      // An unknown or expired identifier answers 400 SessionWithIdentifierNotFound; surface it as 404.
      const status = code === "SessionWithIdentifierNotFound" ? 404 : res.status;
      throw new ProviderError(ID, `${method} ${path} -> ${res.status} ${code ? `${code}: ` : ""}${detail}`.trim(), status);
    }
    return res;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const box = new AzureSession(this, `sbr-${randomBytes(12).toString("hex")}`, spec.env);
    // The first request with a new identifier allocates the session; prove it runs commands.
    const r = await box.exec("true", { timeoutSeconds: 30 });
    if (r.exitCode !== 0) {
      await box.kill().catch(() => {});
      throw new ProviderError(ID, `new session did not run a command (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    if (!IDENTIFIER.test(nativeId)) throw new ProviderError(ID, `invalid session identifier: ${nativeId}`);
    // GET /session does not allocate; an unknown identifier fails instead of starting a fresh session.
    await this.call("GET", "session", nativeId);
    return new AzureSession(this, nativeId);
  }
}

interface ExecutionResource {
  id?: string;
  status?: string;
  result?: { stdout?: string; stderr?: string; executionResult?: unknown; executionTimeInMilliseconds?: number };
  error?: { error?: { code?: string; message?: string } } | { code?: string; message?: string };
}

class AzureSession implements ProviderSandbox {
  constructor(
    private p: AzureSessionsProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  /** @internal One shellCommand execution, returned raw. */
  async run(shellCommand: string, timeoutSeconds: number): Promise<ExecutionResource> {
    const res = await this.p.call("POST", "executions", this.nativeId, {
      json: { shellCommand, timeoutInSeconds: timeoutSeconds, outputStreamsMaxLength: this.p.outputCap },
      timeoutMs: (timeoutSeconds + 60) * 1000,
    });
    const j = (await res.json()) as ExecutionResource;
    if (j.status === "Failed" || j.status === "Canceled") {
      const e = j.error as { error?: { message?: string }; message?: string } | undefined;
      throw new ProviderError(ID, `execution ${j.status.toLowerCase()}: ${e?.error?.message ?? e?.message ?? "no detail"}`);
    }
    return j;
  }

  /** Run a short helper script; throws with its stderr when it fails. */
  private async sh(script: string, what: string): Promise<string> {
    const r = await this.run(script, 120);
    const code = statusCode(r.status);
    if (code !== undefined && code !== 0) throw new ProviderError(ID, `${what}: ${(r.result?.stderr ?? "").trim() || `exit ${code}`}`);
    return r.result?.stdout ?? "";
  }

  /**
   * The command runs with stdout/stderr redirected to files under filesDir. A trailer on stdout
   * reports the exit code and whether the output came inline (it fit under the response cap) or must
   * be downloaded through the files API.
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const timeout = Math.max(1, Math.round(opts.timeoutSeconds ?? 60));
    const job = `sbr-${randomBytes(8).toString("hex")}`;
    const fd = this.p.filesDir;
    const base = `${fd}/${job}`;
    const marker = `__SBR_DONE_${job}__`;
    const full = wrapCommand(cmd, { cwd: opts.cwd, env: { ...this.env, ...opts.env } });
    const b64 = Buffer.from(full).toString("base64");
    const inlineMax = Math.max(0, this.p.outputCap - marker.length - 32);
    const script = [
      `mkdir -p ${shq(fd)} && echo ${b64} | base64 -d > ${shq(`${base}.sh`)} || exit 97`,
      `timeout -k 5 ${timeout} bash ${shq(`${base}.sh`)} > ${shq(`${base}.out`)} 2> ${shq(`${base}.err`)} < /dev/null`,
      `c=$?`,
      `so=$(stat -c %s ${shq(`${base}.out`)}); se=$(stat -c %s ${shq(`${base}.err`)})`,
      `if [ $((so + se)) -le ${inlineMax} ]; then`,
      `  cat ${shq(`${base}.out`)}; cat ${shq(`${base}.err`)} >&2; rm -f ${shq(base)}.*; i=1`,
      `else rm -f ${shq(`${base}.sh`)}; i=0; fi`,
      `printf '\\n${marker} %d %d' "$c" "$i"`,
      `exit 0`,
    ].join("\n");

    const r = await this.run(script, timeout + 30);
    let stdout = r.result?.stdout ?? "";
    let stderr = r.result?.stderr ?? "";
    const m = new RegExp(`\\n${marker} (\\d+) ([01])$`).exec(stdout);
    let exitCode: number;
    if (!m) {
      // The wrapper itself did not finish (killed, or the platform timed it out): report what came back.
      exitCode = statusCode(r.status) ?? 1;
      if (exitCode === 0) exitCode = 1;
    } else {
      exitCode = Number(m[1]);
      stdout = stdout.slice(0, m.index);
      if (m[2] === "0") {
        stdout = new TextDecoder().decode(await this.download(`${job}.out`));
        stderr = new TextDecoder().decode(await this.download(`${job}.err`));
        await this.sh(`rm -f ${shq(base)}.*`, "cleanup").catch(() => {});
      }
    }
    if (stdout) opts.onStdout?.(stdout);
    if (stderr) opts.onStderr?.(stderr);
    return { exitCode, stdout, stderr, durationMs: Date.now() - t0 };
  }

  /** GET files/{name}/content for a file directly under filesDir. */
  private async download(name: string): Promise<Uint8Array> {
    const res = await this.p.call("GET", `files/${encodeURIComponent(name)}/content`, this.nativeId);
    const buf = new Uint8Array(await res.arrayBuffer());
    // The reference example shows the content as a JSON string; unwrap it only when it is one.
    if (res.headers.get("content-type")?.includes("application/json")) {
      try {
        const v = JSON.parse(new TextDecoder().decode(buf));
        if (typeof v === "string") return new TextEncoder().encode(v);
      } catch {
        /* raw bytes */
      }
    }
    return buf;
  }

  /** Upload into filesDir through the files API, then move it into place. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const name = `sbr-${randomBytes(8).toString("hex")}.upload`;
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(toBytes(content))], { type: "application/octet-stream" }), name);
    await this.p.call("POST", "files", this.nativeId, { form, timeoutMs: 300_000 });
    const staged = `${this.p.filesDir}/${name}`;
    await this.sh(`mkdir -p ${shq(dirname(path))} && mv -f ${shq(staged)} ${shq(path)}`, `writeFile ${path}`);
  }

  /** Copy into filesDir, download through the files API, then remove the copy. */
  async readFile(path: string): Promise<Uint8Array> {
    const name = `sbr-${randomBytes(8).toString("hex")}.download`;
    const staged = `${this.p.filesDir}/${name}`;
    await this.sh(`mkdir -p ${shq(this.p.filesDir)} && cp -f -- ${shq(path)} ${shq(staged)}`, `readFile ${path}`);
    try {
      return await this.download(name);
    } finally {
      await this.sh(`rm -f ${shq(staged)}`, "cleanup").catch(() => {});
    }
  }

  async kill(): Promise<void> {
    try {
      await this.p.call("DELETE", "session", this.nativeId);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return; // already gone
      throw err;
    }
  }
}

/** Shell pools put the exit code in `status` ("0"); other pools use OperationState names. */
function statusCode(status: string | undefined): number | undefined {
  if (status === undefined) return undefined;
  if (/^-?\d+$/.test(status)) return Number(status);
  if (status === "Succeeded") return 0;
  return undefined;
}
