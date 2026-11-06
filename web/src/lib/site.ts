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
  submissions: { date: string; label: string | null; platform: string; runs: number; providers: number }[];
};

export const REPO = "https://github.com/gigialc/sandboxrouter";
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

export function provider(id: string) {
  return site.providers.find((p) => p.id === id);
}

/** The router's own rule: cheapest first, ties alphabetical; local providers last (never auto-picked). */
export function ranked(shape: Shape = DEFAULT_SHAPE) {
  return [...site.providers].sort(
    (a, b) =>
      Number(!!a.local) - Number(!!b.local) ||
      Number(!!a.prices[shape].unfit) - Number(!!b.prices[shape].unfit) ||
      a.prices[shape].usd - b.prices[shape].usd ||
      a.id.localeCompare(b.id),
  );
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
  instabox: null,
};
