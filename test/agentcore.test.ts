import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentCoreProvider, encodeEvent, readEventStream } from "../src/providers/agentcore.js";

/**
 * Stand-in for the AgentCore data plane (bedrock-agentcore.{region}.amazonaws.com), per
 * docs.aws.amazon.com/bedrock-agentcore/latest/APIReference: Start/Get/StopCodeInterpreterSession and
 * InvokeCodeInterpreter answering with application/vnd.amazon.eventstream frames. Commands really run.
 */
const CI = "aws.codeinterpreter.v1";
type Req = { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body?: any };

let server: Server;
let base = "";
let root = "";
let shims = "";
let reqs: Req[] = [];
let sessions = new Map<string, { dir: string; status: "READY" | "TERMINATED"; timeout: number }>();
let nextId = 1;
let mode: "events" | "split" | "json" | "exception" = "events";

function makeShims(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "timeout"),
    `#!/bin/bash\n[ "$1" = "-k" ] && shift 2\nt=$1; shift\n"$@" & pid=$!\n( sleep "$t"; kill -9 $pid ) </dev/null >/dev/null 2>&1 & w=$!\nwait $pid; c=$?\nkill $w 2>/dev/null\n[ $c -eq 137 ] && exit 124\nexit $c\n`,
  );
  chmodSync(join(dir, "timeout"), 0o755);
}

function run(cmd: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd, env: { ...process.env, PATH: `${shims}:${process.env.PATH}` } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 137, stdout, stderr }));
  });
}

/**
 * Like the real service, which runs commands in a terminal: stdout and stderr are one stream, \n
 * becomes \r\n unless the command starts with `stty -onlcr`, and the whole stream is labelled
 * stdout on exit 0 and stderr otherwise.
 */
async function pty(cmd: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await run(`{ ${cmd}\n} 2>&1`, cwd);
  const out = cmd.startsWith("stty -onlcr") ? r.stdout : r.stdout.replace(/\n/g, "\r\n");
  return r.code === 0 ? { code: 0, stdout: out, stderr: "" } : { code: r.code, stdout: "", stderr: out };
}

const resultFrame = (result: unknown) =>
  encodeEvent({ ":message-type": "event", ":event-type": "result", ":content-type": "application/json" }, JSON.stringify(result));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-agentcore-"));
  shims = join(root, "shims");
  makeShims(shims);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, base);
    const body = raw ? JSON.parse(raw) : undefined;
    reqs.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const fail = (status: number, type: string, message: string) => json(status, { message }, { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/` });

    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/") || !auth.includes("/us-east-1/bedrock-agentcore/aws4_request") || !req.headers["x-amz-date"]) {
      return fail(403, "AccessDeniedException", "missing SigV4");
    }
    const prefix = `/code-interpreters/${CI}/`;
    if (!url.pathname.startsWith(prefix)) return fail(404, "ResourceNotFoundException", "no such code interpreter");
    const op = url.pathname.slice(prefix.length);

    if (op === "sessions/start" && req.method === "PUT") {
      if (body.sessionTimeoutSeconds < 1 || body.sessionTimeoutSeconds > 28800) return fail(400, "ValidationException", "sessionTimeoutSeconds");
      if (body.clientToken && (body.clientToken.length < 33 || !/^[a-zA-Z0-9](-*[a-zA-Z0-9]){0,256}$/.test(body.clientToken))) return fail(400, "ValidationException", "clientToken");
      const id = `S${String(nextId++).padStart(5, "0")}abc`;
      const dir = join(root, "s", id);
      mkdirSync(dir, { recursive: true });
      sessions.set(id, { dir, status: "READY", timeout: body.sessionTimeoutSeconds });
      return json(200, { codeInterpreterIdentifier: CI, sessionId: id, createdAt: "2026-11-04T00:00:00Z" });
    }
    if (op === "sessions/get" && req.method === "GET") {
      const s = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!s) return fail(404, "ResourceNotFoundException", "session not found");
      return json(200, { codeInterpreterIdentifier: CI, sessionId: url.searchParams.get("sessionId"), status: s.status, sessionTimeoutSeconds: s.timeout });
    }
    if (op === "sessions/stop" && req.method === "PUT") {
      const s = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!s || s.status === "TERMINATED") return fail(404, "ResourceNotFoundException", "session not found");
      s.status = "TERMINATED";
      return json(200, { codeInterpreterIdentifier: CI, sessionId: url.searchParams.get("sessionId"), lastUpdatedAt: "2026-11-04T00:00:00Z" });
    }
    if (op === "tools/invoke" && req.method === "POST") {
      const sid = String(req.headers["x-amzn-code-interpreter-session-id"] ?? "");
      const s = sessions.get(sid);
      if (!s || s.status !== "READY") return fail(404, "ResourceNotFoundException", "session not found or stopped");
      if (body.name !== "executeCommand" || typeof body.arguments?.command !== "string") return fail(400, "ValidationException", `unsupported ${body.name}`);
      if (mode === "exception") {
        res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
        res.end(encodeEvent({ ":message-type": "exception", ":exception-type": "throttlingException", ":content-type": "application/json" }, JSON.stringify({ message: "slow down" })));
        return;
      }
      const r = await pty(body.arguments.command, s.dir);
      const result = {
        content: [{ type: "text", text: r.stdout + r.stderr }],
        structuredContent: { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, executionTime: 0.01 },
        isError: r.code !== 0,
      };
      if (mode === "json") return json(200, { result });
      res.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream", "x-amzn-code-interpreter-session-id": sid });
      if (mode === "split") {
        // Two result events: partial output first, then the rest with the exit code.
        const half = Math.floor(r.stdout.length / 2);
        const f1 = resultFrame({ content: [], structuredContent: { stdout: r.stdout.slice(0, half), stderr: "" } });
        // Deliver the first frame in two TCP writes to exercise frame reassembly.
        res.write(f1.subarray(0, 7));
        await new Promise((x) => setTimeout(x, 20));
        res.write(f1.subarray(7));
        await new Promise((x) => setTimeout(x, 20));
        res.end(resultFrame({ content: [], structuredContent: { stdout: r.stdout.slice(half), stderr: r.stderr, exitCode: r.code } }));
        return;
      }
      res.end(resultFrame(result));
      return;
    }
    fail(400, "ValidationException", `no route ${req.method} ${op}`);
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
  mode = "events";
});

const provider = (extra: Record<string, unknown> = {}) =>
  new AgentCoreProvider({ region: "us-east-1", endpoint: base, credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" }, ...extra });

describe("event stream codec", () => {
  it("round-trips frames and checks CRCs", async () => {
    const frames = Buffer.concat([resultFrame({ a: 1 }), encodeEvent({ ":message-type": "event", ":event-type": "x" }, "")]);
    const out = [];
    for await (const m of readEventStream(new Response(frames))) out.push(m);
    expect(out).toHaveLength(2);
    expect(out[0].headers).toEqual({ ":message-type": "event", ":event-type": "result", ":content-type": "application/json" });
    expect(JSON.parse(new TextDecoder().decode(out[0].payload))).toEqual({ a: 1 });
    const bad = Buffer.from(resultFrame({ a: 1 }));
    bad[bad.length - 6] ^= 0xff;
    await expect(async () => {
      for await (const _ of readEventStream(new Response(bad))) void _;
    }).rejects.toThrow(/CRC/);
  });
});

describe("AgentCore Code Interpreter", () => {
  it("is configured by region + AWS credentials", () => {
    const saved = { ...process.env };
    for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "AGENTCORE_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"]) delete process.env[k];
    try {
      expect(new AgentCoreProvider().configured()).toBe(false);
      expect(new AgentCoreProvider({ region: "us-east-1" }).configured()).toBe(false);
      process.env.AWS_PROFILE = "dev";
      expect(new AgentCoreProvider({ region: "us-east-1" }).configured()).toBe(true);
      expect(provider().configured()).toBe(true);
      // From the environment alone it is opt-in: credentials + region aren't enough.
      process.env.AWS_REGION = "us-east-1";
      expect(new AgentCoreProvider().configured()).toBe(false);
      process.env.AGENTCORE_CODE_INTERPRETER_ID = "aws.codeinterpreter.v1";
      expect(new AgentCoreProvider().configured()).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("starts a signed session with the requested lifetime and runs commands with env and cwd", async () => {
    const box = await provider().create({ timeoutMinutes: 45, env: { GREETING: "hi there" } });
    const start = reqs[0];
    expect(start).toMatchObject({ method: "PUT", path: `/code-interpreters/${CI}/sessions/start` });
    expect(start.body).toMatchObject({ sessionTimeoutSeconds: 2700, name: expect.stringMatching(/^sandboxrouter-/) });
    expect(String(start.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request, SignedHeaders=.*host/);

    const r = await box.exec(`echo "$GREETING"; echo oops >&2; exit 3`);
    expect(r).toMatchObject({ exitCode: 3, stdout: "hi there\n", stderr: "oops\n" });
    const inv = reqs.find((x) => x.path.endsWith("/tools/invoke"))!;
    expect(inv.headers["x-amzn-code-interpreter-session-id"]).toBe(box.nativeId);
    expect(inv.body.name).toBe("executeCommand");

    mkdirSync(join(sessions.get(box.nativeId)!.dir, "work"), { recursive: true });
    expect((await box.exec("pwd", { cwd: "work" })).stdout.trim().endsWith("/work")).toBe(true);
    expect((await box.exec(`printf '%s' "$Q"`, { env: { Q: `it's "quoted" $HOME` } })).stdout).toBe(`it's "quoted" $HOME`);
    await box.kill();
  });

  it("streams each result event as it arrives", async () => {
    const box = await provider().create({});
    mode = "split";
    const seen: string[] = [];
    // The service's events split the terminal stream anywhere, the stderr marker included.
    const text = "a".repeat(100) + "b".repeat(100);
    const r = await box.exec(`printf '${text}'; echo oops >&2`, { onStdout: (s) => seen.push(s) });
    expect(r).toMatchObject({ exitCode: 0, stdout: text, stderr: "oops\n" });
    expect(seen.length).toBe(2);
    expect(seen.join("")).toBe(text);
    mode = "json";
    expect((await box.exec("echo plain-json")).stdout).toBe("plain-json\n");
    await box.kill();
  });

  it("stops a command at its timeout and reports it as a timeout error", async () => {
    const box = await provider().create({});
    await expect(box.exec("sleep 5; echo late", { timeoutSeconds: 1 })).rejects.toMatchObject({
      name: "ProviderError",
      message: "agentcore: command timed out after 1s",
    });
    // A command that exits 124 by itself is a result, not a timeout.
    expect((await box.exec("exit 124", { timeoutSeconds: 5 })).exitCode).toBe(124);
    await box.kill();
  }, 20_000);

  it("writes and reads files in chunks, binary safe, at absolute and relative paths", async () => {
    const box = await provider().create({});
    const dir = sessions.get(box.nativeId)!.dir;
    const big = new Uint8Array(120_000).map((_, i) => (i * 31) % 256); // 3 chunks
    await box.writeFile(join(dir, "nested/a/big.bin"), big);
    expect(Buffer.from(readFileSync(join(dir, "nested/a/big.bin"))).equals(Buffer.from(big))).toBe(true);
    const writes = reqs.filter((x) => x.body?.arguments?.command?.includes("base64 -d"));
    expect(writes).toHaveLength(3);
    expect(writes.every((w) => w.body.arguments.command.length < 128 * 1024)).toBe(true);
    expect(Buffer.from(await box.readFile(join(dir, "nested/a/big.bin"))).equals(Buffer.from(big))).toBe(true);

    await box.writeFile("rel.txt", "relative\n");
    expect(new TextDecoder().decode(await box.readFile("rel.txt"))).toBe("relative\n");
    await box.writeFile("empty.txt", "");
    expect((await box.readFile("empty.txt")).length).toBe(0);
    await expect(box.readFile("nope.txt")).rejects.toThrow(/readFile nope.txt/);
    await box.kill();
  });

  it("reconnects to READY sessions only and stops idempotently", async () => {
    const p = provider();
    const box = await p.create({});
    const again = await p.connect(box.nativeId);
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await expect(p.connect("Snotthere")).rejects.toMatchObject({ status: 404 });
    await expect(p.connect("bad-id!")).rejects.toThrow(/invalid session id/);

    reqs = [];
    await again.kill();
    expect(reqs[0]).toMatchObject({ method: "PUT", path: `/code-interpreters/${CI}/sessions/stop` });
    expect(reqs[0].query.get("sessionId")).toBe(box.nativeId);
    await again.kill(); // already stopped
    await expect(p.connect(box.nativeId)).rejects.toMatchObject({ status: 404 });
    await expect(again.exec("true")).rejects.toThrow(/ResourceNotFoundException/);
  });

  it("surfaces event stream exceptions and HTTP errors as ProviderErrors", async () => {
    const box = await provider().create({});
    mode = "exception";
    await expect(box.exec("echo hi")).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/throttlingException: slow down/) });
    await box.kill();
    await expect(provider({ credentials: { accessKeyId: "OTHER", secretAccessKey: "x" } }).create({})).rejects.toMatchObject({ status: 403 });
  });
});
