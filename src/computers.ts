import type { Ledger } from "./ledger.js";
import { ProviderError, RouterError, SetupError, type Attempt } from "./types.js";
import { SETUP_ERRORS, errorStatus, withDeadline } from "./util.js";

/**
 * Computers: machines with a screen that a model drives with clicks and keys (computer use).
 * Linux and Windows desktops, Android phones. Routed like sandboxes: cheapest published price for
 * the requested OS first, ties alphabetical.
 */

/** Computer providers include sandbox providers (maritime, e2b, daytona) and desktop-only ones. */
export type ComputerProviderId = string;

export type ComputerOs = "linux" | "windows" | "android" | "ios";

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
    /** Every create attempt, including failed fallbacks (empty for a handle from getComputer). */
    readonly attempts: Attempt[] = [],
    /** List price per hour for this OS, where the provider publishes one. */
    readonly estimatedHourlyUsd?: number,
    private ledger?: Ledger,
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
  /** Run a shell command (max 30 s). The second argument is `{ timeoutSeconds }`, or the number alone. */
  exec(command: string, opts?: number | { timeoutSeconds?: number }) {
    return this.c.exec(command, typeof opts === "number" ? opts : opts?.timeoutSeconds);
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
  async viewer(mode?: "watch" | "control", opts?: { ttlSeconds?: number; reason?: string }) {
    if (!this.c.viewer) throw new RouterError(`${this.provider} has no shareable live view`);
    return this.c.viewer(mode, opts);
  }
  async sleep() {
    if (!this.c.sleep) throw new RouterError(`${this.provider} can't sleep a computer; delete it instead`);
    await this.c.sleep();
  }
  /** Delete the computer and everything on it (its files and logins). */
  async delete(): Promise<void> {
    await this.c.delete();
    this.ledger?.close(this.id, "deleted");
  }

  /** Same as delete(), named like a sandbox's. */
  kill(): Promise<void> {
    return this.delete();
  }

  /** `await using pc = await router.computer(...)` deletes it when the block ends. */
  async [Symbol.asyncDispose]() {
    await this.delete();
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
  /** The machine you get by default, so prices compare like for like, e.g. "2 vCPU · 4 GB". */
  size: string;
  /** OSes offered only on a monthly plan, with no hourly price. Routed last for that OS. */
  planOnly?: ComputerOs[];
  credentials: string[][];
  docs: string;
}

export const COMPUTER_ENTRIES: ComputerCatalogEntry[] = [
  {
    id: "maritime",
    name: "Maritime",
    os: { linux: 0.12, windows: 0.18, android: 0.15 },
    note: "per second while awake; Starter $20/mo includes $20 usage; asleep pays $0.08/GB-month of disk; Windows needs Growth $100/mo incl. $100 usage",
    source: "https://maritime.sh/pricing",
    checked: "2026-11-05",
    takeover: true,
    size: "2 vCPU · 4 GB",
    credentials: [["MARITIME_API_KEY"]],
    docs: "https://maritime.sh/docs/computers",
  },
  {
    id: "daytona",
    name: "Daytona",
    // (1 vCPU x $0.0504 + 1 GiB x $0.0162) per hour, billed per second; 3 GiB disk is inside the 5 GiB free
    os: { linux: 0.0666 },
    note: "per second while running; default container snapshot is 1 vCPU / 1 GiB / 3 GiB (daytona-small in daytona.io/docs/en/sandboxes), larger snapshots cost more; stopped keeps the disk ($0.000108/GiB-h past 5 GiB); live view is a signed noVNC preview URL, watch mode is client-side view-only; Windows needs a Tier 3 org, not routed",
    source: "https://www.daytona.io/pricing",
    checked: "2026-11-04",
    takeover: true,
    size: "1 vCPU · 1 GB",
    credentials: [["DAYTONA_API_KEY"]],
    docs: "https://www.daytona.io/docs/en/computer-use",
  },
  {
    id: "e2b",
    name: "E2B",
    // (8 vCPU x $0.000014 + 8 GiB x $0.0000045) per second x 3600
    os: { linux: 0.5328 },
    note: "per second while running; the public `desktop` template is 8 vCPU / 8 GiB (cpu_count=8, memory_mb=8192 in github.com/e2b-dev/desktop template/build_prod.py); live view is noVNC with a password in the URL, watch mode is client-side view-only; Hobby caps a session at 1 h, Pro at 24 h",
    source: "https://e2b.dev/pricing",
    checked: "2026-11-04",
    takeover: true,
    size: "8 vCPU · 8 GB",
    credentials: [["E2B_API_KEY"]],
    docs: "https://docs.e2b.dev/use-cases/computer-use",
  },
];

COMPUTER_ENTRIES.push({
  id: "orgo",
  name: "Orgo",
  os: { linux: 0.055 },
  planOnly: ["windows"],
  size: "2 vCPU · 8 GB",
  note: "Medium Linux by the hour from credit, billed per second; stopped pays only its 40 GB disk. Other sizes need a paid plan (Starter $29/mo). Windows is not hourly: Scale plan ($399/mo) or a $15/mo licence plus a Medium. The live view is a VNC websockify URL whose token is full control, for a noVNC client",
  source: "https://www.orgo.ai/pricing.md",
  checked: "2026-11-04",
  takeover: false,
  credentials: [["ORGO_API_KEY"]],
  docs: "https://docs.orgo.ai/api-reference/introduction",
});

COMPUTER_ENTRIES.push(
  {
    id: "mobilerun",
    name: "Mobilerun",
    os: { android: 1.8 },
    size: "Android cloud phone (virtual, EU)",
    note: "$0.03 per device minute past the plan allowance (Developer $20/mo incl. 600 min, Startup $99, Scaleup $299); Free has 60 min/month; stopped phones keep apps and data and bill no minutes; live view is a WebRTC stream for @mobilerun/react, always controllable; no shell",
    source: "https://mobilerun.ai/pricing",
    checked: "2026-11-04",
    takeover: true,
    credentials: [["MOBILERUN_CLOUD_API_KEY"]],
    docs: "https://docs.mobilerun.ai",
  },
  {
    id: "limrun",
    name: "Limrun",
    os: { android: 3.0, ios: 6.0 },
    size: "Android 15 phone emulator / iPhone simulator",
    note: "per-minute credits (Android 1/min, iOS 2/min); displayed hourly prices use paid overage $0.05/credit; optional no-subscription Trial overage $0.06/credit ($3.60/h Android, $7.20/h iOS); Trial 120 one-time credits, Entry $20/mo incl. 500, Individual $200/mo incl. 5,000; no pause, idle devices deleted at timeout; interactive stream; iOS has no shell",
    source: "https://limrun.com/pricing",
    checked: "2026-11-05",
    takeover: true,
    credentials: [["LIM_API_KEY"]],
    docs: "https://docs.limrun.com/docs/reference/sdk.md",
  },
);

COMPUTER_ENTRIES.push({
  id: "aws-workspaces",
  name: "AWS WorkSpaces (agent access)",
  // stream.standard.medium (AWS's own agent-access example size) + the $0.05/h MCP session fee, us-east-1
  os: { windows: 0.15, linux: 0.138 },
  size: "2 vCPU · 4 GB (stream.standard.medium)",
  note: "us-east-1, Always-On/On-Demand fleet you provision once (fleet + stack), plus $0.05/h MCP session fee (first 10 h per region per month free); Windows adds $6.42 per AI-agent user per month; watch link is truly view-only but a person can't take control; no shell or files",
  source: "https://aws.amazon.com/workspaces/applications/pricing/",
  checked: "2026-11-04",
  takeover: false,
  credentials: [["AWS_REGION", "WORKSPACES_AGENT_STACK", "WORKSPACES_AGENT_FLEET"]],
  docs: "https://docs.aws.amazon.com/appstream2/latest/developerguide/agent-access-mcp-server.html",
});

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

/** How a computer create is routed: the same knobs and rules as a sandbox's (see RouteOptions). */
export interface ComputerRoute {
  provider?: ComputerProviderId | ComputerProviderId[];
  /** true (default): move on when a provider is down or can't bill, stop on a setup error. "any": move on always. false: first only. */
  fallback?: boolean | "any";
  /** Seconds to wait for one provider before trying the next (default 120). */
  createTimeoutSeconds?: number;
  /** Seconds the whole create may take (default 240). */
  deadlineSeconds?: number;
}

const OS_LIST: readonly ComputerOs[] = ["linux", "windows", "android", "ios"];
const SPEC_FIELDS = ["os", "externalUserId", "name", "screen", "arch"] as const;
const ROUTE_FIELDS = ["provider", "fallback", "createTimeoutSeconds", "deadlineSeconds"] as const;

/** Split and check a POST /v1/computers body, like splitRequest does for sandboxes. */
export function splitComputerRequest(body: Record<string, unknown>): { spec: ComputerSpec; route: ComputerRoute } {
  const bad = (msg: string) => new RouterError(msg, [], "bad_request");
  const spec: Record<string, unknown> = {};
  const route: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    if ((SPEC_FIELDS as readonly string[]).includes(k)) spec[k] = v;
    else if ((ROUTE_FIELDS as readonly string[]).includes(k)) route[k] = v;
    else unknown.push(k);
  }
  if (unknown.length) throw bad(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}: a computer takes ${[...SPEC_FIELDS, ...ROUTE_FIELDS].join(", ")}`);
  if (spec.os !== undefined && !OS_LIST.includes(spec.os as ComputerOs)) throw bad(`os must be one of ${OS_LIST.join(", ")}`);
  for (const k of ["externalUserId", "name"] as const) if (spec[k] !== undefined && typeof spec[k] !== "string") throw bad(`${k} must be a string`);
  const screen = spec.screen as { width?: unknown; height?: unknown } | undefined;
  if (screen !== undefined && !(typeof screen === "object" && [screen.width, screen.height].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0))) {
    throw bad("screen must be { width, height } in pixels");
  }
  if (spec.arch !== undefined && spec.arch !== "x86_64" && spec.arch !== "arm64") throw bad('arch must be "x86_64" or "arm64"');
  for (const k of ["createTimeoutSeconds", "deadlineSeconds"] as const) {
    const v = route[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) throw bad(`${k} must be a positive number`);
  }
  if (route.fallback !== undefined && route.fallback !== true && route.fallback !== false && route.fallback !== "any") throw bad('fallback must be true, false or "any"');
  return { spec: spec as ComputerSpec, route: route as ComputerRoute };
}

/**
 * Start a computer on the cheapest provider that offers this OS and has credentials (ties
 * alphabetical), falling back down the list like a sandbox create: on to the next when a provider is
 * down, slow or can't bill, but stopping on a setup error (a bad key or request). An explicit
 * provider list keeps its order. Each computer goes in the ledger, so `ls` and `gc --all` find it;
 * computers have no lifetime of their own, so plain `gc` leaves them.
 */
export async function createComputer(
  providers: ComputerProvider[],
  spec: ComputerSpec = {},
  prefer?: ComputerProviderId[],
  route: ComputerRoute & { ledger?: Ledger } = {},
): Promise<RoutedComputer> {
  const os = spec.os ?? "linux";
  const plan = planComputer(providers, os, prefer);
  const usable = plan.filter((c) => !c.skip);
  if (usable.length === 0) {
    const offering = providers.filter((p) => p.computerOs.includes(os)).map((p) => p.id);
    throw new RouterError(
      offering.length ? `no configured provider for a ${os} computer (offered by: ${offering.join(", ")})` : `no provider offers a ${os} computer`,
      [],
      "no_provider",
    );
  }
  if (prefer && route.fallback === false && plan[0].skip) {
    throw new RouterError(`${plan[0].provider} can't start this computer: ${plan[0].skip}`, [], "no_provider");
  }
  const tries = route.fallback === false ? usable.slice(0, 1) : usable;
  const limitS = route.createTimeoutSeconds ?? DEFAULT_COMPUTER_TIMEOUT_S;
  const deadline = Date.now() + (route.deadlineSeconds ?? DEFAULT_COMPUTER_DEADLINE_S) * 1000;
  const attempts: Attempt[] = [];
  for (const c of tries) {
    const left = deadline - Date.now();
    if (left <= 0) throw new RouterError(`computer create ran out of time: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`, attempts, "timeout");
    const p = providers.find((x) => x.id === c.provider)!;
    const t0 = Date.now();
    const pending = p.createComputer({ ...spec, os });
    const waitS = Math.min(limitS, left / 1000);
    let timedOut = false;
    try {
      const made = await withDeadline(pending, waitS * 1000, () => {
        timedOut = true;
        return new ProviderError(p.id, `create timed out after ${Number(waitS.toFixed(1))}s`);
      });
      attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0 });
      const pc = new RoutedComputer(p.id, made, attempts, c.estimatedHourlyUsd, route.ledger);
      record(route.ledger, pc);
      return pc;
    } catch (err) {
      // One that turns up after we gave up is deleted, so it can't bill unseen (or left in the ledger for gc).
      if (timedOut) {
        pending.then((late) => {
          const pc = new RoutedComputer(p.id, late, [], c.estimatedHourlyUsd, route.ledger);
          record(route.ledger, pc);
          return pc.delete();
        }).catch(() => {});
      }
      const status = errorStatus(err);
      attempts.push({ provider: p.id, ok: false, ms: Date.now() - t0, error: (err as Error).message, ...(status ? { status } : {}) });
      const setup = err instanceof SetupError || (status !== undefined && SETUP_ERRORS.has(status));
      if (route.fallback !== "any" && setup) {
        throw new RouterError(
          `${(err as Error).message.replace(/[.\s]+$/, "")}. This looks like a setup problem with ${p.id} (key or request), so the router stopped instead of moving to another provider; pass fallback: "any" to fall back on every error`,
          attempts,
          "setup",
        );
      }
    }
  }
  throw new RouterError(`all computer providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`, attempts, "all_failed");
}

/** Computers keep running until deleted: the ledger gives them no lifetime, so only `gc --all` takes them. */
const NO_LIFETIME = "9999-12-31T00:00:00.000Z";

function record(ledger: Ledger | undefined, pc: RoutedComputer) {
  ledger?.open({
    id: pc.id,
    provider: pc.provider,
    kind: "computer",
    createdAt: new Date().toISOString(),
    expiresAt: NO_LIFETIME,
    usdHour: pc.estimatedHourlyUsd ?? 0,
  });
}

/** Seconds to wait for one provider's computer before trying the next. */
export const DEFAULT_COMPUTER_TIMEOUT_S = 120;
/** Seconds a whole computer create may take. */
export const DEFAULT_COMPUTER_DEADLINE_S = 240;
