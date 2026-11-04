import { createHash } from "node:crypto";
import { ProviderError, type ProviderId } from "../types.js";
import { optionalImport } from "../util.js";
import type { ActionResult, ComputerAction, ComputerInfo, ComputerOs, ComputerProvider, ComputerSpec, ProviderComputer } from "../computers.js";

/**
 * Amazon WorkSpaces Applications (formerly AppStream 2.0) with agent access: a Windows or Linux
 * desktop streamed from a fleet you own, driven through AWS's managed MCP server.
 *
 *   MCP endpoint: https://agentaccess-mcp.{region}.api.aws/mcp  (Streamable HTTP, SigV4 service "agentaccess-mcp")
 *   Docs: https://docs.aws.amazon.com/appstream2/latest/developerguide/agent-access-mcp-server.html
 *   Sample: https://github.com/aws-samples/sample-code-for-workspaces-agent-access
 *
 * This adapter does not create fleets, images or stacks (that takes tens of minutes and a VPC).
 * It attaches agents to a fleet + stack you provision once.
 *
 * ## Setup (once per region)
 *
 * 1. In the WorkSpaces Applications console choose Get started once, so the
 *    `AmazonAppStreamServiceAccess` service role exists.
 * 2. Create a fleet: Always-On or On-Demand (Elastic and multi-session fleets are not supported by
 *    agent access), a current AWS base image (Windows Server, or a Linux base image such as Rocky
 *    Linux) running the latest WorkSpaces Applications agent, e.g. `stream.standard.medium`, in a VPC
 *    subnet with internet access. Set desired capacity to the number of agents you want to run at once.
 * 3. Create a stack, associate it with the fleet, and turn on agent access with COMPUTER_VISION and
 *    COMPUTER_INPUT enabled, screen resolution 1280x720 (the only one supported), image type PNG, and
 *    UserControlMode VIEW_ONLY or VIEW_STOP if you want `viewer()` links to work. With the CLI:
 *      aws appstream create-stack --name my-agents --agent-access-config \
 *        'Settings=[{AgentAction=COMPUTER_VISION,Permission=ENABLED},{AgentAction=COMPUTER_INPUT,Permission=ENABLED}],ScreenResolution=W_1280xH_720,ScreenImageFormat=PNG,UserControlMode=VIEW_ONLY'
 *      aws appstream associate-fleet --stack-name my-agents --fleet-name my-fleet
 *      aws appstream start-fleet --name my-fleet
 *    (or run ./scripts/setup.sh from the AWS sample repo, which builds VPC + fleet + stack for you.)
 * 4. Give the identity that runs this code:
 *      { "Effect": "Allow", "Action": ["agentaccess-mcp:*"], "Resource": "*" }
 *      { "Effect": "Allow", "Action": ["appstream:CreateStreamingURL", "appstream:DescribeFleets"], "Resource": "*" }
 * 5. Set the env: AWS credentials (standard chain: env vars, profile, SSO, instance role),
 *    AWS_REGION, WORKSPACES_AGENT_STACK, WORKSPACES_AGENT_FLEET, and WORKSPACES_AGENT_OS
 *    ("windows" or "linux", what the fleet runs; default windows). Optional:
 *    WORKSPACES_AGENT_USER_ID, the AppStream user id used when a spec has no externalUserId.
 *
 * Packages: `@smithy/signature-v4`, `@aws-crypto/sha256-js` and `@aws-sdk/credential-provider-node`
 * for signing; `@aws-sdk/client-appstream` only for `viewer()` when the session doesn't hand out a URL.
 *
 * ## How a computer maps onto the service
 *
 * createComputer sends MCP `initialize` with the stack and user id headers, and the MCP server
 * creates (or reattaches to) that user's streaming session. nativeId is the MCP session id, plus
 * `~userId` when a user id was sent. delete() sends the HTTP DELETE that ends the MCP session with
 * `x-amzn-agentaccess-expire-streaming-session-on-delete: true`, which also expires the desktop
 * session (the instance is recycled). If the MCP server forgets a session (HTTP 404), the next call
 * opens a new one for the same user and nativeId changes; the desktop survives until the fleet's
 * disconnect timeout.
 *
 * Cost notes: every distinct user id is a WorkSpaces "AI agent user", $6.42/month on Windows fleets
 * (no user fee on Linux), so reuse ids. A named user has one session per fleet and a session takes
 * one agent, so concurrent computers need distinct user ids. Always-On instances bill while running
 * whether or not an agent is attached; On-Demand fleets bill $0.025/h for stopped instances.
 */

const ID = "aws-workspaces";
/** ProviderId is a closed union in types.ts; this adapter's id isn't in it yet. */
const PID = ID as unknown as ProviderId;
const PREFIX = "agentaccess___";
const PROTOCOL_VERSION = "2025-06-18";
const SCREEN = { width: 1280, height: 720 };
const TICKS_PER_NOTCH = 120;
const MAX_TYPE_CHARS = 10_000;
/** AppStream UserId: 2-128 of [\w+=,.@-]. */
const USER_ID_RE = /^[\w+=,.@-]{2,128}$/;
const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift",
  super: "super", win: "super", windows: "super", meta: "super", cmd: "super", command: "super",
};

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface WorkspacesAgentOptions {
  region?: string;
  stack?: string;
  fleet?: string;
  os?: string;
  /** Default AppStream user id when a spec has no externalUserId. Omitted: the server uses your IAM identity. */
  userId?: string;
  /** Override the MCP endpoint (tests). Default https://agentaccess-mcp.{region}.api.aws/mcp. */
  endpoint?: string;
  /** Static credentials or a provider; default is the standard AWS chain. */
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** Per HTTP exchange. The first tools/list can wait for a desktop to boot or a profile to load. */
  httpTimeoutMs?: number;
  /** How long createComputer waits for the desktop tools to appear. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

interface Signer {
  sign(req: unknown): Promise<{ headers: Record<string, string> }>;
}

export class WorkspacesAgentProvider implements ComputerProvider {
  readonly id = ID;
  readonly computerOs: ComputerOs[];
  readonly region?: string;
  readonly stack?: string;
  readonly fleet?: string;
  readonly os: "windows" | "linux";
  /** @internal */ readonly opts: WorkspacesAgentOptions;
  private signer?: Promise<Signer>;

  constructor(opts: WorkspacesAgentOptions = {}) {
    this.opts = opts;
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.stack = opts.stack ?? process.env.WORKSPACES_AGENT_STACK;
    this.fleet = opts.fleet ?? process.env.WORKSPACES_AGENT_FLEET;
    this.os = (opts.os ?? process.env.WORKSPACES_AGENT_OS ?? "windows").toLowerCase() === "linux" ? "linux" : "windows";
    this.computerOs = [this.os];
  }

  configured(): boolean {
    return !!(this.region && this.stack && this.fleet);
  }

  /** @internal */
  get endpoint(): string {
    return this.opts.endpoint ?? `https://agentaccess-mcp.${this.region}.api.aws/mcp`;
  }

  /** @internal */
  requireConfig(): { region: string; stack: string; fleet: string } {
    if (!this.configured()) throw new ProviderError(PID, "set AWS_REGION, WORKSPACES_AGENT_STACK and WORKSPACES_AGENT_FLEET (see src/providers/workspaces.ts for the one-time fleet + stack setup)");
    return { region: this.region!, stack: this.stack!, fleet: this.fleet! };
  }

  /** @internal SigV4 signer for service agentaccess-mcp, built on first use. */
  getSigner(): Promise<Signer> {
    this.signer ??= (async () => {
      const { region } = this.requireConfig();
      const { SignatureV4 } = await optionalImport<{ SignatureV4: new (init: Record<string, unknown>) => Signer }>("@smithy/signature-v4", "aws-workspaces");
      const { Sha256 } = await optionalImport<{ Sha256: unknown }>("@aws-crypto/sha256-js", "aws-workspaces");
      let credentials = this.opts.credentials;
      if (!credentials) {
        const { defaultProvider } = await optionalImport<{ defaultProvider: () => () => Promise<AwsCredentials> }>("@aws-sdk/credential-provider-node", "aws-workspaces");
        credentials = defaultProvider();
      }
      return new SignatureV4({ service: "agentaccess-mcp", region, credentials, sha256: Sha256, applyChecksum: false });
    })();
    this.signer.catch(() => (this.signer = undefined));
    return this.signer;
  }

  /** The user id for a spec: externalUserId as-is when AppStream accepts it, else a stable hash of it. */
  private userIdFor(spec: ComputerSpec): string | undefined {
    const raw = spec.externalUserId ?? this.opts.userId ?? process.env.WORKSPACES_AGENT_USER_ID;
    if (raw === undefined || raw === "") return undefined;
    if (USER_ID_RE.test(raw)) return raw;
    return `sbr-${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
  }

  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    this.requireConfig();
    if (spec.os && spec.os !== this.os) throw new ProviderError(PID, `this fleet runs ${this.os} (WORKSPACES_AGENT_OS), not ${spec.os}`);
    const session = new McpSession(this, this.userIdFor(spec));
    await session.open();
    return new WorkspacesComputer(this, session, spec.externalUserId ?? null);
  }

  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    this.requireConfig();
    const i = nativeId.lastIndexOf("~");
    const sessionId = i === -1 ? nativeId : nativeId.slice(0, i);
    const userId = i === -1 ? undefined : nativeId.slice(i + 1);
    if (!sessionId) throw new ProviderError(PID, `bad computer id ${JSON.stringify(nativeId)}`);
    const session = new McpSession(this, userId, sessionId);
    await session.tools(); // proves the session is live (reopens it on 404)
    return new WorkspacesComputer(this, session, userId ?? null);
  }

  /** @internal Uses @aws-sdk/client-appstream CreateStreamingURL. */
  async createStreamingUrl(userId: string, validitySeconds: number): Promise<{ url: string; expiresAt: string | null }> {
    const { region, stack, fleet } = this.requireConfig();
    type Mod = {
      AppStreamClient: new (c: { region: string; credentials?: unknown }) => { send(cmd: unknown): Promise<{ StreamingURL?: string; Expires?: Date }> };
      CreateStreamingURLCommand: new (i: Record<string, unknown>) => unknown;
    };
    const { AppStreamClient, CreateStreamingURLCommand } = await optionalImport<Mod>("@aws-sdk/client-appstream", "aws-workspaces viewer");
    const client = new AppStreamClient({ region, ...(this.opts.credentials ? { credentials: this.opts.credentials } : {}) });
    const r = await client.send(new CreateStreamingURLCommand({ StackName: stack, FleetName: fleet, UserId: userId, Validity: validitySeconds }));
    if (!r.StreamingURL) throw new ProviderError(PID, "CreateStreamingURL returned no URL");
    return { url: r.StreamingURL, expiresAt: r.Expires ? new Date(r.Expires).toISOString() : null };
  }
}

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content?: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal MCP Streamable HTTP client: POST JSON-RPC, read a JSON or SSE answer, DELETE to end. */
class McpSession {
  private nextId = 1;
  private protocolVersion = PROTOCOL_VERSION;
  private toolNames?: Set<string>;

  constructor(
    private p: WorkspacesAgentProvider,
    readonly userId: string | undefined,
    public sessionId?: string,
  ) {}

  get nativeId(): string {
    return this.userId ? `${this.sessionId}~${this.userId}` : this.sessionId!;
  }

  private headers(): Record<string, string> {
    const { stack } = this.p.requireConfig();
    const h: Record<string, string> = {
      "x-amzn-agentaccess-workspaces-applications-stack": stack,
      "x-amzn-agentaccess-expire-streaming-session-on-delete": "true",
    };
    if (this.userId) h["x-amzn-agentaccess-workspaces-applications-user-id"] = this.userId;
    if (this.sessionId) {
      h["mcp-session-id"] = this.sessionId;
      h["mcp-protocol-version"] = this.protocolVersion;
    }
    return h;
  }

  /** Signs and sends one HTTP request to the MCP endpoint. */
  private async send(method: "POST" | "DELETE", body?: string): Promise<Response> {
    const url = new URL(this.p.endpoint);
    const headers: Record<string, string> = { host: url.host, ...this.headers() };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers.accept = "application/json, text/event-stream";
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const signed = await (await this.p.getSigner()).sign({
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
      return await fetch(url, { method, headers: out, body, signal: AbortSignal.timeout(this.p.opts.httpTimeoutMs ?? 300_000) });
    } catch (err) {
      throw new ProviderError(PID, `${method} ${url.host}${url.pathname}: ${(err as Error).message}`);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? j?.Message ?? text;
    } catch {
      /* not JSON */
    }
    throw new ProviderError(PID, `${what} -> HTTP ${res.status} ${detail}`.trim(), res.status);
  }

  /** One JSON-RPC request; the answer may come as JSON or as an SSE stream. */
  private async rpc(method: string, params: Record<string, unknown> = {}, retried = false): Promise<any> {
    const id = this.nextId++;
    const res = await this.send("POST", JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    if (res.status === 404 && this.sessionId && method !== "initialize" && !retried) {
      // Streamable HTTP: a 404 for a session id means the server ended it; start a new one.
      await res.body?.cancel().catch(() => {});
      this.sessionId = undefined;
      this.toolNames = undefined;
      await this.initialize();
      return this.rpc(method, params, true);
    }
    if (!res.ok) await this.fail(res, method);
    const sid = res.headers.get("mcp-session-id");
    if (sid && method === "initialize") this.sessionId = sid;
    const msg = await readAnswer(res, id);
    if (msg.error) throw new ProviderError(PID, `${method}: ${msg.error.message}${msg.error.code ? ` (${msg.error.code})` : ""}`);
    return msg.result;
  }

  private async notify(method: string): Promise<void> {
    const res = await this.send("POST", JSON.stringify({ jsonrpc: "2.0", method }));
    if (!res.ok) await this.fail(res, method);
    await res.body?.cancel().catch(() => {});
  }

  private async initialize(): Promise<void> {
    const r = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "sandboxrouter", version: "0.2.0" },
    });
    if (!this.sessionId) throw new ProviderError(PID, "initialize: the MCP server returned no Mcp-Session-Id");
    if (typeof r?.protocolVersion === "string") this.protocolVersion = r.protocolVersion;
    await this.notify("notifications/initialized");
  }

  /** initialize, then wait until tools/list shows the desktop tools (the desktop may still be connecting). */
  async open(): Promise<void> {
    await this.initialize();
    const deadline = Date.now() + (this.p.opts.readyTimeoutMs ?? 600_000);
    let lastError = "";
    for (;;) {
      try {
        const names = await this.tools(true);
        if (names.has(`${PREFIX}screenshot`)) return;
        lastError = `tools/list has no ${PREFIX}screenshot (is COMPUTER_VISION enabled on the stack?): ${[...names].join(", ") || "no tools"}`;
      } catch (err) {
        lastError = (err as Error).message;
        // Bad credentials or another agent holding the desktop won't fix themselves; a booting desktop will.
        if ((err instanceof ProviderError && (err.status === 401 || err.status === 403)) || /CONNECTION_LIMIT_REACHED|already connected/i.test(lastError)) break;
      }
      if (Date.now() >= deadline) break;
      await sleep(this.p.opts.pollMs ?? 3000);
    }
    await this.end().catch(() => {});
    throw new ProviderError(PID, `the desktop did not become ready: ${lastError}`);
  }

  async tools(refresh = false): Promise<Set<string>> {
    if (this.toolNames && !refresh) return this.toolNames;
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (r?.isError) throw new ProviderError(PID, `tools/list refused: ${textOf(r)}`);
      for (const t of r?.tools ?? []) names.add(t.name);
      cursor = r?.nextCursor;
    } while (cursor);
    this.toolNames = names;
    return names;
  }

  /** tools/call with the service prefix added to short names. */
  call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const full = name.includes("___") ? name : PREFIX + name;
    return this.rpc("tools/call", { name: full, arguments: args });
  }

  /** HTTP DELETE ends the MCP session (and, with our header, the streaming session). */
  async end(): Promise<void> {
    if (!this.sessionId) return;
    const res = await this.send("DELETE");
    if (res.status === 404) return; // already gone
    if (!res.ok) await this.fail(res, "DELETE session");
    await res.body?.cancel().catch(() => {});
    this.sessionId = undefined;
  }
}

/** The JSON-RPC response with this id, from a JSON body or a text/event-stream body. */
async function readAnswer(res: Response, id: number): Promise<JsonRpcMessage> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    const msgs: JsonRpcMessage[] = Array.isArray(body) ? body : body ? [body] : [];
    const m = msgs.find((x) => x.id === id);
    if (!m) throw new ProviderError(PID, `no JSON-RPC response for request ${id}`);
    return m;
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + "\n\n" : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line === "" && data.length) {
          const payload = data.join("\n");
          data = [];
          let msg: JsonRpcMessage | undefined;
          try {
            msg = JSON.parse(payload);
          } catch {
            continue;
          }
          // Skip server notifications and requests; return our response.
          if (msg && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
        }
      }
      if (done) throw new ProviderError(PID, `event stream ended without a response to request ${id}`);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function textOf(r: ToolResult): string {
  return (r.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Width and height from PNG IHDR or a JPEG SOF marker. */
function imageSize(b: Uint8Array): { width?: number; height?: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return {};
      const marker = b[i + 1];
      const len = v.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return {};
}

class ActionError extends Error {}

/** A streaming session on your fleet, driven by the agent access MCP tools. */
class WorkspacesComputer implements ProviderComputer {
  private frame = 0;
  private pointer?: [number, number];

  constructor(
    private p: WorkspacesAgentProvider,
    private s: McpSession,
    private externalUserId: string | null,
  ) {}

  get nativeId(): string {
    return this.s.nativeId;
  }

  /** get_session_info: mcpSessionId, stack, userId, workSpacesSessionId, fleet. */
  private async sessionInfo(): Promise<{ info: Record<string, unknown>; meta: Record<string, unknown> }> {
    const r = await this.s.call("get_session_info");
    if (r.isError) throw new ProviderError(PID, `get_session_info: ${textOf(r)}`);
    let info: Record<string, unknown> = {};
    if (r.structuredContent && typeof r.structuredContent === "object") info = r.structuredContent as Record<string, unknown>;
    else {
      try {
        info = JSON.parse(textOf(r));
      } catch {
        /* free text */
      }
    }
    return { info, meta: r._meta ?? {} };
  }

  async info(): Promise<ComputerInfo> {
    const { info } = await this.sessionInfo();
    return {
      id: this.nativeId,
      os: this.p.os,
      status: "ready",
      screen: { ...SCREEN },
      externalUserId: this.externalUserId ?? (typeof info.userId === "string" ? info.userId : null),
    };
  }

  /** Any tool the session lists, e.g. launch_application, toggle_app_switcher or forwarded___server___tool. */
  callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.s.call(name, args);
  }

  /** The service's tools, prefixed (agentaccess___screenshot, ...). */
  async listTools(): Promise<string[]> {
    return [...(await this.s.tools(true))];
  }

  private async shot(): Promise<{ bytes: Uint8Array; mime: string }> {
    const r = await this.s.call("screenshot");
    if (r.isError) throw new ActionError(`screenshot: ${textOf(r) || "failed"}`);
    const img = (r.content ?? []).find((c) => c.type === "image" && c.data);
    if (!img) throw new ActionError("screenshot returned no image");
    return { bytes: new Uint8Array(Buffer.from(img.data!, "base64")), mime: img.mimeType ?? "image/png" };
  }

  async act(action: ComputerAction): Promise<ActionResult> {
    try {
      const extra = await this.perform(action);
      if (action.action === "screenshot" || !action.noScreenshot) {
        const { bytes, mime } = await this.shot();
        return { action: action.action, ok: true, ...extra, frameId: ++this.frame, imageB64: Buffer.from(bytes).toString("base64"), mime, ...imageSize(bytes) };
      }
      return { action: action.action, ok: true, ...extra };
    } catch (err) {
      return { action: action.action, ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /** In order; stops at the first failure (later coordinates may no longer apply). */
  async actBatch(actions: ComputerAction[]): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const a of actions) {
      const r = await this.act(a);
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  private async tool(name: string, args: Record<string, unknown> = {}): Promise<void> {
    const r = await this.s.call(name, args);
    if (r.isError) throw new ActionError(`${name}: ${textOf(r) || "failed"}`);
  }

  private point(a: ComputerAction, what = "coordinate"): [number, number] {
    const c = a.coordinate ?? this.pointer;
    if (!c) throw new ActionError(`${a.action} needs a ${what} [x, y]`);
    return [Math.round(c[0]), Math.round(c[1])];
  }

  private modifiers(a: ComputerAction): Record<string, string> {
    if (!a.modifier?.trim()) return {};
    const parts = a.modifier.split(/[+\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter((x) => !MODIFIERS[x]);
    if (bad.length) throw new ActionError(`unsupported modifier ${JSON.stringify(bad.join("+"))}: use ctrl, alt, shift or super`);
    return { modifiers: [...new Set(parts.map((x) => MODIFIERS[x]))].join("+") };
  }

  private async perform(a: ComputerAction): Promise<Record<string, unknown>> {
    switch (a.action) {
      case "screenshot":
        return {};
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const [x, y] = this.point(a);
        const mods = this.modifiers(a);
        for (let i = 0; i < Math.max(1, Math.round(a.repeat ?? 1)); i++) await this.tool(a.action, { x, y, ...mods });
        this.pointer = [x, y];
        return {};
      }
      case "mouse_move": {
        if (!a.coordinate) throw new ActionError("mouse_move needs a coordinate [x, y]");
        const [x, y] = this.point(a);
        await this.tool("move_pointer", { x, y });
        this.pointer = [x, y];
        return {};
      }
      case "left_click_drag": {
        if (!a.coordinate) throw new ActionError("left_click_drag needs a coordinate [x, y] to drag to");
        const from = a.startCoordinate ?? this.pointer;
        if (!from) throw new ActionError("left_click_drag needs a startCoordinate [x, y]");
        const end: [number, number] = [Math.round(a.coordinate[0]), Math.round(a.coordinate[1])];
        await this.tool("left_click_drag", { start_x: Math.round(from[0]), start_y: Math.round(from[1]), end_x: end[0], end_y: end[1] });
        this.pointer = end;
        return {};
      }
      case "left_mouse_down":
      case "left_mouse_up": {
        const [x, y] = this.point(a);
        await this.tool(a.action, { x, y, ...this.modifiers(a) });
        this.pointer = [x, y];
        return {};
      }
      case "scroll": {
        const [x, y] = this.point(a);
        const dir = a.scrollDirection ?? "down";
        const notches = Math.round(a.scrollAmount ?? 3);
        if (notches < 1 || notches > 100) throw new ActionError("scrollAmount must be 1 to 100 wheel notches");
        await this.tool("scroll", {
          x,
          y,
          scroll_direction: dir[0].toUpperCase() + dir.slice(1),
          scroll_amount: notches * TICKS_PER_NOTCH,
          ...this.modifiers(a),
        });
        this.pointer = [x, y];
        return {};
      }
      case "type": {
        if (!a.text) throw new ActionError("type needs text");
        for (let i = 0; i < a.text.length; i += MAX_TYPE_CHARS) await this.tool("type_text", { text: a.text.slice(i, i + MAX_TYPE_CHARS) });
        return {};
      }
      case "key": {
        if (!a.text?.trim()) throw new ActionError('key needs text, e.g. "Return" or "ctrl+s"');
        // xdotool-style "ctrl+a Delete" is a sequence of presses; the service takes one combo per call.
        const combos = a.text.trim().split(/\s+/);
        for (let i = 0; i < Math.max(1, Math.round(a.repeat ?? 1)); i++) for (const keys of combos) await this.tool("key", { keys });
        return {};
      }
      case "hold_key": {
        if (!a.text?.trim()) throw new ActionError("hold_key needs text");
        const duration = a.duration ?? 1;
        if (duration < 1 || duration > 30) throw new ActionError("hold_key duration must be 1 to 30 seconds");
        await this.tool("hold_key", { keys: a.text.trim(), duration });
        return {};
      }
      case "wait": {
        // The service has no wait tool; pause here.
        const secs = a.duration ?? 1;
        if (secs < 0 || secs > 100) throw new ActionError("wait duration must be 0 to 100 seconds");
        await sleep(secs * 1000);
        return {};
      }
      case "cursor_position": {
        // No tool reports the pointer; this is where our last action left it.
        if (!this.pointer) throw new ActionError("the pointer position is not known yet: move the mouse or click first");
        return { x: this.pointer[0], y: this.pointer[1], coordinate: [...this.pointer] };
      }
      case "zoom":
        throw new ActionError("aws-workspaces does not support zoom; take a screenshot instead");
      default:
        throw new ActionError(`aws-workspaces does not support the "${(a as { action: string }).action}" action`);
    }
  }

  /** The service picks the format (the stack's ScreenImageFormat); `format`/`quality` are ignored. */
  async screenshot(_opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    try {
      return (await this.shot()).bytes;
    } catch (err) {
      if (err instanceof ActionError) throw new ProviderError(PID, err.message);
      throw err;
    }
  }

  private noShell(what: string): never {
    throw new ProviderError(
      PID,
      `${what} is not available: WorkSpaces agent access exposes only screen, mouse, keyboard, app-launch and session tools, no shell or file tools. ` +
        `Drive a terminal through act(), or bake an MCP server into the fleet image and enable FORWARD_MCP_TOOLS, then use callTool("forwarded___<server>___<tool>").`,
    );
  }

  async exec(_command: string, _timeoutSeconds?: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.noShell("exec");
  }

  async readFile(_path: string): Promise<Uint8Array> {
    this.noShell("readFile");
  }

  async writeFile(_path: string, _content: string | Uint8Array): Promise<void> {
    this.noShell("writeFile");
  }

  /**
   * A browser link to this desktop session. `watch` only: what the person can do is enforced by the
   * service through the stack's UserControlMode (VIEW_ONLY: watch; VIEW_STOP: watch plus a stop
   * button that ends the agent's session; DISABLED: no view). There is no documented way to hand a
   * person control of an agent session, so `control` throws.
   * Without ttlSeconds the session's own `_meta.streaming_url` from get_session_info is used when the
   * server provides one (expiry not reported); otherwise CreateStreamingURL (default 3600 s).
   */
  async viewer(mode: "watch" | "control" = "watch", opts: { ttlSeconds?: number; reason?: string } = {}) {
    if (mode === "control") {
      throw new ProviderError(PID, "WorkSpaces agent access has no takeover link: observers can watch (UserControlMode VIEW_ONLY) or watch and stop the agent (VIEW_STOP)");
    }
    const { info, meta } = await this.sessionInfo();
    if (opts.ttlSeconds === undefined && typeof meta.streaming_url === "string") return { url: meta.streaming_url, expiresAt: null };
    const userId = typeof info.userId === "string" ? info.userId : this.s.userId;
    if (!userId) throw new ProviderError(PID, "get_session_info returned no userId, so no streaming URL can be made");
    const ttl = Math.min(604_800, Math.max(1, Math.round(opts.ttlSeconds ?? 3600)));
    return this.p.createStreamingUrl(userId, ttl);
  }

  async delete(): Promise<void> {
    await this.s.end();
  }
}

