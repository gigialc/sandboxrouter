import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, optionalImport, shq, toBytes, wrapCommand } from "../util.js";

type MorphModule = typeof import("morphcloud");
type MorphClient = InstanceType<MorphModule["MorphCloudClient"]>;
type MorphInstance = InstanceType<MorphModule["Instance"]>;
type MorphSSH = Awaited<ReturnType<MorphInstance["ssh"]>>;

/** Base image for the default snapshot (Morph's minimal Ubuntu VM). */
const BASE_IMAGE = "morphvm-minimal";
const DISK_MB = 8192;
/** spec.env lives here inside the VM so it survives connect(); every exec sources it. */
const ENV_FILE = "/etc/sandboxrouter.env";
const READY_TIMEOUT_S = 300;

/**
 * Morph Cloud via `morphcloud`. Instances start from snapshots: by default a cached snapshot of
 * morphvm-minimal sized to spec.vcpu / spec.memoryGb; set image.morph to a snapshot id to start
 * from your own (its resources come from the snapshot).
 */
export class MorphProvider implements Provider {
  readonly id = "morph" as const;
  private client?: MorphClient;

  constructor(private apiKey = process.env.MORPH_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private async morph(): Promise<MorphClient> {
    if (!this.client) {
      const { MorphCloudClient } = await optionalImport<MorphModule>("morphcloud", "morph");
      this.client = new MorphCloudClient({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const m = await this.morph();
    try {
      const snapshotId = spec.image?.morph ?? (await this.baseSnapshot(m, spec));
      const inst = await m.instances.start({
        snapshotId,
        metadata: spec.metadata,
        ttlSeconds: Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60)),
        ttlAction: "stop",
        timeout: READY_TIMEOUT_S,
      });
      const box = new MorphBox(inst);
      if (spec.env && Object.keys(spec.env).length) {
        try {
          await box.writeFile(ENV_FILE, envFile(spec.env));
        } catch (err) {
          await inst.stop().catch(() => {});
          throw err;
        }
      }
      return box;
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reattach; a paused instance is resumed. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const m = await this.morph();
    try {
      const inst = await m.instances.get({ instanceId: nativeId });
      if (String(inst.status) === "paused") await inst.resume();
      if (String(inst.status) !== "ready") await inst.waitUntilReady(READY_TIMEOUT_S);
      return new MorphBox(inst);
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Reuse (or create once) a morphvm-minimal snapshot with this shape, keyed by digest. */
  private async baseSnapshot(m: MorphClient, spec: SandboxSpec): Promise<string> {
    const vcpus = spec.vcpu ?? 2;
    const memory = Math.round((spec.memoryGb ?? 4) * 1024);
    const digest = `sandboxrouter-${BASE_IMAGE}-${vcpus}c-${memory}m-${DISK_MB}d`;
    const existing = (await m.snapshots.list({ digest })).find((s) => String(s.status) === "ready");
    if (existing) return existing.id;
    let snap = await m.snapshots.create({ imageId: BASE_IMAGE, vcpus, memory, diskSize: DISK_MB, digest });
    const t0 = Date.now();
    while (String(snap.status) === "pending") {
      if (Date.now() - t0 > READY_TIMEOUT_S * 1000) throw new ProviderError("morph", `snapshot ${snap.id} not ready`);
      await sleep(1000);
      snap = await m.snapshots.get({ snapshotId: snap.id });
    }
    if (String(snap.status) !== "ready") throw new ProviderError("morph", `snapshot ${snap.id} is ${snap.status}`);
    return snap.id;
  }
}

class MorphBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private inst: MorphInstance) {
    this.nativeId = inst.id;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const script = `[ -r ${ENV_FILE} ] && . ${ENV_FILE}; ${wrapCommand(cmd, { cwd: opts.cwd, env: opts.env })}`;
    try {
      // With callbacks the SDK switches to its SSE endpoint and streams; otherwise one request.
      const r = await this.inst.exec(["sh", "-c", script], {
        timeout: opts.timeoutSeconds ?? 60,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      return { exitCode: r.exit_code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", durationMs: Date.now() - t0 };
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Over SSH: base64 on stdin, decoded in the VM (parent dirs created). */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const b64 = Buffer.from(toBytes(content)).toString("base64");
    const r = await this.ssh((s) =>
      s.execCommand(`mkdir -p ${shq(dirname(path))} && base64 -d > ${shq(path)}${path === ENV_FILE ? ` && chmod 600 ${ENV_FILE}` : ""}`, { stdin: b64 }),
    );
    if (r.code !== 0) throw new ProviderError("morph", `writeFile ${path}: ${r.stderr || `exit ${r.code}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.ssh((s) => s.execCommand(`base64 < ${shq(path)}`));
    if (r.code !== 0) throw new ProviderError("morph", `readFile ${path}: ${r.stderr || `exit ${r.code}`}`);
    return new Uint8Array(Buffer.from(r.stdout, "base64"));
  }

  /** Snapshot memory and disk. router.get() resumes it. */
  async pause(): Promise<void> {
    try {
      await this.inst.pause();
    } catch (err) {
      throw wrap(err);
    }
  }

  async kill(): Promise<void> {
    try {
      await this.inst.stop();
    } catch (err) {
      throw wrap(err);
    }
  }

  /** One SSH connection per call so no socket keeps the process alive. */
  private async ssh<T>(fn: (s: MorphSSH) => Promise<T>): Promise<T> {
    let s: MorphSSH | undefined;
    try {
      s = await this.inst.ssh();
      return await fn(s);
    } catch (err) {
      throw wrap(err);
    } finally {
      s?.dispose();
    }
  }
}

function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${k}`);
      return `export ${k}=${shq(v)}\n`;
    })
    .join("");
}

/** The SDK throws plain Errors whose message starts "HTTP <status> ...". */
function wrap(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = (err as Error)?.message ?? String(err);
  const status = /^HTTP (\d{3})/.exec(msg)?.[1];
  return new ProviderError("morph", msg, status ? Number(status) : undefined);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
