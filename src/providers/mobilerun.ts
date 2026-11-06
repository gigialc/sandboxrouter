import { ProviderError, type ProviderId } from "../types.js";
import { dirname, optionalImport, toBytes } from "../util.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerInfo,
  ComputerOs,
  ComputerProvider,
  ComputerSpec,
  ProviderComputer,
} from "../computers.js";

type MobilerunModule = typeof import("@mobilerun/sdk");
type MobilerunClient = InstanceType<MobilerunModule["Mobilerun"]>;
type MobilerunDevice = Awaited<ReturnType<MobilerunClient["devices"]["retrieve"]>>;

/** Desktop-only provider: not in the sandbox ProviderId union. */
const ID = "mobilerun" as ProviderId;

/** Device names carry the router's user id, so the same user gets the same phone back. */
const USER_PREFIX = "sandboxrouter:";

/** How long create/connect wait for a phone to reach `ready`. */
const READY_DEADLINE_MS = 10 * 60_000;

/**
 * Mobilerun (droidrun) cloud Android phones via `@mobilerun/sdk`. Desktop-only: no sandboxes.
 *
 * createComputer provisions an `android_cloud_phone` (billing `auto`: plan minutes, then
 * $0.03/min overage on paid plans) and blocks on `devices.waitReady`. Input is touch: taps,
 * swipes, IME text and single Android key events. There is no pointer, so hover, right/middle
 * click, key chords and held keys come back as `{ ok: false }`.
 *
 * Not available here, by the API's design:
 * - exec: no command endpoint. adb shell exists only on request, over a WebSocket adb tunnel
 *   (docs.mobilerun.ai/integrations/adb), which needs a local adb binary.
 * - JPEG screenshots: the capture endpoint returns PNG only.
 *
 * Docs: https://docs.mobilerun.ai (API reference: /api-reference/navigation/*, /devices/*)
 */
export class MobilerunProvider implements ComputerProvider {
  readonly id = "mobilerun" as const;
  readonly computerOs: ComputerOs[] = ["android"];
  private client?: MobilerunClient;

  /** The SDK reads MOBILERUN_CLOUD_API_KEY itself; we read it too so configured() is honest. */
  constructor(
    private apiKey = process.env.MOBILERUN_CLOUD_API_KEY,
    private baseURL = process.env.MOBILERUN_BASE_URL,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal */
  async sdk(): Promise<MobilerunClient> {
    if (!this.apiKey) throw new ProviderError(ID, "MOBILERUN_CLOUD_API_KEY is not set");
    if (!this.client) {
      const { Mobilerun } = await optionalImport<MobilerunModule>("@mobilerun/sdk", "mobilerun");
      this.client = new Mobilerun({ apiKey: this.apiKey, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });
    }
    return this.client;
  }

  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    const os = spec.os ?? "android";
    if (os !== "android") throw new ProviderError(ID, `no ${os} computers (Android cloud phones only)`);
    const client = await this.sdk();
    const name = spec.externalUserId ? `${USER_PREFIX}${spec.externalUserId}` : spec.name;

    // Same user, same phone: reuse a live or parked device that carries their name.
    if (spec.externalUserId) {
      const existing = await guard(client.devices.list({ name, platform: "android", type: "android_cloud_phone" }));
      const mine = (existing.items ?? []).find((d) => d.name === name && d.state !== "terminated" && d.state !== "unknown");
      if (mine) {
        if (mine.state === "stopped") await guard(client.devices.resume(mine.id));
        return new MobilerunComputer(this, await waitReady(client, mine.id));
      }
    }

    const created = await guard(client.devices.create({ deviceType: "android_cloud_phone", billing: "auto", ...(name ? { name } : {}) }));
    const ready = created.state === "ready" ? created : await waitReady(client, created.id);
    return new MobilerunComputer(this, ready);
  }

  /** Re-attach by device id. A parked (stopped) phone is resumed and waited on. */
  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    const client = await this.sdk();
    const d = await guard(client.devices.retrieve(nativeId));
    if (d.state === "terminated") throw new ProviderError(ID, `device ${nativeId} is terminated`, 404);
    if (d.state === "stopped") await guard(client.devices.resume(nativeId));
    return new MobilerunComputer(this, d.state === "ready" ? d : await waitReady(client, nativeId));
  }
}

/**
 * The SDK's APIConnectionTimeoutError (its error classes don't set `name`, so the class name is
 * what identifies it), or a gateway timeout from the server-side wait.
 */
function isWaitTimeout(err: unknown): boolean {
  const e = err as { constructor?: { name?: string }; name?: string; status?: number } | undefined;
  return e?.constructor?.name === "APIConnectionTimeoutError" || e?.name === "APIConnectionTimeoutError" || e?.status === 408 || e?.status === 504;
}

/** Block until the device is ready; the server-side wait can time out, so retry until our deadline. */
async function waitReady(client: MobilerunClient, id: string): Promise<MobilerunDevice> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  for (;;) {
    try {
      return await client.devices.waitReady(id, { timeout: 120_000 });
    } catch (err) {
      if (!isWaitTimeout(err) || Date.now() > deadline) throw toProviderError(err, `device ${id} did not become ready`);
      const d = await guard(client.devices.retrieve(id));
      if (d.state === "ready") return d;
      if (d.state === "terminated") throw new ProviderError(ID, `device ${id} was terminated while starting: ${d.stateMessage}`);
    }
  }
}

function toProviderError(err: unknown, prefix?: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { message?: string; status?: number };
  const msg = e?.message ?? String(err);
  return new ProviderError(ID, prefix ? `${prefix}: ${msg}` : msg, typeof e?.status === "number" ? e.status : undefined);
}

/** Await an SDK call, rethrowing its errors as ProviderError. */
async function guard<T>(p: PromiseLike<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw toProviderError(err);
  }
}

/**
 * xdotool-style key names to Android KeyEvent codes, sent one at a time with
 * `devices.keyboard.key`. Back, Home and Recents become system navigation; Enter, BackSpace,
 * Delete and Tab are handled by Mobilerun's Portal through accessibility even without its IME.
 * Arrows, End and page keys need the Mobilerun keyboard (IME) to be the active input method.
 * Single letters and digits map to their KEYCODE_A..Z / KEYCODE_0..9.
 */
export const MOBILERUN_KEYS: Record<string, number> = {
  return: 66, // KEYCODE_ENTER
  enter: 66,
  kp_enter: 66,
  backspace: 67, // KEYCODE_DEL
  delete: 112, // KEYCODE_FORWARD_DEL
  kp_delete: 112,
  tab: 61,
  escape: 4, // KEYCODE_BACK: on a phone, Escape means "dismiss / go back"
  esc: 4,
  back: 4,
  xf86back: 4,
  home: 3, // KEYCODE_HOME: the home screen, not line start
  xf86homepage: 3,
  end: 123, // KEYCODE_MOVE_END
  up: 19, // KEYCODE_DPAD_UP
  down: 20,
  left: 21,
  right: 22,
  kp_up: 19,
  kp_down: 20,
  kp_left: 21,
  kp_right: 22,
  page_up: 92,
  prior: 92,
  page_down: 93,
  next: 93,
  space: 62,
  menu: 82,
  search: 84,
  xf86search: 84,
  recents: 187, // KEYCODE_APP_SWITCH
  app_switch: 187,
  power: 26,
  xf86poweroff: 26,
  xf86audioraisevolume: 24,
  xf86audiolowervolume: 25,
  xf86audiomute: 164,
};

/** One xdotool key name (no modifiers) to an Android key code. */
export function mobilerunKey(name: string): number {
  const k = name.trim();
  if (k.includes("+") && k.length > 1) {
    throw new Error(`mobilerun sends one Android key at a time; "${k}" is a chord (modifiers are not supported)`);
  }
  const code = MOBILERUN_KEYS[k.toLowerCase()];
  if (code !== undefined) return code;
  if (/^[a-zA-Z]$/.test(k)) return 29 + (k.toLowerCase().charCodeAt(0) - 97); // KEYCODE_A = 29
  if (/^[0-9]$/.test(k)) return 7 + Number(k); // KEYCODE_0 = 7
  throw new Error(`mobilerun has no Android key for "${k}" (use type for text)`);
}

/** Width and height from a PNG's IHDR. */
function pngSize(b: Uint8Array): { width?: number; height?: number } {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return {};
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * Read a binary body. The API serves raw bytes (image/png, octet-stream); its OpenAPI spec also
 * describes a base64 JSON string, so accept that too.
 */
async function bytesOf(p: { asResponse(): Promise<Response> }): Promise<Uint8Array> {
  const res = await p.asResponse();
  const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (type.includes("json")) {
    const j = (await res.json()) as unknown;
    if (typeof j !== "string") throw new Error("expected a base64 string body");
    return new Uint8Array(Buffer.from(j.replace(/^data:[^,]*,/, ""), "base64"));
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Gestures take the canonical frame (the last screenshot), which is the phone's native pixels. */
class MobilerunComputer implements ProviderComputer {
  readonly nativeId: string;
  private frame = 0;
  private size?: { width: number; height: number };

  constructor(
    private p: MobilerunProvider,
    device: MobilerunDevice,
  ) {
    this.nativeId = device.id;
  }

  private sdk() {
    return this.p.sdk();
  }

  async info(): Promise<ComputerInfo> {
    const d = await guard((await this.sdk()).devices.retrieve(this.nativeId));
    const status = d.state === "ready" ? "ready" : d.state === "stopped" ? "sleeping" : d.state === "terminated" ? "deleted" : d.state;
    const info: ComputerInfo = {
      id: d.id,
      os: "android",
      status,
      externalUserId: d.name?.startsWith(USER_PREFIX) ? d.name.slice(USER_PREFIX.length) : null,
    };
    if (this.size) info.screen = { ...this.size };
    return info;
  }

  async act(a: ComputerAction): Promise<ActionResult> {
    try {
      const extra = await this.perform(a);
      if (a.noScreenshot) return { action: a.action, ok: true, ...extra };
      return { action: a.action, ok: true, ...extra, ...(await this.frameResult()) };
    } catch (err) {
      return { action: a.action, ok: false, error: (err as Error)?.message ?? String(err) };
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

  private async capture(): Promise<Uint8Array> {
    const client = await this.sdk();
    const png = await bytesOf(client.devices.screenshots.capture(this.nativeId, {}, { headers: { "Accept-Encoding": "identity" } }));
    if (!png.length) throw new Error("screenshot came back empty");
    const s = pngSize(png);
    if (s.width && s.height) this.size = { width: s.width, height: s.height };
    return png;
  }

  private async frameResult(): Promise<ActionResult> {
    const png = await this.capture();
    return { frameId: ++this.frame, imageB64: Buffer.from(png).toString("base64"), mime: "image/png", ...pngSize(png) };
  }

  private async screenSize(): Promise<{ width: number; height: number }> {
    if (!this.size) await this.capture();
    if (!this.size) throw new Error("could not read the screen size from a screenshot");
    return this.size;
  }

  private async perform(a: ComputerAction): Promise<Partial<ActionResult>> {
    const client = await this.sdk();
    const id = this.nativeId;
    switch (a.action) {
      case "screenshot":
        return {};
      case "left_click": {
        if (!a.coordinate) throw new Error("left_click needs coordinate (a phone has no cursor)");
        if (a.modifier) throw new Error("mobilerun taps can't hold modifier keys");
        const [x, y] = a.coordinate;
        await client.devices.actions.tap(id, { x: Math.round(x), y: Math.round(y) });
        return {};
      }
      case "left_click_drag": {
        if (!a.startCoordinate || !a.coordinate) throw new Error("left_click_drag needs startCoordinate and coordinate (a phone has no cursor)");
        const [sx, sy] = a.startCoordinate;
        const [ex, ey] = a.coordinate;
        await client.devices.actions.swipe(id, { startX: Math.round(sx), startY: Math.round(sy), endX: Math.round(ex), endY: Math.round(ey), duration: 600 });
        return {};
      }
      case "scroll": {
        if (!a.scrollDirection) throw new Error("scroll needs scrollDirection");
        const { width, height } = await this.screenSize();
        const [cx, cy] = a.coordinate ?? [width / 2, height / 2];
        const clicks = Math.min(10, Math.max(1, Math.round(a.scrollAmount ?? 3)));
        const vertical = a.scrollDirection === "up" || a.scrollDirection === "down";
        // One scroll click moves about 15% of the screen; the finger travels against the scroll direction.
        const span = (vertical ? height : width) * Math.min(0.8, 0.15 * clicks);
        const sign = a.scrollDirection === "down" || a.scrollDirection === "right" ? 1 : -1;
        const clampX = (v: number) => Math.round(Math.min(width - 2, Math.max(1, v)));
        const clampY = (v: number) => Math.round(Math.min(height - 2, Math.max(1, v)));
        const [sx, sy, ex, ey] = vertical
          ? [cx, cy + (sign * span) / 2, cx, cy - (sign * span) / 2]
          : [cx + (sign * span) / 2, cy, cx - (sign * span) / 2, cy];
        await client.devices.actions.swipe(id, { startX: clampX(sx), startY: clampY(sy), endX: clampX(ex), endY: clampY(ey), duration: 400 });
        return {};
      }
      case "type":
        if (!a.text) throw new Error("type needs text");
        await client.devices.keyboard.write(id, { text: a.text });
        return {};
      case "key": {
        if (!a.text) throw new Error("key needs text");
        // xdotool accepts several space-separated keys: "Down Down Return".
        const codes = a.text.trim().split(/\s+/).map(mobilerunKey);
        for (let n = 0; n < Math.max(1, a.repeat ?? 1); n++) {
          for (const key of codes) await client.devices.keyboard.key(id, { key });
        }
        return {};
      }
      case "wait":
        await sleep(seconds(a.duration ?? 1) * 1000);
        return {};
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click":
      case "mouse_move":
      case "left_mouse_down":
      case "left_mouse_up":
      case "cursor_position":
        throw new Error(`mobilerun does not support action "${a.action}": a touchscreen has no cursor or mouse buttons`);
      case "hold_key":
        throw new Error(`mobilerun does not support action "hold_key": keys are sent as single events`);
      case "zoom":
        throw new Error(`mobilerun does not support action "zoom": the API has no region capture`);
      default:
        throw new Error(`mobilerun does not support action "${(a as { action: string }).action}"`);
    }
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    if (opts.format === "jpeg") throw new ProviderError(ID, "screenshots are PNG only");
    try {
      return await this.capture();
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async exec(_command: string, _timeoutSeconds?: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    throw new ProviderError(
      ID,
      "no shell: the Mobilerun API has no command endpoint (adb shell is only available on request over the adb WebSocket tunnel, docs.mobilerun.ai/integrations/adb)",
    );
  }

  /** Pulls a file from a device path, e.g. /sdcard/Download/report.pdf. */
  async readFile(path: string): Promise<Uint8Array> {
    const client = await this.sdk();
    try {
      return await bytesOf(client.devices.files.download(this.nativeId, { path }, { headers: { "Accept-Encoding": "identity" } }));
    } catch (err) {
      throw toProviderError(err);
    }
  }

  /** The API uploads into a directory under the file's own name, so split the path. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name) throw new ProviderError(ID, `writeFile needs a file path, got directory "${path}"`);
    const client = await this.sdk();
    const { toFile } = await optionalImport<MobilerunModule>("@mobilerun/sdk", "mobilerun");
    const file = await toFile(Buffer.from(toBytes(content)), name);
    await guard(client.devices.files.upload(this.nativeId, { path: dirname(path), file }));
  }

  /**
   * The device's WebRTC stream: `url` is the device's streamUrl and `token` its device-scoped
   * streamToken, for `@mobilerun/react`'s DeviceStream (it is not a page a browser opens on its
   * own). The credentials always carry control; `watch` is honoured only by the embedding UI
   * (DeviceStream hasControl={false}). Mobilerun does not publish an expiry, so expiresAt is null.
   */
  async viewer(mode: "watch" | "control" = "watch", _opts: { ttlSeconds?: number; reason?: string } = {}) {
    const d = await guard((await this.sdk()).devices.retrieve(this.nativeId));
    if (!d.streamUrl || !d.streamToken) throw new ProviderError(ID, `no live stream for device ${this.nativeId} (state: ${d.state})`);
    return {
      url: d.streamUrl,
      token: d.streamToken,
      viewOnlyEnforced: false,
      client: "@mobilerun/react DeviceStream",
      expiresAt: null,
    };
  }

  /** Park: apps, data and identity kept, no minutes billed. connectComputer resumes it. 404 where capabilities.stop is false. */
  async sleep(): Promise<void> {
    await guard((await this.sdk()).devices.stop(this.nativeId));
  }

  /** Terminate and release. Subscription-billed (dedicated) phones refuse this with 401. */
  async delete(): Promise<void> {
    await guard((await this.sdk()).devices.terminate(this.nativeId));
  }
}

function seconds(n: number): number {
  if (!(n >= 0 && n <= 100)) throw new Error("duration must be 0 to 100 seconds");
  return n;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms).unref());
}
