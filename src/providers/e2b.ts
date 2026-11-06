import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderId, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, optionalImport, timeoutError, toBytes } from "../util.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerInfo,
  ComputerOs,
  ComputerProvider,
  ComputerSpec,
  ProviderComputer,
} from "../computers.js";

type E2BModule = typeof import("e2b");
type E2BSandbox = InstanceType<E2BModule["Sandbox"]>;
type DesktopModule = typeof import("@e2b/desktop");
type E2BDesktop = InstanceType<DesktopModule["Sandbox"]>;

/** How long a desktop lives without activity. 1 hour is the Hobby tier's cap (Pro allows 24 h). */
const DESKTOP_TIMEOUT_MS = 60 * 60_000;

/**
 * E2B via the official `e2b` SDK. vCPU and memory come from the template, not the create call.
 * Computers (Linux desktops) via `@e2b/desktop`: the public `desktop` template (Xvfb + XFCE),
 * driven with xdotool and scrot inside the sandbox.
 */
export class E2BProvider implements Provider, ComputerProvider {
  readonly id = "e2b" as const;
  readonly computerOs: ComputerOs[] = ["linux"];

  constructor(private apiKey = process.env.E2B_API_KEY) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "e2b");
    const opts = {
      apiKey: this.apiKey,
      timeoutMs: (spec.timeoutMinutes ?? 30) * 60_000,
      envs: spec.env,
      metadata: spec.metadata,
    };
    const sbx = spec.image?.e2b ? await Sandbox.create(spec.image.e2b, opts) : await Sandbox.create(opts);
    return new E2BBox(sbx);
  }

  async connect(nativeId: string): Promise<ProviderSandbox> {
    const { Sandbox } = await optionalImport<E2BModule>("e2b", "e2b");
    return new E2BBox(await Sandbox.connect(nativeId, { apiKey: this.apiKey }));
  }

  /**
   * A fresh desktop every call. E2B has no get-or-create by user, so `externalUserId` (and `name`)
   * are only stored as sandbox metadata; keep the returned id to come back to the same desktop.
   */
  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    const os = spec.os ?? "linux";
    if (os !== "linux") throw new ProviderError(this.id, `E2B only offers linux desktops, not ${os}`);
    const { Sandbox } = await optionalImport<DesktopModule>("@e2b/desktop", "e2b computers");
    const metadata: Record<string, string> = {};
    if (spec.externalUserId !== undefined) metadata.externalUserId = spec.externalUserId;
    if (spec.name !== undefined) metadata.name = spec.name;
    try {
      const sbx = await Sandbox.create({
        apiKey: this.apiKey,
        timeoutMs: DESKTOP_TIMEOUT_MS,
        metadata,
        ...(spec.screen ? { resolution: [Math.round(spec.screen.width), Math.round(spec.screen.height)] as [number, number] } : {}),
      });
      return new E2BComputer(sbx);
    } catch (err: any) {
      throw new ProviderError(this.id, err?.message ?? String(err));
    }
  }

  /** Reattach by sandbox id. A paused (slept) desktop is resumed. */
  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    const { Sandbox } = await optionalImport<DesktopModule>("@e2b/desktop", "e2b computers");
    try {
      return new E2BComputer(await Sandbox.connect(nativeId, { apiKey: this.apiKey, timeoutMs: DESKTOP_TIMEOUT_MS }));
    } catch (err: any) {
      throw new ProviderError(this.id, err?.message ?? String(err));
    }
  }
}

/**
 * The members of an `e2b` Sandbox that the shared box below uses. SDKs forked from E2B's
 * (e.g. `novita-sandbox`) and E2B-API-compatible services reached through the `e2b` SDK have the
 * same shape, so their adapters reuse these classes.
 */
export interface E2BLikeSandbox {
  readonly sandboxId: string;
  commands: {
    /** Started in the background: returns a handle to wait on or kill. */
    run(
      cmd: string,
      opts: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        background: true;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      },
    ): Promise<E2BCommandHandle>;
  };
  files: {
    write(path: string, data: Uint8Array): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
  };
  kill(): Promise<unknown>;
  pause(): Promise<unknown>;
}

/** A background command (the SDK's CommandHandle). */
export interface E2BCommandHandle {
  /** Resolves when the command exits; like the SDK, rejects with CommandExitError on a nonzero exit. */
  wait(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** SIGKILL the command inside the sandbox. */
  kill(): Promise<boolean>;
}

/** exec/files/kill over an E2B-style SDK sandbox. `provider` labels errors. No pause. */
export class E2BCompatBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(
    protected sbx: E2BLikeSandbox,
    protected provider: ProviderId = "e2b",
  ) {
    this.nativeId = sbx.sandboxId;
  }

  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), seconds * 1000);
      timer.unref();
    });
    try {
      // The command runs in the background so the deadline can kill it: the SDK's own `timeoutMs`
      // only stops listening, and the process would keep running (and billing) in the sandbox.
      // That stream deadline is set past ours so it never ends a command we still want.
      const handle = await this.sbx.commands.run(cmd, {
        cwd: opts.cwd,
        envs: opts.env,
        background: true,
        timeoutMs: (seconds + 15) * 1000,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
      });
      const finished = handle.wait();
      const r = await Promise.race([finished, expired]);
      if (r === "timeout") {
        finished.catch(() => {});
        await handle.kill().catch(() => {});
        throw timeoutError(this.provider, seconds);
      }
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      // The SDK throws CommandExitError for a nonzero exit; that's a result, not a failure.
      if (err?.name === "CommandExitError" || typeof err?.exitCode === "number") {
        return { exitCode: err.exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? "", durationMs: Date.now() - t0 };
      }
      if (err?.name === "TimeoutError") throw timeoutError(this.provider, seconds);
      throw new ProviderError(this.provider, err?.message ?? String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.files.write(path, toBytes(content));
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await this.sbx.files.read(path, { format: "bytes" });
  }

  async kill(): Promise<void> {
    await this.sbx.kill();
  }
}

/** E2BCompatBox plus pause, for services where pause/resume is generally available. */
export class E2BBox extends E2BCompatBox {
  /** Snapshot memory and disk. Sandbox.connect (router.get) resumes it. */
  async pause(): Promise<void> {
    await this.sbx.pause();
  }
}

/** Friendly names models send that xdotool doesn't know; anything else passes through verbatim. */
const KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  del: "Delete",
  delete: "Delete",
  tab: "Tab",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  page_up: "Page_Up",
  pagedown: "Page_Down",
  page_down: "Page_Down",
  cmd: "super",
  command: "super",
  win: "super",
  windows: "super",
  meta: "super",
  control: "ctrl",
  option: "alt",
};

/** "ctrl+Return" -> "ctrl+Return"; "Enter" -> "Return". Space-separated combos stay separate. */
function xdoKeys(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((combo) =>
      combo
        .split("+")
        .map((k) => KEY_ALIASES[k.toLowerCase()] ?? k)
        .join("+"),
    );
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { width?: number; height?: number } {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return {};
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function errMessage(err: any): string {
  return err?.stderr?.trim() || err?.message || String(err);
}

class ActionError extends Error {}

/**
 * An E2B desktop sandbox. Canonical actions map to `@e2b/desktop` calls where the SDK has one, and
 * to xdotool/scrot commands where it doesn't (triple click, horizontal scroll, hold_key, zoom).
 */
class E2BComputer implements ProviderComputer {
  readonly nativeId: string;
  private frame = 0;
  private streamKey?: string;

  constructor(private sbx: E2BDesktop) {
    this.nativeId = sbx.sandboxId;
  }

  async info(): Promise<ComputerInfo> {
    const i = await this.sbx.getInfo();
    const running = i.state === "running";
    return {
      id: this.nativeId,
      os: "linux",
      status: running ? "ready" : "sleeping",
      screen: running ? await this.sbx.getScreenSize().catch(() => undefined) : undefined,
      externalUserId: i.metadata?.externalUserId ?? null,
    };
  }

  async act(action: ComputerAction): Promise<ActionResult> {
    try {
      const extra = await this.perform(action);
      if (action.action === "screenshot" || action.action === "zoom" || !action.noScreenshot) {
        const shot = extra.image ?? (await this.sbx.screenshot());
        delete extra.image;
        return { action: action.action, ok: true, ...extra, ...this.frameOf(shot) };
      }
      delete extra.image;
      return { action: action.action, ok: true, ...extra };
    } catch (err) {
      return { action: action.action, ok: false, error: errMessage(err) };
    }
  }

  /** Runs in order and stops at the first failed action (later coordinates may no longer apply). */
  async actBatch(actions: ComputerAction[]): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const a of actions) {
      const r = await this.act(a);
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  private frameOf(png: Uint8Array) {
    return { frameId: ++this.frame, imageB64: Buffer.from(png).toString("base64"), mime: "image/png", ...pngSize(png) };
  }

  /** Run a desktop command, with an explicit timeout rather than the SDK's 60 s default. */
  private run(cmd: string, timeoutSeconds = 60) {
    return this.sbx.commands.run(cmd, { timeoutMs: timeoutSeconds * 1000 });
  }

  private async withModifier<T>(modifier: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!modifier) return fn();
    const keys = xdoKeys(modifier.replace(/\s+/g, "+"))[0]?.split("+") ?? [];
    await this.run(`xdotool keydown ${keys.map(sh).join(" ")}`);
    try {
      return await fn();
    } finally {
      await this.run(`xdotool keyup ${[...keys].reverse().map(sh).join(" ")}`).catch(() => {});
    }
  }

  private async moveTo(a: ComputerAction, required: boolean) {
    if (!a.coordinate) {
      if (required) throw new ActionError(`${a.action} needs a coordinate`);
      return;
    }
    const [x, y] = a.coordinate;
    // The SDK's click helpers skip the move when x or y is 0, so always move explicitly.
    await this.sbx.moveMouse(Math.round(x), Math.round(y));
  }

  /** Does the action; returns extra result fields (and `image` for actions that produce their own). */
  private async perform(a: ComputerAction): Promise<Record<string, unknown> & { image?: Uint8Array }> {
    const click = async (fn: () => Promise<unknown>) => {
      await this.moveTo(a, false);
      await this.withModifier(a.modifier, async () => {
        for (let i = 0; i < Math.max(1, a.repeat ?? 1); i++) await fn();
      });
      return {};
    };
    switch (a.action) {
      case "screenshot":
        return {};
      case "left_click":
        return click(() => this.sbx.leftClick());
      case "right_click":
        return click(() => this.sbx.rightClick());
      case "middle_click":
        return click(() => this.sbx.middleClick());
      case "double_click":
        return click(() => this.sbx.doubleClick());
      case "triple_click":
        return click(() => this.run("xdotool click --repeat 3 1"));
      case "mouse_move":
        await this.moveTo(a, true);
        return {};
      case "left_click_drag": {
        const to = a.coordinate;
        if (!to) throw new ActionError("left_click_drag needs a coordinate");
        let from = a.startCoordinate;
        if (!from) {
          const p = await this.sbx.getCursorPosition();
          from = [p.x, p.y];
        }
        const start: [number, number] = [Math.round(from[0]), Math.round(from[1])];
        const end: [number, number] = [Math.round(to[0]), Math.round(to[1])];
        await this.withModifier(a.modifier, () => this.sbx.drag(start, end));
        return {};
      }
      case "left_mouse_down":
        await this.moveTo(a, false);
        await this.sbx.mousePress("left");
        return {};
      case "left_mouse_up":
        await this.moveTo(a, false);
        await this.sbx.mouseRelease("left");
        return {};
      case "scroll": {
        const dir = a.scrollDirection ?? "down";
        const amount = Math.max(1, Math.round(a.scrollAmount ?? 3));
        await this.moveTo(a, false);
        await this.withModifier(a.modifier, async () => {
          if (dir === "up" || dir === "down") await this.sbx.scroll(dir, amount);
          else await this.run(`xdotool click --repeat ${amount} ${dir === "left" ? 6 : 7}`);
        });
        return {};
      }
      case "type":
        if (a.text === undefined) throw new ActionError("type needs text");
        await this.sbx.write(a.text);
        return {};
      case "key": {
        if (!a.text) throw new ActionError("key needs text, e.g. \"Return\" or \"ctrl+s\"");
        const repeat = Math.max(1, Math.round(a.repeat ?? 1));
        await this.run(`xdotool key${repeat > 1 ? ` --repeat ${repeat}` : ""} -- ${xdoKeys(a.text).map(sh).join(" ")}`);
        return {};
      }
      case "hold_key": {
        if (!a.text) throw new ActionError("hold_key needs text");
        const keys = xdoKeys(a.text).map(sh).join(" ");
        const secs = a.duration ?? 1;
        if (!(secs >= 0 && secs <= 100)) throw new ActionError("duration must be 0 to 100 seconds");
        // The SDK's default command timeout is 60 s and would end a longer hold with the key still down.
        await this.run(`xdotool keydown ${keys}; sleep ${secs}; xdotool keyup ${keys}`, secs + 30);
        return {};
      }
      case "wait":
        await new Promise((r) => setTimeout(r, Math.max(0, a.duration ?? 1) * 1000));
        return {};
      case "zoom": {
        if (!a.region) throw new ActionError("zoom needs a region [x0, y0, x1, y1]");
        const [x0, y0, x1, y1] = a.region.map((n) => Math.round(n));
        if (x1 <= x0 || y1 <= y0 || x0 < 0 || y0 < 0) throw new ActionError(`bad zoom region ${JSON.stringify(a.region)}`);
        return { image: await this.capture(`-a ${x0},${y0},${x1 - x0},${y1 - y0}`, "png"), region: [x0, y0, x1, y1] };
      }
      case "cursor_position": {
        const p = await this.sbx.getCursorPosition();
        return { x: p.x, y: p.y, coordinate: [p.x, p.y] };
      }
      default:
        throw new ActionError(`e2b does not support the "${(a as { action: string }).action}" action`);
    }
  }

  /** scrot straight to a temp file (format from the extension), read it back, clean up. */
  private async capture(flags: string, ext: "png" | "jpg"): Promise<Uint8Array> {
    const path = `/tmp/sbr-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    await this.run(`scrot ${flags} ${path}`);
    const bytes = await this.sbx.files.read(path, { format: "bytes" });
    this.sbx.files.remove(path).catch(() => {});
    return bytes;
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    if (opts.format === "jpeg") return this.capture(`--pointer -q ${Math.round(opts.quality ?? 75)}`, "jpg");
    return await this.sbx.screenshot();
  }

  async exec(command: string, timeoutSeconds = 60) {
    try {
      const r = await this.sbx.commands.run(command, { timeoutMs: timeoutSeconds * 1000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err: any) {
      // CommandExitError for a nonzero exit is a result, not a failure.
      if (err?.name === "CommandExitError" || typeof err?.exitCode === "number") {
        return { exitCode: err.exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
      throw new ProviderError("e2b", err?.message ?? String(err));
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return await this.sbx.files.read(path, { format: "bytes" });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.files.write(path, toBytes(content));
  }

  /**
   * A noVNC link to the desktop, password in the URL, valid while the sandbox lives (`ttlSeconds`
   * is not supported, so `expiresAt` is null). `watch` sets noVNC's view_only flag, which is
   * enforced by the client page only: whoever holds a watch link can edit it into a control link.
   * The first call from a fresh connection restarts the VNC server with a new password, which
   * invalidates links handed out earlier.
   */
  async viewer(mode: "watch" | "control" = "watch", _opts: { ttlSeconds?: number; reason?: string } = {}) {
    if (!this.streamKey) {
      // After connect/resume the SDK has lost the stream state; restart x11vnc so we know the key.
      await this.sbx.stream.stop().catch(() => {});
      await this.sbx.stream.start({ requireAuth: true });
      this.streamKey = this.sbx.stream.getAuthKey();
    }
    const url = this.sbx.stream.getUrl({ autoConnect: true, viewOnly: mode === "watch", resize: "scale", authKey: this.streamKey });
    return { url, expiresAt: null };
  }

  /** E2B pause: memory and disk are snapshotted. connectComputer resumes it; open viewers drop. */
  async sleep(): Promise<void> {
    await this.sbx.pause();
    this.streamKey = undefined;
  }

  async delete(): Promise<void> {
    await this.sbx.kill();
  }
}
