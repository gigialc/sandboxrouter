import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU } from "../catalog.js";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, dirname, guardTimeout, killedByTimeout, shq, timeoutError, toBytes } from "../util.js";

/**
 * Local sandboxes in Docker containers, through the `docker` CLI. Free and needs no account, so it
 * is good for development and tests. A container shares your machine's kernel: it is weaker
 * isolation than a cloud micro-VM, so don't point untrusted code at it with secrets mounted.
 * Never chosen automatically; route to it with { provider: "docker" }.
 */
export class DockerProvider implements Provider {
  readonly id = "docker" as const;
  private available?: boolean;

  constructor(private bin = process.env.SANDBOXROUTER_DOCKER_BIN ?? "docker") {}

  /** The docker CLI exists and its daemon answers. Cached for the life of the process. */
  configured(): boolean {
    if (this.available === undefined) {
      const r = spawnSync(this.bin, ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000, encoding: "utf8" });
      this.available = r.status === 0 && !!r.stdout.trim();
    }
    return this.available;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const name = `sbr-${randomUUID().slice(0, 12)}`;
    const lifetime = Math.max(60, Math.round((spec.timeoutMinutes ?? 30) * 60));
    const args = [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      "sandboxrouter=1",
      "--cpus",
      String(spec.vcpu ?? DEFAULT_VCPU),
      "--memory",
      `${Math.round((spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024)}m`,
    ];
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
    for (const [k, v] of Object.entries(spec.metadata ?? {})) args.push("--label", `${k}=${v}`);
    // The container's main process is a timer: it exits at the lifetime and --rm removes it.
    args.push(spec.image?.docker ?? "python:3.12-slim", "sleep", String(lifetime));
    const r = await run(this.bin, args);
    if (r.code !== 0) throw new ProviderError("docker", `docker run failed: ${r.stderr.trim().slice(0, 300)}`);
    return new DockerBox(this.bin, name);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const r = await run(this.bin, ["inspect", "-f", "{{.State.Status}}", nativeId]);
    if (r.code !== 0) throw new ProviderError("docker", `no container ${nativeId}`, 404);
    if (r.stdout.trim() === "paused") await run(this.bin, ["unpause", nativeId]);
    return new DockerBox(this.bin, nativeId);
  }
}

class DockerBox implements ProviderSandbox {
  constructor(
    private bin: string,
    readonly nativeId: string,
  ) {}

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const args = ["exec", "-i"];
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    // The command is killed inside the container: Docker does not stop an exec'd process when its
    // client dies, so killing `docker exec` alone would leave it running. The client-side limit
    // only covers a container that stops answering.
    args.push(this.nativeId, "sh", "-c", guardTimeout(cmd, seconds));
    return run(this.bin, args, { timeoutMs: (seconds + 10) * 1000, onStdout: opts.onStdout, onStderr: opts.onStderr }).then((r) => {
      if (r.timedOut || killedByTimeout(r.code ?? -1, r.ms, seconds)) throw timeoutError("docker", seconds);
      return { exitCode: r.code ?? -1, stdout: r.stdout, stderr: r.stderr, durationMs: r.ms };
    });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const r = await run(this.bin, ["exec", "-i", this.nativeId, "sh", "-c", `mkdir -p ${shq(dirname(path))} && cat > ${shq(path)}`], {
      stdin: toBytes(content),
    });
    if (r.code !== 0) throw new ProviderError("docker", `write ${path} failed: ${r.stderr.trim().slice(0, 300)}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await run(this.bin, ["exec", this.nativeId, "cat", path], { binary: true });
    if (r.code !== 0) throw new ProviderError("docker", `read ${path} failed: ${r.stderr.trim().slice(0, 300)}`, 404);
    return r.bytes!;
  }

  async pause(): Promise<void> {
    const r = await run(this.bin, ["pause", this.nativeId]);
    if (r.code !== 0) throw new ProviderError("docker", `pause failed: ${r.stderr.trim()}`);
  }

  async kill(): Promise<void> {
    await run(this.bin, ["rm", "-f", this.nativeId]);
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  bytes?: Uint8Array;
  ms: number;
  timedOut: boolean;
}

function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: Uint8Array; binary?: boolean; onStdout?: (c: string) => void; onStderr?: (c: string) => void } = {},
): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const dec = new TextDecoder();
    const decErr = new TextDecoder();
    child.stdout.on("data", (b: Buffer) => {
      if (opts.binary) return void out.push(b);
      const c = dec.decode(b, { stream: true });
      stdout += c;
      if (c) opts.onStdout?.(c);
    });
    child.stderr.on("data", (b: Buffer) => {
      const c = decErr.decode(b, { stream: true });
      stderr += c;
      if (c) opts.onStderr?.(c);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProviderError("docker", `could not run ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, bytes: opts.binary ? new Uint8Array(Buffer.concat(out)) : undefined, ms: Date.now() - t0, timedOut });
    });
    // A command that exits before reading its stdin makes the pipe raise EPIPE; the exit code already tells the story.
    child.stdin.on("error", () => {});
    if (opts.stdin) child.stdin.end(Buffer.from(opts.stdin));
    else child.stdin.end();
  });
}
