import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CATALOG, hourlyCost } from "./catalog.js";
import { Router, type RoutedSandbox } from "./router.js";
import { ProviderError, RouterError, type RouteOptions, type SandboxSpec } from "./types.js";

/**
 * Hooks for running this API for many users (accounts, billing, per-user sandboxes). With none set,
 * the server is single-user: one SANDBOXROUTER_TOKEN, every sandbox reachable by anyone holding it.
 */
export interface ServerHooks {
  /** Who is calling, or null for 401. Replaces the single-token check. */
  authorize?(req: IncomingMessage): Promise<unknown | null>;
  /** Routes outside /v1 (sign-in, billing webhooks, pages), checked before auth. Return true if handled. */
  extra?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Before a sandbox starts. Throw HttpError to refuse (402 out of credit, 429 too many); may edit spec. */
  beforeCreate?(caller: unknown, spec: SandboxSpec, route: RouteOptions): Promise<void>;
  /** After it started. If this throws, the sandbox is killed and the error returned. */
  afterCreate?(caller: unknown, sbx: RoutedSandbox, spec: SandboxSpec): Promise<void>;
  /** May this caller use this sandbox? No means 404. */
  owns?(caller: unknown, id: string): Promise<boolean>;
  /** After DELETE killed it. */
  afterKill?(caller: unknown, id: string): Promise<void>;
  /** false turns off /v1/computers. */
  computers?: boolean;
  /** false turns off pause. */
  pause?: boolean;
}

/**
 * OpenRouter-style HTTP API in front of every provider. One token for your clients; provider keys
 * stay on this host.
 *
 *   GET    /v1/providers
 *   POST   /v1/route                      dry run: which providers would be tried, in order
 *   POST   /v1/sandboxes                  { vcpu, memoryGb, ..., provider, strategy, fallback, require, createTimeoutSeconds }
 *   POST   /v1/sandboxes/:id/exec         { cmd, cwd, env, timeoutSeconds, stream }
 *          stream: true answers text/event-stream: `stdout`/`stderr` events (JSON string chunks),
 *          then one `result` event (the ExecResult), or an `error` event
 *   POST   /v1/sandboxes/:id/pause        keeps the disk; the next call resumes it
 *   PUT    /v1/sandboxes/:id/files?path=  raw body
 *   GET    /v1/sandboxes/:id/files?path=  raw body
 *   DELETE /v1/sandboxes/:id
 *
 *   POST   /v1/computers                  { os, externalUserId, name, screen, arch, provider }
 *   GET    /v1/computers/:id
 *   POST   /v1/computers/:id/actions      one action, or { actions: [...] }
 *   GET    /v1/computers/:id/screenshot   image bytes
 *   POST   /v1/computers/:id/exec         { command, timeoutSeconds }
 *   PUT    /v1/computers/:id/files?path=  raw body
 *   GET    /v1/computers/:id/files?path=  raw body
 *   POST   /v1/computers/:id/viewer       { mode: "watch" | "control", ttlSeconds, reason }
 *   POST   /v1/computers/:id/sleep
 *   DELETE /v1/computers/:id
 */
export function createApp(
  router = new Router(),
  token = process.env.SANDBOXROUTER_TOKEN,
  /** Browser origins allowed to call this server (e.g. the website's Playground). Off by default. */
  corsOrigins: string[] = (process.env.SANDBOXROUTER_CORS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  hooks: ServerHooks = {},
) {
  // With CORS on, any page open in a browser on this machine can call the server (Chrome even
  // lets a public page reach localhost, which the Private-Network header below allows), so it
  // would start sandboxes on these provider keys. A token is required for that.
  if (corsOrigins.length && !token && !hooks.authorize) {
    throw new Error("CORS is on but SANDBOXROUTER_TOKEN is not set: browser pages could start sandboxes on your keys. Set a token, or turn CORS off.");
  }
  const expected = token ? Buffer.from(`Bearer ${token}`) : undefined;
  const authorized = (req: IncomingMessage) => {
    if (!expected) return true;
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const live = new Map<string, RoutedSandbox>();

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (!origin || !(corsOrigins.includes("*") || corsOrigins.includes(origin))) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    // Chrome asks before a public HTTPS page (the hosted Playground) may call a server on localhost.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    const allowed = cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(allowed ? 204 : 403);
      return res.end();
    }

    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (hooks.extra && (await hooks.extra(req, res, url))) return;
    let caller: unknown = null;
    if (hooks.authorize) {
      caller = await hooks.authorize(req);
      if (caller === null) return json(res, 401, { error: "unauthorized" });
    } else if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (parts[0] !== "v1") return json(res, 404, { error: "not found" });

    const box = async (id: string) => {
      if (hooks.owns && !(await hooks.owns(caller, id))) throw new HttpError(404, "no such sandbox");
      return live.get(id) ?? router.get(id);
    };

    // GET /v1/providers
    if (req.method === "GET" && parts[1] === "providers" && parts.length === 2) {
      return json(res, 200, {
        providers: CATALOG.filter((c) => router.registered().includes(c.id)).map((c) => ({
          ...c,
          configured: router.isConfigured(c.id),
          estimatedHourlyUsd: hourlyCost(c.id),
        })),
      });
    }

    // POST /v1/route
    if (req.method === "POST" && parts[1] === "route" && parts.length === 2) {
      const { spec, route } = splitBody(await readJson(req));
      return json(res, 200, { candidates: router.plan(spec, route) });
    }

    if (parts[1] === "computers") {
      if (hooks.computers === false) return json(res, 404, { error: "computers aren't available on this server" });
      return computers(req, res, url, parts);
    }
    if (parts[1] !== "sandboxes") return json(res, 404, { error: "not found" });

    // POST /v1/sandboxes
    if (req.method === "POST" && parts.length === 2) {
      const { spec, route } = splitBody(await readJson(req));
      await hooks.beforeCreate?.(caller, spec, route);
      const sbx = await router.create(spec, route);
      try {
        await hooks.afterCreate?.(caller, sbx, spec);
      } catch (err) {
        await sbx.kill().catch(() => {});
        throw err;
      }
      live.set(sbx.id, sbx);
      return json(res, 201, {
        id: sbx.id,
        provider: sbx.provider,
        estimatedHourlyUsd: sbx.estimatedHourlyUsd,
        attempts: sbx.attempts,
      });
    }

    const id = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (!id) return json(res, 404, { error: "not found" });

    // POST /v1/sandboxes/:id/exec
    if (req.method === "POST" && parts[3] === "exec") {
      const body = await readJson(req);
      if (typeof body.cmd !== "string" || !body.cmd) return json(res, 400, { error: "cmd (string) is required" });
      const sbx = await box(id);
      const opts = { cwd: body.cwd, env: body.env, timeoutSeconds: body.timeoutSeconds };
      if (body.stream !== true) return json(res, 200, await sbx.exec(body.cmd, opts));

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const r = await sbx.exec(body.cmd, { ...opts, onStdout: (c) => emit("stdout", c), onStderr: (c) => emit("stderr", c) });
        emit("result", r);
      } catch (err) {
        emit("error", { error: (err as Error).message });
      }
      return res.end();
    }

    // POST /v1/sandboxes/:id/pause
    if (req.method === "POST" && parts[3] === "pause" && parts.length === 4) {
      if (hooks.pause === false) return json(res, 400, { error: "pause isn't available on this server" });
      await (await box(id)).pause();
      // Drop the cached handle so the next call reattaches through router.get(), which resumes.
      live.delete(id);
      return json(res, 200, { id, paused: true });
    }

    // /v1/sandboxes/:id/files?path=
    if (parts[3] === "files") {
      const path = url.searchParams.get("path");
      if (!path) return json(res, 400, { error: "path query parameter is required" });
      if (req.method === "PUT") {
        await (await box(id)).writeFile(path, await readRaw(req));
        return json(res, 200, { ok: true, path });
      }
      if (req.method === "GET") {
        const data = await (await box(id)).readFile(path);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.byteLength });
        return res.end(Buffer.from(data));
      }
    }

    // DELETE /v1/sandboxes/:id
    if (req.method === "DELETE" && parts.length === 3) {
      await (await box(id)).kill();
      live.delete(id);
      await hooks.afterKill?.(caller, id);
      return json(res, 200, { id, killed: true });
    }

    return json(res, 404, { error: "not found" });
  };

  const computers = async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => {
    if (req.method === "POST" && parts.length === 2) {
      const { provider, ...spec } = await readJson(req);
      const c = await router.computer(spec, { provider });
      return json(res, 201, { ...(await c.info()), id: c.id, nativeId: c.nativeId, provider: c.provider });
    }
    const id = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (!id) return json(res, 404, { error: "not found" });
    const c = await router.getComputer(id);
    const sub = parts[3];

    if (req.method === "GET" && !sub) return json(res, 200, { ...(await c.info()), id, nativeId: c.nativeId });
    if (req.method === "DELETE" && !sub) {
      await c.delete();
      return json(res, 200, { id, deleted: true });
    }
    if (req.method === "POST" && sub === "actions") {
      const body = await readJson(req);
      return json(res, 200, Array.isArray(body.actions) ? { results: await c.actBatch(body.actions) } : await c.act(body as any));
    }
    if (req.method === "GET" && sub === "screenshot") {
      const format = url.searchParams.get("format") === "jpeg" ? "jpeg" : "png";
      const img = await c.screenshot({ format, quality: Number(url.searchParams.get("quality")) || undefined });
      res.writeHead(200, { "Content-Type": `image/${format}`, "Content-Length": img.byteLength });
      return res.end(Buffer.from(img));
    }
    if (req.method === "POST" && sub === "exec") {
      const body = await readJson(req);
      if (typeof body.command !== "string" || !body.command) return json(res, 400, { error: "command (string) is required" });
      return json(res, 200, await c.exec(body.command, body.timeoutSeconds));
    }
    if (sub === "files") {
      const path = url.searchParams.get("path");
      if (!path) return json(res, 400, { error: "path query parameter is required" });
      if (req.method === "PUT") {
        await c.writeFile(path, await readRaw(req));
        return json(res, 200, { ok: true, path });
      }
      if (req.method === "GET") {
        const data = await c.readFile(path);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.byteLength });
        return res.end(Buffer.from(data));
      }
    }
    if (req.method === "POST" && sub === "viewer") {
      const body = await readJson(req);
      return json(res, 200, await c.viewer(body.mode, { ttlSeconds: body.ttlSeconds, reason: body.reason }));
    }
    if (req.method === "POST" && sub === "sleep") {
      await c.sleep();
      return json(res, 200, { id, sleeping: true });
    }
    return json(res, 404, { error: "not found" });
  };

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status =
        err instanceof HttpError ? err.status
        : err instanceof RouterError ? 502
        : err instanceof ProviderError && err.status ? err.status
        : 500;
      json(res, status, { error: err.message, attempts: err.attempts });
    });
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ROUTE_KEYS = ["provider", "strategy", "fallback", "require", "createTimeoutSeconds"] as const;

function splitBody(body: Record<string, any>): { spec: SandboxSpec; route: RouteOptions } {
  const route: Record<string, unknown> = {};
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) ((ROUTE_KEYS as readonly string[]).includes(k) ? route : spec)[k] = v;
  // A provider id the catalog does not know is the client's mistake, not a routing failure.
  const ids = route.provider === undefined ? [] : ([] as unknown[]).concat(route.provider);
  const unknown = ids.filter((id) => !CATALOG.some((c) => c.id === id));
  if (unknown.length) throw new HttpError(400, `unknown provider: ${unknown.join(", ")}`);
  return { spec: spec as SandboxSpec, route: route as RouteOptions };
}

const MAX_BODY = 100 * 1024 * 1024;

async function readRaw(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const raw = Buffer.from(await readRaw(req)).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
