import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardTimeout, wrapCommand } from "../src/util.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for `@northflank/js-client`: `ApiClientInMemoryContextProvider.addContext`, and an
 * `ApiClient` with `create.service.deployment({ parameters, data })`, `get.service({ parameters })`
 * and `delete.service({ parameters })` answering `{ data }` or `{ error: { status, message } }`
 * like the real client, plus `exec.execServiceSession(params, { command, shell: "none", tty })`
 * returning a session with stdOut/stdErr/stdIn PassThroughs, `on("error")` and
 * `waitForCommandResult()` -> { exitCode, status }.
 *
 * Sessions really run the argv in a temp dir. Northflank's exec has no cwd/env/timeout, so the
 * adapter wraps cwd/env into the command and guards it with `guardTimeout`, which prefers
 * coreutils `timeout` (ubuntu:22.04 has it); macOS does not, so the mock puts a minimal shim on
 * PATH. The deployment reports STARTING for a configurable number of polls, then COMPLETED (or
 * FAILED); a deleted service is 404 on every call.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-northflank-"));
const children = new Set<ChildProcess>();
const contexts: any[] = [];
const creates: any[] = [];
const deletes: string[] = [];
const sessions: { parameters: any; data: any }[] = [];
const services = new Map<string, { name: string; env?: Record<string, string>; polls: number; expiredAt?: string }>();
let startingPolls = 0;
let failDeploy = false;
let createError: { status: number; message: string } | undefined;
let seq = 0;

// The sandbox image has coreutils `timeout`; macOS does not, so give the mock a minimal one.
mkdirSync(join(root, "bin"));
if (spawnSync("sh", ["-c", "command -v timeout"]).status !== 0) {
  writeFileSync(
    join(root, "bin", "timeout"),
    ["#!/bin/sh", '[ "$1" = -k ] && shift 2', "s=$1; shift", '"$@" & p=$!', '( sleep "$s"; kill -TERM $p ) >/dev/null 2>&1 & w=$!', "wait $p; c=$?", "kill $w 2>/dev/null", "[ $c -eq 143 ] && exit 124", "exit $c"].join("\n"),
  );
  chmodSync(join(root, "bin", "timeout"), 0o755);
}
const shimPath = `${join(root, "bin")}:${process.env.PATH}`;
const killGroup = (child: ChildProcess) => {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {}
};

class FakeSession extends EventEmitter {
  readonly stdOut = new PassThrough();
  readonly stdErr = new PassThrough();
  readonly stdIn = new PassThrough();
  private result: Promise<{ exitCode: number; status: string }>;
  constructor(argv: string[], env: Record<string, string> = {}) {
    super();
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, PATH: shimPath, ...env }, detached: true });
    children.add(child);
    child.stdout!.pipe(this.stdOut);
    child.stderr!.pipe(this.stdErr);
    child.stdin!.on("error", () => {});
    this.stdIn.pipe(child.stdin!);
    this.result = new Promise((resolve) => {
      child.on("error", (e) => this.emit("error", e));
      child.on("close", (code, signal) => {
        children.delete(child);
        const exitCode = code ?? (signal ? 137 : -1);
        resolve({ exitCode, status: exitCode === 0 ? "Success" : "Failure" });
      });
    });
  }
  waitForCommandResult = () => this.result;
}

vi.mock("@northflank/js-client", () => ({
  ApiClientInMemoryContextProvider: class {
    addContext(ctx: unknown) {
      contexts.push(ctx);
    }
  },
  ApiClient: class {
    constructor(_ctx: unknown) {}
    create = {
      service: {
        deployment: async ({ parameters, data }: any) => {
          creates.push({ parameters, data });
          if (createError) return { data: undefined, error: createError };
          const id = `svc-${++seq}`;
          services.set(id, { name: data.name, env: data.runtimeEnvironment, polls: 0 });
          return { data: { id, name: data.name, projectId: parameters.projectId } };
        },
      },
    };
    get = {
      service: async ({ parameters }: any) => {
        const svc = services.get(parameters.serviceId);
        if (!svc) return { data: undefined, error: { status: 404, message: "Service not found" } };
        const status = ++svc.polls <= startingPolls ? "STARTING" : failDeploy ? "FAILED" : "COMPLETED";
        return { data: { id: parameters.serviceId, name: svc.name, expiredAt: svc.expiredAt, status: { deployment: { status } } } };
      },
    };
    delete = {
      service: async ({ parameters }: any) => {
        deletes.push(parameters.serviceId);
        if (!services.delete(parameters.serviceId)) return { data: undefined, error: { status: 404, message: "Service not found" } };
        return { data: {} };
      },
    };
    exec = {
      execServiceSession: async (parameters: any, data: any) => {
        sessions.push({ parameters, data });
        const svc = services.get(parameters.serviceId);
        if (!svc) throw Object.assign(new Error("Service not found"), { status: 404 });
        if (data.shell !== "none" || data.tty !== false || !Array.isArray(data.command)) throw new Error("mock expects an argv with shell: none, tty: false");
        return new FakeSession(data.command, svc.env);
      },
    };
  },
}));

const { NorthflankProvider } = await import("../src/providers/northflank.js");
const p = () => new NorthflankProvider("nf_test", "proj-1");

beforeEach(() => {
  for (const a of [contexts, creates, deletes, sessions]) a.length = 0;
  startingPolls = 0;
  failDeploy = false;
  createError = undefined;
});

afterAll(() => {
  for (const c of children) killGroup(c);
  rmSync(root, { recursive: true, force: true });
});

describeConformance("northflank", { provider: p, dir: root });

describe("NorthflankProvider", () => {
  it("needs both the token and the project id", async () => {
    expect(new NorthflankProvider("t", undefined).configured()).toBe(false);
    expect(new NorthflankProvider(undefined, "p").configured()).toBe(false);
    expect(p().configured()).toBe(true);
    await expect(new NorthflankProvider("t", undefined).create({})).rejects.toThrow(/NORTHFLANK_API_TOKEN and NORTHFLANK_PROJECT_ID/);
  });

  it("creates a kept-alive deployment service from the spec and waits for it to deploy", async () => {
    startingPolls = 1;
    const sbx = await p().create({ vcpu: 2, memoryGb: 4, timeoutMinutes: 20, env: { A: "1" }, image: { northflank: "python:3.13-slim" } });
    expect(sbx.nativeId).toMatch(/^svc-\d+$/);
    expect(contexts[0]).toEqual({ name: "sandboxrouter", token: "nf_test", project: "proj-1" });
    expect(creates[0].parameters).toEqual({ projectId: "proj-1" });
    expect(creates[0].data).toEqual({
      name: expect.stringMatching(/^sbr-[0-9a-f]{10}$/),
      description: "sandboxrouter sandbox",
      billing: { deploymentPlan: "nf-compute-200" },
      deployment: {
        instances: 1,
        external: { imagePath: "python:3.13-slim" },
        docker: { configType: "customEntrypointCustomCommand", customEntrypoint: "/bin/sh", customCommand: "-c 'tail -f /dev/null'" },
      },
      runtimeEnvironment: { A: "1" },
      createOptions: { expiryTime: 1200 },
    });
    // Polled past STARTING, then probed exec with `true` before handing the box out.
    expect(services.get(sbx.nativeId)!.polls).toBe(2);
    expect(sessions[0]).toEqual({ parameters: { projectId: "proj-1", serviceId: sbx.nativeId }, data: { command: ["/bin/sh", "-c", "true"], shell: "none", tty: false } });
    // The sandbox's own env is on the service, so a command sees it without being told.
    expect((await sbx.exec("echo $A")).stdout).toBe("1\n");
  });

  it("picks the cheapest plan that fits and clamps the expiry to 5 min .. 7 days", async () => {
    const created = async (spec: Parameters<typeof NorthflankProvider.prototype.create>[0]) => {
      await p().create(spec);
      const { billing, createOptions, deployment } = creates.at(-1).data;
      return [billing.deploymentPlan, createOptions.expiryTime, deployment.external.imagePath];
    };
    expect(await created({})).toEqual(["nf-compute-200", 1800, "ubuntu:22.04"]);
    expect(await created({ vcpu: 0.1, memoryGb: 0.25, timeoutMinutes: 1 })).toEqual(["nf-compute-10", 300, "ubuntu:22.04"]);
    expect(await created({ vcpu: 1, memoryGb: 3 })).toEqual(["nf-compute-100-4", 1800, "ubuntu:22.04"]);
    expect(await created({ vcpu: 64, timeoutMinutes: 1e6 })).toEqual(["nf-compute-32-131072", 604_800, "ubuntu:22.04"]);
  });

  it("turns API error bodies into ProviderError with the status, and cleans up a failed deployment", async () => {
    createError = { status: 403, message: "Forbidden" };
    await expect(p().create({})).rejects.toMatchObject({ name: "ProviderError", provider: "northflank", status: 403, message: "northflank: Forbidden" });
    createError = undefined;
    failDeploy = true;
    await expect(p().create({})).rejects.toThrow(/failed to deploy/);
    expect(deletes).toEqual([`svc-${seq}`]);
    failDeploy = false;
    await expect(p().connect("svc-missing")).rejects.toMatchObject({ status: 404 });
    const sbx = await p().create({});
    services.get(sbx.nativeId)!.expiredAt = "2026-01-01T00:00:00Z";
    await expect(p().connect(sbx.nativeId)).rejects.toThrow(/expired at 2026-01-01/);
  });

  it("wraps cwd and env into a guarded /bin/sh argv, since exec takes none of them", async () => {
    const sbx = await p().create({});
    const cmd = 'printf "%s %s" "$A" "$(basename "$PWD")"';
    const r = await sbx.exec(cmd, { cwd: root, env: { A: "it's" }, timeoutSeconds: 5 });
    expect(r).toMatchObject({ exitCode: 0, stdout: `it's ${root.split("/").pop()}` });
    const { command, shell, tty } = sessions.at(-1)!.data;
    expect([shell, tty, command.slice(0, 2)]).toEqual(["none", false, ["/bin/sh", "-c"]]);
    // cwd/env become a `cd && export` prelude, and the whole thing is wrapped so the sandbox kills it at the deadline.
    expect(command[2]).toBe(guardTimeout(wrapCommand(cmd, { cwd: root, env: { A: "it's" } }), 5));
    expect(command[2]).toContain("timeout -k 5 5 sh -c");
    expect((await sbx.exec("exit 7")).exitCode).toBe(7);
  });

  it("moves files as base64 over the exec session and reports failures with the command's stderr", async () => {
    const sbx = await p().create({});
    const big = new Uint8Array(200 * 1024).map((_, i) => (i * 31) % 256);
    await sbx.writeFile(join(root, "deep", "big.bin"), big);
    expect(sessions.at(-1)!.data.command[2]).toBe(`mkdir -p '${join(root, "deep")}' && base64 -d > '${join(root, "deep", "big.bin")}'`);
    expect(Buffer.from(await sbx.readFile(join(root, "deep", "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await expect(sbx.readFile(join(root, "nope"))).rejects.toMatchObject({ provider: "northflank", message: expect.stringMatching(/read .*nope failed: .*nope/) });
    expect(existsSync(join(root, "deep", "big.bin"))).toBe(true);
  });

  it("kill deletes the service, and no pause is offered", async () => {
    const sbx = await p().create({});
    expect(sbx.pause).toBeUndefined();
    await sbx.kill();
    expect(deletes).toEqual([sbx.nativeId]);
    await expect(sbx.exec("true")).rejects.toMatchObject({ status: 404 });
  });
});
