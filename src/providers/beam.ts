import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, dirname, optionalImport, shq, timeoutError, toBytes } from "../util.js";

/**
 * Beam (beam.cloud) sandboxes via the official `@beamcloud/beam-js` SDK (checked against 1.1.6).
 * Auth: BEAM_TOKEN and BEAM_WORKSPACE_ID (the TS SDK refuses requests without the workspace id).
 *   new Sandbox({ name, cpu, memory: MiB, gpu?, image?, keepWarmSeconds, env }).create()
 *       -> SandboxInstance (containerId is the sandbox id)
 *   Sandbox.connect(id)                       reattach by id
 *   instance.execShell(text, { cwd, env, wait })  start a process; .wait() -> exit code,
 *       .stdout / .stderr are polled streams (async-iterable by line, or .read() for all so far)
 *   instance.fs.writeBytes(path, buf) / fs.readBytes(path)
 *   instance.terminate()
 * keepWarmSeconds is the sandbox's TTL, not an idle timeout, so it carries timeoutMinutes.
 * There is no pause: snapshot() + Sandbox.createFromSnapshot() restores into a NEW sandbox id, so
 * it can't back router.get(); the pause/resume Beam documents is for its separate VM product.
 * GPUs: spec.gpu is passed straight to Beam's `gpu` (e.g. "T4", "A10G", "A100-40", "H100",
 * "RTX4090"). The catalog doesn't list "gpu" for beam because GPU sandboxes bill different rates.
 * The SDK keeps its auth in a module-global (`beamOpts`) and caches its HTTP client on the first
 * request, so one process can only talk to one Beam token/workspace.
 * Docs: https://docs.beam.cloud/v2/reference/ts-sdk, https://docs.beam.cloud/v2/sandbox/configuration,
 *       https://docs.beam.cloud/v2/getting-started/quickstart-sandbox, https://www.beam.cloud/pricing,
 *       https://github.com/beam-cloud/beam-client/tree/master/js
 */
const ID = "beam" as const;

/** Beam groups sandboxes under an app name. */
const APP_NAME = process.env.SANDBOXROUTER_BEAM_APP ?? "sandboxrouter";

interface BeamStream extends AsyncIterable<string> {
  read(): Promise<string>;
}

interface BeamProcess {
  pid: number;
  wait(): Promise<number>;
  kill(): Promise<void>;
  readonly stdout: BeamStream;
  readonly stderr: BeamStream;
}

interface BeamInstance {
  containerId: string;
  execShell(command: string, opts?: { cwd?: string; env?: Record<string, string>; wait?: boolean }): Promise<BeamProcess>;
  fs: {
    writeBytes(path: string, content: Uint8Array | Buffer): Promise<void>;
    readBytes(path: string): Promise<Uint8Array>;
  };
  terminate(): Promise<boolean>;
}

/** The slice of `@beamcloud/beam-js` this adapter uses. */
interface BeamModule {
  beamOpts: { token: string; workspaceId: string; gatewayUrl: string };
  Sandbox: {
    new (config: Record<string, unknown>): { create(opts?: { waitForReady?: boolean }): Promise<BeamInstance> };
    connect(id: string): Promise<BeamInstance>;
  };
  Image: { fromRegistry(uri: string): unknown };
}

function fail(err: any, what: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status: number | undefined = err?.response?.status;
  const detail = err?.response?.data?.errorMsg || err?.response?.data?.message || err?.message || String(err);
  return new ProviderError(ID, `${what}: ${detail}`, status);
}

export class BeamProvider implements Provider {
  readonly id = ID;

  constructor(
    private token = process.env.BEAM_TOKEN,
    private workspaceId = process.env.BEAM_WORKSPACE_ID,
  ) {}

  configured(): boolean {
    return !!this.token && !!this.workspaceId;
  }

  private async beam(): Promise<BeamModule> {
    if (!this.token || !this.workspaceId) throw new ProviderError(ID, "BEAM_TOKEN and BEAM_WORKSPACE_ID must both be set");
    const mod = await optionalImport<BeamModule>("@beamcloud/beam-js", ID);
    mod.beamOpts.token = this.token;
    mod.beamOpts.workspaceId = this.workspaceId;
    return mod;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox, Image } = await this.beam();
    const image = spec.image?.beam;
    const config: Record<string, unknown> = {
      name: APP_NAME,
      cpu: spec.vcpu ?? DEFAULT_VCPU,
      memory: Math.round((spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024), // MiB
      keepWarmSeconds: Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)),
      env: spec.env ?? {},
    };
    if (image) config.image = Image.fromRegistry(image);
    if (spec.gpu) config.gpu = spec.gpu;
    try {
      const sb = await new Sandbox(config).create();
      return new BeamBox(sb, spec.env);
    } catch (err) {
      throw fail(err, "create");
    }
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await this.beam();
    try {
      return new BeamBox(await Sandbox.connect(nativeId));
    } catch (err) {
      throw fail(err, `connect ${nativeId}`);
    }
  }
}

/** Drain a Beam output stream line by line, passing each line to `on`. */
async function drain(stream: BeamStream, on: ((chunk: string) => void) | undefined): Promise<string> {
  let out = "";
  for await (const line of stream) {
    out += line;
    on?.(line);
  }
  return out;
}

class BeamBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(
    private sb: BeamInstance,
    private env?: Record<string, string>,
  ) {
    this.nativeId = sb.containerId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const limit = seconds * 1000;
    const streaming = !!(opts.onStdout || opts.onStderr);
    const env = this.env || opts.env ? { ...this.env, ...opts.env } : undefined;
    let proc: BeamProcess;
    try {
      // Never `wait: true`: that call returns only when the command exits, so the deadline below
      // could not start until it was already too late to enforce.
      proc = await this.sb.execShell(cmd, { cwd: opts.cwd, env, wait: false });
    } catch (err) {
      throw fail(err, "exec");
    }

    const work = (async () => {
      if (streaming) {
        const [stdout, stderr] = await Promise.all([drain(proc.stdout, opts.onStdout), drain(proc.stderr, opts.onStderr)]);
        return { exitCode: await proc.wait(), stdout, stderr };
      }
      const exitCode = await proc.wait();
      const [stdout, stderr] = await Promise.all([proc.stdout.read(), proc.stderr.read()]);
      return { exitCode, stdout, stderr };
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit)));
    try {
      const r = await Promise.race([work, timeout]);
      if (r === "timeout") {
        work.catch(() => {});
        await proc.kill().catch(() => {});
        throw timeoutError(ID, seconds);
      }
      return { ...r, durationMs: Date.now() - t0 };
    } catch (err) {
      throw fail(err, "exec");
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const buf = Buffer.from(toBytes(content));
    try {
      await this.sb.fs.writeBytes(path, buf);
    } catch {
      // Most likely a missing parent directory: create it and try once more.
      try {
        const p = await this.sb.execShell(`mkdir -p ${shq(dirname(path))}`, { wait: true });
        await p.wait();
        await this.sb.fs.writeBytes(path, buf);
      } catch (err) {
        throw fail(err, `write ${path}`);
      }
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sb.fs.readBytes(path));
    } catch (err) {
      throw fail(err, `read ${path}`);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.sb.terminate();
    } catch (err) {
      throw fail(err, "terminate");
    }
  }
}
