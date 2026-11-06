import { randomBytes } from "node:crypto";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, dirname, guardTimeout, killedByTimeout, optionalImport, shq, timeoutError, toBytes, wrapCommand } from "../util.js";

type NorthflankModule = typeof import("@northflank/js-client");
type NorthflankClient = InstanceType<NorthflankModule["ApiClient"]>;
type NorthflankSession = Awaited<ReturnType<NorthflankClient["exec"]["execServiceSession"]>>;

const DEFAULT_IMAGE = "ubuntu:22.04";
/** Northflank's createOptions.expiryTime bounds: 5 minutes to 7 days. */
const MIN_EXPIRY_SECONDS = 300;
const MAX_EXPIRY_SECONDS = 604_800;
const READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Northflank sandboxes via `@northflank/js-client`. Auth: NORTHFLANK_API_TOKEN plus
 * NORTHFLANK_PROJECT_ID (the project every sandbox is created in; its region is fixed at
 * project creation). A sandbox is a deployment service (microVM-isolated on Northflank cloud)
 * kept alive by `tail -f /dev/null`; commands run over Northflank's exec API. Default image
 * ubuntu:22.04; set image.northflank to any public image path (e.g. "python:3.13-slim"). The
 * image's entrypoint is replaced, and it needs `sh` and `base64` on PATH for file transfer.
 */
export class NorthflankProvider implements Provider {
  readonly id = "northflank" as const;
  private client?: NorthflankClient;

  constructor(
    private token = process.env.NORTHFLANK_API_TOKEN,
    private projectId = process.env.NORTHFLANK_PROJECT_ID,
  ) {}

  configured(): boolean {
    return !!this.token && !!this.projectId;
  }

  private async northflank(): Promise<NorthflankClient> {
    if (!this.client) {
      if (!this.token || !this.projectId) {
        throw new ProviderError("northflank", "NORTHFLANK_API_TOKEN and NORTHFLANK_PROJECT_ID must both be set");
      }
      const { ApiClient, ApiClientInMemoryContextProvider } = await optionalImport<NorthflankModule>("@northflank/js-client", "northflank");
      const ctx = new ApiClientInMemoryContextProvider();
      ctx.addContext({ name: "sandboxrouter", token: this.token, project: this.projectId });
      this.client = new ApiClient(ctx);
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const nf = await this.northflank();
    const projectId = this.projectId!;
    const name = `sbr-${randomBytes(5).toString("hex")}`;
    const expiry = Math.round((spec.timeoutMinutes ?? 30) * 60);
    const svc = await call(() =>
      nf.create.service.deployment({
        parameters: { projectId },
        data: {
          name,
          description: "sandboxrouter sandbox",
          billing: { deploymentPlan: plan(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB) },
          deployment: {
            instances: 1,
            external: { imagePath: spec.image?.northflank ?? DEFAULT_IMAGE },
            docker: { configType: "customEntrypointCustomCommand", customEntrypoint: "/bin/sh", customCommand: "-c 'tail -f /dev/null'" },
          },
          runtimeEnvironment: spec.env,
          // At expiry Northflank pauses the service (compute billing stops) and schedules its deletion.
          createOptions: { expiryTime: Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, expiry)) },
        },
      }),
    );
    const box = new NorthflankBox(nf, projectId, svc?.id ?? name);
    try {
      await box.waitReady();
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  /** Reattach to a running sandbox by service id. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new NorthflankBox(await this.northflank(), this.projectId!, nativeId);
    const { expiredAt } = await box.info();
    if (expiredAt) throw new ProviderError("northflank", `sandbox ${nativeId} expired at ${expiredAt}`);
    await box.waitReady();
    return box;
  }
}

class NorthflankBox implements ProviderSandbox {
  constructor(
    private nf: NorthflankClient,
    private projectId: string,
    readonly nativeId: string,
  ) {}

  private get params() {
    return { projectId: this.projectId, serviceId: this.nativeId };
  }

  /** The deployment-service fields this adapter reads (GetServiceResult is a union over service types). */
  async info(): Promise<{ expiredAt?: string; status?: { deployment?: { status?: string } } }> {
    return (await call(() => this.nf.get.service({ parameters: this.params }))) as any;
  }

  /**
   * Poll until the deployment is COMPLETED (container running), then until exec is accepted:
   * the exec endpoint can refuse briefly while the instance comes up.
   */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const status = (await this.info())?.status?.deployment?.status;
      if (status === "FAILED") throw new ProviderError("northflank", `sandbox ${this.nativeId} failed to deploy`);
      if (status === "COMPLETED") break;
      if (Date.now() > deadline) throw new ProviderError("northflank", `sandbox ${this.nativeId} not ready after ${READY_TIMEOUT_MS / 1000}s`);
      await sleep(1000);
    }
    for (;;) {
      try {
        const r = await this.run(["/bin/sh", "-c", "true"], 30_000);
        if (r.exitCode === 0) return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
      if (Date.now() > deadline) throw new ProviderError("northflank", `sandbox ${this.nativeId} not accepting exec`);
      await sleep(1000);
    }
  }

  /**
   * Exec has no cwd/env/timeout, so cwd/env are wrapped into the command, the sandbox kills the
   * command at the deadline (`guardTimeout`), and this side gives up a little later as a fallback.
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const secs = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const guarded = guardTimeout(wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }), secs);
    const r = await this.run(["/bin/sh", "-c", guarded], secs * 1000 + 10_000, opts, undefined, () => timeoutError("northflank", secs));
    const durationMs = Date.now() - t0;
    if (killedByTimeout(r.exitCode, durationMs, secs)) throw timeoutError("northflank", secs);
    return { ...r, durationMs };
  }

  /** Stream base64 over stdin and decode in the sandbox. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    const r = await this.run(
      ["/bin/sh", "-c", `mkdir -p ${shq(dirname(path))} && base64 -d > ${shq(path)}`],
      120_000 + b64.length / 100,
      {},
      b64,
    );
    if (r.exitCode !== 0) throw new ProviderError("northflank", `write ${path} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.run(["/bin/sh", "-c", `base64 < ${shq(path)}`], 120_000);
    if (r.exitCode !== 0) throw new ProviderError("northflank", `read ${path} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return new Uint8Array(Buffer.from(r.stdout, "base64"));
  }

  async kill(): Promise<void> {
    await call(() => this.nf.delete.service({ parameters: this.params }));
  }

  /** One exec session: optional stdin, streamed stdout/stderr, exit code. `expired` is thrown when limitMs passes. */
  private async run(
    command: string[],
    limitMs: number,
    opts: Pick<ExecOptions, "onStdout" | "onStderr"> = {},
    stdin?: string,
    expired: () => ProviderError = () => timeoutError("northflank", Math.round(limitMs / 1000)),
  ): Promise<Omit<ExecResult, "durationMs">> {
    const t0 = Date.now();
    let session: NorthflankSession;
    try {
      session = await this.nf.exec.execServiceSession(this.params, { command, shell: "none", tty: false });
    } catch (err: any) {
      throw new ProviderError("northflank", err?.message ?? String(err), err?.status);
    }
    let stdout = "";
    let stderr = "";
    session.stdOut.setEncoding("utf8");
    session.stdErr.setEncoding("utf8");
    session.stdOut.on("data", (c: string) => {
      stdout += c;
      opts.onStdout?.(c);
    });
    session.stdErr.on("data", (c: string) => {
      stderr += c;
      opts.onStderr?.(c);
    });
    const failed = new Promise<never>((_, reject) => session.on("error", (e: any) => reject(e)));
    failed.catch(() => {});
    // Send stdin (if any) and close it so commands that read stdin don't hang.
    const CHUNK = 64 * 1024;
    if (stdin) for (let i = 0; i < stdin.length; i += CHUNK) session.stdIn.write(stdin.slice(i, i + CHUNK));
    session.stdIn.end();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limitMs);
      timer.unref();
    });
    try {
      const res = await Promise.race([session.waitForCommandResult(), failed, timedOut]);
      if (res === "timeout") throw expired();
      return { exitCode: typeof res.exitCode === "number" ? res.exitCode : -1, stdout, stderr };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("northflank", err?.message ?? String(err), err?.status);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Unwrap a Northflank API response, turning an `error` body into a ProviderError with its HTTP status. */
async function call<T>(fn: () => Promise<{ data: T; error?: { status: number; message: string } }>): Promise<T> {
  let res;
  try {
    res = await fn();
  } catch (err: any) {
    throw new ProviderError("northflank", err?.message ?? String(err), err?.status);
  }
  if (res.error) throw new ProviderError("northflank", res.error.message || `HTTP ${res.error.status}`, res.error.status);
  return res.data;
}

/**
 * Northflank deployment plans (vCPU, GB), from
 * https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas. Northflank bills
 * per vCPU-hour and GB-hour, so the cheapest plan that fits is the one with the least of both.
 */
const PLANS: [id: string, vcpu: number, gb: number][] = [
  ["nf-compute-10", 0.1, 0.25],
  ["nf-compute-20", 0.2, 0.5],
  ["nf-compute-50", 0.5, 1],
  ["nf-compute-100-1", 1, 1],
  ["nf-compute-100-2", 1, 2],
  ["nf-compute-100-4", 1, 4],
  ["nf-compute-200", 2, 4],
  ["nf-compute-200-8", 2, 8],
  ["nf-compute-200-16", 2, 16],
  ["nf-compute-400", 4, 8],
  ["nf-compute-400-16", 4, 16],
  ["nf-compute-800-8", 8, 8],
  ["nf-compute-800-16", 8, 16],
  ["nf-compute-800-24", 8, 24],
  ["nf-compute-800-32", 8, 32],
  ["nf-compute-800-40", 8, 40],
  ["nf-compute-1200-24", 12, 24],
  ["nf-compute-1600-32", 16, 32],
  ["nf-compute-2000-40", 20, 40],
  ["nf-compute-32-131072", 32, 128],
];

/** Smallest plan with at least the requested vCPU and memory; the largest plan if none fits. */
function plan(vcpu: number, memoryGb: number): string {
  const cost = ([, c, g]: (typeof PLANS)[number]) => c * 0.01667 + g * 0.00833;
  const fits = PLANS.filter(([, c, g]) => c >= vcpu && g >= memoryGb).sort((a, b) => cost(a) - cost(b));
  return (fits[0] ?? PLANS[PLANS.length - 1])[0];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
