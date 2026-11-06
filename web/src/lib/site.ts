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
  pricing: { vcpuHour: number; gbHour: number; note?: string; source: string; checked: string };
  /** Set when you can't just sign up: "waitlist" (invite or beta only) or "closed" (no new accounts). */
  access: null | { status: "waitlist" | "closed"; note: string; checked: string };
  /** "active-cpu": CPU billed only while busy, so the listed price is the most an hour costs. */
  billing: "allocated" | "active-cpu";
  /** The monthly plan needed before the API creates sandboxes; null when a free tier or pay-as-you-go works. */
  plan: null | { usdMonth: number; credited: boolean; unclear?: boolean; note: string; checked: string };
  planLabel: string;
  /** The size the provider's default image gives whatever is asked for; bigger requests need a custom image. */
  defaultSize: null | { vcpu: number; memoryGb: number };
  /** Last real-account run: passed, failing, or untested (mock-tested only). */
  live: { status: "passed" | "failing" | "untested"; label: string };
  computers: string[];
  prices: Record<Shape, { usd: number; unfit: string | null }>;
  /** The last saved real-account `check` run, or null when none has been saved. */
  check: null | {
    date: string;
    version: string;
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
  successRate: number;
  hourlyUsd: number;
  size: { vcpu: number; memoryGb: number };
}

export interface CostRow {
  provider: string;
  name: string;
  date: string;
  minutes: number;
  load: boolean;
  requested: { vcpu: number; memoryGb: number };
  delivered: null | { vcpu: number; memoryGb: number };
  seconds: number | null;
  predictedUsd: number | null;
  billedUsd: number | null;
  billedSeconds: number | null;
  billSource: string | null;
  error: string | null;
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
  providers: SiteProvider[];
  checkSteps: string[];
  desktops: SiteDesktop[];
  leaderboard: LeaderRow[];
  costRuns: CostRow[];
  submissions: { date: string; label: string | null; platform: string; runs: number; providers: number }[];
};

export const REPO = "https://github.com/gigialc/sandboxrouter";
/** The repo is private until launch. Flip this when it goes public, and the GitHub links come back. */
export const REPO_PUBLIC = false;
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
  if (!unfit || !p.defaultSize || !unfit.startsWith("default size")) return null;
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
