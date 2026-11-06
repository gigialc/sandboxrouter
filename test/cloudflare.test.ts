import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUDFLARE_INSTANCES } from "../src/catalog.js";
import { CloudflareProvider } from "../src/providers/cloudflare.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for the bridge Worker in bridges/cloudflare (the contract in its header comment):
 * every route needs Authorization: Bearer <BRIDGE_TOKEN>; POST /sandboxes {env, instance, image,
 * timeoutMinutes} -> 201 {id} (400 bad_request for an unknown instance or image key);
 * GET /sandboxes/:id -> {id, running, expiresAt} or 404 not_found; POST /sandboxes/:id/exec
 * {cmd, cwd, env, timeoutSeconds} runs `timeout --kill-after=5 N sh -c cmd` like the Worker does
 * (so a kill at the deadline is exit 124) and answers JSON, or with Accept: text/event-stream the
 * events stdout / stderr (JSON string chunks), result, error; PUT|GET /sandboxes/:id/files?path=
 * move raw bytes (404 ENOENT); DELETE /sandboxes/:id -> 204. Errors are JSON {code, message}.
 * Commands run in a temp dir standing in for /workspace, with a `timeout` shim on PATH for macOS.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-cf-"));
const shims = join(root, "bin");
const IMAGES = ["sandbox", "python"];
const ROUTE = /^\/sandboxes(?:\/([a-z0-9-]{1,63})(?:\/(exec|files))?)?\/?$/;
interface Box {
  env: Record<string, string>;
  instance: string;
  image: string;
  expiresAt: string;
  procs: Set<ChildProcess>;
}
let server: Server;
let base = "";
const boxes = new Map<string, Box>();
const seen: { method: string; path: string; auth?: string; accept?: string; body?: any }[] = [];
const killGroup = (c: ChildProcess) => {
  if (c.pid) try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
};

beforeAll(async () => {
  mkdirSync(shims);
  if (spawnSync("sh", ["-c", "command -v timeout"], { stdio: "ignore" }).status !== 0) {
    writeFileSync(
      join(shims, "timeout"),
      [
        "#!/bin/sh",
        "# coreutils timeout for hosts without it: timeout [-k N|--kill-after=N] N cmd...",
        'while :; do case "$1" in -k) shift 2 ;; --kill-after=*) shift ;; *) break ;; esac; done',
        's=$1; shift',
        '"$@" & p=$!',
        "# Freeze the shell, end its children, then the shell; the grace sleep is reaped with the watchdog.",
        '( sleep "$s"; kill -STOP $p; pkill -TERM -P $p; kill -TERM $p; kill -CONT $p; sleep 5; pkill -KILL -P $p; kill -KILL $p ) >/dev/null 2>&1 & w=$!',
        "wait $p 2>/dev/null; c=$?",
        "pkill -P $w >/dev/null 2>&1; kill $w >/dev/null 2>&1",
        "[ $c -eq 143 ] && exit 124",
        "exit $c",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const PATH = `${shims}:${process.env.PATH}`;

  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const body = req.headers["content-type"]?.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, accept: req.headers.accept, body });
    const error = (status: number, code: string, message: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code, message }));
    };
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer cf_test") return error(401, "unauthorized", "missing or wrong bearer token");
    const m = ROUTE.exec(url.pathname);
    if (!m) return error(404, "not_found", `no route for ${url.pathname}`);
    const [, id, action] = m;

    if (!id) {
      if (req.method !== "POST") return error(405, "method_not_allowed", `${req.method} /sandboxes`);
      const instance = body.instance ?? "standard-1";
      if (!CLOUDFLARE_INSTANCES.some((t) => t.name === instance)) return error(400, "bad_request", `unknown instance type: ${instance}`);
      const image = body.image ?? "sandbox";
      if (!IMAGES.includes(image)) return error(400, "bad_request", `unknown image "${image}" (add it under containers[].images in wrangler.jsonc)`);
      const minutes = Math.min(1440, Math.max(1, Math.round(body.timeoutMinutes ?? 30)));
      const newId = randomUUID();
      boxes.set(newId, { env: body.env ?? {}, instance, image, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), procs: new Set() });
      return json(201, { id: newId });
    }
    const box = boxes.get(id);
    if (!action && req.method === "DELETE") {
      if (box) for (const c of box.procs) killGroup(c);
      boxes.delete(id);
      res.writeHead(204);
      return res.end();
    }
    if (!box) return error(404, "not_found", "sandbox not found");
    if (!action && req.method === "GET") return json(200, { id, running: true, expiresAt: box.expiresAt });

    if (action === "exec" && req.method === "POST") {
      if (typeof body?.cmd !== "string" || !body.cmd) return error(400, "bad_request", "cmd is required");
      const stream = (req.headers.accept ?? "").includes("text/event-stream");
      const cwd = body.cwd ?? root;
      if (!existsSync(cwd)) return error(500, "internal", `chdir to cwd ("${cwd}") failed: no such file or directory`);
      const timeout = Math.max(1, Math.round(body.timeoutSeconds ?? 60));
      const child = spawn("timeout", ["--kill-after=5", String(timeout), "sh", "-c", body.cmd], {
        cwd,
        env: { PATH, HOME: root, ...box.env, ...(body.env ?? {}) },
        detached: true,
      });
      box.procs.add(child);
      const out = { stdout: "", stderr: "" };
      if (stream) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event: string, data: unknown) => stream && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => stream && res.write(": keep-alive\n\n"), 5_000);
      child.stdout.on("data", (d: Buffer) => (out.stdout += d, send("stdout", String(d))));
      child.stderr.on("data", (d: Buffer) => (out.stderr += d, send("stderr", String(d))));
      child.on("close", (code) => {
        clearInterval(heartbeat);
        box.procs.delete(child);
        if (body.cmd === "__bridge_failure__") {
          send("error", { code: "exec_failed", message: "container exec failed" });
          return res.end();
        }
        const result = { exitCode: code ?? 137, ...out };
        if (stream) {
          send("result", result);
          return res.end();
        }
        json(200, result);
      });
      return;
    }
    if (action === "files") {
      const path = url.searchParams.get("path");
      if (!path) return error(400, "bad_request", "path query parameter is required");
      if (req.method === "PUT") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, raw);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET") {
        try {
          const data = readFileSync(path);
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(data);
        } catch {
          return error(404, "ENOENT", `no such file or directory: ${path}`);
        }
      }
    }
    error(405, "method_not_allowed", `${req.method} ${url.pathname}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  for (const b of boxes.values()) for (const c of b.procs) killGroup(c);
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const p = () => new CloudflareProvider(`${base}/`, "cf_test");
const creates = () => seen.filter((s) => s.method === "POST" && s.path === "/sandboxes").map((s) => s.body);

describeConformance("cloudflare", { provider: p, dir: root });

describe("CloudflareProvider", () => {
  it("needs both the bridge URL and the token, from the constructor or the environment", async () => {
    expect(new CloudflareProvider(undefined, "t").configured()).toBe(false);
    expect(new CloudflareProvider(base, undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
    await expect(new CloudflareProvider(undefined, "t").create({})).rejects.toThrow("cloudflare: CLOUDFLARE_SANDBOX_URL is not set");
    await expect(new CloudflareProvider(base, undefined).create({})).rejects.toThrow("cloudflare: CLOUDFLARE_SANDBOX_TOKEN is not set");
    const saved = { url: process.env.CLOUDFLARE_SANDBOX_URL, token: process.env.CLOUDFLARE_SANDBOX_TOKEN };
    process.env.CLOUDFLARE_SANDBOX_URL = base;
    process.env.CLOUDFLARE_SANDBOX_TOKEN = "cf_test";
    try {
      const sbx = await new CloudflareProvider().create({});
      expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
      await sbx.kill();
    } finally {
      process.env.CLOUDFLARE_SANDBOX_URL = saved.url;
      process.env.CLOUDFLARE_SANDBOX_TOKEN = saved.token;
    }
  });

  it("maps the spec onto the bridge's create body: smallest instance type that fits, clamped lifetime, env, image", async () => {
    expect(CLOUDFLARE_INSTANCES.map((t) => t.name)).toEqual(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]);
    seen.length = 0;
    const sbx = await p().create({ vcpu: 1, memoryGb: 6, timeoutMinutes: 20, env: { A: "1" }, image: { cloudflare: "python" } });
    expect(seen[0]).toMatchObject({ auth: "Bearer cf_test", path: "/sandboxes" });
    expect(creates()[0]).toEqual({ instance: "standard-2", timeoutMinutes: 20, env: { A: "1" }, image: "python" });
    expect(boxes.get(sbx.nativeId)).toMatchObject({ instance: "standard-2", image: "python" });
    expect((await sbx.exec("echo $A")).stdout).toBe("1\n");
    await sbx.kill();
    seen.length = 0;
    await (await p().create({})).kill();
    await (await p().create({ vcpu: 16, memoryGb: 64, timeoutMinutes: 0.2 })).kill();
    await (await p().create({ vcpu: 0.1, memoryGb: 0.1, timeoutMinutes: 100_000 })).kill();
    expect(creates()).toEqual([
      { instance: "standard-3", timeoutMinutes: 30 },
      { instance: "standard-4", timeoutMinutes: 1 },
      { instance: "basic", timeoutMinutes: 1440 },
    ]);
  });

  it("carries the bridge's {code, message} errors and HTTP status into ProviderError", async () => {
    await expect(new CloudflareProvider(base, "cf_wrong").create({})).rejects.toMatchObject({
      name: "ProviderError",
      status: 401,
      message: "cloudflare: POST /sandboxes -> 401 unauthorized: missing or wrong bearer token",
    });
    await expect(p().create({ image: { cloudflare: "nope" } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('bad_request: unknown image "nope"') });
    await expect(p().connect("missing-id")).rejects.toMatchObject({ status: 404, message: "cloudflare: GET /sandboxes/missing-id -> 404 not_found: sandbox not found" });
    const sbx = await p().create({});
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404, message: expect.stringContaining("ENOENT") });
    await expect(sbx.exec("__bridge_failure__", { onStdout: () => {} })).rejects.toThrow("cloudflare: exec_failed: container exec failed");
    await sbx.kill();
  });

  it("sends cwd, env and timeoutSeconds as JSON and asks for SSE only when streaming", async () => {
    const sbx = await p().create({});
    seen.length = 0;
    const r = await sbx.exec('printf "%s %s" "$X" "$(basename "$PWD")"', { cwd: root, env: { X: "y" }, timeoutSeconds: 7 });
    expect(r).toMatchObject({ exitCode: 0, stdout: `y ${root.split("/").pop()}` });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/sandboxes/${sbx.nativeId}/exec`, body: { cmd: 'printf "%s %s" "$X" "$(basename "$PWD")"', cwd: root, env: { X: "y" }, timeoutSeconds: 7 } });
    expect(seen[0].accept ?? "").not.toContain("text/event-stream");
    expect(seen[0].body).not.toHaveProperty("onStdout");

    const events: string[] = [];
    const s = await sbx.exec("echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(seen[1]).toMatchObject({ accept: "text/event-stream", body: { timeoutSeconds: 60 } });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(s).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    await sbx.kill();
  });

  it("reads exit 124 from the Worker's `timeout` as the contract's timeout, but not a quick exit 124", async () => {
    const sbx = await p().create({});
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toMatchObject({ name: "ProviderError", message: "cloudflare: command timed out after 1s" });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await sbx.exec("exit 124")).exitCode).toBe(124);
    await sbx.kill();
  });

  it("has no pause (containers keep no disk when stopped); DELETE ends the sandbox and is idempotent", async () => {
    const sbx = await p().create({});
    expect(sbx.pause).toBeUndefined();
    seen.length = 0;
    await sbx.kill();
    await sbx.kill();
    expect(seen.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404 });
  });
});
