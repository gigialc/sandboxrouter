import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, type ProviderId } from "../types.js";
import { optionalImport, toBytes } from "../util.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerInfo,
  ComputerOs,
  ComputerProvider,
  ComputerSpec,
  ProviderComputer,
} from "../computers.js";

/**
 * Limrun: cloud Android emulators and iOS simulators, driven through `@limrun/api`.
 * Control plane: `new Limrun({ apiKey })` -> androidInstances / iosInstances (create, get, delete).
 * Device: createInstanceClient (Android) / Ios.createInstanceClient, built from the instance's
 * status.apiUrl + status.token (a WebSocket; no API key needed).
 * Docs: https://docs.limrun.com/docs/reference/sdk.md
 *
 * Canonical action mapping (coordinates are in the last screenshot's frame; iOS screenshots are
 * the SDK's default "scaled" size, i.e. tap points, so they line up with taps):
 *
 *   screenshot             Android client.screenshot() (data URI) | iOS screenshot({ format: "png" })
 *   left_click             tap(x, y); with `duration` (s) > 0 it is a long press of that length
 *   right_click            long press (800 ms), the phone's context-menu gesture
 *   double/triple_click    2 or 3 quick taps (Android: one `input tap` shell line; iOS: one performActions batch)
 *   left_click_drag        swipe startCoordinate -> coordinate (Android `input swipe`; iOS touchDown/touchMove/touchUp)
 *   scroll                 Android scrollScreen / scrollElement({x, y}) with amount = steps;
 *                          iOS scroll(direction, steps x 100 points, { coordinate })
 *   type                   Android setText(focused input) | iOS typeText(requireFocus: false)
 *   key                    xdotool-style chords, see KEYS below; `repeat` presses it again
 *   wait                   sleep `duration` seconds (default 1)
 *   cursor_position, mouse_move, middle_click, left_mouse_down/up, hold_key, zoom
 *                          error result: phones have no cursor, hover or held keys, and there is no
 *                          in-process image crop
 *
 * Key table (case-insensitive xdotool names -> Android pressKey | iOS):
 *   Return, Enter, KP_Enter     ENTER           | pressKey("enter")
 *   BackSpace                   DEL             | pressKey("backspace")
 *   Delete                      FORWARD_DEL     | pressKey("delete")
 *   Tab                         TAB             | pressKey("tab")
 *   Escape, Esc                 BACK            | pressKey("escape")
 *   Back                        BACK            | error (no Back button on iOS)
 *   Home, Super, XF86HomePage   HOME            | home button
 *   Up/Down/Left/Right          DPAD_*          | pressKey("up" ...)
 *   space                       SPACE           | pressKey("space")
 *   XF86AudioRaiseVolume        VOLUME_UP       | volumeUp button
 *   XF86AudioLowerVolume        VOLUME_DOWN     | volumeDown button
 *   XF86AudioMute               VOLUME_MUTE     | error
 *   Power, XF86PowerOff, Lock   POWER           | lock button
 *   Menu                        MENU            | error
 *   a single digit              KEYCODE_<d>     | the digit (Android reads a bare "4" as keycode 4 = BACK)
 *   anything else               passed through  | passed through, lowercased
 * Modifiers in a chord (ctrl+a): ctrl/control, shift, alt/option, super/meta/cmd/command.
 */
export class LimrunProvider implements ComputerProvider {
  readonly id = "limrun";
  /** Android emulators and iPhone simulators. Limrun also offers tablets/iPads, not routed here. */
  readonly computerOs: ComputerOs[] = ["android", "ios"];
  private sdk?: Promise<{ mod: LimrunModule; lim: LimrunClient }>;

  constructor(
    private apiKey = process.env.LIM_API_KEY,
    private opts: {
      /** e.g. "10m", up to "24h". Unset uses the organization default (Limrun's own default is 3m). */
      inactivityTimeout?: string;
      /** Region or region group, e.g. "us-west1" or "eu". Unset lets Limrun pick by proximity. */
      region?: string;
      baseURL?: string;
    } = {},
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  client(): Promise<{ mod: LimrunModule; lim: LimrunClient }> {
    if (!this.apiKey) return Promise.reject(err("LIM_API_KEY is not set"));
    this.sdk ??= optionalImport<LimrunModule>("@limrun/api", "limrun").then((mod) => ({
      mod,
      lim: new mod.Limrun({ apiKey: this.apiKey, ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}) }),
    }));
    return this.sdk;
  }

  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    const os = spec.os ?? "android";
    if (os !== "android" && os !== "ios") throw err(`no ${os} computers (limrun offers android and ios)`);
    const { mod, lim } = await this.client();
    const labels = spec.externalUserId ? { externalUserId: spec.externalUserId } : undefined;
    const metadata = { ...(spec.name ? { displayName: spec.name } : {}), ...(labels ? { labels } : {}) };
    const common = {
      ...(this.opts.inactivityTimeout ? { inactivityTimeout: this.opts.inactivityTimeout } : {}),
      ...(this.opts.region ? { region: this.opts.region } : {}),
    };
    // reuseIfExists returns the instance that already carries these labels: same user, same device.
    const params = { wait: true, reuseIfExists: !!labels, metadata };
    try {
      const inst =
        os === "android"
          ? await lim.androidInstances.create({ ...params, spec: { ...common, model: "phone" } })
          : await lim.iosInstances.create({ ...params, spec: { ...common, model: "iphone" } });
      const c = new LimrunComputer(mod, lim, os, inst);
      await c.waitReady();
      return c;
    } catch (e) {
      throw wrap(e);
    }
  }

  /** Limrun ids don't say which platform they belong to, so try Android, then iOS. */
  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    const { mod, lim } = await this.client();
    try {
      return new LimrunComputer(mod, lim, "android", await lim.androidInstances.get(nativeId));
    } catch (e) {
      if (!isNotFound(e)) throw wrap(e);
    }
    try {
      return new LimrunComputer(mod, lim, "ios", await lim.iosInstances.get(nativeId));
    } catch (e) {
      throw isNotFound(e) ? err(`no android or ios instance ${nativeId}`, 404) : wrap(e);
    }
  }
}

type LimrunModule = typeof import("@limrun/api");
type LimrunClient = InstanceType<LimrunModule["Limrun"]>;
type AndroidClient = Awaited<ReturnType<LimrunModule["createInstanceClient"]>>;
type IosClient = Awaited<ReturnType<LimrunModule["Ios"]["createInstanceClient"]>>;
type Instance = Awaited<ReturnType<LimrunClient["androidInstances"]["get"]>> | Awaited<ReturnType<LimrunClient["iosInstances"]["get"]>>;
type Device = { os: "android"; c: AndroidClient } | { os: "ios"; c: IosClient };
type Shot = { b64: string; mime: string; width?: number; height?: number };

const READY_TIMEOUT_MS = 5 * 60_000;
/** iOS scroll takes pixels (points); one canonical scroll step moves this far. */
const IOS_POINTS_PER_STEP = 100;
const LONG_PRESS_MS = 800;
const SWIPE_MS = 300;

class LimrunComputer implements ProviderComputer {
  readonly nativeId: string;
  private dev?: Promise<Device>;
  private frame = 0;
  private size?: { width: number; height: number };

  constructor(
    private mod: LimrunModule,
    private lim: LimrunClient,
    readonly os: "android" | "ios",
    private inst: Instance,
  ) {
    this.nativeId = inst.metadata.id;
  }

  private api() {
    return this.os === "android" ? this.lim.androidInstances : this.lim.iosInstances;
  }

  private async refresh(): Promise<Instance> {
    this.inst = await this.api().get(this.nativeId);
    return this.inst;
  }

  /** @internal create({ wait: true }) normally returns ready; poll in case it came back early. */
  async waitReady(): Promise<void> {
    const t0 = Date.now();
    while (this.inst.status.state !== "ready") {
      if (this.inst.status.state === "terminated") {
        throw err(`instance ${this.nativeId} terminated before it was ready${this.inst.status.errorMessage ? `: ${this.inst.status.errorMessage}` : ""}`);
      }
      if (Date.now() - t0 > READY_TIMEOUT_MS) throw err(`instance ${this.nativeId} not ready after ${READY_TIMEOUT_MS / 1000}s (state: ${this.inst.status.state})`);
      await sleep(2000);
      await this.refresh();
    }
  }

  /** The device WebSocket client, opened once and reopened if it dropped for good. */
  private device(): Promise<Device> {
    const cur = this.dev;
    if (!cur) return this.reopen();
    return cur.then((d) => (d.c.getConnectionState() === "disconnected" ? this.reopen(cur) : d));
  }

  private reopen(stale?: Promise<Device>): Promise<Device> {
    if (stale && this.dev && this.dev !== stale) return this.dev; // another call already reopened
    const p = this.open();
    this.dev = p;
    p.catch(() => {
      if (this.dev === p) this.dev = undefined;
    });
    return p;
  }

  private async open(): Promise<Device> {
    if (this.inst.status.state !== "ready" || !this.inst.status.apiUrl || !this.inst.status.token) await this.refresh();
    const s = this.inst.status;
    if (s.state !== "ready") throw err(`instance ${this.nativeId} is ${s.state}`);
    if (!s.apiUrl || !s.token) throw err(`instance ${this.nativeId} came back without apiUrl/token (a read-only key can't control devices)`);
    if (this.os === "android") {
      const adbUrl = (s as { adbWebSocketUrl?: string }).adbWebSocketUrl;
      return { os: "android", c: await this.mod.createInstanceClient({ apiUrl: s.apiUrl, token: s.token, ...(adbUrl ? { adbUrl } : {}), logLevel: "error" }) };
    }
    return { os: "ios", c: await this.mod.Ios.createInstanceClient({ apiUrl: s.apiUrl, token: s.token, logLevel: "error" }) };
  }

  async info(): Promise<ComputerInfo> {
    const inst = await this.refresh().catch((e) => {
      throw wrap(e);
    });
    const state = inst.status.state;
    const info: ComputerInfo = {
      id: this.nativeId,
      os: this.os,
      status: state === "creating" || state === "assigned" ? "creating" : state,
      externalUserId: inst.metadata.labels?.externalUserId ?? null,
    };
    if (state === "ready") {
      const screen = await this.screenSize().catch(() => undefined);
      if (screen) info.screen = screen;
    }
    return info;
  }

  private async screenSize(): Promise<{ width: number; height: number } | undefined> {
    const d = await this.device();
    if (d.os === "ios") return { width: d.c.deviceInfo.screenWidth, height: d.c.deviceInfo.screenHeight };
    if (!this.size) await this.shot();
    return this.size;
  }

  async act(a: ComputerAction): Promise<ActionResult> {
    try {
      const extra = await this.perform(a);
      if (a.noScreenshot) return { action: a.action, ok: true, ...extra };
      return { action: a.action, ok: true, ...extra, ...(await this.frameResult()) };
    } catch (e) {
      return { action: a.action, ok: false, error: (e as Error)?.message ?? String(e) };
    }
  }

  /** Runs in order and stops at the first error; only the last action returns a screenshot. */
  async actBatch(actions: ComputerAction[]): Promise<ActionResult[]> {
    const out: ActionResult[] = [];
    for (const [i, a] of actions.entries()) {
      const r = await this.act(i === actions.length - 1 ? a : { ...a, noScreenshot: true });
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  private async frameResult(): Promise<ActionResult> {
    const s = await this.shot();
    return { frameId: ++this.frame, imageB64: s.b64, mime: s.mime, width: s.width, height: s.height };
  }

  private async shot(format: "png" | "jpeg" = "png"): Promise<Shot> {
    const d = await this.device();
    let s: Shot;
    if (d.os === "ios") {
      const r = await d.c.screenshot({ format });
      s = { b64: r.base64, mime: `image/${format}`, width: r.width, height: r.height };
    } else {
      const { dataUri } = await d.c.screenshot();
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri ?? "");
      if (!m || !m[3]) throw new Error("screenshot came back empty");
      const b64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), "binary").toString("base64");
      s = { b64, mime: m[1] ?? "image/png", ...imageSize(b64) };
    }
    if (s.width && s.height) this.size = { width: s.width, height: s.height };
    return s;
  }

  /** One canonical action to SDK calls. Returns extra result fields. */
  private async perform(a: ComputerAction): Promise<Partial<ActionResult>> {
    const d = await this.device();
    const xy = () => {
      if (!a.coordinate) throw new Error(`${a.action} needs coordinate (phones have no cursor)`);
      return a.coordinate.map(Math.round) as [number, number];
    };
    const noMods = () => {
      if (a.modifier) throw new Error(`${a.action} with a modifier isn't supported on a touchscreen`);
    };
    switch (a.action) {
      case "screenshot":
        return {};
      case "left_click": {
        noMods();
        const [x, y] = xy();
        if (a.duration && a.duration > 0) await longPress(d, x, y, seconds(a.duration) * 1000);
        else if (d.os === "android") await d.c.tap({ x, y });
        else await d.c.tap(x, y);
        return {};
      }
      case "right_click": {
        noMods();
        const [x, y] = xy();
        await longPress(d, x, y, LONG_PRESS_MS);
        return {};
      }
      case "double_click":
      case "triple_click": {
        noMods();
        const [x, y] = xy();
        await taps(d, x, y, a.action === "double_click" ? 2 : 3);
        return {};
      }
      case "left_click_drag": {
        if (!a.startCoordinate) throw new Error("left_click_drag needs startCoordinate (phones have no cursor)");
        const [x2, y2] = xy();
        const [x1, y1] = a.startCoordinate.map(Math.round);
        await swipe(d, x1, y1, x2, y2, a.duration && a.duration > 0 ? seconds(a.duration) * 1000 : SWIPE_MS);
        return {};
      }
      case "scroll": {
        if (!a.scrollDirection) throw new Error("scroll needs scrollDirection");
        const steps = Math.max(1, Math.round(a.scrollAmount ?? 3));
        const at = a.coordinate?.map(Math.round) as [number, number] | undefined;
        if (d.os === "android") {
          if (at) await d.c.scrollElement({ x: at[0], y: at[1] }, a.scrollDirection, steps);
          else await d.c.scrollScreen(a.scrollDirection, steps);
        } else {
          await d.c.scroll(a.scrollDirection, steps * IOS_POINTS_PER_STEP, at ? { coordinate: at } : undefined);
        }
        return {};
      }
      case "type":
        if (!a.text) throw new Error("type needs text");
        if (d.os === "android") await d.c.setText(undefined, a.text);
        else await d.c.typeText(a.text, false, { requireFocus: false });
        return {};
      case "key": {
        if (!a.text) throw new Error("key needs text");
        // xdotool accepts several space-separated chords: "ctrl+a BackSpace".
        const chords = a.text.trim().split(/\s+/).map((c) => limrunKey(c, d.os));
        for (let n = 0; n < Math.max(1, a.repeat ?? 1); n++) {
          for (const k of chords) {
            if (d.os === "android") await d.c.pressKey(k.key, k.modifiers.length ? k.modifiers : undefined);
            else if (k.button) await d.c.performActions([{ type: "buttonDown", button: k.button }, { type: "buttonUp", button: k.button }]);
            else await d.c.pressKey(k.key, k.modifiers.length ? k.modifiers : undefined);
          }
        }
        return {};
      }
      case "wait":
        await sleep(seconds(a.duration ?? 1) * 1000);
        return {};
      case "cursor_position":
        throw new Error("cursor_position: phones have no cursor");
      case "mouse_move":
        throw new Error("mouse_move: a touchscreen has no hover; tap or swipe instead");
      case "zoom":
        throw new Error("zoom isn't supported on limrun phones; use a full screenshot");
      case "left_mouse_down":
      case "left_mouse_up":
        throw new Error(`${a.action} isn't supported on limrun phones; use left_click_drag or left_click with duration`);
      default:
        throw new Error(`limrun does not support action "${(a as { action: string }).action}" on ${this.os}`);
    }
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    try {
      const s = await this.shot(opts.format ?? "png");
      return new Uint8Array(Buffer.from(s.b64, "base64"));
    } catch (e) {
      throw wrap(e);
    }
  }

  /** Android: `adb shell` as the shell user. iOS simulators have no shell. */
  async exec(command: string, timeoutSeconds = 30) {
    if (this.os === "ios") throw err("iOS simulators have no shell (Limrun exposes only simctl, a few xcrun flags and file transfer)");
    const d = (await this.device()) as Extract<Device, { os: "android" }>;
    try {
      const r = await d.c.adbShell("sh", ["-c", command], { timeoutMs: Math.max(1, timeoutSeconds) * 1000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.truncated ? `${r.stderr}\n[limrun: output truncated]` : r.stderr };
    } catch (e) {
      throw wrap(e);
    }
  }

  /**
   * Android: like `adb pull` (readable paths such as /sdcard, /data/local/tmp).
   * iOS: a file in the simulator's staging folder (the path is relative to it; a leading / is dropped).
   */
  async readFile(path: string): Promise<Uint8Array> {
    const d = await this.device();
    try {
      if (d.os === "ios") return new Uint8Array(await d.c.pullFile(path.replace(/^\/+/, "")));
      return await withTemp(async (local) => {
        await d.c.pullFile(path, local);
        return new Uint8Array(await readFile(local));
      });
    } catch (e) {
      throw wrap(e);
    }
  }

  /** Android: like `adb push`. iOS: into the simulator's staging folder (path relative to it). */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const d = await this.device();
    try {
      await withTemp(async (local) => {
        await writeFile(local, toBytes(content));
        if (d.os === "ios") await d.c.pushFile(local, path.replace(/^\/+/, ""));
        else await d.c.pushFile(local, path);
      });
    } catch (e) {
      throw wrap(e);
    }
  }

  /**
   * status.signedStreamUrl: the token is in the URL, no sign-in needed, and it opens an interactive
   * stream (Limrun: "watch and control"). There is no view-only variant, so `watch` is refused
   * rather than handing out control. The SDK gives no expiry; it lives with the instance.
   */
  async viewer(mode: "watch" | "control" = "watch", _opts: { ttlSeconds?: number; reason?: string } = {}) {
    if (mode === "watch") throw err("limrun has no view-only link: the signed stream URL also controls the device; ask for mode \"control\"");
    const inst = await this.refresh().catch((e) => {
      throw wrap(e);
    });
    const url = inst.status.signedStreamUrl;
    if (!url) throw err(`instance ${this.nativeId} has no stream URL (state: ${inst.status.state}; a read-only key gets none)`);
    return { url, expiresAt: null };
  }

  // No sleep(): Limrun documents no pause; an idle device is deleted after its inactivity timeout.

  async delete(): Promise<void> {
    const dev = this.dev;
    this.dev = undefined;
    if (dev) await dev.then((d) => d.c.disconnect()).catch(() => {});
    try {
      await this.api().delete(this.nativeId);
    } catch (e) {
      if (!isNotFound(e)) throw wrap(e);
    }
  }
}

async function taps(d: Device, x: number, y: number, n: number) {
  if (d.os === "android") {
    // One shell line so the taps land close enough together to count as a double/triple tap.
    const r = await d.c.adbShell("sh", ["-c", Array(n).fill(`input tap ${x} ${y}`).join("; ")]);
    if (r.exitCode !== 0) throw new Error(`input tap failed: ${r.stderr || r.stdout}`);
  } else {
    await d.c.performActions(Array.from({ length: n }, () => ({ type: "tap" as const, x, y })));
  }
}

async function longPress(d: Device, x: number, y: number, ms: number) {
  await swipe(d, x, y, x, y, ms);
}

async function swipe(d: Device, x1: number, y1: number, x2: number, y2: number, ms: number) {
  ms = Math.max(1, Math.round(ms));
  if (d.os === "android") {
    const r = await d.c.adbShell("input", ["swipe", `${x1}`, `${y1}`, `${x2}`, `${y2}`, `${ms}`]);
    if (r.exitCode !== 0) throw new Error(`input swipe failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (x1 === x2 && y1 === y2) {
    await d.c.performActions([
      { type: "touchDown", x: x1, y: y1 },
      { type: "wait", durationMs: ms },
      { type: "touchUp", x: x1, y: y1 },
    ]);
    return;
  }
  const steps = 10;
  const moves = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return [
      { type: "wait" as const, durationMs: Math.round(ms / steps) },
      { type: "touchMove" as const, x: Math.round(x1 + (x2 - x1) * t), y: Math.round(y1 + (y2 - y1) * t) },
    ];
  }).flat();
  await d.c.performActions([{ type: "touchDown", x: x1, y: y1 }, ...moves, { type: "touchUp", x: x2, y: y2 }]);
}

interface KeyEntry {
  android?: string;
  ios?: string;
  iosButton?: string;
}

/** xdotool names (lowercased) to Limrun. Missing side = not available on that platform. */
const KEYS: Record<string, KeyEntry> = {
  return: { android: "ENTER", ios: "enter" },
  enter: { android: "ENTER", ios: "enter" },
  kp_enter: { android: "ENTER", ios: "enter" },
  backspace: { android: "DEL", ios: "backspace" },
  back_space: { android: "DEL", ios: "backspace" },
  delete: { android: "FORWARD_DEL", ios: "delete" },
  tab: { android: "TAB", ios: "tab" },
  escape: { android: "BACK", ios: "escape" },
  esc: { android: "BACK", ios: "escape" },
  back: { android: "BACK" },
  xf86back: { android: "BACK" },
  home: { android: "HOME", iosButton: "home" },
  super: { android: "HOME", iosButton: "home" },
  super_l: { android: "HOME", iosButton: "home" },
  xf86homepage: { android: "HOME", iosButton: "home" },
  up: { android: "DPAD_UP", ios: "up" },
  down: { android: "DPAD_DOWN", ios: "down" },
  left: { android: "DPAD_LEFT", ios: "left" },
  right: { android: "DPAD_RIGHT", ios: "right" },
  space: { android: "SPACE", ios: "space" },
  xf86audioraisevolume: { android: "VOLUME_UP", iosButton: "volumeUp" },
  volumeup: { android: "VOLUME_UP", iosButton: "volumeUp" },
  volume_up: { android: "VOLUME_UP", iosButton: "volumeUp" },
  xf86audiolowervolume: { android: "VOLUME_DOWN", iosButton: "volumeDown" },
  volumedown: { android: "VOLUME_DOWN", iosButton: "volumeDown" },
  volume_down: { android: "VOLUME_DOWN", iosButton: "volumeDown" },
  xf86audiomute: { android: "VOLUME_MUTE" },
  power: { android: "POWER", iosButton: "lock" },
  xf86poweroff: { android: "POWER", iosButton: "lock" },
  lock: { android: "POWER", iosButton: "lock" },
  menu: { android: "MENU" },
};

const MODIFIERS: Record<string, { android: string; ios: string }> = {
  ctrl: { android: "ctrl", ios: "control" },
  control: { android: "ctrl", ios: "control" },
  control_l: { android: "ctrl", ios: "control" },
  control_r: { android: "ctrl", ios: "control" },
  shift: { android: "shift", ios: "shift" },
  shift_l: { android: "shift", ios: "shift" },
  shift_r: { android: "shift", ios: "shift" },
  alt: { android: "alt", ios: "alt" },
  alt_l: { android: "alt", ios: "alt" },
  option: { android: "alt", ios: "alt" },
  super: { android: "meta", ios: "command" },
  meta: { android: "meta", ios: "command" },
  cmd: { android: "meta", ios: "command" },
  command: { android: "meta", ios: "command" },
};

/** @internal "ctrl+Return" on android -> { key: "ENTER", modifiers: ["ctrl"] }. Throws if unavailable. */
export function limrunKey(chord: string, os: "android" | "ios"): { key: string; modifiers: string[]; button?: string } {
  const parts = chord.split("+").filter(Boolean);
  if (parts.length === 0) throw new Error(`empty key "${chord}"`);
  const name = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) throw new Error(`unknown modifier "${m}" in "${chord}"`);
    return mod[os];
  });
  const lower = name.toLowerCase();
  const e = KEYS[lower];
  if (os === "android") {
    if (e) {
      if (!e.android) throw new Error(`key "${name}" has no Android equivalent`);
      return { key: e.android, modifiers };
    }
    if (/^[0-9]$/.test(name)) return { key: `KEYCODE_${name}`, modifiers };
    return { key: name.length === 1 ? name : name.toUpperCase(), modifiers };
  }
  if (e) {
    if (e.iosButton) {
      if (modifiers.length) throw new Error(`the ${e.iosButton} button can't take modifiers`);
      return { key: lower, modifiers, button: e.iosButton };
    }
    if (!e.ios) throw new Error(`key "${name}" has no iOS equivalent${lower === "back" || lower === "xf86back" ? " (swipe from the left edge instead)" : ""}`);
    return { key: e.ios, modifiers };
  }
  return { key: name.length === 1 ? name : lower, modifiers };
}

/** Width and height from a PNG IHDR or a JPEG SOF marker. */
function imageSize(b64: string): { width?: number; height?: number } {
  const b = Buffer.from(b64.slice(0, 64 * 1024), "base64");
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return {};
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return {};
}

async function withTemp<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "limrun-"));
  try {
    return await fn(join(dir, "file"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// "limrun" isn't in the shared ProviderId union yet; the error carries the right name regardless.
function err(message: string, status?: number): ProviderError {
  return new ProviderError("limrun", message, status);
}

function wrap(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status = (e as { status?: unknown })?.status;
  return err((e as Error)?.message ?? String(e), typeof status === "number" ? status : undefined);
}

function isNotFound(e: unknown): boolean {
  return (e as { status?: unknown })?.status === 404;
}

function seconds(n: number): number {
  if (!(n >= 0 && n <= 100)) throw new Error("duration must be 0 to 100 seconds");
  return n;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
