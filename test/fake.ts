import type { ExecOptions, ExecResult, Provider, ProviderId, ProviderSandbox, SandboxSpec } from "../src/types.js";

/** In-memory provider for router/server tests. */
export class FakeProvider implements Provider {
  created: SandboxSpec[] = [];
  live = new Map<string, FakeBox>();
  private n = 0;

  constructor(
    readonly id: ProviderId,
    /** `hang`: exec never settles, like an adapter that lost its connection. */
    public opts: { configured?: boolean; fail?: string; pause?: boolean; hang?: boolean } = {},
  ) {}

  configured() {
    return this.opts.configured ?? true;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    if (this.opts.fail) throw new Error(this.opts.fail);
    this.created.push(spec);
    const box = new FakeBox(`${this.id}-${++this.n}`);
    if (this.opts.pause === false) (box as { pause?: unknown }).pause = undefined;
    if (this.opts.hang) box.exec = () => new Promise<ExecResult>(() => {});
    this.live.set(box.nativeId, box);
    return box;
  }

  async connect(id: string): Promise<ProviderSandbox> {
    const b = this.live.get(id);
    if (!b) throw new Error(`no sandbox ${id}`);
    return b;
  }
}

export class FakeBox implements ProviderSandbox {
  files = new Map<string, Uint8Array>();
  killed = false;
  paused = false;
  constructor(readonly nativeId: string) {}

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.paused = false;
    if (cmd.startsWith("exit ")) return { exitCode: Number(cmd.slice(5)), stdout: "", stderr: "", durationMs: 1 };
    opts.onStdout?.("ran: ");
    opts.onStderr?.("warn\n");
    opts.onStdout?.(`${cmd}\n`);
    return { exitCode: 0, stdout: `ran: ${cmd}\n`, stderr: "warn\n", durationMs: 1 };
  }
  async pause() {
    this.paused = true;
  }
  async writeFile(path: string, content: string | Uint8Array) {
    this.files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }
  async readFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file ${path}`);
    return f;
  }
  async kill() {
    this.killed = true;
  }
}

export const ALL: ProviderId[] = ["maritime", "e2b", "daytona", "modal", "vercel"];
