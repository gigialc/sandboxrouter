import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CATALOG } from "./catalog.js";
import { Router, type RoutedSandbox } from "./router.js";
import { splitComputerRequest, type ComputerSpec, type RoutedComputer } from "./computers.js";
import { ProviderError, RouterError, type RouteOptions, type RouterErrorCode, type SandboxSpec } from "./types.js";
import { errorStatus } from "./util.js";
import { splitRequest } from "./validate.js";

/**
 * Hooks for running this API for many users (accounts, billing, per-user sandboxes). With none set,
 * the server is single-user: one SANDBOXROUTER_TOKEN, every sandbox reachable by anyone holding it.
 */
export interface ServerHooks {
  /** Who is calling, or null for 401. Replaces the single-token check. */
  authorize?(req: IncomingMessage): Promise<unknown | null>;
  /** Routes outside /v1 (sign-in, billing webhooks, pages), checked before auth. Return true if handled. */
  extra?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Before a sandbox starts. Throw HttpError to refuse (402 out of credit, 429 too many); may edit spec and route. */
  beforeCreate?(caller: unknown, spec: SandboxSpec, route: RouteOptions): Promise<void>;
  /**
   * After it started. Return fields to add to the create response (e.g. what the caller is charged). If
   * this throws, the sandbox is killed and the error returned. Not called when the caller hung up before
   * the sandbox was ready: that sandbox is killed instead.
   */
  afterCreate?(caller: unknown, sbx: RoutedSandbox, spec: SandboxSpec): Promise<Record<string, unknown> | void>;
  /** A create that passed beforeCreate ended without a sandbox for the caller. Release whatever beforeCreate held. */
  createFailed?(caller: unknown): Promise<void> | void;
  /** May this caller use this sandbox? No means 404. */
  owns?(caller: unknown, id: string): Promise<boolean>;
  /**
   * After DELETE. `error` is set when the provider's kill failed (the sandbox may still be running): the
   * server answers with the error, but the caller asked for it gone, so stop charging them for it. A kill
   * of a sandbox the provider no longer has counts as done.
   */
  afterKill?(caller: unknown, id: string, outcome?: { error?: Error }): Promise<void>;
  /**
   * /v1/computers. Default: on for a single-user server, off when `authorize` is set. When on with
   * `authorize`, `owns` guards computer ids too, and the computer hooks below run.
   */
  computers?: boolean;
  /** Before a computer starts. Throw HttpError to refuse; may edit spec. */
  beforeCreateComputer?(caller: unknown, spec: ComputerSpec): Promise<void>;
  /** After a computer started. Return fields to add to the answer. If this throws, the computer is deleted. */
  afterCreateComputer?(caller: unknown, computer: RoutedComputer): Promise<Record<string, unknown> | void>;
  /** After DELETE /v1/computers/:id; `error` is set when the provider's delete failed. */
  afterDeleteComputer?(caller: unknown, id: string, outcome?: { error?: Error }): Promise<void>;
  /** Milliseconds a sandbox whose caller hung up (having sent an Idempotency-Key) waits for a retry to collect it. Default 120000. */
  orphanGraceMs?: number;
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
  const computersOn = hooks.computers ?? !hooks.authorize;

  /**
   * Idempotency-Key: a create retried with the same key (by the same caller, to the same path) gets the
   * first create's answer instead of starting another sandbox, for 24 hours. A retry that arrives while
   * the first is still starting waits for it. The same key with a different body is refused (422).
   * Failed creates aren't remembered, so retrying one runs it again.
   */
  const replays = new Map<string, { bodyHash: string; result: Promise<Created>; at: number; claimed: boolean }>();
  type Created = { status: number; body: Record<string, unknown>; discard?: () => Promise<void> };
  const once = async (req: IncomingMessage, res: ServerResponse, body: unknown, run: (keepIfHungUp: boolean) => Promise<Created>) => {
    const raw = req.headers["idempotency-key"];
    if (raw === undefined) {
      const r = await run(false);
      return json(res, r.status, r.body);
    }
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || key.length > 255) throw new HttpError(400, "Idempotency-Key must be 1 to 255 characters");
    const now = Date.now();
    for (const [k, v] of replays) if (now - v.at > IDEMPOTENCY_TTL_MS) replays.delete(k);
    while (replays.size >= IDEMPOTENCY_MAX) replays.delete(replays.keys().next().value!);
    const scope = sha256(`${req.headers.authorization ?? ""}\n${req.url}\n${key}`);
    const bodyHash = sha256(JSON.stringify(body ?? {}));
    const hit = replays.get(scope);
    if (hit) {
      if (hit.bodyHash !== bodyHash) throw new HttpError(422, "this Idempotency-Key was already used with a different request");
      const r = await hit.result;
      hit.claimed = true;
      res.setHeader("Idempotent-Replayed", "true");
      return json(res, r.status, r.body);
    }
    const entry = { bodyHash, result: run(true), at: now, claimed: false };
    replays.set(scope, entry);
    let r: Created;
    try {
      r = await entry.result;
    } catch (err) {
      replays.delete(scope);
      throw err;
    }
    // The caller hung up but sent a key, so it means to retry: keep the sandbox for a retry to
    // collect, and only then give up on it.
    if (!res.writableEnded && (res.destroyed || !res.writable) && r.discard) {
      setTimeout(() => {
        if (!entry.claimed) {
          replays.delete(scope);
          r.discard!().catch(() => {});
        }
      }, hooks.orphanGraceMs ?? ORPHAN_GRACE_MS).unref();
    } else entry.claimed = true;
    return json(res, r.status, r.body);
  };

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
        providers: CATALOG.filter((c) => router.registered().includes(c.id)).map((c) => {
          const p = router.plan({}, { provider: c.id })[0];
          return { ...c, configured: router.isConfigured(c.id), estimatedHourlyUsd: p.estimatedHourlyUsd, listHourlyUsd: p.listHourlyUsd, size: p.size };
        }),
      });
    }

    // POST /v1/route
    if (req.method === "POST" && parts[1] === "route" && parts.length === 2) {
      const { spec, route } = splitRequest(await readJson(req));
      return json(res, 200, { candidates: router.plan(spec, route) });
    }

    if (parts[1] === "computers") {
      if (!computersOn) return json(res, 404, { error: "computers aren't available on this server" });
      return computers(req, res, url, parts, caller);
    }
    if (parts[1] !== "sandboxes") return json(res, 404, { error: "not found" });

    // POST /v1/sandboxes
    if (req.method === "POST" && parts.length === 2) {
      const body = await readJson(req);
      const { spec, route } = splitRequest(body);
      // A caller that gives up (client timeout, closed connection) never learns the id: kill what
      // starts after that rather than leave it running, and billing, unseen. With an Idempotency-Key
      // it's kept for a retry instead (see once).
      let hungUp = false;
      res.on("close", () => (hungUp = !res.writableFinished));
      return once(req, res, body, async (keepIfHungUp) => {
        await hooks.beforeCreate?.(caller, spec, route);
        let sbx: RoutedSandbox;
        let extra: Record<string, unknown> | void;
        try {
          sbx = await router.create(spec, route);
        } catch (err) {
          await hooks.createFailed?.(caller);
          throw err;
        }
        try {
          if (hungUp && !keepIfHungUp) throw new HttpError(499, "the client closed the connection before the sandbox was ready; it was killed");
          extra = await hooks.afterCreate?.(caller, sbx, spec);
        } catch (err) {
          await sbx.kill().catch(() => {});
          await hooks.createFailed?.(caller);
          throw err;
        }
        live.set(sbx.id, sbx);
        const made = sbx;
        return {
          status: 201,
          body: {
            id: sbx.id,
            provider: sbx.provider,
            size: sbx.size,
            estimatedHourlyUsd: sbx.estimatedHourlyUsd,
            listHourlyUsd: sbx.listHourlyUsd,
            attempts: sbx.attempts,
            ...(extra ?? {}),
          },
          discard: async () => {
            live.delete(made.id);
            await made.kill().catch(() => {});
            await hooks.afterKill?.(caller, made.id);
          },
        };
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
        const e = describeError(err);
        emit("error", { ...e.body, status: e.status });
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
      try {
        await (await box(id)).kill();
      } catch (err) {
        // Already gone at the provider: that's what the caller wanted.
        if (!(err instanceof HttpError) && errorStatus(err) === 404) {
          live.delete(id);
          await hooks.afterKill?.(caller, id);
          return json(res, 200, { id, killed: true });
        }
        if (!(err instanceof HttpError)) await hooks.afterKill?.(caller, id, { error: err as Error });
        throw err;
      }
      live.delete(id);
      await hooks.afterKill?.(caller, id);
      return json(res, 200, { id, killed: true });
    }

    return json(res, 404, { error: "not found" });
  };

  const computers = async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], caller: unknown) => {
    if (req.method === "POST" && parts.length === 2) {
      const body = await readJson(req);
      const { spec, route } = splitComputerRequest(body);
      return once(req, res, body, async () => {
        await hooks.beforeCreateComputer?.(caller, spec);
        const c = await router.computer(spec, route);
        let extra: Record<string, unknown> | void;
        try {
          extra = await hooks.afterCreateComputer?.(caller, c);
        } catch (err) {
          await c.delete().catch(() => {});
          throw err;
        }
        return {
          status: 201,
          body: { ...(await c.info()), id: c.id, nativeId: c.nativeId, provider: c.provider, estimatedHourlyUsd: c.estimatedHourlyUsd, attempts: c.attempts, ...(extra ?? {}) },
        };
      });
    }
    const id = parts[2] ? decodeURIComponent(parts[2]) : "";
    if (!id) return json(res, 404, { error: "not found" });
    if (hooks.owns && !(await hooks.owns(caller, id))) throw new HttpError(404, "no such computer");
    const c = await router.getComputer(id);
    const sub = parts[3];

    if (req.method === "GET" && !sub) return json(res, 200, { ...(await c.info()), id, nativeId: c.nativeId });
    if (req.method === "DELETE" && !sub) {
      try {
        await c.delete();
      } catch (err) {
        if (errorStatus(err) !== 404) {
          await hooks.afterDeleteComputer?.(caller, id, { error: err as Error });
          throw err;
        }
      }
      await hooks.afterDeleteComputer?.(caller, id);
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
      // A closed connection can't be answered.
      if (res.writableEnded || res.destroyed) return;
      const e = describeError(err);
      json(res, e.status, e.body);
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

/**
 * The HTTP status and JSON body for an error: `{ error, code?, attempts? }`. RouterErrors carry a code
 * (see RouterErrorCode) that maps to one status; a ProviderError with an HTTP status passes it on.
 */
function describeError(err: any): { status: number; body: { error: string; code?: RouterErrorCode; attempts?: unknown[] } } {
  const status =
    err instanceof HttpError ? err.status
    : err instanceof RouterError ? ERROR_STATUS[err.code]
    : err instanceof ProviderError && err.status ? err.status
    : 500;
  const code = err instanceof RouterError ? err.code : undefined;
  return { status, body: { error: err?.message ?? String(err), ...(code ? { code } : {}), ...(err?.attempts?.length ? { attempts: err.attempts } : {}) } };
}

/** How long an Idempotency-Key is remembered, and how many at most. */
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IDEMPOTENCY_MAX = 10_000;
/** How long a sandbox whose caller hung up (with an Idempotency-Key) waits for a retry to collect it. */
export const ORPHAN_GRACE_MS = 120_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The HTTP status for each RouterError code (see RouterErrorCode). */
export const ERROR_STATUS: Record<RouterErrorCode, number> = {
  bad_request: 400,
  unsupported: 400,
  no_provider: 422,
  setup: 502,
  all_failed: 503,
  timeout: 504,
};

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
