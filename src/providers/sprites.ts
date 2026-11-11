import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { optionalImport, timeoutError, toBytes } from "../util.js";

type SpritesModule = typeof import("@fly/sprites");
type SpritesClient = InstanceType<SpritesModule["SpritesClient"]>;
type Sprite = InstanceType<SpritesModule["Sprite"]>;

/**
 * Fly.io Sprites via `@fly/sprites`. A sprite is a persistent machine named by the caller, so the
 * name is the native id. Sprites idle on their own and have no lifetime knob: kill() deletes it.
 */
export class SpritesProvider implements Provider {
  readonly id = "sprites" as const;
  private client?: SpritesClient;

  constructor(private token = process.env.SPRITES_TOKEN) {}

  configured(): boolean {
    return !!this.token;
  }

  private async sprites(): Promise<SpritesClient> {
    if (!this.client) {
      const { SpritesClient } = await optionalImport<SpritesModule>("@fly/sprites", "sprites");
      this.client = new SpritesClient(this.token!);
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const client = await this.sprites();
    const name = `sbr-${randomUUID().slice(0, 12)}`;
    try {
      const sprite = await client.createSprite(name, {
        config: { cpus: spec.vcpu, ramMB: spec.memoryGb ? Math.round(spec.memoryGb * 1024) : undefined },
        environment: spec.env,
      });
      return new SpritesBox(sprite);
    } catch (err: any) {
      throw new ProviderError("sprites", err?.message ?? String(err), err?.statusCode);
    }
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const client = await this.sprites();
    try {
      return new SpritesBox(await client.getSprite(nativeId));
    } catch (err: any) {
      throw new ProviderError("sprites", err?.message ?? String(err), err?.statusCode);
    }
  }
}

class SpritesBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sprite: Sprite) {
    this.nativeId = sprite.name;
  }

  /** `sprite.exec` splits on whitespace without a shell, so spawn `sh -c` and stream its output. */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const limit = (opts.timeoutSeconds ?? 60) * 1000;
    const proc = this.sprite.spawn("sh", ["-c", cmd], { cwd: opts.cwd, env: opts.env });
    const out = new StringDecoder("utf8");
    const errd = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      const c = out.write(b);
      stdout += c;
      if (c) opts.onStdout?.(c);
    });
    proc.stderr.on("data", (b: Buffer) => {
      const c = errd.write(b);
      stderr += c;
      if (c) opts.onStderr?.(c);
    });
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Reject first: killing can report an exit (-1) right away, and that must not count as the result.
          reject(timeoutError("sprites", limit / 1000));
          proc.kill("SIGKILL");
          proc.close();
        }, limit);
        timer.unref();
        proc.on("exit", (code: number) => {
          clearTimeout(timer);
          resolve(code);
        });
        proc.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
          proc.close();
        });
      });
      const so = out.end();
      const se = errd.end();
      if (so) opts.onStdout?.(so);
      if (se) opts.onStderr?.(se);
      return { exitCode, stdout: stdout + so, stderr: stderr + se, durationMs: Date.now() - t0 };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("sprites", err?.message ?? String(err));
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    try {
      await this.sprite.filesystem().writeFile(path, Buffer.from(toBytes(content)));
    } catch (err: any) {
      throw new ProviderError("sprites", err?.message ?? String(err));
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sprite.filesystem().readFile(path, null));
    } catch (err: any) {
      throw new ProviderError("sprites", err?.message ?? String(err));
    }
  }

  /** Sprites are persistent; delete so the router's disposable sandboxes don't linger. */
  async kill(): Promise<void> {
    try {
      await this.sprite.delete();
    } catch (err: any) {
      throw new ProviderError("sprites", err?.message ?? String(err), err?.statusCode);
    }
  }
}
