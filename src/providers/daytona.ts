import { randomUUID } from "node:crypto";
import { ProviderError, type ExecOptions, type ExecResult, type Provider, type ProviderSandbox, type SandboxSpec } from "../types.js";
import { DEFAULT_EXEC_TIMEOUT_S, optionalImport, timeoutError, toBytes, wrapCommand } from "../util.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerInfo,
  ComputerOs,
  ComputerProvider,
  ComputerSpec,
  ProviderComputer,
} from "../computers.js";

type DaytonaModule = typeof import("@daytonaio/sdk");
type DaytonaClient = InstanceType<DaytonaModule["Daytona"]>;
type DaytonaSandbox = Awaited<ReturnType<DaytonaClient["get"]>>;

/**
 * Daytona via `@daytonaio/sdk`. Default snapshot; set image.daytona to start from an image.
 *
 * Computers are Linux container sandboxes from a default snapshot (they ship Xvfb, xfce4,
 * x11vnc and noVNC) with the desktop started through `computerUse.start()`. Windows sandboxes
 * exist but need a Tier 3 organization plus a support request, so they aren't routed here.
 * Pass `computerSnapshot` (e.g. "daytona-medium") for a bigger desktop than the 1 vCPU / 1 GiB default.
 * Docs: https://www.daytona.io/docs/en/computer-use
 */
export class DaytonaProvider implements Provider, ComputerProvider {
  readonly id = "daytona" as const;
  readonly computerOs: ComputerOs[] = ["linux"];
  private client?: DaytonaClient;

  constructor(
    private apiKey = process.env.DAYTONA_API_KEY,
    private computerSnapshot?: string,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  private async daytona(): Promise<DaytonaClient> {
    if (!this.client) {
      const { Daytona } = await optionalImport<DaytonaModule>("@daytonaio/sdk", "daytona");
      this.client = new Daytona({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async create(spec: SandboxSpec): Promise<ProviderSandbox> {
    const d = await this.daytona();
    const base = {
      envVars: spec.env,
      labels: spec.metadata,
      // Minutes of inactivity before Daytona stops it; delete right after stop.
      autoStopInterval: Math.max(1, Math.round(spec.timeoutMinutes ?? 30)),
      autoDeleteInterval: 0,
    };
    const sbx = spec.image?.daytona
      ? await d.create({
          ...base,
          image: spec.image.daytona,
          resources: { cpu: spec.vcpu, memory: spec.memoryGb },
        })
      : await d.create(base);
    return new DaytonaBox(sbx);
  }

  /** Reattach; a paused (stopped) sandbox is started again. */
  async connect(nativeId: string): Promise<ProviderSandbox> {
    const sbx = await (await this.daytona()).get(nativeId);
    if (sbx.state === "stopped") await sbx.start();
    return new DaytonaBox(sbx);
  }

  /** A new Linux desktop. `externalUserId` is stored as a label only: every call creates a new sandbox. */
  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    const os = spec.os ?? "linux";
    if (os !== "linux") throw new ProviderError(this.id, `no ${os} computers (Windows needs a Tier 3 org and a support request)`);
    const labels: Record<string, string> = { "sandboxrouter.kind": "computer" };
    if (spec.externalUserId) labels.externalUserId = spec.externalUserId;
    const envVars: Record<string, string> = {};
    if (spec.screen) {
      const { width, height } = spec.screen;
      // Daytona silently falls back to 1024x768 on a bad value, so refuse it here instead.
      if (!(width >= 640 && width <= 7680 && height >= 480 && height <= 4320)) {
        throw new ProviderError(this.id, `screen ${width}x${height} is outside 640-7680 x 480-4320`);
      }
      envVars.VNC_RESOLUTION = `${Math.round(width)}x${Math.round(height)}`;
    }
    const d = await this.daytona();
    const sbx = await d.create({
      name: spec.name,
      snapshot: this.computerSnapshot,
      labels,
      envVars: Object.keys(envVars).length ? envVars : undefined,
      autoStopInterval: COMPUTER_IDLE_MINUTES,
      // Keep the disk when it stops (idle or sleep()), so files and logins survive.
      autoDeleteInterval: -1,
    });
    try {
      await startDesktop(sbx);
    } catch (err) {
      await sbx.delete().catch(() => {});
      throw new ProviderError(this.id, `desktop did not start: ${(err as Error).message}`);
    }
    return new DaytonaComputer(sbx);
  }

  /** Reattach; a stopped, paused or archived computer is started again, desktop included. */
  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    const sbx = await (await this.daytona()).get(nativeId);
    if (sbx.state !== "started") await sbx.start();
    await startDesktop(sbx);
    return new DaytonaComputer(sbx);
  }
}

class DaytonaBox implements ProviderSandbox {
  readonly nativeId: string;
  constructor(private sbx: DaytonaSandbox) {
    this.nativeId = sbx.id;
  }

  /**
   * Every command runs in a throwaway session. Unlike `executeCommand`, a session keeps stdout and
   * stderr apart and lets the deadline be enforced here: deleting the session ends the command.
   */
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const seconds = opts.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_S;
    const session = `sbr-${randomUUID()}`;
    const proc = this.sbx.process;
    let stdout = "";
    let stderr = "";
    try {
      await proc.createSession(session);
      const { cmdId } = await proc.executeSessionCommand(session, {
        command: wrapCommand(cmd, { cwd: opts.cwd, env: opts.env }),
        runAsync: true,
      });
      const logs = proc.getSessionCommandLogs(
        session,
        cmdId,
        (c) => {
          stdout += c;
          opts.onStdout?.(c);
        },
        (c) => {
          stderr += c;
          opts.onStderr?.(c);
        },
      );
      const timedOut = await Promise.race([logs.then(() => false), sleep(seconds * 1000).then(() => true)]);
      if (timedOut) {
        logs.catch(() => {});
        throw timeoutError("daytona", seconds);
      }
      const done = await proc.getSessionCommand(session, cmdId);
      return { exitCode: done.exitCode ?? -1, stdout, stderr, durationMs: Date.now() - t0 };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("daytona", err?.message ?? String(err));
    } finally {
      await proc.deleteSession(session).catch(() => {});
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.fs.uploadFile(Buffer.from(toBytes(content)), path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.sbx.fs.downloadFile(path));
  }

  /** Stop and keep the disk until kill(). router.get() starts it again. */
  async pause(): Promise<void> {
    await this.sbx.setAutoDeleteInterval(-1);
    await this.sbx.stop();
  }

  async kill(): Promise<void> {
    await this.sbx.delete();
  }
}

/** Minutes without activity before Daytona stops a computer (disk kept, billing stops). */
const COMPUTER_IDLE_MINUTES = 30;
/** Where the default snapshots serve noVNC. */
const NOVNC_PORT = 6080;

async function startDesktop(sbx: DaytonaSandbox): Promise<void> {
  const cu = sbx.computerUse;
  if ((await cu.getStatus().catch(() => undefined))?.status === "active") return;
  await cu.start();
  for (let i = 0; i < 30; i++) {
    if ((await cu.getStatus())?.status === "active") return;
    await sleep(500);
  }
  throw new Error("computer use processes are not active after 15s");
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(b64: string): { width?: number; height?: number } {
  const head = Buffer.from(b64.slice(0, 44), "base64");
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return {};
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** xdotool key names to Daytona's (which already lowercases and maps Return, control, meta, win, option). */
const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  kp_enter: "num_enter",
  esc: "escape",
  back_space: "backspace",
  prior: "pageup",
  page_up: "pageup",
  next: "pagedown",
  page_down: "pagedown",
  caps_lock: "capslock",
  num_lock: "num_lock",
  super: "cmd",
  super_l: "cmd",
  super_r: "cmd",
  meta_l: "cmd",
  meta_r: "cmd",
  control_l: "ctrl",
  control_r: "ctrl",
  ctrl_l: "ctrl",
  ctrl_r: "ctrl",
  alt_l: "alt",
  alt_r: "alt",
  shift_l: "shift",
  shift_r: "shift",
  kp_add: "num_plus",
  kp_subtract: "num_minus",
  kp_multiply: "num_asterisk",
  kp_divide: "num_slash",
  kp_decimal: "num_decimal",
  kp_equal: "num_equal",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  apostrophe: "'",
  grave: "`",
  comma: ",",
  period: ".",
  slash: "/",
};

/** @internal "ctrl+Return" -> ["ctrl", "enter"]. */
export function daytonaKeys(chord: string): string[] {
  return chord
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const l = k.toLowerCase();
      if (KEY_ALIASES[l]) return KEY_ALIASES[l];
      const kp = /^kp_(\d)$/.exec(l);
      return kp ? `num${kp[1]}` : l;
    });
}

const MOUSE_BUTTON: Partial<Record<ComputerAction["action"], { button: string; clicks: number }>> = {
  left_click: { button: "left", clicks: 1 },
  right_click: { button: "right", clicks: 1 },
  middle_click: { button: "middle", clicks: 1 },
  double_click: { button: "left", clicks: 2 },
  triple_click: { button: "left", clicks: 3 },
};

/** A Daytona desktop driven through `sandbox.computerUse`. Coordinates are real screen pixels. */
class DaytonaComputer implements ProviderComputer {
  readonly nativeId: string;
  private frame = 0;
  constructor(private sbx: DaytonaSandbox) {
    this.nativeId = sbx.id;
  }

  async info(): Promise<ComputerInfo> {
    await this.sbx.refreshData();
    const state = String(this.sbx.state ?? "unknown");
    const status = state === "started" ? "ready" : ["stopped", "archived", "paused"].includes(state) ? "sleeping" : state;
    const info: ComputerInfo = { id: this.nativeId, os: "linux", status, externalUserId: this.sbx.labels?.externalUserId ?? null };
    if (state === "started") {
      const d = (await this.sbx.computerUse.display.getInfo().catch(() => undefined))?.displays?.[0];
      if (d?.width && d.height) info.screen = { width: d.width, height: d.height };
    }
    return info;
  }

  async act(a: ComputerAction): Promise<ActionResult> {
    try {
      const extra = await this.perform(a);
      if (a.action === "zoom" || a.noScreenshot) return { action: a.action, ok: true, ...extra };
      return { action: a.action, ok: true, ...extra, ...(await this.frameResult()) };
    } catch (err) {
      return { action: a.action, ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /** Runs in order and stops at the first error; only the last action returns a screenshot. */
  async actBatch(actions: ComputerAction[]): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const [i, a] of actions.entries()) {
      const r = await this.act(i === actions.length - 1 ? a : { ...a, noScreenshot: a.action === "zoom" ? a.noScreenshot : true });
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  private async frameResult(): Promise<ActionResult> {
    const shot = await this.sbx.computerUse.screenshot.takeFullScreen();
    if (!shot.screenshot) throw new Error("screenshot came back empty");
    return { frameId: ++this.frame, imageB64: shot.screenshot, mime: "image/png", ...pngSize(shot.screenshot) };
  }

  private async here(c?: [number, number]): Promise<[number, number]> {
    if (c) return c;
    const p = await this.sbx.computerUse.mouse.getPosition();
    return [p.x ?? 0, p.y ?? 0];
  }

  /** One canonical action to SDK calls. Returns extra result fields. */
  private async perform(a: ComputerAction): Promise<Partial<ActionResult>> {
    const { mouse, keyboard, screenshot } = this.sbx.computerUse;
    const mods = a.modifier ? daytonaKeys(a.modifier) : undefined;
    const click = MOUSE_BUTTON[a.action];
    if (click) {
      const [x, y] = await this.here(a.coordinate);
      await mouse.click(x, y, click.button, false, click.clicks, mods);
      return {};
    }
    switch (a.action) {
      case "screenshot":
        return {};
      case "mouse_move": {
        if (!a.coordinate) throw new Error("mouse_move needs coordinate");
        await mouse.move(...a.coordinate);
        return {};
      }
      case "left_click_drag": {
        if (!a.coordinate) throw new Error("left_click_drag needs coordinate");
        const [sx, sy] = await this.here(a.startCoordinate);
        await mouse.drag(sx, sy, a.coordinate[0], a.coordinate[1], "left", mods);
        return {};
      }
      case "left_mouse_down":
        await mouse.down(a.coordinate?.[0], a.coordinate?.[1], "left");
        return {};
      case "left_mouse_up":
        await mouse.up(a.coordinate?.[0], a.coordinate?.[1], "left");
        return {};
      case "scroll": {
        if (!a.scrollDirection) throw new Error("scroll needs scrollDirection");
        const [x, y] = await this.here(a.coordinate);
        await mouse.scroll(x, y, a.scrollDirection, a.scrollAmount ?? 3, mods);
        return {};
      }
      case "type":
        if (!a.text) throw new Error("type needs text");
        await keyboard.type(a.text);
        return {};
      case "key": {
        if (!a.text) throw new Error("key needs text");
        // xdotool accepts several space-separated chords: "ctrl+a Delete".
        const chords = a.text.trim().split(/\s+/).map(daytonaKeys);
        for (let n = 0; n < Math.max(1, a.repeat ?? 1); n++) {
          for (const keys of chords) await keyboard.press(keys[keys.length - 1], keys.slice(0, -1));
        }
        return {};
      }
      case "hold_key": {
        if (!a.text) throw new Error("hold_key needs text");
        const keys = daytonaKeys(a.text);
        const held: string[] = [];
        try {
          for (const k of keys) {
            await keyboard.down(k);
            held.push(k);
          }
          await sleep(seconds(a.duration ?? 1) * 1000);
        } finally {
          for (const k of held.reverse()) await keyboard.up(k).catch(() => {});
        }
        return {};
      }
      case "wait":
        await sleep(seconds(a.duration ?? 1) * 1000);
        return {};
      case "zoom": {
        if (!a.region) throw new Error("zoom needs region [x0, y0, x1, y1]");
        const [x0, y0, x1, y1] = a.region;
        if (x1 <= x0 || y1 <= y0) throw new Error("zoom region must have x1 > x0 and y1 > y0");
        const shot = await screenshot.takeRegion({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        if (!shot.screenshot) throw new Error("screenshot came back empty");
        // Region crop at native resolution; the image is the result.
        return { frameId: ++this.frame, imageB64: shot.screenshot, mime: "image/png", ...pngSize(shot.screenshot) };
      }
      case "cursor_position": {
        const p = await mouse.getPosition();
        return { coordinate: [p.x ?? 0, p.y ?? 0] };
      }
      default:
        throw new Error(`daytona does not support action "${(a as { action: string }).action}"`);
    }
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    const s = this.sbx.computerUse.screenshot;
    const shot = opts.format === "jpeg" ? await s.takeCompressed({ format: "jpeg", quality: opts.quality }) : await s.takeFullScreen();
    if (!shot.screenshot) throw new ProviderError("daytona", "screenshot came back empty");
    return new Uint8Array(Buffer.from(shot.screenshot, "base64"));
  }

  /** Daytona merges stderr into stdout here. */
  async exec(command: string, timeoutSeconds = 60) {
    try {
      const r = await this.sbx.process.executeCommand(command, undefined, undefined, timeoutSeconds);
      return { exitCode: r.exitCode, stdout: r.result, stderr: "" };
    } catch (err: any) {
      throw new ProviderError("daytona", err?.message ?? String(err));
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.sbx.fs.downloadFile(path));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.sbx.fs.uploadFile(Buffer.from(toBytes(content)), path);
  }

  /**
   * noVNC through a signed preview URL (token in the URL, no headers needed). `watch` sets noVNC's
   * view_only flag, which is enforced by the viewer page only: anyone holding the link can drop it.
   */
  async viewer(mode: "watch" | "control" = "watch", opts: { ttlSeconds?: number; reason?: string } = {}) {
    const ttl = Math.max(60, Math.round(opts.ttlSeconds ?? 3600));
    const signed = await this.sbx.getSignedPreviewUrl(NOVNC_PORT, ttl);
    const url = new URL(signed.url);
    url.pathname = "/vnc.html";
    url.searchParams.set("autoconnect", "true");
    url.searchParams.set("resize", "scale");
    url.searchParams.set("view_only", mode === "watch" ? "true" : "false");
    return { url: url.toString(), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** Stop: billing ends, the disk is kept. connectComputer starts it and its desktop again. */
  async sleep(): Promise<void> {
    await this.sbx.setAutoDeleteInterval(-1);
    await this.sbx.stop();
  }

  async delete(): Promise<void> {
    await this.sbx.delete();
  }
}

function seconds(n: number): number {
  if (!(n >= 0 && n <= 100)) throw new Error("duration must be 0 to 100 seconds");
  return n;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
