import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MaritimeProvider } from "../src/providers/maritime.js";

const run = promisify(execFile);

/**
 * A stand-in for api.maritime.sh that follows the documented contract: control plane with a
 * Bearer key, data plane `POST /commands` with X-Maritime-Token. Commands really run in a temp
 * dir, so the base64 file path is tested end to end.
 */
let server: Server;
let base = "";
let root = "";
const seen: { method: string; path: string; auth?: string; token?: string; body?: any }[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-maritime-"));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBuf = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const isJson = req.headers["content-type"]?.includes("json");
    const body = isJson && rawBuf.length ? JSON.parse(rawBuf.toString()) : undefined;
    seen.push({
      method: req.method!,
      path: url.pathname,
      auth: req.headers.authorization,
      token: req.headers["x-maritime-token"] as string | undefined,
      body,
    });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const sandbox = { id: "sbx-test1", state: "running", dataPlaneUrl: `${base}/dp/sbx-test1/v1`, secret: "s3cret" };

    if (url.pathname === "/api/sandboxes/ephemeral" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer mk_test") return send(401, { code: "unauthorized", message: "bad key" });
      if (body.vcpu > 16) return send(400, { code: "invalid_request", message: "vcpu", field: "vcpu" });
      return send(201, { ...sandbox, expiresAt: "x", endsWhenIdleSeconds: 300 });
    }
    if (url.pathname === "/v1/sandboxes/sbx-test1" && req.method === "GET") return send(200, sandbox);
    if (url.pathname === "/api/sandboxes/ephemeral/sbx-test1" && req.method === "DELETE") return send(200, { ...sandbox, state: "ended" });
    if (url.pathname === "/v1/sandboxes/sbx-test1/pause" && req.method === "POST") return send(200, { ...sandbox, state: "paused" });
    const dp = url.pathname.startsWith("/dp/sbx-test1/v1/");
    if (dp && req.headers["x-maritime-token"] !== "s3cret") return send(401, { code: "unauthenticated", message: "bad secret" });
    if (dp && url.pathname.endsWith("/files")) {
      const path = url.searchParams.get("path")!;
      if (req.method === "PUT") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, rawBuf);
        res.writeHead(204);
        return res.end();
      }
      try {
        const data = readFileSync(path);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(data);
      } catch {
        return send(404, { code: "file_not_found", message: path });
      }
    }
    if (dp && url.pathname.endsWith("/commands") && req.method === "POST") {
      const env = { ...process.env, ...(body.env ?? {}) };
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const child = spawn("sh", ["-c", body.cmd], { cwd: body.cwd ?? root, env });
        let stdout = "";
        let stderr = "";
        const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        child.stdout.on("data", (d) => ((stdout += d), emit("stdout", String(d))));
        child.stderr.on("data", (d) => ((stderr += d), emit("stderr", String(d))));
        child.on("close", (code) => {
          emit("result", { id: "cmd-1", state: "exited", exitCode: code, stdout, stderr });
          res.end();
        });
        return;
      }
      try {
        const { stdout, stderr } = await run("sh", ["-c", body.cmd], { cwd: body.cwd ?? root, env, maxBuffer: 64 * 1024 * 1024 });
        return send(200, { exitCode: 0, stdout, stderr });
      } catch (e: any) {
        return send(200, { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      }
    }
    send(404, { code: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("MaritimeProvider", () => {
  const p = () => new MaritimeProvider("mk_test", base);

  it("creates with the documented body and auth", async () => {
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, image: { maritime: "python" } });
    expect(sbx.nativeId).toBe("sbx-test1");
    const req = seen.find((s) => s.path === "/api/sandboxes/ephemeral")!;
    expect(req.auth).toBe("Bearer mk_test");
    expect(req.body).toEqual({ from: "python", vcpu: 4, memoryMib: 8192, timeLimitMinutes: 20, idleMinutes: 20, env: { A: "1" } });
  });

  it("clamps out-of-range values instead of sending a 400", async () => {
    seen.length = 0;
    await p().create({ vcpu: 99, timeoutMinutes: 1 });
    const body = seen[0].body;
    expect(body.vcpu).toBe(16);
    expect(body.timeLimitMinutes).toBe(5);
  });

  it("surfaces Maritime error codes with the HTTP status", async () => {
    const bad = new MaritimeProvider("mk_wrong", base);
    await expect(bad.create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("unauthorized: bad key") });
  });

  it("runs commands on the data plane with the sandbox secret, env and cwd", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('echo "$GREETING from $(basename "$PWD")"; echo err >&2', { env: { GREETING: "it's me" }, cwd: "/tmp" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("it's me from tmp\n");
    expect(r.stderr).toBe("err\n");
    expect(seen.at(-1)!.token).toBe("s3cret");
    expect(seen.at(-1)!.body.env).toEqual({ GREETING: "it's me" });
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("round-trips text and binary files through the files endpoint", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");

    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    expect(seen.filter((s) => s.path.endsWith("/files")).map((s) => s.method)).toEqual(["PUT", "GET", "PUT", "GET"]);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("streams stdout and stderr chunks as they happen", async () => {
    const sbx = await p().create({});
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    expect(seen.at(-1)!.body.env).toBeUndefined();
  });

  it("pauses through the control plane", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/sandboxes/sbx-test1/pause", auth: "Bearer mk_test" });
  });

  it("reconnects by id and ends the sandbox", async () => {
    const sbx = await p().connect("sbx-test1");
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    await sbx.kill();
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/sandboxes/ephemeral/sbx-test1", auth: "Bearer mk_test" });
  });

  it("reports configured() from the key", () => {
    expect(new MaritimeProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
