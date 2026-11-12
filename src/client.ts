import type { Candidate, Size } from "./router.js";
import type { Attempt, ExecOptions, ExecResult, RouteOptions, RouterErrorCode, SandboxSpec } from "./types.js";

/**
 * Client for the sandboxrouter HTTP API: the hosted service (one key, prepaid credits) or your own
 * `sandboxrouter serve`. Provider keys live on the server; this side only needs the one key.
 *
 *   const sr = new Client({ apiKey: process.env.SANDBOXROUTER_API_KEY });
 *   const sbx = await sr.create({ vcpu: 2, memoryGb: 4 });
 *   console.log(sbx.provider, (await sbx.exec("python3 -c 'print(6*7)'")).stdout);
 *   await sbx.kill();
 */
export class Client {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetch: typeof fetch;

  constructor(opts: { apiKey?: string; baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.SANDBOXROUTER_URL ?? DEFAULT_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.SANDBOXROUTER_API_KEY ?? process.env.SANDBOXROUTER_TOKEN;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** @internal */
  async request(method: string, path: string, body?: unknown, accept = "application/json", headers: Record<string, string> = {}): Promise<Response> {
    const raw = body instanceof Uint8Array;
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Accept: accept,
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": raw ? "application/octet-stream" : "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? (body as unknown as BodyInit) : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: { error?: string; attempts?: Attempt[]; code?: RouterErrorCode } = {};
      try {
        parsed = JSON.parse(text);
      } catch {}
      throw new ClientError(res.status, parsed.error ?? (text || res.statusText), parsed.attempts ?? [], parsed.code);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  /** Providers this server can route to, with prices at the default size. */
  async providers(): Promise<{ id: string; configured: boolean; estimatedHourlyUsd: number; listHourlyUsd: number; size: Size }[]> {
    return (await this.json<{ providers: any[] }>("GET", "/v1/providers")).providers;
  }

  /** Dry run: which providers would be tried, in order, each with its price, size and any reason it's skipped. */
  async route(spec: SandboxSpec = {}, route: RouteOptions = {}): Promise<Candidate[]> {
    return (await this.json<{ candidates: Candidate[] }>("POST", "/v1/route", { ...spec, ...route })).candidates;
  }

  /**
   * Start a sandbox on the first provider that works, as the server routes it. With `idempotencyKey`,
   * sending the same create again (say, after a timeout) returns the same sandbox instead of starting
   * a second one; use a new key for each sandbox you mean to start.
   */
  async create(spec: SandboxSpec = {}, route: RouteOptions = {}, opts: { idempotencyKey?: string } = {}): Promise<RemoteSandbox> {
    const headers: Record<string, string> = opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {};
    const res = await this.request("POST", "/v1/sandboxes", { ...spec, ...route }, "application/json", headers);
    const r = (await res.json()) as CreateResponse;
    return new RemoteSandbox(this, r.id, r.provider, { ...r, replayed: res.headers.get("idempotent-replayed") === "true" });
  }

  /** A handle on a sandbox you created earlier. */
  sandbox(id: string): RemoteSandbox {
    return new RemoteSandbox(this, id, id.split(":")[0]);
  }
}

const DEFAULT_URL = "http://127.0.0.1:8787";

export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly attempts: Attempt[] = [],
    /** The server's RouterErrorCode, when the router refused or failed (e.g. "no_provider", "all_failed"). */
    readonly code?: RouterErrorCode,
  ) {
    super(`${status}: ${message}`);
    this.name = "ClientError";
  }
}

/** What POST /v1/sandboxes answers. A hosted service may add fields (e.g. what it charges). */
export interface CreateResponse {
  id: string;
  provider: string;
  size?: Size;
  estimatedHourlyUsd?: number;
  listHourlyUsd?: number;
  attempts: Attempt[];
  [field: string]: unknown;
}

export class RemoteSandbox {
  readonly estimatedHourlyUsd?: number;
  readonly listHourlyUsd?: number;
  readonly size?: Size;
  readonly attempts: Attempt[];

  constructor(
    private readonly client: Client,
    readonly id: string,
    readonly provider: string,
    /** The full create response, including any fields the server added. Empty for `client.sandbox(id)`. */
    readonly details: Partial<CreateResponse> = {},
  ) {
    this.estimatedHourlyUsd = details.estimatedHourlyUsd;
    this.listHourlyUsd = details.listHourlyUsd;
    this.size = details.size;
    this.attempts = details.attempts ?? [];
  }

  private path(suffix = "") {
    return `/v1/sandboxes/${encodeURIComponent(this.id)}${suffix}`;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { onStdout, onStderr, ...rest } = opts;
    const body = { cmd, ...rest };
    if (!onStdout && !onStderr) return (await this.client.request("POST", this.path("/exec"), body)).json() as Promise<ExecResult>;

    const res = await this.client.request("POST", this.path("/exec"), { ...body, stream: true }, "text/event-stream");
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = /^event: ?(.*)$/m.exec(block)?.[1] ?? "message";
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(l[5] === " " ? 6 : 5))
          .join("\n");
        const payload = JSON.parse(data);
        if (event === "stdout") onStdout?.(payload);
        else if (event === "stderr") onStderr?.(payload);
        else if (event === "result") return payload as ExecResult;
        else if (event === "error") throw new ClientError(payload.status ?? 502, payload.error ?? data, [], payload.code);
      }
    }
    throw new ClientError(502, "stream ended before the command finished");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.client.request("PUT", this.path(`/files?path=${encodeURIComponent(path)}`), data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.client.request("GET", this.path(`/files?path=${encodeURIComponent(path)}`), undefined, "application/octet-stream");
    return new Uint8Array(await res.arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async pause(): Promise<void> {
    await this.client.request("POST", this.path("/pause"));
  }

  async kill(): Promise<void> {
    await this.client.request("DELETE", this.path());
  }

  /** `await using sbx = await client.create()` kills it when the block ends. */
  async [Symbol.asyncDispose]() {
    await this.kill();
  }
}
