/**
 * sandboxrouter bridge for Cloudflare Sandboxes.
 *
 * Cloudflare sandboxes are Containers started from a Durable Object, so they can only be driven
 * from inside a Worker. This Worker exposes them over HTTPS for sandboxrouter's CloudflareProvider.
 * Every route needs `Authorization: Bearer <BRIDGE_TOKEN>`.
 *
 *   POST   /sandboxes                 {env?, instance?, image?, timeoutMinutes?} -> {id}
 *   GET    /sandboxes/:id             -> {id, running, expiresAt}
 *   POST   /sandboxes/:id/exec        {cmd, cwd?, env?, timeoutSeconds?} -> {exitCode, stdout, stderr}
 *                                     With `Accept: text/event-stream`: `stdout` / `stderr` events
 *                                     (data = JSON string chunk), then `result` (data = JSON result).
 *   PUT    /sandboxes/:id/files?path= raw body
 *   GET    /sandboxes/:id/files?path= raw bytes
 *   DELETE /sandboxes/:id
 *
 * Errors are JSON {code, message} with a matching HTTP status.
 * Docs: https://developers.cloudflare.com/sandbox/  (SDK 1.0: Files from @cloudflare/sandbox,
 * commands via ctx.container.exec()).
 */
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export interface Env {
	SANDBOX: DurableObjectNamespace<BridgeSandbox>;
	BRIDGE_TOKEN?: string;
	SANDBOX_INTERNET?: string;
}

type Instance = "lite" | "basic" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
const INSTANCES: readonly Instance[] = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];

const WORKDIR = "/workspace";
const DEFAULT_LIFETIME_MIN = 30;
const MAX_LIFETIME_MIN = 24 * 60;
/** setInactivityTimeout() accepts at most 6 hours. */
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_EXEC_TIMEOUT_S = 60;

interface CreateBody {
	env?: Record<string, string>;
	instance?: Instance;
	image?: string;
	timeoutMinutes?: number;
}

interface ExecBody {
	cmd: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutSeconds?: number;
}

interface Meta {
	env: Record<string, string>;
	deadline: number;
	idleMs: number;
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ code, message }, { status });
}

function toErrorResponse(err: unknown): Response {
	if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message);
	if (SandboxFileError.is(err)) {
		const status = err.code === "ENOENT" ? 404 : err.code === "EACCES" || err.code === "EPERM" ? 403 : 400;
		return errorResponse(status, err.code, err.message);
	}
	return errorResponse(500, "internal", err instanceof Error ? err.message : String(err));
}

/** Keep only string values: env vars cross a JSON boundary. */
function stringEnv(v: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (v && typeof v === "object") {
		for (const [k, val] of Object.entries(v)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, "bad_request", `invalid env var name: ${k}`);
			if (typeof val === "string") out[k] = val;
		}
	}
	return out;
}

function parentDir(path: string): string | null {
	const i = path.lastIndexOf("/");
	return i <= 0 ? null : path.slice(0, i);
}

/** One sandbox: a Durable Object that owns one Container instance. */
export class BridgeSandbox extends DurableObject<Env> {
	private readonly files: Files;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (!ctx.container) throw new Error("No container is configured");
		const container = ctx.container;
		this.files = new Files(container);
		// The inactivity timeout does not survive a Durable Object restart (e.g. a deploy): set it again.
		void ctx.blockConcurrencyWhile(async () => {
			const meta = await ctx.storage.get<Meta>("meta");
			if (meta && container.running) await container.setInactivityTimeout(meta.idleMs);
		});
	}

	private get container(): Container {
		const c = this.ctx.container;
		if (!c) throw new Error("No container is configured");
		return c;
	}

	/** Start the container and wait until it accepts commands. */
	async create(id: string, body: CreateBody): Promise<Response> {
		try {
			await this.start(body);
			return Response.json({ id }, { status: 201 });
		} catch (err) {
			// Errors cross RPC as plain Errors, so build the HTTP response here.
			return toErrorResponse(err);
		}
	}

	private async start(body: CreateBody): Promise<void> {
		const instance = body.instance ?? "standard-1";
		if (!INSTANCES.includes(instance)) throw new HttpError(400, "bad_request", `unknown instance type: ${instance}`);
		const imageKey = body.image ?? "sandbox";
		const image = this.container.images[imageKey];
		if (!image) throw new HttpError(400, "bad_request", `unknown image "${imageKey}" (add it under containers[].images in wrangler.jsonc)`);
		const minutes = Math.min(MAX_LIFETIME_MIN, Math.max(1, Math.round(body.timeoutMinutes ?? DEFAULT_LIFETIME_MIN)));
		const env = stringEnv(body.env);
		const meta: Meta = {
			env,
			deadline: Date.now() + minutes * 60_000,
			// The router promises a hard lifetime, so don't let the idle timer end it much earlier.
			idleMs: Math.min(MAX_IDLE_MS, minutes * 60_000),
		};

		if (!this.container.running) {
			this.container.start({ image, instance, env, enableInternet: this.env.SANDBOX_INTERNET !== "false" });
		}
		try {
			await this.container.setInactivityTimeout(meta.idleMs);
			await this.ctx.storage.put("meta", meta);
			// Hard lifetime: the alarm destroys the container at the deadline.
			await this.ctx.storage.setAlarm(meta.deadline);
			// start() returns before the container is ready; the first exec() waits for it.
			const ready = await this.container.exec(["true"]);
			await ready.exitCode;
		} catch (err) {
			await this.destroy();
			throw err;
		}
	}

	async alarm(): Promise<void> {
		await this.destroy();
	}

	/** Metadata for a live sandbox, or an HttpError when it is gone. */
	private async live(): Promise<Meta> {
		const meta = await this.ctx.storage.get<Meta>("meta");
		if (!meta) throw new HttpError(404, "not_found", "sandbox not found");
		if (Date.now() >= meta.deadline || !this.container.running) {
			await this.destroy();
			throw new HttpError(404, "not_found", "sandbox has stopped");
		}
		return meta;
	}

	async info(id: string): Promise<Response> {
		try {
			const meta = await this.live();
			return Response.json({ id, running: true, expiresAt: new Date(meta.deadline).toISOString() });
		} catch (err) {
			return toErrorResponse(err);
		}
	}

	async exec(body: ExecBody, stream: boolean): Promise<Response> {
		try {
			const meta = await this.live();
			if (typeof body?.cmd !== "string" || !body.cmd) throw new HttpError(400, "bad_request", "cmd is required");
			const timeout = Math.max(1, Math.round(body.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S));
			// exec() runs argv without a shell and does not inherit start() env (except PATH).
			// GNU `timeout` stops the command and its process group: exit 124 (or 137 after SIGKILL).
			const argv = ["timeout", "--kill-after=5", String(timeout), "sh", "-c", body.cmd];
			const proc = await this.container.exec(argv, {
				cwd: body.cwd ?? WORKDIR,
				env: { ...meta.env, ...stringEnv(body.env) },
			});
			if (!stream) {
				const out = await proc.output();
				const dec = new TextDecoder();
				const result: ExecResult = { exitCode: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
				return Response.json(result);
			}
			return this.streamProcess(proc);
		} catch (err) {
			return toErrorResponse(err);
		}
	}

	/** Server-sent events: stdout/stderr chunks as they arrive, then the full result. */
	private streamProcess(proc: ExecProcess): Response {
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const enc = new TextEncoder();
		const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
		const collected = { stdout: "", stderr: "" };

		const forward = async (s: ReadableStream<Uint8Array> | null, event: "stdout" | "stderr") => {
			if (!s) return;
			for await (const text of s.pipeThrough(new TextDecoderStream())) {
				collected[event] += text;
				await send(event, text);
			}
		};

		let exited = false;
		const markExited = () => {
			exited = true;
		};
		proc.exitCode.then(markExited, markExited);
		// Signaling a process that has exited records an internal error.
		const stop = () => {
			if (!exited) proc.kill();
		};
		// Kill the command when the client disconnects.
		writer.closed.catch(stop);
		// Comments keep the connection alive and detect a disconnect while the command is silent.
		const heartbeat = setInterval(() => {
			writer.write(enc.encode(": keep-alive\n\n")).catch(() => {});
		}, 5_000);

		const pump = async () => {
			try {
				// Read both streams at once: an unread pipe can block a process that keeps writing.
				await Promise.all([forward(proc.stdout, "stdout"), forward(proc.stderr, "stderr")]);
				const result: ExecResult = { exitCode: await proc.exitCode, ...collected };
				await send("result", result);
				await writer.close();
			} catch (err) {
				stop();
				await send("error", { code: "exec_failed", message: err instanceof Error ? err.message : String(err) }).catch(() => {});
				await writer.close().catch(() => {});
			} finally {
				clearInterval(heartbeat);
			}
		};
		void pump();

		return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
	}

	async writeFile(path: string, body: ReadableStream<Uint8Array> | null): Promise<Response> {
		try {
			await this.live();
			const opts = { cwd: WORKDIR };
			const dir = parentDir(path);
			if (dir) await this.files.mkdir(dir, { ...opts, recursive: true });
			await this.files.writeFile(path, body ?? "", opts);
			return new Response(null, { status: 204 });
		} catch (err) {
			return toErrorResponse(err);
		}
	}

	async readFile(path: string): Promise<Response> {
		try {
			await this.live();
			const res = await this.files.readFile(path, { cwd: WORKDIR });
			return new Response(res.body, { headers: { "Content-Type": "application/octet-stream" } });
		} catch (err) {
			return toErrorResponse(err);
		}
	}

	/** Stop the container at once and forget the sandbox. Safe to call twice. */
	async destroy(): Promise<void> {
		if (this.container.running) await this.container.destroy();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
}

async function authorized(request: Request, token: string): Promise<boolean> {
	const header = request.headers.get("Authorization") ?? "";
	const given = header.startsWith("Bearer ") ? header.slice(7) : "";
	// Hash both sides so timingSafeEqual gets equal lengths.
	const [a, b] = await Promise.all(
		[given, token].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
	);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function readJson<T>(request: Request): Promise<T> {
	const text = await request.text();
	if (!text) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new HttpError(400, "bad_request", "body must be JSON");
	}
}

const ROUTE = /^\/sandboxes(?:\/([a-z0-9-]{1,63})(?:\/(exec|files))?)?\/?$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (!env.BRIDGE_TOKEN) return errorResponse(500, "not_configured", "BRIDGE_TOKEN secret is not set (npx wrangler secret put BRIDGE_TOKEN)");
			if (!(await authorized(request, env.BRIDGE_TOKEN))) return errorResponse(401, "unauthorized", "missing or wrong bearer token");

			const url = new URL(request.url);
			const m = ROUTE.exec(url.pathname);
			if (!m) return errorResponse(404, "not_found", `no route for ${url.pathname}`);
			const [, id, action] = m;
			const method = request.method;

			if (!id) {
				if (method !== "POST") return errorResponse(405, "method_not_allowed", `${method} /sandboxes`);
				const body = await readJson<CreateBody>(request);
				const newId = crypto.randomUUID();
				return await env.SANDBOX.getByName(newId).create(newId, body);
			}

			const sandbox = env.SANDBOX.getByName(id);
			if (!action) {
				if (method === "GET") return await sandbox.info(id);
				if (method === "DELETE") {
					await sandbox.destroy();
					return new Response(null, { status: 204 });
				}
			} else if (action === "exec" && method === "POST") {
				const body = await readJson<ExecBody>(request);
				const stream = (request.headers.get("Accept") ?? "").includes("text/event-stream");
				return await sandbox.exec(body, stream);
			} else if (action === "files") {
				const path = url.searchParams.get("path");
				if (!path) return errorResponse(400, "bad_request", "path query parameter is required");
				if (method === "GET") return await sandbox.readFile(path);
				if (method === "PUT") return await sandbox.writeFile(path, request.body);
			}
			return errorResponse(405, "method_not_allowed", `${method} ${url.pathname}`);
		} catch (err) {
			return toErrorResponse(err);
		}
	},
} satisfies ExportedHandler<Env>;
