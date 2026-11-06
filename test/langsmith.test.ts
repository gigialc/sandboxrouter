import { beforeEach, describe, expect, it, vi } from "vitest";
import { hourlyCost } from "../src/catalog.js";

/**
 * `langsmith` isn't installed here (optional peer dep), so `langsmith/sandbox` is mocked with the
 * surface its typings declare: SandboxClient.createSandbox(snapshotId?, opts) / getSandbox(name),
 * and Sandbox instances with name, run (stdout/stderr/exit_code), write, read, stop, delete.
 */
function fakeSandbox(name = "sbr-abc") {
  return {
    name,
    run: vi.fn(async (cmd: string, opts: any) => {
      if (cmd === "explode") throw Object.assign(new Error("Sandbox 'sbr-abc' not found"), { name: "LangSmithResourceNotFoundError" });
      opts?.onStdout?.("one\n");
      opts?.onStderr?.("two\n");
      return { stdout: "one\n", stderr: "two\n", exit_code: cmd === "exit 3" ? 3 : 0 };
    }),
    write: vi.fn(async () => undefined),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

let sbx: ReturnType<typeof fakeSandbox>;
const clientConfig = vi.fn();
const createSandbox = vi.fn(async (..._a: unknown[]) => sbx);
const getSandbox = vi.fn(async (_name: string) => sbx);

vi.mock("langsmith/sandbox", () => ({
  SandboxClient: class {
    constructor(config: unknown) {
      clientConfig(config);
    }
    createSandbox = (...a: unknown[]) => createSandbox(...a);
    getSandbox = (n: string) => getSandbox(n);
  },
}));

const { LangSmithProvider, langsmithSize } = await import("../src/providers/langsmith.js");

beforeEach(() => {
  sbx = fakeSandbox();
  for (const f of [clientConfig, createSandbox, getSandbox]) f.mockClear();
});

describe("LangSmithProvider", () => {
  it("is configured by LANGSMITH_API_KEY and passes it to the client", async () => {
    expect(new LangSmithProvider(undefined).configured()).toBe(false);
    await new LangSmithProvider("lsv2_test").create({});
    expect(clientConfig).toHaveBeenCalledWith({ apiKey: "lsv2_test" });
  });

  it("creates with size in bytes, idle stop from timeoutMinutes, one-day delete after stop, env and labels", async () => {
    const box = await new LangSmithProvider("k").create({ vcpu: 4, memoryGb: 8, timeoutMinutes: 15, env: { A: "1" }, metadata: { run: "x" } });
    expect(box.nativeId).toBe("sbr-abc");
    expect(createSandbox).toHaveBeenCalledWith(undefined, {
      vCpus: 4,
      memBytes: 8 * 1024 ** 3,
      idleTtlSeconds: 900,
      deleteAfterStopSeconds: 86_400,
      runConfig: { env_vars: { A: "1" } },
      labels: { run: "x" },
    });
  });

  it("rounds the idle stop up to whole minutes, and takes a snapshot id or name as the image", async () => {
    const id = "0b9f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    await new LangSmithProvider("k").create({ timeoutMinutes: 0.2, image: { langsmith: id } });
    expect(createSandbox).toHaveBeenLastCalledWith(id, expect.objectContaining({ idleTtlSeconds: 60 }));
    await new LangSmithProvider("k").create({ image: { langsmith: "my-python" } });
    expect(createSandbox).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ snapshotName: "my-python", idleTtlSeconds: 1800 }));
  });

  it("keeps memory inside 2 to 6 GiB per vCPU, and prices what it will run", () => {
    expect(langsmithSize(2, 4)).toEqual({ vcpu: 2, memoryGb: 4 });
    expect(langsmithSize(4, 2)).toEqual({ vcpu: 4, memoryGb: 8 });
    expect(langsmithSize(1, 16)).toEqual({ vcpu: 3, memoryGb: 16 });
    expect(hourlyCost("langsmith", { vcpu: 2, memoryGb: 4 })).toBeCloseTo(2 * 0.0576 + 4 * 0.01845, 6);
    expect(hourlyCost("langsmith", { vcpu: 4, memoryGb: 2 })).toBeCloseTo(4 * 0.0576 + 8 * 0.01845, 6);
  });

  it("runs with timeout, cwd and env as runConfig, streams, and returns nonzero exits as results", async () => {
    const box = await new LangSmithProvider("k").create({});
    const out: string[] = [];
    const r = await box.exec("echo hi", { cwd: "/work", env: { B: "2" }, timeoutSeconds: 5, onStdout: (c) => out.push(c), onStderr: (c) => out.push(c) });
    expect(sbx.run).toHaveBeenCalledWith("echo hi", { timeout: 5, runConfig: { work_dir: "/work", env_vars: { B: "2" } }, onStdout: expect.any(Function), onStderr: expect.any(Function) });
    expect(r).toMatchObject({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
    expect(out).toEqual(["one\n", "two\n"]);

    await box.exec("ls");
    expect(sbx.run).toHaveBeenLastCalledWith("ls", { timeout: 60 });
    expect((await box.exec("exit 3")).exitCode).toBe(3);
  });

  it("maps files, pause (stop), kill (delete) and errors", async () => {
    const box = await new LangSmithProvider("k").create({});
    await box.writeFile("/tmp/a", "x");
    expect(sbx.write).toHaveBeenCalledWith("/tmp/a", "x");
    expect(await box.readFile("/tmp/a")).toEqual(new Uint8Array([1, 2, 3]));
    await box.pause!();
    expect(sbx.stop).toHaveBeenCalled();
    await box.kill();
    expect(sbx.delete).toHaveBeenCalled();
    await expect(box.exec("explode")).rejects.toMatchObject({ provider: "langsmith", status: 404 });
  });

  it("reconnects by sandbox name", async () => {
    const box = await new LangSmithProvider("k").connect("sbr-abc");
    expect(getSandbox).toHaveBeenCalledWith("sbr-abc");
    expect(box.nativeId).toBe("sbr-abc");
  });
});
