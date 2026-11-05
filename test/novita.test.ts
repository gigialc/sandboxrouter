import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `novita-sandbox` isn't installed (optional peer dep), so the module is mocked with the surface
 * its 2.x typings declare: static Sandbox.create(template?, opts) / Sandbox.connect(id, opts), and
 * instances with sandboxId, commands.run, files.read/write, pause, kill.
 */
function fakeSandbox(id = "sbx_nov") {
  const calls: unknown[][] = [];
  return {
    calls,
    sandboxId: id,
    commands: {
      run: vi.fn(async (cmd: string, opts: any) => {
        calls.push(["run", cmd, opts]);
        if (cmd === "exit 3") throw Object.assign(new Error("exit status 3"), { name: "CommandExitError", exitCode: 3, stdout: "", stderr: "boom" });
        if (cmd === "explode") throw Object.assign(new Error("sandbox unreachable"), { name: "SandboxError" });
        opts?.onStdout?.("one\n");
        opts?.onStderr?.("two\n");
        return { exitCode: 0, stdout: "one\n", stderr: "two\n" };
      }),
    },
    files: {
      write: vi.fn(async (path: string, data: Uint8Array) => void calls.push(["write", path, data])),
      read: vi.fn(async (path: string, opts: unknown) => (calls.push(["read", path, opts]), new Uint8Array([1, 2, 3]))),
    },
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
  };
}

let sbx: ReturnType<typeof fakeSandbox>;
const create = vi.fn(async (..._args: unknown[]) => sbx);
const connect = vi.fn(async (_id: string, _opts: unknown) => sbx);

vi.mock("novita-sandbox", () => ({
  Sandbox: { create: (...a: unknown[]) => create(...a), connect: (id: string, o: unknown) => connect(id, o) },
}));

const { NovitaProvider } = await import("../src/providers/novita.js");

beforeEach(() => {
  sbx = fakeSandbox();
  create.mockClear();
  connect.mockClear();
});

describe("NovitaProvider", () => {
  it("creates from the default template with key, timeout, envs and metadata", async () => {
    const box = await new NovitaProvider("sk_test").create({ timeoutMinutes: 20, env: { A: "1" }, metadata: { run: "x" } });
    expect(box.nativeId).toBe("sbx_nov");
    expect(create).toHaveBeenCalledWith({ apiKey: "sk_test", timeoutMs: 1_200_000, envs: { A: "1" }, metadata: { run: "x" } });
  });

  it("passes image.novita as the template and NOVITA_DOMAIN as domain", async () => {
    await new NovitaProvider("sk_test", "sandbox.novita.ai").create({ image: { novita: "my-python-app" } });
    expect(create).toHaveBeenCalledWith("my-python-app", expect.objectContaining({ apiKey: "sk_test", domain: "sandbox.novita.ai", timeoutMs: 1_800_000 }));
  });

  it("runs commands with cwd/env/timeout and streams through the SDK callbacks", async () => {
    const box = await new NovitaProvider("sk_test").create({});
    const out: string[] = [];
    const r = await box.exec("echo hi", { cwd: "/tmp", env: { B: "2" }, timeoutSeconds: 5, onStdout: (c) => out.push(`o:${c}`), onStderr: (c) => out.push(`e:${c}`) });
    expect(r).toMatchObject({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
    expect(out).toEqual(["o:one\n", "e:two\n"]);
    expect(sbx.calls[0][2]).toMatchObject({ cwd: "/tmp", envs: { B: "2" }, timeoutMs: 5000 });
  });

  it("returns a nonzero exit as a result and other failures as ProviderError('novita')", async () => {
    const box = await new NovitaProvider("sk_test").create({});
    expect(await box.exec("exit 3")).toMatchObject({ exitCode: 3, stderr: "boom" });
    await expect(box.exec("explode")).rejects.toMatchObject({ name: "ProviderError", provider: "novita", message: "novita: sandbox unreachable" });
  });

  it("moves files as bytes, pauses, kills", async () => {
    const box = await new NovitaProvider("sk_test").create({});
    await box.writeFile("/home/user/a.txt", "hé");
    expect(sbx.calls[0]).toEqual(["write", "/home/user/a.txt", new TextEncoder().encode("hé")]);
    expect(await box.readFile("/home/user/a.txt")).toEqual(new Uint8Array([1, 2, 3]));
    expect(sbx.calls[1]).toEqual(["read", "/home/user/a.txt", { format: "bytes" }]);
    expect(typeof box.pause).toBe("function");
    await box.pause!();
    expect(sbx.pause).toHaveBeenCalled();
    await box.kill();
    expect(sbx.kill).toHaveBeenCalled();
  });

  it("reconnects by id and maps SDK errors to statuses", async () => {
    const box = await new NovitaProvider("sk_test").connect("sbx_nov");
    expect(box.nativeId).toBe("sbx_nov");
    expect(connect).toHaveBeenCalledWith("sbx_nov", { apiKey: "sk_test" });
    connect.mockRejectedValueOnce(Object.assign(new Error("Sandbox gone not found"), { name: "SandboxNotFoundError" }));
    await expect(new NovitaProvider("sk_test").connect("gone")).rejects.toMatchObject({ status: 404 });
    create.mockRejectedValueOnce(Object.assign(new Error("Invalid API key"), { name: "AuthenticationError" }));
    await expect(new NovitaProvider("sk_bad").create({})).rejects.toMatchObject({ status: 401 });
  });

  it("reports configured() from the key and refuses to call without one", async () => {
    expect(new NovitaProvider(undefined).configured()).toBe(false);
    expect(new NovitaProvider("sk_test").configured()).toBe(true);
    await expect(new NovitaProvider(undefined).create({})).rejects.toThrow("NOVITA_API_KEY is not set");
    expect(create).not.toHaveBeenCalled();
  });
});
