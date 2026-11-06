import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOAT_SIZES } from "../src/catalog.js";
import { BoatProvider } from "../src/providers/boat.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for https://boat.dev/api/v1 following the adapter's wire protocol:
 *   POST /sandboxes (202, state provisioning -> ready), GET /sandboxes/{id} (404 once deleted),
 *   POST /sandboxes/{id}/commands {command, timeoutSeconds, stream}: the command really runs with
 *     `sh -c` in the temp dir, is killed at timeoutSeconds and reported `timedOut: true`; with
 *     stream: true the answer is NDJSON frames started/stdout/stderr/exit, else one JSON result,
 *   GET|PUT /sandboxes/{id}/files (base64 JSON, only under /home/user or /tmp, 400 elsewhere) and
 *     POST /files/folder (mkdir -p),
 *   POST /stop (state stopped; commands then answer 409 sandbox_not_ready) and POST /resume,
 *   DELETE /sandboxes/{id} with X-Ascii-Confirm-Delete: {id}.
 * Errors use the ErrorEnvelope {ok:false, status, code, message}. The temp dir lives under /tmp so
 * the files API reaches it, as it would on a real sandbox.
 */
interface Box {
  state: string;
  body: any;
  pollsLeft: number;
  procs: Set<ChildProcess>;
}
let server: Server;
let base = "";
// Created at load time: describeConformance needs the path when the suite is declared.
const root = mkdtempSync("/tmp/sbr-boat-");
const boxes = new Map<string, Box>();
const seen: { method: string; path: string; headers: Record<string, string | undefined>; body?: any }[] = [];
let provisionPolls = 0;
let createState: "ready" | "error" = "ready";
let nextId = 1;

const envelope = (status: number, code: string, message: string) => ({ ok: false, status, code, message, error: { code, message, status } });
const filesOk = (p: string) => /^\/(home\/user|tmp)(\/|$)/.test(p);
const killAll = (box: Box) => {
  for (const c of box.procs) if (c.pid) try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, base);
    const body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : undefined;
    seen.push({ method: req.method!, path: url.pathname, headers: req.headers as Record<string, string>, body });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer boat_test") return send(401, envelope(401, "unauthorized", "invalid API key"));

    if (url.pathname === "/sandboxes" && req.method === "POST") {
      if (!BOAT_SIZES.some((s) => s.type === body.type)) return send(400, envelope(400, "validation_error", `unknown type ${body.type}`));
      const id = `sbx_${nextId++}`;
      boxes.set(id, { state: createState === "error" ? "error" : "provisioning", body, pollsLeft: provisionPolls, procs: new Set() });
      return send(202, { sandbox: { id, state: "provisioning" } });
    }
    const m = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return send(404, envelope(404, "not_found", "no route"));
    const [, id, route = ""] = m;
    const box = boxes.get(id);
    if (!box) return send(404, envelope(404, "sandbox_not_found", `sandbox ${id} not found`));

    if (route === "" && req.method === "GET") {
      if (box.state === "provisioning" && box.pollsLeft-- <= 0) box.state = "ready";
      return send(200, { sandbox: { id, state: box.state, error: box.state === "error" ? "host capacity" : null } });
    }
    if (route === "" && req.method === "DELETE") {
      if (req.headers["x-ascii-confirm-delete"] !== id) return send(400, envelope(400, "confirmation_required", "X-Ascii-Confirm-Delete must be the sandbox id"));
      killAll(box);
      boxes.delete(id);
      return send(200, { ok: true });
    }
    if (route === "/stop") {
      killAll(box);
      box.state = "stopped";
      return send(200, { sandbox: { id, state: "stopped" } });
    }
    if (route === "/resume") {
      box.state = "ready";
      return send(200, { sandbox: { id, state: "ready" } });
    }
    if (box.state !== "ready") return send(409, envelope(409, "sandbox_not_ready", `sandbox is ${box.state}`));

    if (route === "/files/folder") {
      if (!filesOk(body.path)) return send(400, envelope(400, "invalid_path", "path must be under /home/user or /tmp"));
      mkdirSync(body.path, { recursive: true });
      return send(200, { ok: true });
    }
    if (route === "/files" && req.method === "PUT") {
      if (!filesOk(body.path)) return send(400, envelope(400, "invalid_path", "path must be under /home/user or /tmp"));
      if (!existsSync(dirname(body.path))) return send(404, envelope(404, "file_not_found", `no such directory: ${dirname(body.path)}`));
      writeFileSync(body.path, Buffer.from(body.content, body.encoding ?? "utf8"));
      return send(200, { path: body.path, size: Buffer.from(body.content, "base64").length });
    }
    if (route === "/files" && req.method === "GET") {
      const p = url.searchParams.get("path")!;
      if (!filesOk(p)) return send(400, envelope(400, "invalid_path", "path must be under /home/user or /tmp"));
      try {
        return send(200, { path: p, content: readFileSync(p).toString("base64"), encoding: "base64" });
      } catch {
        return send(404, envelope(404, "file_not_found", `no such file: ${p}`));
      }
    }
    if (route === "/commands" && req.method === "POST") {
      const child = spawn("sh", ["-c", body.command], { cwd: root, env: { ...process.env, ...(box.body.env ?? {}) }, detached: true });
      box.procs.add(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }, body.timeoutSeconds * 1000);
      const result = { stdout: "", stderr: "" };
      const ndjson = body.stream === true;
      if (ndjson) res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const frame = (f: unknown) => ndjson && res.write(`${JSON.stringify(f)}\n`);
      frame({ type: "started" });
      child.stdout.on("data", (d: Buffer) => (result.stdout += d, frame({ type: "stdout", data: String(d) })));
      child.stderr.on("data", (d: Buffer) => (result.stderr += d, frame({ type: "stderr", data: String(d) })));
      child.on("close", (code) => {
        clearTimeout(timer);
        box.procs.delete(child);
        const exitCode = timedOut ? null : code;
        if (ndjson) {
          frame({ type: "exit", exitCode, timedOut });
          return res.end();
        }
        send(200, { exitCode, timedOut, ...result });
      });
      return;
    }
    send(404, envelope(404, "not_found", "no route"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  for (const b of boxes.values()) killAll(b);
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const p = () => new BoatProvider("boat_test", base);
const commands = () => seen.filter((s) => s.path.endsWith("/commands")).map((s) => s.body);

describeConformance("boat", { provider: p, dir: root });

describe("BoatProvider", () => {
  it("reports configured() from the key", () => {
    expect(new BoatProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("maps the spec onto the create body: smallest size that fits, ttl, env, labels and snapshot", async () => {
    seen.length = 0;
    provisionPolls = 1;
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 20, env: { A: "1" }, metadata: { team: "x" }, image: { boat: "snap-1" } });
    provisionPolls = 0;
    expect(seen[0]).toMatchObject({ method: "POST", path: "/sandboxes", headers: { authorization: "Bearer boat_test" } });
    expect(seen[0].body).toEqual({ type: "default", ttlSeconds: 1200, env: { A: "1" }, labels: { team: "x" }, from: "snap-1" });
    // Polled past "provisioning" once a second until ready.
    expect(seen.filter((s) => s.method === "GET" && s.path === `/sandboxes/${sbx.nativeId}`).length).toBe(2);
    expect((await sbx.exec("echo $A")).stdout).toBe("1\n");
    await sbx.kill();

    seen.length = 0;
    await (await p().create({ vcpu: 0.5, memoryGb: 0.5, timeoutMinutes: 0.1 })).kill();
    expect(seen[0].body).toEqual({ type: "small", ttlSeconds: 60 });
    await expect(p().create({ vcpu: 32 })).rejects.toThrow(/no Boat size has 32 vCPU/);
  });

  it("surfaces Boat's error envelope with status and code, and deletes a sandbox that fails to boot", async () => {
    await expect(new BoatProvider("boat_wrong", base).create({})).rejects.toMatchObject({ name: "ProviderError", status: 401, message: "boat: POST /sandboxes -> 401 unauthorized: invalid API key" });
    createState = "error";
    seen.length = 0;
    try {
      await expect(p().create({})).rejects.toThrow(/is error: host capacity/);
    } finally {
      createState = "ready";
    }
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", headers: { "x-ascii-confirm-delete": seen.at(-1)!.path.split("/")[2] } });
    await expect(p().connect("sbx_missing")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("sandbox_not_found") });
  });

  it("sends timeoutSeconds (capped at 600) and treats a timedOut frame as the contract's error", async () => {
    const sbx = await p().create({});
    seen.length = 0;
    expect((await sbx.exec("exit 124", { timeoutSeconds: 1000 })).exitCode).toBe(124);
    expect(commands()[0]).toMatchObject({ command: "exit 124", timeoutSeconds: 600, stream: false });
    const chunks: string[] = [];
    await expect(sbx.exec("echo start; sleep 5", { timeoutSeconds: 1, onStdout: (c) => chunks.push(c) })).rejects.toThrow("boat: command timed out after 1s");
    expect(chunks).toEqual(["start\n"]);
    expect(commands()[1].stream).toBe(true);
    await sbx.kill();
  });

  it("uses wrapCommand for cwd and env, and streams NDJSON frames only when asked", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    seen.length = 0;
    const r = await sbx.exec('printf "%s %s %s" "$BASE" "$X" "$(pwd)"', { cwd: "/tmp", env: { X: "y" } });
    expect(r.stdout).toMatch(/^b y \/(private\/)?tmp$/);
    expect(commands()[0].command).toBe(`cd '/tmp' && export X='y' && {\nprintf "%s %s %s" "$BASE" "$X" "$(pwd)"\n}`);
    const events: string[] = [];
    await sbx.exec("echo one; echo two >&2", { onStdout: (c) => events.push(`out:${c}`), onStderr: (c) => events.push(`err:${c}`) });
    expect(events.sort()).toEqual(["err:two\n", "out:one\n"]);
    await sbx.kill();
  });

  it("writes outside /home/user and /tmp through sudo in a command", async () => {
    const sbx = await p().create({});
    // A ".." segment keeps the path off the files API, like /etc would.
    const path = `${root}/sub/../sudo.txt`;
    // A passwordless `sudo` like the sandbox's; it also gives `base64 -w0 FILE` GNU semantics on a BSD host.
    mkdirSync(join(root, "shims"), { recursive: true });
    writeFileSync(
      join(root, "shims", "sudo"),
      ['#!/bin/sh', 'if [ "$1" = base64 ] && [ "$2" = -w0 ]; then base64 < "$3" | tr -d "\\n"; exit $?; fi', 'exec "$@"'].join("\n") + "\n",
      { mode: 0o755 },
    );
    boxes.get(sbx.nativeId)!.body.env = { PATH: `${join(root, "shims")}:${process.env.PATH}` };
    seen.length = 0;
    await sbx.writeFile(path, "via sudo");
    expect(seen.map((s) => s.path.split("/").at(-1))).toEqual(["commands"]);
    expect(commands()[0].command).toMatch(/^sudo mkdir -p .* \| base64 -d \| sudo tee /);
    expect(readFileSync(join(root, "sudo.txt"), "utf8")).toBe("via sudo");
    expect(new TextDecoder().decode(await sbx.readFile(path))).toBe("via sudo");
    await sbx.kill();
  });

  it("stop keeps the sandbox for the next call to resume, and delete confirms with the id header", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(boxes.get(sbx.nativeId)!.state).toBe("stopped");
    seen.length = 0;
    // The data call hits 409 sandbox_not_ready, the adapter resumes and retries.
    expect((await sbx.exec("echo back")).stdout).toBe("back\n");
    expect(seen.map((s) => `${s.method} ${s.path.split("/").slice(3).join("/")}`)).toEqual(["POST commands", "GET ", "POST resume", "GET ", "POST commands"]);
    seen.length = 0;
    await sbx.kill();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "DELETE", path: `/sandboxes/${sbx.nativeId}`, headers: { "x-ascii-confirm-delete": sbx.nativeId } });
    expect(boxes.has(sbx.nativeId)).toBe(false);
  });
});
