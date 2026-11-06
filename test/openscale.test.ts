import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenScale Sandboxes speak the E2B API, so the adapter drives the real `e2b` SDK with OpenScale's
 * apiUrl/domain. The SDK is mocked here; the test pins the connection options OpenScale documents
 * (key + https://api.sandbox.openscale.so + sandbox.openscale.so), the default "base" template,
 * the uncapped timeout, pause, and that E2B_API_KEY is never picked up.
 */
function fakeSandbox(id = "sbx_os") {
  return {
    sandboxId: id,
    commands: {
      // Like the SDK with `background: true`: a handle whose wait() rejects with CommandExitError on a nonzero exit.
      run: vi.fn(async (cmd: string, opts: any) => {
        opts?.onStdout?.("hi\n");
        return {
          wait: async () => {
            if (cmd === "false") throw Object.assign(new Error("exit status 1"), { name: "CommandExitError", exitCode: 1, stdout: "", stderr: "nope" });
            return { exitCode: 0, stdout: "hi\n", stderr: "" };
          },
          kill: vi.fn(async () => true),
        };
      }),
    },
    files: {
      write: vi.fn(async () => ({})),
      read: vi.fn(async () => new Uint8Array([104, 105])),
    },
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
  };
}

let sbx: ReturnType<typeof fakeSandbox>;
const create = vi.fn(async (..._args: unknown[]) => sbx);
const connect = vi.fn(async (_id: string, _opts: unknown) => sbx);

vi.mock("e2b", () => ({
  Sandbox: { create: (...a: unknown[]) => create(...a), connect: (id: string, o: unknown) => connect(id, o) },
}));

const { OpenScaleProvider } = await import("../src/providers/openscale.js");

beforeEach(() => {
  sbx = fakeSandbox();
  create.mockClear();
  connect.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const os = { apiKey: "sk-openscale-test", domain: "sandbox.openscale.so", apiUrl: "https://api.sandbox.openscale.so" };

describe("OpenScaleProvider", () => {
  it("creates the base template by default with the documented connection options", async () => {
    const box = await new OpenScaleProvider("sk-openscale-test").create({ timeoutMinutes: 10, env: { A: "1" }, metadata: { k: "v" } });
    expect(box.nativeId).toBe("sbx_os");
    expect(create).toHaveBeenCalledWith("base", { ...os, timeoutMs: 600_000, envs: { A: "1" }, metadata: { k: "v" } });
  });

  it("uses image.openscale and does not cap the timeout (no session limit)", async () => {
    await new OpenScaleProvider("sk-openscale-test").create({ image: { openscale: "my-app", e2b: "other" }, timeoutMinutes: 3000 });
    expect(create).toHaveBeenCalledWith("my-app", { ...os, timeoutMs: 180_000_000, envs: undefined, metadata: undefined });
  });

  it("defaults to a 30 minute timeout", async () => {
    await new OpenScaleProvider("sk-openscale-test").create({});
    expect(create).toHaveBeenCalledWith("base", expect.objectContaining({ timeoutMs: 1_800_000 }));
  });

  it("reads OPENSCALE_API_KEY and never falls back to E2B_API_KEY", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_secret");
    vi.stubEnv("OPENSCALE_API_KEY", "");
    const p = new OpenScaleProvider();
    expect(p.configured()).toBe(false);
    await expect(p.create({})).rejects.toThrow("OPENSCALE_API_KEY is not set");
    expect(create).not.toHaveBeenCalled();

    vi.stubEnv("OPENSCALE_API_KEY", "sk-openscale-env");
    await new OpenScaleProvider().create({});
    expect(create).toHaveBeenCalledWith("base", expect.objectContaining({ apiKey: "sk-openscale-env", domain: "sandbox.openscale.so" }));
  });

  it("execs, moves files, pauses and kills through the e2b box, labelled openscale", async () => {
    const box = await new OpenScaleProvider("sk-openscale-test").create({});
    const chunks: string[] = [];
    expect(await box.exec("echo hi", { onStdout: (c) => chunks.push(c) })).toMatchObject({ exitCode: 0, stdout: "hi\n" });
    expect(chunks).toEqual(["hi\n"]);
    expect(await box.exec("false")).toMatchObject({ exitCode: 1, stderr: "nope" });
    sbx.commands.run.mockRejectedValueOnce(new Error("connection reset"));
    await expect(box.exec("echo")).rejects.toMatchObject({ provider: "openscale" });
    await box.writeFile("/tmp/x", "hi");
    expect(sbx.files.write).toHaveBeenCalledWith("/tmp/x", new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(await box.readFile("/tmp/x"))).toBe("hi");
    expect(typeof box.pause).toBe("function");
    await box.pause!();
    expect(sbx.pause).toHaveBeenCalled();
    await box.kill();
    expect(sbx.kill).toHaveBeenCalled();
  });

  it("reconnects (resuming a paused sandbox) with the same connection options and maps errors", async () => {
    const box = await new OpenScaleProvider("sk-openscale-test").connect("sbx_os");
    expect(connect).toHaveBeenCalledWith("sbx_os", os);
    expect(typeof box.pause).toBe("function");
    connect.mockRejectedValueOnce(Object.assign(new Error("not found"), { name: "SandboxNotFoundError" }));
    await expect(new OpenScaleProvider("sk-openscale-test").connect("nope")).rejects.toMatchObject({ status: 404, provider: "openscale" });
    create.mockRejectedValueOnce(Object.assign(new Error("Invalid API key"), { name: "AuthenticationError" }));
    await expect(new OpenScaleProvider("sk-openscale-plan").create({})).rejects.toMatchObject({ status: 401, provider: "openscale" });
  });

  it("reports configured() from the key", () => {
    expect(new OpenScaleProvider(undefined).configured()).toBe(false);
    expect(new OpenScaleProvider("sk-openscale-test").configured()).toBe(true);
  });
});
