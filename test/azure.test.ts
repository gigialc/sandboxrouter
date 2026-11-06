import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AzureSessionsProvider } from "../src/providers/azure.js";

/**
 * Stand-in for a Shell session pool's management endpoint and for Entra's token endpoint, per
 * learn.microsoft.com/rest/api/data-plane/containerapps (2025-10-02-preview) and the shell tutorial.
 * Commands really run (bash, in a temp dir per session that stands in for /mnt/data).
 */
const POOL = "/subscriptions/sub1/resourceGroups/rg1/sessionPools/pool1";
const API = "2025-10-02-preview";

let server: Server;
let base = "";
let root = "";
let shims = "";
let sessions = new Map<string, string>(); // identifier -> files dir
let tokenCalls = 0;
let reqs: { method: string; path: string; identifier?: string | null; auth?: string; body?: any }[] = [];

/** macOS lacks GNU `timeout` and `stat -c`; give the mock's bash Linux-like ones. */
function makeShims(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stat"), `#!/bin/bash\n[ "$1" = "-c" ] && shift 2\nwc -c < "$1" | tr -d ' '\n`);
  writeFileSync(
    join(dir, "timeout"),
    `#!/bin/bash\n[ "$1" = "-k" ] && shift 2\nt=$1; shift\n"$@" & pid=$!\n( sleep "$t"; kill -9 $pid ) </dev/null >/dev/null 2>&1 & w=$!\nwait $pid; c=$?\nkill $w 2>/dev/null\n[ $c -eq 137 ] && exit 124\nexit $c\n`,
  );
  chmodSync(join(dir, "stat"), 0o755);
  chmodSync(join(dir, "timeout"), 0o755);
}

function run(cmd: string, cwd: string, timeoutS: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd, env: { ...process.env, PATH: `${shims}:${process.env.PATH}` } });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 137, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-azure-"));
  shims = join(root, "shims");
  makeShims(shims);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const send = (status: number, obj?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, obj === undefined ? headers : { "Content-Type": "application/json", ...headers });
      res.end(obj === undefined ? undefined : JSON.stringify(obj));
    };
    const err = (status: number, code: string, message: string) => send(status, { error: { code, message } }, { "x-ms-error-code": code });

    // Entra client-credentials token endpoint.
    if (url.pathname === "/tenant1/oauth2/v2.0/token" && req.method === "POST") {
      const form = new URLSearchParams(raw.toString());
      tokenCalls++;
      if (form.get("grant_type") !== "client_credentials" || form.get("client_secret") !== "s3cret" || form.get("scope") !== "https://dynamicsessions.io/.default") {
        return send(401, { error: "invalid_client", error_description: "bad client" });
      }
      return send(200, { token_type: "Bearer", expires_in: 3599, access_token: "entra-token" });
    }

    if (!url.pathname.startsWith(POOL + "/")) return err(404, "NotFound", "no route");
    const path = url.pathname.slice(POOL.length + 1);
    const identifier = url.searchParams.get("identifier");
    const isJson = req.headers["content-type"]?.includes("json");
    reqs.push({ method: req.method!, path, identifier, auth: req.headers.authorization, body: isJson && raw.length ? JSON.parse(raw.toString()) : undefined });
    if (req.headers.authorization !== "Bearer entra-token" && req.headers.authorization !== "Bearer static-token") return send(401, { error: { code: "Unauthorized", message: "bad token" } });
    if (url.searchParams.get("api-version") !== API) return err(400, "SessionRequestValidationFailed", "api-version");
    if (!identifier || !/^[A-Za-z0-9|\-&^%$#(){}[\];<>]{4,128}$/.test(identifier)) return err(400, "SessionRequestValidationFailed", "identifier");

    // Requests that run something allocate the session on first use; GET/DELETE /session do not.
    const allocate = () => {
      if (!sessions.has(identifier)) {
        const d = join(root, "sessions", identifier);
        mkdirSync(d, { recursive: true });
        sessions.set(identifier, d);
      }
      return sessions.get(identifier)!;
    };

    if (path === "session" && req.method === "GET") {
      if (!sessions.has(identifier)) return err(400, "SessionWithIdentifierNotFound", `no session ${identifier}`);
      return send(200, { identifier, expireAt: "2026-11-04T01:00:00Z", createdAt: "2026-11-04T00:00:00Z", lastAccessedAt: "2026-11-04T00:00:00Z", etag: "e1" });
    }
    if (path === "session" && req.method === "DELETE") {
      if (!sessions.has(identifier)) return err(400, "SessionWithIdentifierNotFound", `no session ${identifier}`);
      rmSync(sessions.get(identifier)!, { recursive: true, force: true });
      sessions.delete(identifier);
      return send(204);
    }
    if (path === "executions" && req.method === "POST") {
      const body = JSON.parse(raw.toString());
      if (typeof body.timeoutInSeconds !== "number") return err(400, "SessionRequestValidationFailed", "timeoutInSeconds is required");
      if (typeof body.shellCommand !== "string") return err(400, "SessionRequestValidationFailed", "shellCommand");
      const dir = allocate();
      const max = body.outputStreamsMaxLength ?? 4096;
      const r = await run(body.shellCommand, dir, body.timeoutInSeconds);
      return send(200, {
        id: "exec-1",
        identifier,
        status: String(r.code),
        result: { stdout: r.stdout.slice(0, max), stderr: r.stderr.slice(0, max), executionTimeInMilliseconds: 2 },
      }, { "operation-id": "exec-1" });
    }
    if (path === "files" && req.method === "POST") {
      const dir = allocate();
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"]! } }).formData();
      const file = form.get("file") as File | null;
      if (!file || !file.name) return err(400, "SessionRequestValidationFailed", "file with a name is required");
      const data = Buffer.from(await file.arrayBuffer());
      writeFileSync(join(dir, file.name), data);
      return send(200, { name: file.name, type: "File", contentType: "application/octet-stream", sizeInBytes: data.length, lastModifiedAt: "2026-11-04T00:00:00Z" });
    }
    const m = /^files\/([^/]+)\/content$/.exec(path);
    if (m && req.method === "GET") {
      const dir = sessions.get(identifier);
      const name = decodeURIComponent(m[1]);
      if (!dir || !existsSync(join(dir, name))) return err(404, "FileNotFound", name);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(readFileSync(join(dir, name)));
    }
    err(400, "SessionRequestNotSupported", `${req.method} ${path}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  reqs = [];
});

/** Each session's files dir is its own temp dir, so filesDir points at whichever one the mock made. */
function provider(extra: Record<string, unknown> = {}) {
  const p = new AzureSessionsProvider({
    endpoint: `${base}${POOL}/`,
    tenantId: "tenant1",
    clientId: "client1",
    clientSecret: "s3cret",
    authorityHost: base,
    filesDir: ".", // the mock runs every command inside the session's files dir
    ...extra,
  });
  return p;
}

describe("Azure Container Apps Shell sessions", () => {
  it("is configured by endpoint + a token or a service principal", () => {
    const saved = { ...process.env };
    for (const k of ["AZURE_SESSIONS_POOL_ENDPOINT", "AZURE_SESSIONS_TOKEN", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) delete process.env[k];
    try {
      expect(new AzureSessionsProvider().configured()).toBe(false);
      expect(new AzureSessionsProvider({ endpoint: "https://x" }).configured()).toBe(false);
      expect(new AzureSessionsProvider({ endpoint: "https://x", token: "t" }).configured()).toBe(true);
      expect(new AzureSessionsProvider({ endpoint: "https://x", tenantId: "a", clientId: "b" }).configured()).toBe(false);
      expect(provider().configured()).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("gets an Entra token once, allocates a session with a first command, and runs commands", async () => {
    tokenCalls = 0;
    const p = provider();
    const box = await p.create({ env: { GREETING: "hi there" } });
    expect(box.nativeId).toMatch(/^sbr-[0-9a-f]{24}$/);
    expect(sessions.has(box.nativeId)).toBe(true);
    const first = reqs[0];
    expect(first).toMatchObject({ method: "POST", path: "executions", identifier: box.nativeId, auth: "Bearer entra-token" });
    expect(first.body).toMatchObject({ timeoutInSeconds: expect.any(Number), outputStreamsMaxLength: 4096, shellCommand: expect.any(String) });

    const r = await box.exec(`echo "$GREETING"; echo oops >&2; exit 3`);
    expect(r).toMatchObject({ exitCode: 3, stdout: "hi there\n", stderr: "oops\n" });

    mkdirSync(join(sessions.get(box.nativeId)!, "sub"), { recursive: true });
    const cwd = await box.exec("pwd", { cwd: "sub", env: { A: "it's" } });
    expect(cwd.stdout.trim().endsWith("/sub")).toBe(true);
    expect((await box.exec(`printf %s "$A"`, { env: { A: "it's" } })).stdout).toBe("it's");

    let streamed = "";
    await box.exec("echo streamed", { onStdout: (s) => (streamed += s) });
    expect(streamed).toBe("streamed\n");
    expect(tokenCalls).toBe(1);
    // No stray output files left behind in the session.
    expect(readdirSync(sessions.get(box.nativeId)!).filter((f) => f.startsWith("sbr-"))).toEqual([]);
    await box.kill();
  });

  it("downloads output that would be truncated by outputStreamsMaxLength", async () => {
    const box = await provider({ token: "static-token", outputCap: 256 }).create({});
    const r = await box.exec(`for i in $(seq 1 200); do echo "line $i"; done; echo done >&2`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n").length).toBe(201);
    expect(r.stdout.startsWith("line 1\nline 2\n")).toBe(true);
    expect(r.stdout.endsWith("line 200\n")).toBe(true);
    expect(r.stderr).toBe("done\n");
    expect(reqs.filter((x) => /^files\/sbr-[0-9a-f]+\.(out|err)\/content$/.test(x.path))).toHaveLength(2);
    expect(reqs.every((x) => x.auth === "Bearer static-token")).toBe(true);
    expect(readdirSync(sessions.get(box.nativeId)!).filter((f) => f.startsWith("sbr-"))).toEqual([]);
    await box.kill();
  });

  it("writes and reads files through the files API, including binary and nested paths", async () => {
    const box = await provider().create({});
    const bin = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    await box.writeFile("deep/dir/blob.bin", bin);
    const dir = sessions.get(box.nativeId)!;
    expect(Buffer.from(readFileSync(join(dir, "deep/dir/blob.bin"))).equals(Buffer.from(bin))).toBe(true);
    const back = await box.readFile("deep/dir/blob.bin");
    expect(Buffer.from(back).equals(Buffer.from(bin))).toBe(true);

    await box.writeFile("hello.txt", "hello\n");
    expect((await box.exec("cat hello.txt")).stdout).toBe("hello\n");
    expect(new TextDecoder().decode(await box.readFile("hello.txt"))).toBe("hello\n");
    expect(reqs.filter((x) => x.method === "POST" && x.path === "files")).toHaveLength(2);
    await expect(box.readFile("missing.txt")).rejects.toThrow(/readFile missing.txt/);
    expect(readdirSync(dir).filter((f) => f.startsWith("sbr-"))).toEqual([]);
    await box.kill();
  });

  it("stops a command at its timeout and reports it as a timeout error", async () => {
    const box = await provider().create({});
    await expect(box.exec("sleep 5; echo late", { timeoutSeconds: 1 })).rejects.toMatchObject({
      name: "ProviderError",
      message: "azure: command timed out after 1s",
    });
    // A command that exits 124 by itself is a result, not a timeout.
    expect((await box.exec("exit 124", { timeoutSeconds: 5 })).exitCode).toBe(124);
    await box.kill();
  }, 20_000);

  it("connects to a live session, refuses unknown ones, and deletes idempotently", async () => {
    const p = provider();
    const box = await p.create({});
    const again = await p.connect(box.nativeId);
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await expect(p.connect("sbr-doesnotexist")).rejects.toMatchObject({ status: 404 });
    await expect(p.connect("x")).rejects.toThrow(/invalid session identifier/);

    reqs = [];
    await again.kill();
    expect(reqs).toEqual([expect.objectContaining({ method: "DELETE", path: "session", identifier: box.nativeId })]);
    expect(sessions.has(box.nativeId)).toBe(false);
    await again.kill(); // already gone: no throw
  });

  it("fails clearly without an endpoint or with bad credentials", async () => {
    await expect(new AzureSessionsProvider({ endpoint: undefined, token: "t" }).create({})).rejects.toThrow(/AZURE_SESSIONS_POOL_ENDPOINT/);
    await expect(provider({ clientSecret: "wrong" }).create({})).rejects.toThrow(/Entra token -> 401 bad client/);
  });
});
