import { randomBytes } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { dirname, shq, toBytes, wrapCommand } from "../util.js";

/**
 * exe.dev standalone VMs over the HTTPS API (no SDK needed).
 * Everything is one endpoint: POST https://exe.dev/exec, Authorization: Bearer exe1..., body = the
 * command you would type at `ssh exe.dev`. Lifecycle commands answer JSON; `ssh <vm> <cmd>` runs a
 * command in the VM and, with Accept: application/x-ndjson, answers {"stdout":b64} / {"stderr":b64}
 * lines then {"exit_code":N} (or {"error":...}).
 *   new --standalone --name=N --cpu=C --memory=MGB [--image=I] --json   create (metered per second)
 *   ls --json                                                           list ({vms:[{vm_name,status,...}]})
 *   ssh <vm> '<cmd>'                                                    run a command
 *   rm <vm>                                                             delete; billing stops
 * Limits of /exec: 30 s per request (504), 64 KB request body, no stdin, no pty. So exec runs the
 * command detached on the VM (setsid nohup, as the docs suggest) and polls its output files, and
 * files move as base64 inside commands, in chunks.
 * The token must allow `new`, `ls`, `ssh` and `rm` (`ssh` and `rm` are not in the default cmds):
 *   ssh exe.dev ssh-key generate-api-key --cmds=new,ls,ssh,rm --exp=30d
 * Docs: https://exe.dev/docs/https-api.md, https://exe.dev/docs/https-api-run-on-vm.md,
 *       https://exe.dev/docs/standalone-vms.md, https://exe.dev/docs/api.md
 */
const ID = "exedev" as const;

/** Leave headroom under the 64 KB body cap. */
const MAX_BODY = 60_000;
/** Raw bytes per writeFile chunk: base64 twice (4/3 * 4/3) plus the script stays under MAX_BODY. */
const WRITE_CHUNK = 30_000;
const VM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class ExeDevProvider implements Provider {
  readonly id = ID;

  constructor(
    private token = process.env.EXE_TOKEN,
    private baseUrl = process.env.EXE_API_URL ?? "https://exe.dev",
  ) {}

  configured(): boolean {
    return !!this.token;
  }

  /** @internal POST /exec with a command line. */
  async request(command: string, accept = "application/json"): Promise<Response> {
    if (!this.token) throw new ProviderError(ID, "EXE_TOKEN is not set");
    if (Buffer.byteLength(command) > MAX_BODY) throw new ProviderError(ID, `request body over the 64 KB /exec limit (${Buffer.byteLength(command)} bytes)`);
    const res = await fetch(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "text/plain", Accept: accept },
      body: command,
    });
    // A VM command with a nonzero exit still streams its NDJSON result.
    if (!res.ok && !(accept.includes("ndjson") && res.headers.get("content-type")?.includes("ndjson"))) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (typeof j?.error === "string") detail = j.error;
      } catch {
        /* plain-text body */
      }
      const verb = command.split(" ", 1)[0];
      throw new ProviderError(ID, `/exec ${verb} -> ${res.status} ${detail}`, res.status);
    }
    return res;
  }

  /** @internal Lobby command with JSON output. */
  async lobby<T>(command: string): Promise<T> {
    const text = await (await this.request(`${command} --json`)).text();
    const j = (text ? JSON.parse(text) : {}) as T & { error?: string };
    if (typeof j.error === "string") throw new ProviderError(ID, `${command.split(" ", 1)[0]}: ${j.error}`);
    return j;
  }

  /**
   * @internal Run a shell script on the VM. The script is base64-encoded so it survives both quoting
   * layers (the lobby's shell lexer, then the VM's shell) untouched.
   */
  async ssh(vm: string, script: string): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    const b64 = Buffer.from(script).toString("base64");
    const res = await this.request(`ssh ${vm} 'bash -c "$(echo ${b64} | base64 -d)"'`, "application/x-ndjson");
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let exitCode: number | undefined;
    for await (const line of readLines(res)) {
      const j = JSON.parse(line) as { stdout?: string; stderr?: string; exit_code?: number; error?: string };
      if (j.stdout !== undefined) out.push(Buffer.from(j.stdout, "base64"));
      if (j.stderr !== undefined) err.push(Buffer.from(j.stderr, "base64"));
      if (j.exit_code !== undefined) exitCode = j.exit_code;
      if (j.error !== undefined) throw new ProviderError(ID, `ssh ${vm}: ${j.error}`);
    }
    if (exitCode === undefined) throw new ProviderError(ID, `ssh ${vm}: response ended without an exit code`);
    return { exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    // Standalone VMs take up to 2 GiB per vCPU, so raise the vCPUs when the memory asks for more.
    const memoryGb = Math.max(1, Math.ceil(spec.memoryGb ?? 4));
    const cpu = Math.max(1, Math.ceil(spec.vcpu ?? 2), Math.ceil(memoryGb / 2));
    const name = `sbr-${randomBytes(6).toString("hex")}`;
    const flags = [`--standalone`, `--name=${name}`, `--cpu=${cpu}`, `--memory=${memoryGb}GB`];
    const image = spec.image?.exedev;
    if (image) {
      if (!/^[A-Za-z0-9._/:@-]+$/.test(image)) throw new ProviderError(ID, `invalid image reference: ${image}`);
      flags.push(`--image=${image}`);
    }
    const vm = await this.lobby<{ vm_name?: string }>(`new ${flags.join(" ")}`);
    const box = new ExeDevSandbox(this, vm.vm_name ?? name, spec.env);
    try {
      await box.waitForSsh();
    } catch (err) {
      await box.kill().catch(() => {});
      throw err;
    }
    return box;
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    if (!VM_NAME.test(nativeId)) throw new ProviderError(ID, `invalid VM name: ${nativeId}`);
    const { vms = [] } = await this.lobby<{ vms?: { vm_name: string; status?: string }[] }>("ls");
    if (!vms.some((v) => v.vm_name === nativeId)) throw new ProviderError(ID, `VM ${nativeId} not found`, 404);
    return new ExeDevSandbox(this, nativeId);
  }
}

class ExeDevSandbox implements ProviderSandbox {
  constructor(
    private p: ExeDevProvider,
    readonly nativeId: string,
    private env?: Record<string, string>,
  ) {}

  /** `new` returns once the VM exists; retry a no-op until sshd answers. */
  async waitForSsh(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if ((await this.p.ssh(this.nativeId, "true")).exitCode === 0) return;
      } catch (err) {
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) throw err;
        if (Date.now() > deadline) throw err;
      }
      if (Date.now() > deadline) throw new ProviderError(ID, `VM ${this.nativeId} did not accept commands within ${timeoutMs / 1000}s`);
      await sleep(1000);
    }
  }

  /**
   * One /exec request lasts at most 30 s, so the command runs detached on the VM, writing to
   * /tmp/.sbr-<id>/{out,err,exit}. Each request waits up to `wait` for it to finish, sends the output
   * written since the last request, and either exits with the command's code (done) or ends stderr
   * with a random marker (still running).
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const timeout = Math.max(1, Math.round(opts.timeoutSeconds ?? 60));
    const job = randomBytes(8).toString("hex");
    const dir = `/tmp/.sbr-${job}`;
    const marker = `__sandboxrouter_running_${job}__`;
    const streaming = !!(opts.onStdout || opts.onStderr);
    const waitTenths = streaming ? 10 : 200; // 1 s or 20 s per request
    const full = wrapCommand(cmd, { cwd: opts.cwd, env: { ...this.env, ...opts.env } });
    const cmdB64 = Buffer.from(full).toString("base64");

    const report = (outOff: number, errOff: number) =>
      [
        `d=${dir}; i=0`,
        `while [ ! -f "$d/exit" ] && [ $i -lt ${waitTenths} ]; do sleep 0.1; i=$((i+1)); done`,
        `f=0; [ -f "$d/exit" ] && f=1`,
        `tail -c +${outOff + 1} "$d/out" 2>/dev/null`,
        `tail -c +${errOff + 1} "$d/err" >&2 2>/dev/null`,
        `if [ $f = 1 ]; then c=$(cat "$d/exit"); rm -rf "$d"; exit "$c"; fi`,
        `printf %s ${marker} >&2`,
      ].join("\n");

    const start = [
      `d=${dir}; mkdir -p "$d" && echo ${cmdB64} | base64 -d > "$d/cmd" || exit 1`,
      `setsid nohup bash -c 'timeout -k 5 ${timeout} bash "$0/cmd" > "$0/out" 2> "$0/err" < /dev/null; echo $? > "$0/exit.tmp"; mv "$0/exit.tmp" "$0/exit"' "$d" > /dev/null 2>&1 < /dev/null &`,
      report(0, 0),
    ].join("\n");

    const outDec = new TextDecoder();
    const errDec = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let outOff = 0;
    let errOff = 0;
    const deadline = Date.now() + (timeout + 60) * 1000;

    let script = start;
    for (;;) {
      const r = await this.p.ssh(this.nativeId, script);
      let errBytes = r.stderr;
      const m = Buffer.from(marker);
      const running = errBytes.length >= m.length && Buffer.from(errBytes.subarray(errBytes.length - m.length)).equals(m);
      if (running) errBytes = errBytes.subarray(0, errBytes.length - m.length);
      outOff += r.stdout.length;
      errOff += errBytes.length;
      const o = outDec.decode(r.stdout, { stream: running });
      const e = errDec.decode(errBytes, { stream: running });
      if (o) {
        stdout += o;
        opts.onStdout?.(o);
      }
      if (e) {
        stderr += e;
        opts.onStderr?.(e);
      }
      if (!running) return { exitCode: r.exitCode, stdout, stderr, durationMs: Date.now() - t0 };
      if (Date.now() > deadline) {
        await this.p.ssh(this.nativeId, `pkill -f ${shq(`${dir}/cmd`)}; rm -rf ${dir}`).catch(() => {});
        throw new ProviderError(ID, `command still running ${timeout + 60}s after it started`);
      }
      script = report(outOff, errOff);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = toBytes(content);
    const tmp = `${path}.sbr-${randomBytes(4).toString("hex")}`;
    let first = true;
    for (let i = 0; first || i < bytes.length; i += WRITE_CHUNK) {
      const b64 = Buffer.from(bytes.subarray(i, i + WRITE_CHUNK)).toString("base64");
      const prefix = first ? `mkdir -p ${shq(dirname(path))} && ` : "";
      const r = await this.p.ssh(this.nativeId, `${prefix}echo ${b64 || "''"} | base64 -d ${first ? ">" : ">>"} ${shq(tmp)}`);
      if (r.exitCode !== 0) throw new ProviderError(ID, `writeFile ${path}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
      first = false;
    }
    const r = await this.p.ssh(this.nativeId, `mv -f ${shq(tmp)} ${shq(path)}`);
    if (r.exitCode !== 0) throw new ProviderError(ID, `writeFile ${path}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.p.ssh(this.nativeId, `base64 -w0 ${shq(path)}`);
    if (r.exitCode !== 0) throw new ProviderError(ID, `readFile ${path}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
    return new Uint8Array(Buffer.from(r.stdout.toString(), "base64"));
  }

  async kill(): Promise<void> {
    await this.p.lobby(`rm ${this.nativeId}`);
  }
}

/** Newline-delimited JSON reader for a fetch Response. */
async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
    if (done) {
      if (buffer.trim()) yield buffer.trim();
      return;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
