import { RouterError, type ProviderId } from "./types.js";

/**
 * Computers: machines with a screen that a model drives with clicks and keys (computer use).
 * Linux and Windows desktops, Android phones. Maritime is the first implementation.
 */

export type ComputerOs = "linux" | "windows" | "android";

export interface ComputerSpec {
  os?: ComputerOs;
  /** Your user's id. The same id returns the same computer (files and logins kept). */
  externalUserId?: string;
  name?: string;
  /** Linux only, each side 640 to 1920. */
  screen?: { width: number; height: number };
  /** Android only. */
  arch?: "x86_64" | "arm64";
}

export type ComputerActionName =
  | "screenshot"
  | "left_click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "triple_click"
  | "mouse_move"
  | "left_click_drag"
  | "left_mouse_down"
  | "left_mouse_up"
  | "scroll"
  | "type"
  | "key"
  | "hold_key"
  | "wait"
  | "zoom"
  | "cursor_position";

/** The canonical action (Anthropic computer-use shaped). Coordinates are in the last screenshot's frame. */
export interface ComputerAction {
  action: ComputerActionName;
  coordinate?: [number, number];
  startCoordinate?: [number, number];
  /** `type`: text to type. `key` / `hold_key`: an xdotool key name like "Return" or "ctrl+s". */
  text?: string;
  modifier?: string;
  repeat?: number;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
  region?: [number, number, number, number];
  noScreenshot?: boolean;
}

export interface ActionResult {
  action?: string;
  ok?: boolean;
  error?: string;
  frameId?: number;
  /** Post-action screenshot, base64. */
  imageB64?: string;
  mime?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface ComputerInfo {
  id: string;
  os: ComputerOs;
  status: string;
  screen?: { width: number; height: number; modelWidth?: number };
  externalUserId?: string | null;
}

export interface ProviderComputer {
  readonly nativeId: string;
  info(): Promise<ComputerInfo>;
  act(action: ComputerAction): Promise<ActionResult>;
  actBatch(actions: ComputerAction[]): Promise<ActionResult[]>;
  screenshot(opts?: { format?: "png" | "jpeg"; quality?: number }): Promise<Uint8Array>;
  exec(command: string, timeoutSeconds?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** A link for a person: `watch` is view-only, `control` hands them the desktop (logins, CAPTCHAs). */
  viewer(mode?: "watch" | "control", opts?: { ttlSeconds?: number; reason?: string }): Promise<{ url: string; expiresAt: string }>;
  sleep(): Promise<void>;
  delete(): Promise<void>;
}

export interface ComputerProvider {
  readonly id: ProviderId;
  readonly computerOs: ComputerOs[];
  configured(): boolean;
  createComputer(spec: ComputerSpec): Promise<ProviderComputer>;
  connectComputer(nativeId: string): Promise<ProviderComputer>;
}

export class RoutedComputer {
  readonly id: string;
  constructor(
    readonly provider: ProviderId,
    private c: ProviderComputer,
  ) {
    this.id = `${provider}:${c.nativeId}`;
  }
  get nativeId() {
    return this.c.nativeId;
  }
  info() {
    return this.c.info();
  }
  act(action: ComputerAction) {
    return this.c.act(action);
  }
  actBatch(actions: ComputerAction[]) {
    if (actions.length > 50) throw new RouterError("at most 50 actions per batch");
    return this.c.actBatch(actions);
  }
  screenshot(opts?: { format?: "png" | "jpeg"; quality?: number }) {
    return this.c.screenshot(opts);
  }
  exec(command: string, timeoutSeconds?: number) {
    return this.c.exec(command, timeoutSeconds);
  }
  readFile(path: string) {
    return this.c.readFile(path);
  }
  writeFile(path: string, content: string | Uint8Array) {
    return this.c.writeFile(path, content);
  }
  viewer(mode?: "watch" | "control", opts?: { ttlSeconds?: number; reason?: string }) {
    return this.c.viewer(mode, opts);
  }
  sleep() {
    return this.c.sleep();
  }
  delete() {
    return this.c.delete();
  }
}

/** Pick a computer provider that offers this OS and has credentials, in the given order. */
export async function createComputer(providers: ComputerProvider[], spec: ComputerSpec = {}, prefer?: ProviderId[]): Promise<RoutedComputer> {
  const os = spec.os ?? "linux";
  const ordered = prefer ? prefer.map((id) => providers.find((p) => p.id === id)).filter((p): p is ComputerProvider => !!p) : providers;
  const usable = ordered.filter((p) => p.computerOs.includes(os) && p.configured());
  if (usable.length === 0) {
    const offering = providers.filter((p) => p.computerOs.includes(os)).map((p) => p.id);
    throw new RouterError(
      offering.length ? `no configured provider for a ${os} computer (offered by: ${offering.join(", ")})` : `no provider offers a ${os} computer`,
    );
  }
  const errors: string[] = [];
  for (const p of usable) {
    try {
      return new RoutedComputer(p.id, await p.createComputer({ ...spec, os }));
    } catch (err) {
      errors.push(`${p.id}: ${(err as Error).message}`);
    }
  }
  throw new RouterError(`all computer providers failed: ${errors.join(" | ")}`);
}
