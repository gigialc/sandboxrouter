import { randomBytes } from "node:crypto";
import * as zlib from "node:zlib";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, killedByTimeout, optionalImport, shq, timeoutError, toBytes, wrapCommand } from "../util.js";

/**
 * Amazon Bedrock AgentCore Code Interpreter: AWS-managed sandboxes (2 vCPU / 8 GB, 10 GB disk) with a
 * shell, called over the AgentCore data plane with SigV4 (service "bedrock-agentcore").
 *
 *   PUT  /code-interpreters/{id}/sessions/start            {"name", "sessionTimeoutSeconds"} -> {"sessionId", ...}
 *   GET  /code-interpreters/{id}/sessions/get?sessionId=S  -> {"status": "READY" | "TERMINATED", ...}
 *   POST /code-interpreters/{id}/tools/invoke              header x-amzn-code-interpreter-session-id: S
 *        {"name": "executeCommand", "arguments": {"command": "..."}}
 *        -> event stream of {"result": {"content": [...], "structuredContent": {"stdout", "stderr", "exitCode"}, "isError"}}
 *   PUT  /code-interpreters/{id}/sessions/stop?sessionId=S {}
 * Host: https://bedrock-agentcore.{region}.amazonaws.com. The built-in interpreter id is aws.codeinterpreter.v1.
 *
 * Docs:
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StartCodeInterpreterSession.html
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeCodeInterpreter.html
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_GetCodeInterpreterSession.html
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopCodeInterpreterSession.html
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-api-reference-examples.html
 *   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html  (2vCPU/8GB, 15 min per request, 100 MB payload)
 *   https://docs.aws.amazon.com/general/latest/gr/bedrock_agentcore.html                     (endpoints)
 *   https://aws.amazon.com/bedrock/agentcore/pricing/
 *
 * Mapping:
 * - Size is fixed at 2 vCPU / 8 GB; vcpu/memoryGb are ignored and the catalog caps limits there.
 * - timeoutMinutes -> sessionTimeoutSeconds (1..28800; default 30 min).
 * - No env API: spec.env and opts.env are exported in front of each command.
 * - Files move as base64 through executeCommand (paths are plain shell paths, so absolute paths work
 *   the same as in exec). writeFile sends 48 KB chunks to stay under the kernel's 128 KB single-argument
 *   limit; readFile is one command.
 * - Streaming: each result event the service sends is passed to onStdout/onStderr as it arrives.
 *
 * ## Setup (once)
 *
 * Nothing to create for the built-in interpreter. The caller's IAM identity needs
 * bedrock-agentcore:StartCodeInterpreterSession, InvokeCodeInterpreter, GetCodeInterpreterSession and
 * StopCodeInterpreterSession on arn:aws:bedrock-agentcore:{region}:aws:code-interpreter/aws.codeinterpreter.v1
 * (or on your own interpreter, if you created one with CreateCodeInterpreter for VPC/network settings and
 * set AGENTCORE_CODE_INTERPRETER_ID). Set AWS_REGION (or AGENTCORE_REGION) to a region AgentCore runs in,
 * plus credentials the default AWS chain can find. Needs the optional peers @smithy/signature-v4,
 * @aws-crypto/sha256-js and @aws-sdk/credential-provider-node.
 */
const ID = "agentcore" as const;
const DEFAULT_INTERPRETER = "aws.codeinterpreter.v1";
const SESSION_ID = /^[0-9a-zA-Z]{1,40}$/;
/** Raw bytes per writeFile command: base64 makes it 64 KB, under Linux's 128 KB per-argument cap. */
const WRITE_CHUNK = 48 * 1024;

// ---------------------------------------------------------------------------------------------
// Shared AWS plumbing (also used by ./lambda.ts): SigV4 via the optional @smithy peers, as in
// ./workspaces.ts, plus a decoder for the application/vnd.amazon.eventstream framing.
// ---------------------------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface Signer {
  sign(req: unknown): Promise<{ headers: Record<string, string> }>;
}

/** True when the default AWS chain plausibly has credentials (env keys, a profile, or a container/web identity). */
export function awsCredentialsHinted(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    env.AWS_PROFILE ||
    env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  );
}

/** SigV4-signs and sends JSON requests for one AWS service in one region. */
export class AwsClient {
  private signer?: Promise<Signer>;

  constructor(
    readonly provider: string,
    readonly service: string,
    readonly region: string,
    private credentials?: AwsCredentials | (() => Promise<AwsCredentials>),
  ) {}

  private getSigner(): Promise<Signer> {
    this.signer ??= (async () => {
      const { SignatureV4 } = await optionalImport<{ SignatureV4: new (init: Record<string, unknown>) => Signer }>("@smithy/signature-v4", this.provider);
      const { Sha256 } = await optionalImport<{ Sha256: unknown }>("@aws-crypto/sha256-js", this.provider);
      let credentials = this.credentials;
      if (!credentials) {
        const { defaultProvider } = await optionalImport<{ defaultProvider: () => () => Promise<AwsCredentials> }>("@aws-sdk/credential-provider-node", this.provider);
        credentials = defaultProvider();
      }
      return new SignatureV4({ service: this.service, region: this.region, credentials, sha256: Sha256, applyChecksum: false });
    })();
    this.signer.catch(() => (this.signer = undefined));
    return this.signer;
  }

  /** Signs and sends; returns the response as-is (callers check status). */
  async send(method: string, url: URL, opts: { json?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
    const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
    const headers: Record<string, string> = { host: url.host, ...opts.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const signed = await (await this.getSigner()).sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query,
      headers,
      body,
    });
    const out = { ...signed.headers };
    for (const k of Object.keys(out)) if (k.toLowerCase() === "host") delete out[k]; // fetch sets it from the URL
    try {
      return await fetch(url, { method, headers: out, body, signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined });
    } catch (err) {
      throw new ProviderError(this.provider, `${method} ${url.pathname}: ${(err as Error).message}`);
    }
  }

  /** send() + parse JSON, throwing ProviderError (with the AWS error name) on non-2xx. */
  async json<T>(method: string, url: URL, opts: { json?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
    const res = await this.send(method, url, opts);
    if (!res.ok) await awsFail(this.provider, res, `${method} ${url.pathname}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export async function awsFail(provider: string, res: Response, what: string): Promise<never> {
  const text = (await res.text().catch(() => "")).slice(0, 500);
  let detail = text;
  let name = res.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
  try {
    const j = JSON.parse(text);
    detail = j?.message ?? j?.Message ?? text;
    name ||= String(j?.__type ?? "").split("#").pop() ?? "";
  } catch {
    /* not JSON */
  }
  throw new ProviderError(provider, `${what} -> ${res.status} ${name ? `${name}: ` : ""}${detail}`.trim(), res.status);
}

export interface EventMessage {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
}

/**
 * Decodes the AWS event stream binary framing: [total len u32][headers len u32][prelude crc u32]
 * [headers][payload][message crc u32]. Header value types per the spec (7 = string).
 */
export async function* readEventStream(res: Response): AsyncGenerator<EventMessage> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let buf: Buffer = Buffer.alloc(0);
  const crc32 = (zlib as unknown as { crc32?: (b: Uint8Array) => number }).crc32;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
    while (buf.length >= 12) {
      const total = buf.readUInt32BE(0);
      if (total < 16) throw new Error(`bad event stream frame length ${total}`);
      if (buf.length < total) break;
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      if (crc32) {
        if (crc32(frame.subarray(0, 8)) !== frame.readUInt32BE(8)) throw new Error("event stream prelude CRC mismatch");
        if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4)) throw new Error("event stream message CRC mismatch");
      }
      const hlen = frame.readUInt32BE(4);
      yield { headers: decodeHeaders(frame.subarray(12, 12 + hlen)), payload: new Uint8Array(frame.subarray(12 + hlen, total - 4)) };
    }
    if (done) {
      if (buf.length) throw new Error("event stream ended mid-frame");
      return;
    }
  }
}

function decodeHeaders(b: Buffer): EventMessage["headers"] {
  const out: EventMessage["headers"] = {};
  let i = 0;
  while (i < b.length) {
    const nlen = b.readUInt8(i);
    const name = b.subarray(i + 1, i + 1 + nlen).toString("utf8");
    i += 1 + nlen;
    const type = b.readUInt8(i++);
    switch (type) {
      case 0: out[name] = true; break;
      case 1: out[name] = false; break;
      case 2: out[name] = b.readInt8(i); i += 1; break;
      case 3: out[name] = b.readInt16BE(i); i += 2; break;
      case 4: out[name] = b.readInt32BE(i); i += 4; break;
      case 5: case 8: out[name] = Number(b.readBigInt64BE(i)); i += 8; break;
      case 6: case 7: {
        const len = b.readUInt16BE(i);
        const v = b.subarray(i + 2, i + 2 + len);
        out[name] = type === 7 ? v.toString("utf8") : new Uint8Array(v);
        i += 2 + len;
        break;
      }
      case 9: out[name] = new Uint8Array(b.subarray(i, i + 16)); i += 16; break;
      default: throw new Error(`unknown event stream header type ${type}`);
    }
  }
  return out;
}

/** Encodes one event stream frame (string headers only). Used by tests' mocks. */
export function encodeEvent(headers: Record<string, string>, payload: Uint8Array | string): Buffer {
  const hparts: Buffer[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = Buffer.from(k);
    const val = Buffer.from(v);
    const h = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
    h.writeUInt8(name.length, 0);
    name.copy(h, 1);
    h.writeUInt8(7, 1 + name.length);
    h.writeUInt16BE(val.length, 2 + name.length);
    val.copy(h, 4 + name.length);
    hparts.push(h);
  }
  const hb = Buffer.concat(hparts);
  const pb = Buffer.from(payload);
  const total = 12 + hb.length + pb.length + 4;
  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0);
  frame.writeUInt32BE(hb.length, 4);
  const crc32 = (zlib as unknown as { crc32?: (b: Uint8Array) => number }).crc32 ?? (() => 0);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)) >>> 0, 8);
  hb.copy(frame, 12);
  pb.copy(frame, 12 + hb.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, total - 4)) >>> 0, total - 4);
  return frame;
}

// ---------------------------------------------------------------------------------------------

export interface AgentCoreOptions {
  region?: string;
  /** Code interpreter id (default aws.codeinterpreter.v1, the AWS-managed one). */
  codeInterpreterId?: string;
  /** Override the data-plane base URL (tests). Default https://bedrock-agentcore.{region}.amazonaws.com. */
  endpoint?: string;
  /** Static credentials or a provider; default is the standard AWS chain. */
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
  structuredContent?: { stdout?: string; stderr?: string; exitCode?: number; executionTime?: number; taskId?: string; taskStatus?: string };
  isError?: boolean;
}

export class AgentCoreProvider implements Provider {
  readonly id = ID;
  readonly region?: string;
  readonly interpreter: string;
  private readonly opts: AgentCoreOptions;
  private client?: AwsClient;

  constructor(opts: AgentCoreOptions = {}) {
    this.opts = opts;
    this.region = opts.region ?? process.env.AGENTCORE_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.interpreter = opts.codeInterpreterId ?? process.env.AGENTCORE_CODE_INTERPRETER_ID ?? DEFAULT_INTERPRETER;
  }

  /**
   * Opt-in: AWS credentials alone are common, so the router only uses AgentCore when you name an
   * interpreter (AGENTCORE_CODE_INTERPRETER_ID=aws.codeinterpreter.v1 for the managed one) or
   * construct the provider yourself.
   */
  configured(): boolean {
    const optedIn = Object.keys(this.opts).length > 0 || !!process.env.AGENTCORE_CODE_INTERPRETER_ID;
    return optedIn && !!this.region && (!!this.opts.credentials || awsCredentialsHinted());
  }

  /** @internal */
  aws(): AwsClient {
    if (!this.region) throw new ProviderError(ID, "set AWS_REGION (or AGENTCORE_REGION) to a region AgentCore Code Interpreter runs in");
    this.client ??= new AwsClient(ID, "bedrock-agentcore", this.region, this.opts.credentials);
    return this.client;
  }

  /** @internal */
  url(path: string, query: Record<string, string> = {}): URL {
    const base = this.opts.endpoint ?? `https://bedrock-agentcore.${this.region}.amazonaws.com`;
    const u = new URL(`${base.replace(/\/+$/, "")}/code-interpreters/${encodeURIComponent(this.interpreter)}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const timeout = Math.min(28_800, Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)));
    const name = (spec.metadata?.name ?? `sandboxrouter-${randomBytes(4).toString("hex")}`).slice(0, 100);
    const r = await this.aws().json<{ sessionId?: string }>("PUT", this.url("sessions/start"), {
      json: { name, sessionTimeoutSeconds: timeout, clientToken: randomBytes(24).toString("hex") },
    });
    if (!r.sessionId) throw new ProviderError(ID, "StartCodeInterpreterSession returned no sessionId");
    return new AgentCoreSandbox(this, r.sessionId, spec.env);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    if (!SESSION_ID.test(nativeId)) throw new ProviderError(ID, `invalid session id: ${nativeId}`);
    const s = await this.aws().json<{ status?: string }>("GET", this.url("sessions/get", { sessionId: nativeId }));
    if (s.status !== "READY") throw new ProviderError(ID, `session ${nativeId} is ${s.status ?? "unknown"}`, 404);
    return new AgentCoreSandbox(this, nativeId);
  }
}

class AgentCoreSandbox implements ProviderSandbox {
  constructor(
    private p: AgentCoreProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  /** InvokeCodeInterpreter; calls onResult for each result event. */
  private async invoke(name: string, args: Record<string, unknown>, onResult: (r: ToolResult) => void, timeoutMs = 16 * 60_000): Promise<void> {
    const res = await this.p.aws().send("POST", this.p.url("tools/invoke"), {
      json: { name, arguments: args },
      headers: { "x-amzn-code-interpreter-session-id": this.nativeId, accept: "application/vnd.amazon.eventstream, application/json" },
      timeoutMs,
    });
    if (!res.ok) await awsFail(ID, res, `InvokeCodeInterpreter ${name}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("eventstream")) {
      // Plain JSON body: either {"result": {...}} or one of the exception members.
      const j = (await res.json()) as Record<string, unknown>;
      const exc = Object.keys(j).find((k) => k.endsWith("Exception"));
      if (exc) throw new ProviderError(ID, `${name}: ${exc}: ${(j[exc] as { message?: string })?.message ?? ""}`.trim(), exceptionStatus(exc));
      onResult((j.result ?? j) as ToolResult);
      return;
    }
    for await (const msg of readEventStream(res)) {
      const mtype = msg.headers[":message-type"];
      const text = new TextDecoder().decode(msg.payload);
      if (mtype === "exception" || mtype === "error") {
        const exc = String(msg.headers[":exception-type"] ?? msg.headers[":error-code"] ?? "error");
        let detail = String(msg.headers[":error-message"] ?? "");
        try {
          detail ||= JSON.parse(text)?.message ?? "";
        } catch {
          detail ||= text;
        }
        throw new ProviderError(ID, `${name}: ${exc}: ${detail}`.trim(), exceptionStatus(exc));
      }
      if (!text) continue;
      const j = JSON.parse(text) as Record<string, unknown>;
      onResult((msg.headers[":event-type"] === "result" ? j : (j.result ?? j)) as ToolResult);
    }
  }

  /** executeCommand, collecting stdout/stderr/exit code across result events. */
  private async command(command: string, opts: { onStdout?: (s: string) => void; onStderr?: (s: string) => void; timeoutMs?: number } = {}) {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    let errorText = "";
    await this.invoke(
      "executeCommand",
      { command },
      (r) => {
        const sc = r.structuredContent;
        if (sc) {
          if (sc.stdout) (stdout += sc.stdout), opts.onStdout?.(sc.stdout);
          if (sc.stderr) (stderr += sc.stderr), opts.onStderr?.(sc.stderr);
          if (typeof sc.exitCode === "number") exitCode = sc.exitCode;
        } else {
          const t = (r.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
          if (r.isError) errorText += t;
          else if (t) (stdout += t), opts.onStdout?.(t);
        }
        if (r.isError && exitCode === undefined && !sc) exitCode = 1;
      },
      opts.timeoutMs,
    );
    if (exitCode === undefined && errorText) throw new ProviderError(ID, `executeCommand: ${errorText.trim()}`);
    return { stdout, stderr, exitCode: exitCode ?? 0 };
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const timeout = Math.max(1, Math.round(opts.timeoutSeconds ?? 60));
    const full = wrapCommand(cmd, { cwd: opts.cwd, env: { ...this.env, ...opts.env } });
    const b64 = Buffer.from(full).toString("base64");
    // base64 keeps the user's command intact through whatever quoting the service applies.
    const command = `timeout -k 5 ${timeout} bash -c "$(echo ${b64} | base64 -d)"`;
    const r = await this.command(command, { onStdout: opts.onStdout, onStderr: opts.onStderr, timeoutMs: (timeout + 60) * 1000 });
    const durationMs = Date.now() - t0;
    // `timeout` leaves exit 124 (or 137 after SIGKILL) when it had to stop the command.
    if (killedByTimeout(r.exitCode, durationMs, timeout)) throw timeoutError(ID, timeout);
    return { ...r, durationMs };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = toBytes(content);
    const tmp = `${path}.sbr-${randomBytes(4).toString("hex")}`;
    for (let i = 0, first = true; first || i < bytes.length; i += WRITE_CHUNK, first = false) {
      const b64 = Buffer.from(bytes.subarray(i, i + WRITE_CHUNK)).toString("base64");
      const prefix = first ? `mkdir -p ${shq(dirname(path))} && ` : "";
      const r = await this.command(`${prefix}echo ${b64 || "''"} | base64 -d ${first ? ">" : ">>"} ${shq(tmp)}`);
      if (r.exitCode !== 0) throw new ProviderError(ID, `writeFile ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    const r = await this.command(`mv -f ${shq(tmp)} ${shq(path)}`);
    if (r.exitCode !== 0) throw new ProviderError(ID, `writeFile ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.command(`base64 -w0 < ${shq(path)}`);
    if (r.exitCode !== 0) throw new ProviderError(ID, `readFile ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  async kill(): Promise<void> {
    try {
      await this.p.aws().json("PUT", this.p.url("sessions/stop", { sessionId: this.nativeId }), { json: {} });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return;
      throw err;
    }
  }
}

function exceptionStatus(name: string): number | undefined {
  const n = name.toLowerCase();
  if (n.startsWith("accessdenied")) return 403;
  if (n.startsWith("resourcenotfound")) return 404;
  if (n.startsWith("validation")) return 400;
  if (n.startsWith("conflict")) return 409;
  if (n.startsWith("throttling")) return 429;
  if (n.startsWith("servicequota")) return 402;
  if (n.startsWith("internalserver")) return 500;
  return undefined;
}
