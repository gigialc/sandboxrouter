import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpstashProvider, upstashSize } from "../src/providers/upstash.js";

/**
 * A stand-in for us-east-1.box.upstash.com following the routes and fields the official
 * @upstash/box SDK uses (X-Box-Api-Key, POST /v2/box {ephemeral...}, /exec, /exec-stream,
 * /files/read|write, DELETE). Commands really run (argv as sent), in a temp dir.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; query: string; key?: string; body?: any }[] = [];
const boxes = new Map<string, string>();
/** How the next exec-stream should end: normally, split across writes, or with an error event. */
let streamMode: "normal" | "split" | "error" | "error-split" = "normal";

function run(argv: string[], onData?: (s: string) => void): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => ((out += d), onData?.(String(d))));
    // Merge stderr into the stream like a pty would; the adapter must keep it out of stdout anyway.
    child.stderr.on("data", (d) => ((err += d), onData?.(String(d))));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-upstash-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, base);
    const body = raw ? JSON.parse(raw) : undefined;
    const key = req.headers["x-box-api-key"] as string | undefined;
    seen.push({ method: req.method!, path: url.pathname, query: url.search, key, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (key !== "box_test") return send(401, { error: "invalid api key" });

    if (url.pathname === "/v2/box" && req.method === "POST") {
      if (!body.ephemeral) return send(400, { error: "expected ephemeral" });
      if (body.ttl > 259200) return send(400, { error: "ttl too large" });
      const id = `sweet-shark-${boxes.size + 1}`;
      boxes.set(id, "idle");
      return send(200, { id, status: "idle", size: body.size, ephemeral: true, expires_at: Math.floor(Date.now() / 1000) + body.ttl });
    }
    const m = url.pathname.match(/^\/v2\/box\/([^/]+)(\/.*)?$/);
    if (!m || !boxes.has(m[1])) return send(404, { error: "box not found" });
    const [, id, sub = ""] = m;
    if (sub === "" && req.method === "GET") return send(200, { id, status: boxes.get(id) });
    if (sub === "" && req.method === "DELETE") {
      boxes.set(id, "deleted");
      return send(200, {});
    }
    if (sub === "/exec" && req.method === "POST") {
      const r = await run(body.command);
      return send(200, { output: r.out, error: r.err, exit_code: r.code });
    }
    if (sub === "/exec-stream" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const r = await run(body.command, (s) => res.write(s));
      if (streamMode === "error") {
        res.end(`event: error\ndata: ${JSON.stringify({ error: "box crashed" })}\n\n`);
      } else if (streamMode === "error-split") {
        // A read that ends exactly after "event: error" (12 chars, longer than the exit marker).
        res.write("event: error");
        await new Promise((r) => setTimeout(r, 30));
        res.end(`\ndata: ${JSON.stringify({ error: "box crashed" })}\n\n`);
      } else if (streamMode === "split") {
        res.write("event: ex");
        await new Promise((r) => setTimeout(r, 30));
        res.write(`it\ndata: {"exit_code":${r.code},`);
        await new Promise((r) => setTimeout(r, 30));
        res.end(`"cpu_ns":1}\n\n`);
      } else {
        res.end(`event: exit\ndata: ${JSON.stringify({ exit_code: r.code, cpu_ns: 1 })}\n\n`);
      }
      return;
    }
    if (sub === "/files/write" && req.method === "POST") {
      if (body.encoding !== "base64") return send(400, { error: "expected base64" });
      try {
        writeFileSync(body.path, Buffer.from(body.content, "base64"));
      } catch (e: any) {
        return send(400, { error: e.message });
      }
      return send(200, {});
    }
    if (sub === "/files/read" && req.method === "GET") {
      try {
        const data = readFileSync(url.searchParams.get("path")!);
        return send(200, { content: url.searchParams.get("encoding") === "base64" ? data.toString("base64") : data.toString() });
      } catch {
        return send(404, { error: "file not found" });
      }
    }
    send(404, { error: "no route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("UpstashProvider", () => {
  const p = () => new UpstashProvider("box_test", base);

  it("creates an ephemeral box with size, ttl, runtime and env", async () => {
    const sbx = await p().create({ vcpu: 3, memoryGb: 4, timeoutMinutes: 20, env: { A: "1" }, image: { upstash: "python" } });
    expect(sbx.nativeId).toMatch(/^sweet-shark-/);
    const req = seen.find((s) => s.method === "POST" && s.path === "/v2/box")!;
    expect(req.key).toBe("box_test");
    expect(req.body).toEqual({ ephemeral: true, ttl: 1200, size: "medium", runtime: "python", env_vars: { A: "1" } });
  });

  it("picks the smallest fixed size that fits and clamps ttl to 3 days", async () => {
    expect(upstashSize(2, 4).size).toBe("small");
    expect(upstashSize(2, 6).size).toBe("medium");
    expect(upstashSize(8, 16).size).toBe("large");
    expect(upstashSize(32, 64).size).toBe("large");
    seen.length = 0;
    await p().create({ timeoutMinutes: 100_000 });
    expect(seen[0].body).toEqual({ ephemeral: true, ttl: 259200, size: "small" });
  });

  it("rejects unknown runtimes before calling the API", async () => {
    seen.length = 0;
    await expect(p().create({ image: { upstash: "ubuntu:22.04" } })).rejects.toThrow("unknown runtime");
    expect(seen).toHaveLength(0);
  });

  it("surfaces API errors with the HTTP status", async () => {
    await expect(new UpstashProvider("box_wrong", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("invalid api key") });
    await expect(p().connect("no-such-box")).rejects.toMatchObject({ status: 404 });
  });

  it("runs commands with env, cwd and exit codes", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('echo "$GREETING from $(basename "$PWD")"; echo err >&2', { env: { GREETING: "it's me" }, cwd: "/tmp" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "it's me from tmp\n", stderr: "err\n" });
    const req = seen.at(-1)!;
    expect(req.path).toMatch(/\/exec$/);
    expect(req.body.command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("wraps commands in `timeout` and reports a timeout as an error", async () => {
    const sbx = await p().create({});
    await sbx.exec("true", { timeoutSeconds: 7 });
    expect(seen.at(-1)!.body.command[2]).toContain("timeout 7 sh -c 'true'");
    // Boxes run Debian/Alpine, which ship `timeout`; a macOS test host may not.
    const hasTimeout = (await run(["sh", "-c", "command -v timeout"])).code === 0;
    if (hasTimeout) await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toThrow("timed out after 1s");
  });

  it("streams stdout live and keeps stderr separate", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    expect(events).toEqual(["out:one", "out:three", "err:two"]);
    expect(seen.some((s) => s.path.endsWith("/exec-stream"))).toBe(true);
  });

  it("parses an exit event split across network reads", async () => {
    streamMode = "split";
    try {
      const sbx = await p().create({});
      const out: string[] = [];
      const r = await sbx.exec("printf abc; exit 2", { onStdout: (c) => out.push(c) });
      expect(r).toMatchObject({ exitCode: 2, stdout: "abc" });
      expect(out.join("")).toBe("abc");
    } finally {
      streamMode = "normal";
    }
  });

  it("recognises an error event whose marker is split across network reads", async () => {
    streamMode = "error-split";
    try {
      const sbx = await p().create({});
      const out: string[] = [];
      await expect(sbx.exec("printf abc", { onStdout: (c) => out.push(c) })).rejects.toThrow("exec-stream: box crashed");
      // Nothing of the marker leaked into the output.
      expect(out.join("")).toBe("abc");
    } finally {
      streamMode = "normal";
    }
  });

  it("turns a stream error event into a ProviderError", async () => {
    streamMode = "error";
    try {
      const sbx = await p().create({});
      await expect(sbx.exec("echo hi", { onStdout: () => {} })).rejects.toThrow("exec-stream: box crashed");
    } finally {
      streamMode = "normal";
    }
  });

  it("round-trips text and binary files as base64, creating parent dirs", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");
    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    const read = seen.filter((s) => s.path.endsWith("/files/read")).at(-1)!;
    expect(new URLSearchParams(read.query).get("encoding")).toBe("base64");
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    mkdirSync(dirname(path), { recursive: true });
  });

  it("has no pause, reconnects by id, and deletes", async () => {
    const sbx = await p().create({});
    expect(sbx.pause).toBeUndefined();
    const again = await p().connect(sbx.nativeId);
    expect((await again.exec("echo hi")).stdout).toBe("hi\n");
    await again.kill();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `/v2/box/${sbx.nativeId}`, key: "box_test" });
    await expect(p().connect(sbx.nativeId)).rejects.toMatchObject({ status: 404, message: expect.stringContaining("deleted") });
  });

  it("reports configured() from the key", () => {
    expect(new UpstashProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
