import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, base);
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
    if (url.pathname === "/dp/sbx-test1/v1/commands" && req.method === "POST") {
      if (req.headers["x-maritime-token"] !== "s3cret") return send(401, { code: "unauthorized" });
      try {
        const { stdout, stderr } = await run("sh", ["-c", body.cmd], { cwd: body.cwd ?? root, maxBuffer: 64 * 1024 * 1024 });
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
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
  });

  it("round-trips text and binary files, including multi-chunk ones", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");

    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
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
