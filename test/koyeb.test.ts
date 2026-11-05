import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KoyebProvider, koyebInstance } from "../src/providers/koyeb.js";

/**
 * A stand-in for app.koyeb.com plus the sandbox executor, following the wire protocol of the
 * official SDKs: control plane with the API token, executor under <public_url>/koyeb-sandbox with
 * the SANDBOX_SECRET and X-Routing-Key. Commands really run in a temp dir; output is sent one line
 * per SSE event without its line ending (the trailing partial line carries eol: "").
 */
let server: Server;
let base = "";
let root = "";
let shimPath = "";
const seen: { method: string; path: string; auth?: string; routing?: string; body?: any }[] = [];
let secret = "";
let deploymentPolls = 0;
let deploymentStatus = "HEALTHY";
const deleted: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-koyeb-"));
  // The sandbox image has coreutils `timeout`; macOS does not, so give the mock a minimal one.
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin", "timeout"),
    [
      "#!/bin/sh",
      '[ "$1" = -k ] && shift 2',
      's=$1; shift',
      '"$@" & p=$!',
      '( sleep "$s"; kill -TERM $p ) >/dev/null 2>&1 & w=$!',
      "wait $p; c=$?",
      "kill $w 2>/dev/null",
      "[ $c -eq 143 ] && exit 124",
      "exit $c",
    ].join("\n"),
  );
  chmodSync(join(root, "bin", "timeout"), 0o755);
  shimPath = `${join(root, "bin")}:${process.env.PATH}`;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const body = req.headers["content-type"]?.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    seen.push({ method: req.method!, path: url.pathname, auth: req.headers.authorization, routing: req.headers["x-routing-key"] as string, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname.startsWith("/v1/")) {
      if (req.headers.authorization !== "Bearer kt_test") return send(401, { status: 401, code: "unauthorized", message: "invalid token" });
      if (url.pathname === "/v1/apps" && req.method === "POST") return send(200, { app: { id: "app-1", name: body.name } });
      if (url.pathname === "/v1/services" && req.method === "POST") {
        if (body.definition.instance_types[0].type === "nano") return send(400, { status: 400, code: "invalid_argument", message: "validation error", fields: [{ field: "instance_types", description: "not allowed" }] });
        secret = body.definition.env.find((e: any) => e.key === "SANDBOX_SECRET").value;
        deploymentPolls = 0;
        return send(200, { service: { id: "svc-1", app_id: "app-1", latest_deployment_id: "dep-1" } });
      }
      if (url.pathname === "/v1/services/svc-1" && req.method === "GET") return send(200, { service: { id: "svc-1", app_id: "app-1", active_deployment_id: "dep-1", latest_deployment_id: "dep-1" } });
      if (url.pathname === "/v1/deployments/dep-1") {
        deploymentPolls++;
        const status = deploymentPolls === 1 ? "STARTING" : deploymentStatus;
        return send(200, {
          deployment: {
            id: "dep-1",
            status,
            messages: status === "ERROR" ? ["image pull failed"] : [],
            definition: { env: [{ key: "SANDBOX_SECRET", value: secret }] },
            metadata: { sandbox: { public_url: `${base}/pub`, routing_key: "rk-1" } },
          },
        });
      }
      if (req.method === "DELETE") {
        deleted.push(url.pathname);
        return send(200, {});
      }
      return send(404, { status: 404, code: "not_found", message: "not found" });
    }

    if (url.pathname.startsWith("/pub/koyeb-sandbox/")) {
      if (req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: "bad secret" });
      if (req.headers["x-routing-key"] !== "rk-1") return send(404, { error: "no route" });
      const route = url.pathname.slice("/pub/koyeb-sandbox".length);
      if (route === "/health") return send(200, { status: "ok" });
      if (route === "/files") {
        const path = url.searchParams.get("path")!;
        if (req.method === "PUT") {
          if (url.searchParams.get("parents") === "1") mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, raw);
          return send(200, { size: raw.length, sha256: "x" });
        }
        try {
          const data = readFileSync(path);
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(data);
        } catch {
          return send(404, { error: `not found: ${path}` });
        }
      }
      if (route === "/run_streaming" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const child = spawn("sh", ["-c", body.cmd], { cwd: body.cwd ?? root, env: { ...process.env, PATH: shimPath, ...(body.env ?? {}) } });
        const pending = { stdout: "", stderr: "" };
        const pipe = (stream: "stdout" | "stderr") => (d: Buffer) => {
          pending[stream] += String(d);
          let nl: number;
          while ((nl = pending[stream].indexOf("\n")) !== -1) {
            emit("output", { stream, data: pending[stream].slice(0, nl) });
            pending[stream] = pending[stream].slice(nl + 1);
          }
        };
        child.stdout.on("data", pipe("stdout"));
        child.stderr.on("data", pipe("stderr"));
        child.on("close", (code) => {
          for (const s of ["stdout", "stderr"] as const) if (pending[s]) emit("output", { stream: s, data: pending[s], eol: "" });
          emit("complete", { code, error: false });
          res.end();
        });
        return;
      }
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("KoyebProvider", () => {
  const p = () => new KoyebProvider("kt_test", base, "fra");

  it("creates an app and a SANDBOX service with the documented definition", async () => {
    seen.length = 0;
    const sbx = await p().create({ vcpu: 2, memoryGb: 2, timeoutMinutes: 20, env: { A: "1" }, image: { koyeb: "python:3.13" } });
    expect(sbx.nativeId).toBe("svc-1");
    const app = seen.find((s) => s.path === "/v1/apps")!;
    expect(app.auth).toBe("Bearer kt_test");
    expect(app.body.life_cycle).toEqual({ delete_when_empty: true });
    const svc = seen.find((s) => s.path === "/v1/services")!.body;
    expect(svc.app_id).toBe("app-1");
    expect(svc.life_cycle).toEqual({ delete_after_create: 1200 });
    expect(svc.definition).toMatchObject({
      type: "SANDBOX",
      docker: { image: "python:3.13" },
      instance_types: [{ type: "medium" }],
      regions: ["fra"],
      ports: [
        { port: 3030, protocol: "http" },
        { port: 3031, protocol: "http" },
      ],
      routes: [
        { port: 3030, path: "/koyeb-sandbox/" },
        { port: 3031, path: "/" },
      ],
      scalings: [{ min: 1, max: 1 }],
    });
    expect(svc.definition.env[0].key).toBe("SANDBOX_SECRET");
    expect(svc.definition.env[0].value.length).toBeGreaterThanOrEqual(43);
    expect(svc.definition.env[1]).toEqual({ key: "A", value: "1" });
    // Polled the deployment past STARTING, then the executor health with secret and routing key.
    expect(seen.filter((s) => s.path === "/v1/deployments/dep-1").length).toBe(2);
    expect(seen.find((s) => s.path.endsWith("/health"))).toMatchObject({ auth: `Bearer ${secret}`, routing: "rk-1" });
  });

  it("picks the smallest instance that fits and clamps the lifetime", async () => {
    expect(koyebInstance(2, 4)?.type).toBe("large");
    expect(koyebInstance(0.5, 0.5)?.type).toBe("micro");
    expect(koyebInstance(41, 1)).toBeUndefined();
    seen.length = 0;
    await p().create({ timeoutMinutes: 0.1 });
    const svc = seen.find((s) => s.path === "/v1/services")!.body;
    expect(svc.definition.instance_types).toEqual([{ type: "large" }]);
    expect(svc.definition.docker.image).toBe("koyeb/sandbox");
    expect(svc.life_cycle.delete_after_create).toBe(60);
    await expect(p().create({ vcpu: 64 })).rejects.toThrow(/no Koyeb instance/);
  });

  it("surfaces Koyeb errors with status and field details, and cleans up the app", async () => {
    await expect(new KoyebProvider("wrong", base).create({})).rejects.toMatchObject({ status: 401, message: expect.stringContaining("unauthorized: invalid token") });
    deleted.length = 0;
    await expect(p().create({ vcpu: 0.25, memoryGb: 0.25 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("instance_types: not allowed") });
    expect(deleted).toEqual(["/v1/apps/app-1"]);
  });

  it("fails fast and deletes the sandbox when the deployment errors", async () => {
    deploymentStatus = "ERROR";
    deleted.length = 0;
    try {
      await expect(p().create({})).rejects.toThrow(/deployment is ERROR: image pull failed/);
      expect(deleted).toEqual(["/v1/apps/app-1"]);
    } finally {
      deploymentStatus = "HEALTHY";
    }
  });

  it("runs commands with env and cwd, and reassembles line events", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('echo "$GREETING from $(basename "$PWD")"; echo err >&2; printf tail', { env: { GREETING: "it's me" }, cwd: "/tmp" });
    expect(r).toMatchObject({ exitCode: 0, stdout: "it's me from tmp\ntail", stderr: "err\n" });
    const req = seen.filter((s) => s.path.endsWith("/run_streaming")).at(-1)!;
    expect(req.body.env).toEqual({ GREETING: "it's me" });
    expect(req.body.cwd).toBe("/tmp");
    expect((await sbx.exec("exit 3")).exitCode).toBe(3);
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
  });

  it("enforces the command timeout", async () => {
    const sbx = await p().create({});
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toThrow(/timed out after 1s/);
  });

  it("round-trips text and binary files through /files", async () => {
    const sbx = await p().create({});
    const path = join(root, "nested", "dir", "a file.txt");
    await sbx.writeFile(path, "héllo 'quoted' \n world");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("héllo 'quoted' \n world");
    const big = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "big.bin"), big);
    expect(Buffer.from(await sbx.readFile(join(root, "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
  });

  it("reconnects by service id with the secret from the deployment, and kills", async () => {
    const created = await p().create({});
    deleted.length = 0;
    await created.kill();
    expect(deleted).toEqual(["/v1/apps/app-1"]);

    const sbx = await p().connect("svc-1");
    expect((await sbx.exec("echo hi")).stdout).toBe("hi\n");
    deleted.length = 0;
    await sbx.kill();
    // A reconnected handle may live in someone else's app: only its service is deleted.
    expect(deleted).toEqual(["/v1/services/svc-1"]);
    await expect(p().connect("svc-missing")).rejects.toMatchObject({ status: 404 });
  });

  it("reports configured() from the token", () => {
    expect(new KoyebProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });
});
