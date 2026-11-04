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
  computers: string[];
  prices: Record<Shape, { usd: number; unfit: string | null }>;
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
};
