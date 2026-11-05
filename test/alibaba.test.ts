import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Alibaba's Flash Edition speaks the E2B API, so the adapter drives the real `e2b` SDK with
 * Alibaba's regional apiUrl/domain. The SDK is mocked here; the test pins the connection options
 * Alibaba documents (key + https://api.<region>.sandbox.aliyuncs.com + <region>.sandbox.aliyuncs.com),
 * the default template, the 24 h timeout cap and the absence of pause.
 */
function fakeSandbox(id = "sbx_ali") {
  return {
    sandboxId: id,
    commands: {
      run: vi.fn(async (cmd: string, opts: any) => {
        if (cmd === "false") throw Object.assign(new Error("exit status 1"), { name: "CommandExitError", exitCode: 1, stdout: "", stderr: "nope" });
        opts?.onStdout?.("hi\n");
        return { exitCode: 0, stdout: "hi\n", stderr: "" };
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

const { AlibabaProvider } = await import("../src/providers/alibaba.js");

beforeEach(() => {
  sbx = fakeSandbox();
  create.mockClear();
  connect.mockClear();
});

const sg = { apiKey: "ak_test", domain: "ap-southeast-1.sandbox.aliyuncs.com", apiUrl: "https://api.ap-southeast-1.sandbox.aliyuncs.com" };

describe("AlibabaProvider", () => {
  it("creates code-interpreter-v1 in ap-southeast-1 by default with the documented connection options", async () => {
    const box = await new AlibabaProvider("ak_test").create({ timeoutMinutes: 10, env: { A: "1" }, metadata: { k: "v" } });
    expect(box.nativeId).toBe("sbx_ali");
    expect(create).toHaveBeenCalledWith("code-interpreter-v1", { ...sg, timeoutMs: 600_000, envs: { A: "1" }, metadata: { k: "v" } });
  });

  it("uses the configured region and image.alibaba, and caps the timeout at 24 h", async () => {
    await new AlibabaProvider("ak_test", "us-east-1").create({ image: { alibaba: "my-tpl" }, timeoutMinutes: 3000 });
    expect(create).toHaveBeenCalledWith("my-tpl", {
      apiKey: "ak_test",
      domain: "us-east-1.sandbox.aliyuncs.com",
      apiUrl: "https://api.us-east-1.sandbox.aliyuncs.com",
      timeoutMs: 86_400_000,
      envs: undefined,
      metadata: undefined,
    });
  });

  it("rejects a region that isn't a hostname label", async () => {
    await expect(new AlibabaProvider("ak_test", "evil.com/x").create({})).rejects.toThrow("invalid region");
    expect(create).not.toHaveBeenCalled();
  });

  it("execs, moves files and kills through the e2b box, labelled alibaba, with no pause", async () => {
    const box = await new AlibabaProvider("ak_test").create({});
    const chunks: string[] = [];
    expect(await box.exec("echo hi", { onStdout: (c) => chunks.push(c) })).toMatchObject({ exitCode: 0, stdout: "hi\n" });
    expect(chunks).toEqual(["hi\n"]);
    expect(await box.exec("false")).toMatchObject({ exitCode: 1, stderr: "nope" });
    sbx.commands.run.mockRejectedValueOnce(new Error("connection reset"));
    await expect(box.exec("echo")).rejects.toMatchObject({ provider: "alibaba" });
    await box.writeFile("/tmp/x", "hi");
    expect(sbx.files.write).toHaveBeenCalledWith("/tmp/x", new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(await box.readFile("/tmp/x"))).toBe("hi");
    expect(box.pause).toBeUndefined();
    await box.kill();
    expect(sbx.kill).toHaveBeenCalled();
  });

  it("reconnects with the same connection options and maps not-found to 404", async () => {
    await new AlibabaProvider("ak_test").connect("sbx_ali");
    expect(connect).toHaveBeenCalledWith("sbx_ali", sg);
    connect.mockRejectedValueOnce(Object.assign(new Error("not found"), { name: "SandboxNotFoundError" }));
    await expect(new AlibabaProvider("ak_test").connect("nope")).rejects.toMatchObject({ status: 404, provider: "alibaba" });
  });

  it("reports configured() from the key", () => {
    expect(new AlibabaProvider(undefined).configured()).toBe(false);
    expect(new AlibabaProvider("ak_test").configured()).toBe(true);
  });
});
