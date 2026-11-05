import { randomBytes } from "node:crypto";
import { CODESANDBOX_TIERS, DEFAULT_MEMORY_GB, DEFAULT_VCPU, codesandboxTier } from "../catalog.js";
export { CODESANDBOX_TIERS, codesandboxTier };
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, optionalImport, shq, toBytes, wrapCommand } from "../util.js";

/**
 * CodeSandbox SDK (Together AI's "code sandbox", legacy edition) via `@codesandbox/sdk` (checked
 * against 2.4.2). Auth: CSB_API_KEY, a token from https://codesandbox.io/t/api.
 *   new CodeSandbox(key).sandboxes.create({ id: template, vmTier, hibernationTimeoutSeconds, privacy })
 *   sandboxes.resume(id) -> Sandbox (wakes a hibernated one), sandbox.connect() -> SandboxClient
 *   client.commands.runBackground(cmd) -> Command (.waitUntilComplete(), .kill())
 *   client.fs.writeFile / readFile / mkdir / remove
 *   sandboxes.hibernate(id)   memory + disk snapshot; resume continues where it left off
 *   sandboxes.shutdown(id), sandboxes.delete(id)
 * Sizes are fixed VM tiers billed in credits per minute (CODESANDBOX_TIERS below); the router asks
 * for the smallest tier that fits. timeoutMinutes becomes hibernationTimeoutSeconds (60 s .. 1 day),
 * which is an inactivity timeout that hibernates, not a hard kill.
 * Commands run in a PTY that merges stdout and stderr, so exec redirects both to files in /tmp and
 * reads them back; onStdout/onStderr are fed by polling those files. spec.env is written to
 * $HOME/.sandboxrouter.env and sourced by every exec, so it survives connect().
 * Successor: Together's `together-sandbox` SDK (https://docs.together.ai/docs/together-code-sandbox)
 * needs sales enablement and publishes no prices, so it isn't used here.
 * Docs: https://docs.together.ai/docs/together-code-sandbox-legacy, https://codesandbox.io/docs/sdk,
 *       https://github.com/codesandbox/codesandbox-sdk, https://codesandbox.io/pricing
 */
const ID = "codesandbox" as const;

/**
 * VM tiers and list prices ($0.01486 per credit), from
 * https://docs.together.ai/docs/together-code-sandbox-legacy ("VM credit prices by VM size").
 * Pico: the docs table says 2 cores / 1 GB while the SDK's VMTier says 1 CPU / 2 GiB, so it is only
 * picked for requests that fit both (1 vCPU, 1 GB).
 */

/** Hibernation timeout bounds: below 60 s the SDK warns of unstable sessions; 86400 s is the max. */
const MIN_HIBERNATE_S = 60;
const MAX_HIBERNATE_S = 86_400;
const POLL_MS = 250;
const ENV_FILE = "$HOME/.sandboxrouter.env";

interface CsbCommand {
  waitUntilComplete(): Promise<string>;
  kill(): Promise<void>;
}

interface CsbClient {
  commands: { runBackground(command: string, opts?: Record<string, unknown>): Promise<CsbCommand> };
  fs: {
    writeFile(path: string, content: Uint8Array, opts?: { create?: boolean; overwrite?: boolean }): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    remove(path: string, recursive?: boolean): Promise<void>;
  };
  disconnect(): Promise<void>;
}

interface CsbSandbox {
  id: string;
  connect(): Promise<CsbClient>;
}

interface CsbSdk {
  sandboxes: {
    create(opts: Record<string, unknown>): Promise<CsbSandbox>;
    resume(id: string): Promise<CsbSandbox>;
    hibernate(id: string): Promise<void>;
    shutdown(id: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
}

/** The slice of `@codesandbox/sdk` this adapter uses. */
interface CsbModule {
  CodeSandbox: new (apiToken?: string, opts?: { baseUrl?: string }) => CsbSdk;
  VMTier: { fromName(name: string): unknown };
}

function fail(err: any, what: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = typeof err?.status === "number" ? err.status : typeof err?.response?.status === "number" ? err.response.status : undefined;
  return new ProviderError(ID, `${what}: ${err?.message ?? String(err)}`, status);
}

export class CodeSandboxProvider implements Provider {
  readonly id = ID;
  private sdk?: CsbSdk;

  constructor(
    private apiKey = process.env.CSB_API_KEY,
    private baseUrl = process.env.CSB_BASE_URL,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async module(): Promise<CsbModule> {
    return optionalImport<CsbModule>("@codesandbox/sdk", ID);
  }

  /** @internal */
  async client(): Promise<CsbSdk> {
    if (!this.apiKey) throw new ProviderError(ID, "CSB_API_KEY is not set");
    if (!this.sdk) {
      const { CodeSandbox } = await this.module();
      this.sdk = new CodeSandbox(this.apiKey, this.baseUrl ? { baseUrl: this.baseUrl } : undefined);
    }
    return this.sdk;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const [sdk, { VMTier }] = await Promise.all([this.client(), this.module()]);
    const tier = codesandboxTier(spec.vcpu ?? DEFAULT_VCPU, spec.memoryGb ?? DEFAULT_MEMORY_GB);
    const hibernate = Math.min(MAX_HIBERNATE_S, Math.max(MIN_HIBERNATE_S, Math.round((spec.timeoutMinutes ?? 30) * 60)));
    let sandbox: CsbSandbox;
    try {
      sandbox = await sdk.sandboxes.create({
        ...(spec.image?.codesandbox ? { id: spec.image.codesandbox } : {}),
        vmTier: VMTier.fromName(tier.name),
        hibernationTimeoutSeconds: hibernate,
        // The SDK defaults to "public-hosts" (open preview URLs); keep router sandboxes private.
        privacy: "private",
        tags: ["sdk", "sandboxrouter"],
        ...(spec.metadata?.name ? { title: spec.metadata.name } : {}),
      });
    } catch (err) {
      throw fail(err, "create");
    }
    const box = new CodeSandboxBox(this, sandbox.id);
    try {
      await box.attach(sandbox);
      if (spec.env && Object.keys(spec.env).length) await box.saveEnv(spec.env);
      return box;
    } catch (err) {
      await box.kill().catch(() => {});
      throw fail(err, "create");
    }
  }

  /** Reattach by id; a hibernated sandbox is resumed (shut-down ones boot clean). */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const box = new CodeSandboxBox(this, nativeId);
    await box.session();
    return box;
  }
}

class CodeSandboxBox implements ProviderSandbox {
  private conn?: CsbClient;

  constructor(
    private p: CodeSandboxProvider,
    readonly nativeId: string,
  ) {}

  /** @internal */
  async attach(sandbox: CsbSandbox): Promise<CsbClient> {
    this.conn = await sandbox.connect();
    return this.conn;
  }

  /** The live session, resuming the sandbox first if this box has none (fresh connect or after pause). */
  async session(): Promise<CsbClient> {
    if (this.conn) return this.conn;
    try {
      const sdk = await this.p.client();
      return await this.attach(await sdk.sandboxes.resume(this.nativeId));
    } catch (err) {
      throw fail(err, `resume ${this.nativeId}`);
    }
  }

  /** @internal Persist env vars as `export` lines in the sandbox; every exec sources the file. */
  async saveEnv(env: Record<string, string>): Promise<void> {
    const lines = Object.entries(env).map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ProviderError(ID, `invalid env var name: ${k}`);
      return `export ${k}=${shq(v)}\n`;
    });
    const b64 = Buffer.from(lines.join("")).toString("base64");
    const r = await this.exec(`echo ${b64} | base64 -d > "${ENV_FILE}"`, { timeoutSeconds: 30 });
    if (r.exitCode !== 0) throw new ProviderError(ID, `could not write env file: ${r.stderr.trim()}`);
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const client = await this.session();
    const limit = (opts.timeoutSeconds ?? 60) * 1000;
    const dir = `/tmp/.sbr-${randomBytes(8).toString("hex")}`;
    const user = wrapCommand(cmd, { cwd: opts.cwd, env: opts.env });
    const script = [
      `mkdir -p ${dir} || exit 1`,
      `[ -f "${ENV_FILE}" ] && . "${ENV_FILE}"`,
      `( ${user}\n) > ${dir}/out 2> ${dir}/err < /dev/null`,
    ].join("\n");
    // base64 so the script passes the SDK's own `bash -c '...'` quoting untouched.
    const line = `bash -c "$(echo ${Buffer.from(script).toString("base64")} | base64 -d)"`;

    let command: CsbCommand;
    try {
      command = await client.commands.runBackground(line);
    } catch (err) {
      throw fail(err, "exec");
    }

    let done = false;
    const finished = command.waitUntilComplete().then(
      () => 0,
      (err: any) => {
        // CommandError carries the exit code for a nonzero exit: that's a result, not a failure.
        if (typeof err?.exitCode === "number") return err.exitCode as number;
        throw err;
      },
    );
    finished.finally(() => (done = true)).catch(() => {});

    const out = new Tail(client, `${dir}/out`, opts.onStdout);
    const err = new Tail(client, `${dir}/err`, opts.onStderr);
    const streaming = !!(opts.onStdout || opts.onStderr);
    const poller = (async () => {
      while (streaming && !done) {
        await Promise.all([out.poll(), err.poll()]);
        if (!done) await sleep(POLL_MS);
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit)));
    try {
      const r = await Promise.race([finished, timeout]);
      if (r === "timeout") {
        done = true;
        finished.catch(() => {});
        await command.kill().catch(() => {});
        throw new ProviderError(ID, `command timed out after ${limit / 1000}s`);
      }
      await poller;
      const [stdout, stderr] = await Promise.all([out.poll(), err.poll()]).then(() => [out.text(), err.text()]);
      return { exitCode: r, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (e) {
      throw fail(e, "exec");
    } finally {
      clearTimeout(timer);
      done = true;
      client.fs.remove(dir, true).catch(() => {});
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const client = await this.session();
    try {
      const parent = dirname(path);
      if (parent !== "/") await client.fs.mkdir(parent, true).catch(() => {});
      await client.fs.writeFile(path, toBytes(content), { create: true, overwrite: true });
    } catch (err) {
      throw fail(err, `write ${path}`);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const client = await this.session();
    try {
      return await client.fs.readFile(path);
    } catch (err) {
      throw fail(err, `read ${path}`);
    }
  }

  /** Hibernate: memory and disk are snapshotted. router.get() (connect) resumes it. */
  async pause(): Promise<void> {
    const sdk = await this.p.client();
    await this.conn?.disconnect().catch(() => {});
    this.conn = undefined;
    try {
      await sdk.sandboxes.hibernate(this.nativeId);
    } catch (err) {
      throw fail(err, "hibernate");
    }
  }

  /** Shut the VM down (billing stops), then delete the sandbox so it doesn't pile up in the workspace. */
  async kill(): Promise<void> {
    const sdk = await this.p.client();
    await this.conn?.disconnect().catch(() => {});
    this.conn = undefined;
    await sdk.sandboxes.shutdown(this.nativeId).catch(() => {});
    try {
      await sdk.sandboxes.delete(this.nativeId);
    } catch (err) {
      throw fail(err, "delete");
    }
  }
}

/** Follows a file in the sandbox: each poll reads it and passes on the bytes added since the last. */
class Tail {
  private bytes: Uint8Array = new Uint8Array(0);
  private decoder = new TextDecoder();

  constructor(
    private client: CsbClient,
    private path: string,
    private on?: (chunk: string) => void,
  ) {}

  async poll(): Promise<void> {
    let data: Uint8Array;
    try {
      data = await this.client.fs.readFile(this.path);
    } catch {
      return; // not created yet
    }
    if (data.length <= this.bytes.length) return;
    const fresh = data.subarray(this.bytes.length);
    this.bytes = data;
    const text = this.decoder.decode(fresh, { stream: true });
    if (text) this.on?.(text);
  }

  text(): string {
    return new TextDecoder().decode(this.bytes);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
