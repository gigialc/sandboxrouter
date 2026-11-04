import { randomUUID } from "node:crypto";
import { ProviderError, type ProviderId } from "../types.js";
import { toBytes } from "../util.js";
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
 * Orgo (orgo.ai): hosted Linux and Windows desktops, over plain REST (no SDK needed).
 * Base https://www.orgo.ai/api, `Authorization: Bearer sk_live_...`, snake_case JSON.
 *   POST   /computers                      create (returns once running); needs a workspace_id
 *   GET    /computers/{id}                 status, resolution, project_id (= workspace)
 *   GET    /computers/{id}/screenshot      ?response_format=base64|binary&format=png|jpeg
 *   POST   /computers/{id}/click|mouse-move|drag|type|key|scroll|wait|bash
 *   POST   /computers/{id}/stop|start|resume
 *   GET    /computers/{id}/vnc-password    the per-computer VNC token (root on that computer)
 *   POST   /files/upload (multipart, destPath)  /  POST /files/export -> signed url
 *   DELETE /computers/{id}
 * Docs: https://docs.orgo.ai/api-reference/introduction, spec https://docs.orgo.ai/api-reference/openapi.json
 */

// ProviderId in types.ts is the sandbox-provider union; computer-only providers are plain strings.
const ID = "orgo" as ProviderId;

/** Medium: 2 vCPU, 8 GB, 40 GB disk. The only size a free account can run, the dashboard default, and Windows needs 8 GB. */
const MEDIUM = { cpu: 2, ram: 8, disk_size_gb: 40 } as const;
/** POST /files/upload caps a file at 10 MB. */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

type Json = Record<string, any>;

export class OrgoProvider implements ComputerProvider {
  readonly id = "orgo" as const;
  /**
   * Linux on every account. Windows is created with `os: "windows"` but needs a Scale plan or a
   * purchased Windows licence (else 403 WINDOWS_REQUIRES_SCALE) and is never offered by the hour.
   * Android, macOS and iPhone are devices set up on request, not self-serve.
   */
  readonly computerOs: ComputerOs[] = ["linux", "windows"];
  private workspace?: Promise<string>;

  constructor(
    private apiKey = process.env.ORGO_API_KEY,
    private baseUrl = process.env.ORGO_API_URL ?? "https://www.orgo.ai/api",
    /** Workspace to create computers in. Unset: the first workspace this key can write to. */
    private workspaceId = process.env.ORGO_WORKSPACE_ID,
  ) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  configured(): boolean {
    return !!this.apiKey;
  }

  /** @internal Authenticated call to the Orgo API. Throws ProviderError with the HTTP status. */
  async request(method: string, path: string, init: { json?: unknown; form?: FormData; query?: Record<string, string> } = {}): Promise<Response> {
    if (!this.apiKey) throw new ProviderError(ID, "ORGO_API_KEY is not set");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    const q = init.query ? `?${new URLSearchParams(init.query)}` : "";
    const res = await fetch(`${this.baseUrl}${path}${q}`, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 300);
      try {
        // Every failure carries {error}; most add a machine-readable {code}.
        const j = JSON.parse(text);
        if (typeof j?.error === "string") detail = j.code ? `${j.code}: ${j.error}` : j.error;
      } catch {
        /* non-JSON body */
      }
      throw new ProviderError(ID, `${method} ${path} -> ${res.status} ${detail}`, res.status);
    }
    return res;
  }

  /** @internal */
  async json<T = Json>(method: string, path: string, init: { json?: unknown; form?: FormData; query?: Record<string, string> } = {}): Promise<T> {
    const text = await (await this.request(method, path, init)).text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** @internal The workspace new computers go in: ORGO_WORKSPACE_ID, else the first one the key can write to. */
  resolveWorkspace(): Promise<string> {
    if (this.workspaceId) return Promise.resolve(this.workspaceId);
    this.workspace ??= (async () => {
      // Owned workspaces come first. An account with none gets one made on this call.
      const r = await this.json<{ workspaces?: Json[] }>("GET", "/workspaces");
      const ws = (r.workspaces ?? []).find((w) => w?.permissions?.canWrite !== false);
      if (!ws?.id) throw new ProviderError(ID, "no Orgo workspace this key can create computers in; set ORGO_WORKSPACE_ID");
      return String(ws.id);
    })();
    this.workspace.catch(() => (this.workspace = undefined));
    return this.workspace;
  }

  async createComputer(spec: ComputerSpec): Promise<ProviderComputer> {
    const os = spec.os ?? "linux";
    if (!this.computerOs.includes(os)) throw new ProviderError(ID, `no ${os} computers (Orgo self-serve is Linux and Windows)`);
    const body: Json = { workspace_id: await this.resolveWorkspace(), name: computerName(spec), os, ...MEDIUM };
    if (spec.screen) {
      if (os !== "linux") throw new ProviderError(ID, "screen size is Linux only");
      const { width, height } = spec.screen;
      if (!(width >= 640 && width <= 1920 && height >= 640 && height <= 1920)) {
        throw new ProviderError(ID, `screen ${width}x${height} is outside 640-1920 per side`);
      }
      body.resolution = `${Math.round(width)}x${Math.round(height)}x24`;
    }
    // Orgo has no metadata field, so externalUserId only shapes the (workspace-unique) name.
    // Each create makes a new computer; reconnect with connectComputer(id) to keep files and logins.
    const c = await this.json("POST", "/computers", { json: body });
    return new OrgoComputer(this, c, spec.externalUserId ?? null);
  }

  /** Reattach to a computer. A stopped (frozen) one is started, a suspended one resumed. */
  async connectComputer(nativeId: string): Promise<ProviderComputer> {
    const path = `/computers/${encodeURIComponent(nativeId)}`;
    let c = await this.json("GET", path);
    if (c.status === "frozen" || c.status === "stopped") {
      await this.json("POST", `${path}/start`);
      c = await this.json("GET", path);
    } else if (c.status === "suspended") {
      await this.json("POST", `${path}/resume`);
      c = await this.json("GET", path);
    }
    return new OrgoComputer(this, c, null);
  }

  /** @internal wss:// origin for the computer's VNC WebSocket (same host as the API). */
  wsOrigin(): string {
    const u = new URL(this.baseUrl);
    return `${u.protocol === "http:" ? "ws:" : "wss:"}//${u.host}`;
  }
}

/** A name unique within the workspace (80 chars max): spec.name as given, else from externalUserId. */
function computerName(spec: ComputerSpec): string {
  if (spec.name) return spec.name.slice(0, 80);
  const base = (spec.externalUserId ?? "computer").replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 60);
  return `${base}-${randomUUID().slice(0, 8)}`;
}

const BUTTON: Partial<Record<ComputerAction["action"], Json>> = {
  left_click: { button: "left" },
  right_click: { button: "right" },
  middle_click: { button: "middle" },
  double_click: { button: "left", double: true },
  triple_click: { button: "left", repeat: 3 },
};

const MODIFIERS = new Set(["ctrl", "control", "alt", "option", "shift", "super", "cmd", "meta", "win"]);

/** "ctrl+shift" -> ["ctrl", "shift"], in the names /click accepts. */
function clickModifiers(m: string): string[] {
  const out = m
    .split("+")
    .map((k) => k.trim().toLowerCase().replace(/_[lr]$/, ""))
    .filter(Boolean);
  for (const k of out) if (!MODIFIERS.has(k)) throw new Error(`orgo can't hold modifier "${k}" during a click`);
  if (out.length > 4) throw new Error("orgo holds at most 4 modifiers during a click");
  return out;
}

function point(c: [number, number] | undefined, what: string): { x: number; y: number } {
  if (!c) throw new Error(`${what} needs coordinate (orgo can't read the pointer position)`);
  const [x, y] = c.map((n) => Math.round(n));
  if (!(x >= 0 && y >= 0)) throw new Error(`${what} coordinate must be non-negative`);
  return { x, y };
}

/** An Orgo desktop. Coordinates are real screen pixels (screenshots are full size). */
class OrgoComputer implements ProviderComputer {
  readonly nativeId: string;
  private base: string;
  private os: ComputerOs;
  private workspaceId?: string;
  private resolution?: string;
  private frame = 0;

  constructor(
    private p: OrgoProvider,
    c: Json,
    private externalUserId: string | null,
  ) {
    this.nativeId = String(c.id);
    this.base = `/computers/${encodeURIComponent(this.nativeId)}`;
    this.os = c.os === "windows" ? "windows" : "linux";
    this.remember(c);
  }

  private remember(c: Json) {
    this.workspaceId = c.workspace_id ?? c.project_id ?? this.workspaceId;
    this.resolution = c.resolution ?? c.instance_details?.resolution ?? this.resolution;
  }

  async info(): Promise<ComputerInfo> {
    const c = await this.p.json("GET", this.base);
    this.remember(c);
    const s = String(c.status ?? "unknown");
    const status = s === "running" ? "ready" : ["frozen", "stopped", "suspended"].includes(s) ? "sleeping" : s;
    const info: ComputerInfo = { id: this.nativeId, os: this.os, status, externalUserId: this.externalUserId };
    const m = /^(\d+)x(\d+)/.exec(this.resolution ?? "");
    if (m) info.screen = { width: Number(m[1]), height: Number(m[2]) };
    return info;
  }

  async act(a: ComputerAction): Promise<ActionResult> {
    try {
      await this.perform(a);
      if (a.noScreenshot && a.action !== "screenshot") return { action: a.action, ok: true };
      return { action: a.action, ok: true, ...(await this.frameResult()) };
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

  private async frameResult(): Promise<ActionResult> {
    const s = await this.p.json("GET", `${this.base}/screenshot`, { query: { response_format: "base64", format: "png" } });
    if (!s.image) throw new Error("screenshot came back empty");
    return { frameId: ++this.frame, imageB64: s.image, mime: s.mime_type ?? "image/png", width: s.width, height: s.height };
  }

  private post(endpoint: string, json: unknown) {
    return this.p.json("POST", `${this.base}/${endpoint}`, { json });
  }

  /** One canonical action to Orgo calls. Throws on anything Orgo has no endpoint for. */
  private async perform(a: ComputerAction): Promise<void> {
    const click = BUTTON[a.action];
    if (click) {
      const body: Json = { ...point(a.coordinate, a.action), ...click };
      if (a.modifier) {
        // /click refuses modifiers with double or repeat > 1.
        if (click.double || click.repeat) throw new Error(`orgo can't hold a modifier during ${a.action}`);
        body.modifiers = clickModifiers(a.modifier);
      }
      await this.post("click", body);
      return;
    }
    switch (a.action) {
      case "screenshot":
        return;
      case "mouse_move":
        await this.post("mouse-move", point(a.coordinate, a.action));
        return;
      case "left_click_drag": {
        if (a.modifier) throw new Error("orgo can't hold a modifier during a drag");
        // No pointer-position endpoint, so the start has to be given.
        const s = point(a.startCoordinate, "left_click_drag start (startCoordinate)");
        const e = point(a.coordinate, a.action);
        await this.post("drag", { start_x: s.x, start_y: s.y, end_x: e.x, end_y: e.y });
        return;
      }
      case "scroll": {
        const dir = a.scrollDirection;
        if (dir !== "up" && dir !== "down") throw new Error(`orgo scrolls up or down only, not ${dir ?? "(none)"}`);
        if (a.modifier) throw new Error("orgo can't hold a modifier during a scroll");
        const amount = Math.max(1, Math.round(a.scrollAmount ?? 3));
        await this.post("scroll", { ...point(a.coordinate, a.action), direction: dir, amount });
        return;
      }
      case "type":
        if (!a.text) throw new Error("type needs text");
        await this.post("type", { text: a.text });
        return;
      case "key": {
        if (!a.text) throw new Error("key needs text");
        // xdotool-style "ctrl+a Delete" is several chords; Orgo presses one per call (X keysym names).
        const chords = a.text.trim().split(/\s+/);
        for (let n = 0; n < Math.max(1, a.repeat ?? 1); n++) for (const key of chords) await this.post("key", { key });
        return;
      }
      case "wait": {
        const d = a.duration ?? 1;
        if (!(d >= 0 && d <= 100)) throw new Error("duration must be 0 to 100 seconds");
        if (this.os === "windows") {
          // Windows computers have no /wait endpoint.
          await new Promise<void>((r) => setTimeout(r, d * 1000).unref());
          return;
        }
        for (let left = d; left > 0; left -= 60) await this.post("wait", { seconds: Math.min(60, left) });
        return;
      }
      default:
        // left_mouse_down/up, hold_key, zoom, cursor_position: no Orgo endpoint.
        throw new Error(`orgo does not support action "${a.action}"`);
    }
  }

  async screenshot(opts: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    const query: Record<string, string> = { response_format: "binary", format: opts.format ?? "png" };
    if (opts.format === "jpeg" && opts.quality) query.quality = String(Math.min(100, Math.max(1, Math.round(opts.quality))));
    const res = await this.p.request("GET", `${this.base}/screenshot`, { query });
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Bash on Linux, PowerShell on Windows; timeout 1 to 300 s. Linux returns stdout and stderr
   * combined in `output`, so stderr is empty there. Windows returns them separately.
   */
  async exec(command: string, timeoutSeconds = 60) {
    const timeout = Math.min(300, Math.max(1, Math.round(timeoutSeconds)));
    const r = await this.post("bash", { command, timeout });
    return {
      exitCode: typeof r.exit_code === "number" ? r.exit_code : -1,
      stdout: String(r.stdout ?? r.output ?? ""),
      stderr: String(r.stderr ?? ""),
    };
  }

  /** Files API: export copies the file into workspace storage and signs a one-hour URL; the copy is then removed. */
  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.p.json("POST", "/files/export", { json: { desktopId: this.nativeId, path } });
    if (!r.url) throw new ProviderError(ID, `export of ${path} returned no download url`);
    try {
      const res = await fetch(r.url);
      if (!res.ok) throw new ProviderError(ID, `download of ${path} -> ${res.status}`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      if (r.file?.id) await this.p.request("DELETE", "/files/delete", { query: { id: String(r.file.id) } }).catch(() => {});
    }
  }

  /** Files API upload with destPath: placed straight into that folder on this computer, nothing stored. 10 MB max. */
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = toBytes(content);
    if (bytes.byteLength > UPLOAD_MAX_BYTES) throw new ProviderError(ID, `upload is capped at 10 MB (${bytes.byteLength} bytes)`);
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const name = path.slice(cut + 1);
    const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    if (!absolute || !name) throw new ProviderError(ID, `writeFile needs an absolute file path, got ${path}`);
    // The folder keeps the file's own name; "/x" -> "/", "C:\x" -> "C:\".
    let dir = cut === 0 ? "/" : path.slice(0, cut);
    if (/^[A-Za-z]:$/.test(dir)) dir += "\\";
    if (!this.workspaceId) this.remember(await this.p.json("GET", this.base));
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart]), name);
    form.append("desktopId", this.nativeId);
    form.append("destPath", dir);
    form.append("workspaceId", this.workspaceId ?? (await this.p.resolveWorkspace()));
    await this.p.request("POST", "/files/upload", { form });
  }

  /**
   * The documented embed URL: wss://www.orgo.ai/desktops/{id}/ws/websockify?token={vnc password},
   * for noVNC or any websockify VNC client (not a page a browser opens on its own). The token is the
   * computer's full VNC credential (also root on its terminal) and Orgo has no view-only token, so
   * only `control` is offered. It rotates on start/restart/RAM resize; no published expiry.
   */
  async viewer(mode: "watch" | "control" = "watch", _opts: { ttlSeconds?: number; reason?: string } = {}) {
    if (mode !== "control") {
      throw new ProviderError(ID, "orgo has no view-only link: its VNC token controls the computer. Ask for mode \"control\"");
    }
    const r = await this.p.json("GET", `${this.base}/vnc-password`);
    if (!r.password) throw new ProviderError(ID, "no VNC password for this computer (view-only access or a restricted key)");
    const url = `${this.p.wsOrigin()}/desktops/${encodeURIComponent(this.nativeId)}/ws/websockify?token=${encodeURIComponent(r.password)}`;
    return { url, expiresAt: null };
  }

  /**
   * Stop: the disk is archived and the computer kept (status `frozen`); by the hour it then pays
   * only for its disk. Memory is not kept. connectComputer starts it again.
   */
  async sleep(): Promise<void> {
    await this.p.request("POST", `${this.base}/stop`);
  }

  async delete(): Promise<void> {
    await this.p.request("DELETE", this.base);
  }
}
