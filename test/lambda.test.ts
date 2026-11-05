import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LAMBDA_MICROVM_DOCKERFILE, LAMBDA_MICROVM_SERVER, LambdaMicrovmProvider, writeLambdaMicrovmBundle } from "../src/providers/lambda.js";

/**
 * Stand-in for the Lambda MicroVMs control plane (rest-json at /2025-09-09/microvms, SigV4 "lambda",
 * per docs.aws.amazon.com/lambda/latest/microvm-api and botocore's lambda-microvms model) plus each
 * MicroVM's HTTPS endpoint (X-aws-proxy-auth / X-aws-proxy-port). Every "MicroVM" runs the real
 * LAMBDA_MICROVM_SERVER from the adapter, so the in-VM server is tested too.
 */
const IMAGE = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sbr";
type Vm = { id: string; state: string; port: number; child?: ChildProcess; tokens: Set<string>; healthFailures: number; noServer: boolean };
type Req = { method: string; path: string; headers: IncomingHttpHeaders; body?: any };

let api: Server;
let proxy: Server;
let apiBase = "";
let proxyBase = "";
let root = "";
let serverFile = "";
let reqs: Req[] = [];
let vms = new Map<string, Vm>();
let nextVm = 1;
let healthFailuresForNew = 0;
let noServerForNew = false;

const ops = () => reqs.map((r) => `${r.method} ${r.path.replace(/\/2025-09-09\/microvms/, "")}`);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitListening(port: number) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => {
      const q = request({ host: "127.0.0.1", port, path: "/sbr/v1/health" }, (res) => (res.resume(), r(res.statusCode === 200)));
      q.on("error", () => r(false));
      q.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sbr-lambda-"));
  serverFile = join(root, "server.mjs");
  writeFileSync(serverFile, LAMBDA_MICROVM_SERVER);

  api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, apiBase);
    const body = raw ? JSON.parse(raw) : undefined;
    reqs.push({ method: req.method!, path: url.pathname, headers: req.headers, body });
    const json = (status: number, obj: unknown, type?: string) => {
      res.writeHead(status, { "Content-Type": "application/json", ...(type ? { "x-amzn-errortype": type } : {}) });
      res.end(JSON.stringify(obj));
    };
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/") || !auth.includes("/us-east-1/lambda/aws4_request")) return json(403, { message: "bad signature" }, "AccessDeniedException");
    const view = (vm: Vm) => ({ microvmId: vm.id, state: vm.state, endpoint: `${proxyBase}/vm/${vm.id}`, imageArn: IMAGE, imageVersion: "1", maximumDurationInSeconds: 1800, startedAt: 1 });

    if (url.pathname === "/2025-09-09/microvms" && req.method === "POST") {
      if (!body.imageIdentifier?.startsWith("arn:aws:lambda:us-east-1:123456789012:microvm-image:")) return json(404, { message: "image not found" }, "ResourceNotFoundException");
      const ip = body.idlePolicy;
      if (ip && (ip.maxIdleDurationSeconds < 60 || ip.suspendedDurationSeconds === undefined || ip.autoResumeEnabled === undefined)) return json(400, { message: "idlePolicy" }, "ValidationException");
      if (body.maximumDurationInSeconds < 1 || body.maximumDurationInSeconds > 28800) return json(400, { message: "maximumDurationInSeconds" }, "ValidationException");
      const id = `mvm-${String(nextVm++).padStart(4, "0")}`;
      const vm: Vm = { id, state: "PENDING", port: await freePort(), tokens: new Set(), healthFailures: healthFailuresForNew, noServer: noServerForNew };
      if (!vm.noServer) {
        vm.child = spawn(process.execPath, [serverFile], { env: { ...process.env, SBR_PORT: String(vm.port), HOME: root }, stdio: "ignore" });
        await waitListening(vm.port);
      }
      vms.set(id, vm);
      return json(200, view(vm));
    }
    const m = /^\/2025-09-09\/microvms\/([^/]+)(?:\/(auth-token|suspend|resume))?$/.exec(url.pathname);
    const vm = m && vms.get(decodeURIComponent(m[1]));
    if (!m || !vm) return json(404, { message: "MicroVM not found" }, "ResourceNotFoundException");
    const action = m[2];
    if (!action && req.method === "GET") {
      if (vm.state === "PENDING") vm.state = "RUNNING"; // one poll in PENDING, then running
      else if (vm.state === "RESUMING") vm.state = "RUNNING";
      return json(200, view({ ...vm, state: vm.state === "RESUMING" ? "SUSPENDED" : vm.state }));
    }
    if (!action && req.method === "DELETE") {
      if (vm.state === "TERMINATED") return json(404, { message: "MicroVM not found" }, "ResourceNotFoundException");
      vm.state = "TERMINATED";
      vm.child?.kill("SIGKILL");
      return json(200, {});
    }
    if (vm.state === "TERMINATED") return json(409, { message: "terminated" }, "ConflictException");
    if (action === "auth-token" && req.method === "POST") {
      if (!(body.expirationInMinutes >= 1) || !Array.isArray(body.allowedPorts) || body.allowedPorts[0]?.port !== 8080) return json(400, { message: "allowedPorts" }, "ValidationException");
      const t = `jwe-${vm.id}-${vm.tokens.size + 1}`;
      vm.tokens.add(t);
      return json(200, { authToken: { "X-aws-proxy-auth": t } });
    }
    if (action === "suspend" && req.method === "POST") {
      vm.state = "SUSPENDED";
      return json(200, {});
    }
    if (action === "resume" && req.method === "POST") {
      if (vm.state !== "SUSPENDED") return json(409, { message: "not suspended" }, "ConflictException");
      vm.state = "RESUMING";
      return json(200, {});
    }
    json(400, { message: "no route" }, "ValidationException");
  });

  // The per-MicroVM HTTPS endpoint: checks the JWE header and port, then forwards to the VM's server.
  proxy = createServer((req, res) => {
    const m = /^\/vm\/([^/]+)(\/.*)$/.exec(req.url!);
    const vm = m && vms.get(m[1]);
    const deny = (status: number, msg: string) => (res.writeHead(status, { "Content-Type": "text/plain" }), res.end(msg));
    if (!m || !vm || vm.state === "TERMINATED") return deny(404, "no such MicroVM");
    if (!vm.tokens.has(String(req.headers["x-aws-proxy-auth"] ?? ""))) return deny(401, "missing or invalid X-aws-proxy-auth");
    if ((req.headers["x-aws-proxy-port"] ?? "8080") !== "8080") return deny(403, "port not allowed");
    if (vm.state !== "RUNNING") return deny(502, "MicroVM is not running");
    if (vm.noServer) return deny(404, "not found"); // the image's own app has no such route
    if (m[2] === "/sbr/v1/health" && vm.healthFailures > 0) {
      vm.healthFailures--;
      return deny(503, "starting");
    }
    const up = request({ host: "127.0.0.1", port: vm.port, path: m[2], method: req.method, headers: { ...req.headers, host: `127.0.0.1:${vm.port}` } }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    });
    up.on("error", () => deny(502, "upstream error"));
    req.pipe(up);
  });

  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});
afterAll(() => {
  for (const vm of vms.values()) vm.child?.kill("SIGKILL");
  api.close();
  proxy.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  reqs = [];
  healthFailuresForNew = 0;
  noServerForNew = false;
});

const provider = (extra: Record<string, unknown> = {}) =>
  new LambdaMicrovmProvider({ region: "us-east-1", image: IMAGE, endpoint: apiBase, credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" }, pollMs: 5, ...extra });

describe("Lambda MicroVMs", () => {
  it("is configured by region + image + AWS credentials", () => {
    const saved = { ...process.env };
    for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "LAMBDA_MICROVM_IMAGE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE"]) delete process.env[k];
    try {
      expect(new LambdaMicrovmProvider().configured()).toBe(false);
      expect(new LambdaMicrovmProvider({ region: "us-east-1", credentials: { accessKeyId: "a", secretAccessKey: "b" } }).configured()).toBe(false);
      expect(provider().configured()).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("runs a MicroVM, waits for RUNNING and a healthy server, and execs with streaming output", async () => {
    healthFailuresForNew = 2;
    const box = await provider().create({ timeoutMinutes: 20, env: { GREETING: "hi there" } });
    expect(box.nativeId).toMatch(/^mvm-\d+$/);
    const run = reqs[0];
    expect(run.body).toMatchObject({
      imageIdentifier: IMAGE,
      maximumDurationInSeconds: 1200,
      ingressNetworkConnectors: ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:HTTP_INGRESS"],
      egressNetworkConnectors: ["arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS"],
      idlePolicy: { autoResumeEnabled: true, maxIdleDurationSeconds: 900, suspendedDurationSeconds: 1200 },
      clientToken: expect.any(String),
    });
    expect(String(run.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/lambda\/aws4_request/);
    expect(ops()).toEqual(["POST ", `GET /${box.nativeId}`, `POST /${box.nativeId}/auth-token`]);

    const chunks: string[] = [];
    const r = await box.exec(`echo "$GREETING"; sleep 0.3; echo second; echo oops >&2; exit 4`, { onStdout: (s) => chunks.push(s) });
    expect(r).toMatchObject({ exitCode: 4, stdout: "hi there\nsecond\n", stderr: "oops\n" });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect((await box.exec("pwd", { cwd: "/tmp" })).stdout.trim()).toMatch(/\/tmp$/);
    expect((await box.exec(`printf '%s' "$Q"`, { env: { Q: `it's "q" $HOME` } })).stdout).toBe(`it's "q" $HOME`);
    // One auth token, reused.
    expect(reqs.filter((x) => x.path.endsWith("/auth-token"))).toHaveLength(1);
    await box.kill();
  });

  it("enforces the command timeout with exit 124", async () => {
    const box = await provider().create({});
    const r = await box.exec("sleep 5; echo late", { timeoutSeconds: 1 });
    expect(r).toMatchObject({ exitCode: 124, stdout: "" });
    await box.kill();
  }, 20_000);

  it("writes and reads files (binary, nested), and only at absolute paths", async () => {
    const box = await provider().create({});
    const p = join(root, "files", box.nativeId, "deep/blob.bin");
    const bin = new Uint8Array(300_000).map((_, i) => (i * 13) % 256);
    await box.writeFile(p, bin);
    expect(Buffer.from(readFileSync(p)).equals(Buffer.from(bin))).toBe(true);
    expect(Buffer.from(await box.readFile(p)).equals(Buffer.from(bin))).toBe(true);
    await box.writeFile(p, "text now");
    expect(new TextDecoder().decode(await box.readFile(p))).toBe("text now");
    await expect(box.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404 });
    await expect(box.writeFile("relative.txt", "x")).rejects.toThrow(/absolute/);
    await box.kill();
  });

  it("pauses with SuspendMicrovm and resumes with state intact on the next call", async () => {
    const box = await provider().create({});
    const f = join(root, `state-${box.nativeId}`);
    await box.exec(`echo kept > ${f}`);
    reqs = [];
    await box.pause!();
    expect(ops()).toEqual([`POST /${box.nativeId}/suspend`]);
    expect(vms.get(box.nativeId)!.state).toBe("SUSPENDED");
    const r = await box.exec(`cat ${f}`);
    expect(r.stdout).toBe("kept\n");
    expect(ops()).toContain(`POST /${box.nativeId}/resume`);
    await box.kill();
  });

  it("connects by id (resuming if suspended), refuses terminated or unknown VMs, and terminates idempotently", async () => {
    const p = provider();
    const box = await p.create({});
    await box.pause!();
    const again = await p.connect(box.nativeId);
    expect(vms.get(box.nativeId)!.state).toBe("RUNNING");
    expect((await again.exec("echo back")).stdout).toBe("back\n");
    await expect(p.connect("mvm-9999")).rejects.toMatchObject({ status: 404 });
    await expect(p.connect("bad id")).rejects.toThrow(/invalid MicroVM id/);

    reqs = [];
    await again.kill();
    expect(ops()).toEqual([`DELETE /${box.nativeId}`]);
    await again.kill(); // already gone
    await expect(p.connect(box.nativeId)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses specs beyond the image's 4x burst and honours spec.image", async () => {
    const small = provider({ memoryGb: 1 }); // 0.5 vCPU baseline -> 2 vCPU / 4 GB peak
    await expect(small.create({ vcpu: 4 })).rejects.toMatchObject({ status: 400 });
    await expect(small.create({ memoryGb: 8 })).rejects.toMatchObject({ status: 400 });
    expect(reqs).toHaveLength(0);
    const other = "arn:aws:lambda:us-east-1:123456789012:microvm-image:other";
    const box = await small.create({ vcpu: 2, memoryGb: 4, image: { lambda: other } });
    expect(reqs[0].body.imageIdentifier).toBe(other);
    await box.kill();
  });

  it("terminates the VM when its image does not run the sandboxrouter server", async () => {
    noServerForNew = true;
    await expect(provider().create({})).rejects.toThrow(/does not run the sandboxrouter server/);
    const id = reqs[0] && [...vms.keys()].at(-1)!;
    expect(vms.get(id)!.state).toBe("TERMINATED");
  });

  it("writes a ready-to-zip bundle", async () => {
    const dir = join(root, "bundle");
    await writeLambdaMicrovmBundle(dir);
    expect(readFileSync(join(dir, "server.mjs"), "utf8")).toBe(LAMBDA_MICROVM_SERVER);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toBe(LAMBDA_MICROVM_DOCKERFILE);
    expect(existsSync(join(dir, "server.mjs"))).toBe(true);
  });
});
