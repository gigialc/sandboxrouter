import type { Attempt, ExecOptions, ExecResult, RouteOptions, SandboxSpec } from "./types.js";

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
  async request(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const raw = body instanceof Uint8Array;
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Accept: accept,
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": raw ? "application/octet-stream" : "application/json" }),
      },
      body: body === undefined ? undefined : raw ? (body as unknown as BodyInit) : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: { error?: string; attempts?: Attempt[] } = {};
      try {
        parsed = JSON.parse(text);
      } catch {}
      throw new ClientError(res.status, parsed.error ?? (text || res.statusText), parsed.attempts ?? []);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  /** Providers this server can route to, with list prices. */
  async providers(): Promise<{ id: string; configured: boolean; estimatedHourlyUsd: number }[]> {
    return (await this.json<{ providers: any[] }>("GET", "/v1/providers")).providers;
  }

  /** Dry run: which providers would be tried, in order. */
  async route(spec: SandboxSpec = {}, route: RouteOptions = {}): Promise<{ provider: string; estimatedHourlyUsd: number; skip?: string }[]> {
    return (await this.json<{ candidates: any[] }>("POST", "/v1/route", { ...spec, ...route })).candidates;
  }

  /** Start a sandbox on the first provider that works, as the server routes it. */
  async create(spec: SandboxSpec = {}, route: RouteOptions = {}): Promise<RemoteSandbox> {
    const r = await this.json<{ id: string; provider: string; estimatedHourlyUsd: number; attempts: Attempt[] }>("POST", "/v1/sandboxes", {
      ...spec,
      ...route,
    });
    return new RemoteSandbox(this, r.id, r.provider, r.estimatedHourlyUsd, r.attempts);
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
  ) {
    super(`${status}: ${message}`);
    this.name = "ClientError";
  }
}

export class RemoteSandbox {
  constructor(
    private readonly client: Client,
    readonly id: string,
    readonly provider: string,
    readonly estimatedHourlyUsd?: number,
    readonly attempts: Attempt[] = [],
  ) {}

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
        else if (event === "error") throw new ClientError(502, payload.error ?? data);
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

  async pause(): Promise<void> {
    await this.client.request("POST", this.path("/pause"));
  }

  async kill(): Promise<void> {
    await this.client.request("DELETE", this.path());
  }
}
