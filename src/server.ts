import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CATALOG, hourlyCost } from "./catalog.js";
import { Router, type RoutedSandbox } from "./router.js";
import { ProviderError, RouterError, type RouteOptions, type SandboxSpec } from "./types.js";

/**
 * OpenRouter-style HTTP API in front of every provider. One token for your clients; provider keys
 * stay on this host.
 *
 *   GET    /v1/providers
 *   POST   /v1/route                      dry run: which providers would be tried, in order
 *   POST   /v1/sandboxes                  { vcpu, memoryGb, ..., provider, strategy, fallback, require }
 *   POST   /v1/sandboxes/:id/exec         { cmd, cwd, env, timeoutSeconds }
 *   PUT    /v1/sandboxes/:id/files?path=  raw body
 *   GET    /v1/sandboxes/:id/files?path=  raw body
 *   DELETE /v1/sandboxes/:id
 */
export function createApp(router = new Router(), token = process.env.SANDBOXROUTER_TOKEN) {
  const live = new Map<string, RoutedSandbox>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
    if (parts[0] !== "v1") return json(res, 404, { error: "not found" });

    const box = async (id: string) => live.get(id) ?? router.get(id);

    // GET /v1/providers
    if (req.method === "GET" && parts[1] === "providers" && parts.length === 2) {
      return json(res, 200, {
        providers: CATALOG.map((c) => ({
          ...c,
          configured: router.provider(c.id).configured(),
          estimatedHourlyUsd: hourlyCost(c.id),
        })),
      });
    }

    // POST /v1/route
    if (req.method === "POST" && parts[1] === "route" && parts.length === 2) {
      const { spec, route } = splitBody(await readJson(req));
      return json(res, 200, { candidates: router.plan(spec, route) });
    }

    if (parts[1] !== "sandboxes") return json(res, 404, { error: "not found" });

    // POST /v1/sandboxes
    if (req.method === "POST" && parts.length === 2) {
      const { spec, route } = splitBody(await readJson(req));
      const sbx = await router.create(spec, route);
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
      const r = await (await box(id)).exec(body.cmd, { cwd: body.cwd, env: body.env, timeoutSeconds: body.timeoutSeconds });
      return json(res, 200, r);
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
      return json(res, 200, { id, killed: true });
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ROUTE_KEYS = ["provider", "strategy", "fallback", "require"] as const;

function splitBody(body: Record<string, any>): { spec: SandboxSpec; route: RouteOptions } {
  const route: Record<string, unknown> = {};
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) ((ROUTE_KEYS as readonly string[]).includes(k) ? route : spec)[k] = v;
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
