import { RouterError } from "./types.js";

/**
 * Computers: machines with a screen that a model drives with clicks and keys (computer use).
 * Linux and Windows desktops, Android phones. Routed like sandboxes: cheapest published price for
 * the requested OS first, ties alphabetical.
 */

/** Computer providers include sandbox providers (maritime, e2b, daytona) and desktop-only ones. */
export type ComputerProviderId = string;

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
  /**
   * A link for a person: `watch` is view-only, `control` hands them the desktop (logins, CAPTCHAs).
   * Optional: only on providers that offer a shareable live view. `expiresAt` may be null.
   */
  viewer?(mode?: "watch" | "control", opts?: { ttlSeconds?: number; reason?: string }): Promise<{ url: string; expiresAt: string | null }>;
  /** Optional: stop billing while keeping the computer, where the provider supports it. */
  sleep?(): Promise<void>;
  delete(): Promise<void>;
}

export interface ComputerProvider {
  readonly id: ComputerProviderId;
  readonly computerOs: ComputerOs[];
  configured(): boolean;
  createComputer(spec: ComputerSpec): Promise<ProviderComputer>;
  connectComputer(nativeId: string): Promise<ProviderComputer>;
}

export class RoutedComputer {
  readonly id: string;
  constructor(
    readonly provider: ComputerProviderId,
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
  /** What this computer's provider supports beyond the core actions. */
  get supports() {
    return { viewer: typeof this.c.viewer === "function", sleep: typeof this.c.sleep === "function" };
  }
  viewer(mode?: "watch" | "control", opts?: { ttlSeconds?: number; reason?: string }) {
    if (!this.c.viewer) throw new RouterError(`${this.provider} has no shareable live view`);
    return this.c.viewer(mode, opts);
  }
  async sleep() {
    if (!this.c.sleep) throw new RouterError(`${this.provider} can't sleep a computer; delete it instead`);
    await this.c.sleep();
  }
  delete() {
    return this.c.delete();
  }
}

/** Published prices per OS for every computer provider. Same rules as the sandbox catalog. */
export interface ComputerCatalogEntry {
  id: ComputerProviderId;
  name: string;
  /** USD per hour while awake, per OS offered. */
  os: Partial<Record<ComputerOs, number>>;
  note?: string;
  source: string;
  checked: string;
  /** A person can watch or take over the screen through a link. */
  takeover: boolean;
  credentials: string[][];
  docs: string;
}

export const COMPUTER_ENTRIES: ComputerCatalogEntry[] = [
  {
    id: "maritime",
    name: "Maritime",
    os: { linux: 0.12, windows: 0.18, android: 0.15 },
    note: "per second while awake; asleep pays $0.08/GB-month of disk; Windows needs the Growth plan",
    source: "https://maritime.sh/pricing",
    checked: "2026-11-04",
    takeover: true,
    credentials: [["MARITIME_API_KEY"]],
    docs: "https://maritime.sh/docs/computers",
  },
];

export function computerCatalog(): ComputerCatalogEntry[] {
  return [...COMPUTER_ENTRIES].sort((a, b) => a.name.localeCompare(b.name));
}

export function computerHourly(id: ComputerProviderId, os: ComputerOs): number | undefined {
  return COMPUTER_ENTRIES.find((e) => e.id === id)?.os[os];
}

export interface ComputerCandidate {
  provider: ComputerProviderId;
  estimatedHourlyUsd?: number;
  skip?: string;
}

/** The order a computer create would try, with the reason any provider is skipped. */
export function planComputer(providers: ComputerProvider[], os: ComputerOs = "linux", prefer?: ComputerProviderId[]): ComputerCandidate[] {
  const ids = prefer ?? providers.map((p) => p.id);
  const list = ids.map((id): ComputerCandidate => {
    const p = providers.find((x) => x.id === id);
    const c: ComputerCandidate = { provider: id, estimatedHourlyUsd: computerHourly(id, os) };
    if (!p) c.skip = "unknown provider";
    else if (!p.computerOs.includes(os)) c.skip = `no ${os} computers`;
    else if (!p.configured()) c.skip = "not configured";
    return c;
  });
  if (!prefer) {
    list.sort(
      (a, b) => (a.estimatedHourlyUsd ?? Infinity) - (b.estimatedHourlyUsd ?? Infinity) || a.provider.localeCompare(b.provider),
    );
  }
  return list;
}

/**
 * Start a computer on the cheapest provider that offers this OS and has credentials (ties
 * alphabetical), falling back down the list. An explicit `prefer` list keeps its order.
 */
export async function createComputer(providers: ComputerProvider[], spec: ComputerSpec = {}, prefer?: ComputerProviderId[]): Promise<RoutedComputer> {
  const os = spec.os ?? "linux";
  const usable = planComputer(providers, os, prefer)
    .filter((c) => !c.skip)
    .map((c) => providers.find((p) => p.id === c.provider)!);
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
