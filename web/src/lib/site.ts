import data from "@/data/site.json";

export type Shape = string; // "2x4" = 2 vCPU, 4 GB

export interface SiteProvider {
  id: string;
  name: string;
  capabilities: string[];
  limits: { maxVcpu: number; maxMemoryGb: number };
  credentials: string[][];
  docs: string;
  local?: boolean;
  pricing: { vcpuHour: number; gbHour: number; perSandboxUsd?: number; conditionalStartFee?: { minUsd: number; maxUsd: number; source: string }; minSeconds?: number; note?: string; source: string; checked: string };
  /** Set when you can't just sign up: "waitlist" (invite or beta only) or "closed" (no new accounts). */
  access: null | { status: "waitlist" | "closed"; note: string; checked: string };
  /** "active-cpu": CPU billed only while busy, so the listed price is the most an hour costs. */
  billing: "allocated" | "active-cpu";
  /** The monthly plan needed before the API creates sandboxes; null when a free tier or pay-as-you-go works. */
  plan: null | { usdMonth: number; credited: boolean; unclear?: boolean; note: string; checked: string };
  planLabel: string;
  /** Set when the provider's terms forbid publishing benchmarks: no speed, size or bill data is shown. */
  noBenchmarks: null | { clause: string; source: string; checked: string };
  /** The size the provider's default image gives whatever is asked for; bigger requests need a custom image. */
  defaultSize: null | { vcpu: number; memoryGb: number };
  /** Last real-account run: passed, failing, or untested (mock-tested only). */
  live: { status: "passed" | "failing" | "untested"; label: string };
  /** What the provider really billed / the list-price prediction, from a saved cost run; the router ranks by list price x this. */
  billedVsList: null | { ratio: number; date: string };
  computers: string[];
  prices: Record<Shape, { usd: number; unfit: string | null }>;
  /** The last saved real-account `check` run, or null when none has been saved. */
  check: null | {
    date: string;
    version: string;
    by: string | null;
    passed: number;
    failed: { step: string; detail?: string }[];
    skipped: string[];
    notRun: string[];
    notes: { step: string; detail?: string }[];
    steps: Record<string, "pass" | "fail" | "skip" | "info" | "not run">;
  };
}

export interface LeaderRow {
  provider: string;
  name: string;
  submissions: number;
  medianCreateMs?: number;
  medianExecMs?: number;
  medianReadyMs?: number;
  successRate: number;
  runs: number;
  hourlyUsd: number;
  size: { vcpu: number; memoryGb: number };
  measuredAt: string;
}

export interface TaskRow {
  provider: string;
  name: string;
  size: { vcpu: number; memoryGb: number };
  createMs: number;
  taskMs: number;
  phasesMs: Record<string, number>;
  hourlyUsd: number;
  taskUsd: number;
  reusedUsd: number;
  runs: number;
  ok: number;
  limited: number;
  successRate: number;
  cpuMs?: number;
  activeCpu: boolean;
  minimumSeconds: number;
  perSandboxUsd: number;
  measuredAt: string;
}

export interface IndexLine {
  id: string;
  label: string;
  unit: string;
  median: number;
  cheapest: { provider: string; name: string; usd: number };
  providers: number;
}

export interface LoadRow {
  provider: string;
  name: string;
  n: number;
  ok: number;
  limited: number;
  size?: { vcpu: number; memoryGb: number };
  createFailures?: number;
  commandFailures?: number;
  taskFailures?: number;
  cleanupFailures?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  wallMs: number;
  jobP50Ms?: number;
  usd?: number;
  measuredAt: string;
  label: string | null;
}

export interface AgentRow {
  provider: string;
  name: string;
  runs: number;
  requested?: number;
  started?: number;
  limited?: number;
  ok: number;
  medianWallMs?: number;
  medianModelMs?: number;
  medianCpuMs?: number;
  medianTurns?: number;
  medianUsd?: number;
  medianTokens?: number;
  measuredAt: string;
  model: string;
}

export interface UseCase {
  id: string;
  title: string;
  blurb: string;
  spec: { vcpu?: number; memoryGb?: number; expectedSeconds?: number; timeoutMinutes?: number; cpuUtilization?: number };
  require: string[];
  runSeconds: number;
  top: { provider: string; name: string; runUsd: number; runHourlyUsd: number; hourlyUsd: number; perSandboxUsd: number; minimumSeconds: number; ownImage?: boolean }[];
}

export interface CostRow {
  provider: string;
  name: string;
  date: string;
  minutes: number;
  load: boolean;
  by: string | null;
  requested: { vcpu: number; memoryGb: number };
  delivered: null | { vcpu: number; memoryGb: number };
  seconds: number | null;
  predictedUsd: number | null;
  billedUsd: number | null;
  billedSeconds: number | null;
  billSource: string | null;
  billKind: "provider-usage" | "provider-estimate" | null;
  billResolutionUsd: number | null;
  settledAt: string | null;
  file: string;
  error: string | null;
}

export interface HostedCostRow {
  provider: string;
  name: string;
  date: string;
  file: string;
  requested: { vcpu: number; memoryGb: number };
  size: { vcpu: number; memoryGb: number };
  expectedSeconds: number;
  runtimeSeconds: number;
  quoteUsd: number;
  quoteAtRecordedRuntimeUsd?: number;
  chargeUsd: number;
  balanceDeltaUsd: number;
  keySpendDeltaUsd?: number;
  minimumSeconds?: number;
  minimumCovers?: "all" | "memory";
  incrementSeconds?: number;
  feePct: number;
  checkedAt?: string;
  createMs?: number;
  commandMs?: number;
  belowQuotedCapRejected?: boolean;
  commandVerified: true;
  deleted: true;
}

export interface SiteDesktop {
  id: string;
  name: string;
  os: Partial<Record<"linux" | "windows" | "android" | "ios", number>>;
  note?: string;
  source: string;
  checked: string;
  takeover: boolean;
  size: string;
  planOnly?: string[];
  credentials: string[][];
  docs: string;
}

export const site = data as unknown as {
  version: string;
  generatedAt: string;
  shapes: Shape[];
  /** A spread run compared with recorded standalone runs in the same location at the same burst size. */
  scale: {
    date: string;
    n: number;
    ok: number;
    poolSize: number;
    wallMs: number;
    standaloneProviders: number;
    byProvider: { provider: string; name: string; ok: number; spilledIn: number }[];
    bestSingle: { provider: string; name: string; ok: number } | null;
  } | null;
  /** Provider id -> its icon under /logos/. */
  logos: Record<string, string>;
  providers: SiteProvider[];
  checkSteps: string[];
  desktops: SiteDesktop[];
  leaderboard: LeaderRow[];
  load: { id: string; n: number; job: string; title: string; blurb: string; rows: LoadRow[] }[];
  agent: AgentRow[];
  priceIndex: { lines: IndexLine[]; history: { date: string; lines: Record<string, { median: number; cheapest: number; provider: string }> }[] };
  tasks: { kinds: {
    id: string; title: string; blurb: string; version: string; repeat: number; phases: { id: string; label: string }[];
    rows: TaskRow[];
    outcomes: { provider: string; name: string; requested: number; completed: number; limited: number; failures: number; taskFailures: number }[];
  }[] };
  useCases: UseCase[];
  costRuns: CostRow[];
  hostedCosts: HostedCostRow[];
  submissions: { date: string; label: string | null; by: string | null; platform: string; runs: number; providers: number; ids: string[] }[];
};

export const REPO = "https://github.com/gigialc/sandboxrouter";
const deployedCommit = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
export const RESULTS_REF = /^[a-f0-9]{40}$/.test(deployedCommit) ? deployedCommit : "main";
/** The repo is public (since 2026-11-07). Set to false to hide GitHub links and "open a PR" wording, e.g. while a repo is private. */
export const REPO_PUBLIC = true;
/** The hosted key: one sandboxrouter API key, prepaid credit, sandboxes on sandboxrouter's own provider accounts. */
export const HOSTED_URL = "https://api.sandboxrouter.ai";
export const HOSTED_FEE_PCT = 5.5;
/** Whether the site shows the hosted key (Get a key, pricing, dashboard, docs). Off until providers' accounts have auto-recharge. */
export const HOSTED_PUBLIC = true;
export const NPM_URL = "https://www.npmjs.com/package/@sandboxrouter/sdk";
export const NPM = "@sandboxrouter/sdk";
export const DEFAULT_SHAPE: Shape = "2x4";

export function shapeLabel(s: Shape) {
  const [v, m] = s.split("x");
  return `${v} vCPU · ${m} GB`;
}

export function usd(n: number) {
  if (n === 0) return "free";
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/**
 * What to show for a provider at a size it can't take. Providers whose default image is a fixed size
 * (E2B, OpenScale, Daytona) still get a price: the one at the size they really run.
 */
export function fixedPrice(p: SiteProvider, shape: Shape): null | { usd: number; size: string } {
  const unfit = p.prices[shape].unfit;
  if (!unfit || !p.defaultSize || !unfit.startsWith("default image")) return null;
  return { usd: p.prices[shape].usd, size: `${p.defaultSize.vcpu} vCPU · ${p.defaultSize.memoryGb} GB` };
}

export function provider(id: string) {
  return site.providers.find((p) => p.id === id);
}

/**
 * Same order as the library's listingOrder(): providers anyone can sign up for, cheapest first, ties
 * alphabetical; then waitlisted or closed sign-ups; then ones that can't take the size; Docker last.
 */
export function ranked(shape: Shape = DEFAULT_SHAPE) {
  const rank = (p: SiteProvider) => (p.local ? 3 : p.prices[shape].unfit ? 2 : p.access ? 1 : 0);
  return [...site.providers].sort((a, b) => rank(a) - rank(b) || a.prices[shape].usd - b.prices[shape].usd || a.id.localeCompare(b.id));
}

export const CAPABILITY_LABEL: Record<string, string> = {
  pause: "Pause",
  ports: "Preview URLs",
  background: "Background commands",
  gpu: "GPU",
  "custom-image": "Custom image",
  computers: "Desktops",
};

export const PACKAGE: Record<string, string | null> = {
  maritime: null,
  docker: null,
  boat: null,
  exedev: null,
  cloudflare: null,
  e2b: "e2b",
  daytona: "@daytonaio/sdk",
  modal: "modal",
  vercel: "@vercel/sandbox",
  morph: "morphcloud",
  sprites: "@fly/sprites",
  blaxel: "@blaxel/core",
  tensorlake: "@tensorlakeai/tensorlake",
  runloop: "@runloop/api-client",
  hopx: "@hopx-ai/sdk",
  northflank: "@northflank/js-client",
  koyeb: null,
  freestyle: null,
  upstash: null,
  azure: null,
  digitalocean: null,
  google: "google-auth-library",
  agentcore: "@smithy/signature-v4 @aws-crypto/sha256-js @aws-sdk/credential-provider-node",
  lambda: "@smithy/signature-v4 @aws-crypto/sha256-js @aws-sdk/credential-provider-node",
  alibaba: "e2b",
  novita: "novita-sandbox",
  langsmith: "langsmith ws",
  beam: "@beamcloud/beam-js",
  codesandbox: "@codesandbox/sdk",
  deno: "@deno/sandbox",
  dedalus: null,
  agent37: null,
  openscale: "e2b",
  superserve: null,
  sail: null,
  instabox: null,
};
