import data from "@/data/site.json";

export type Shape = string; // "2x4" = 2 vCPU, 4 GB

export interface SiteProvider {
  id: string;
  name: string;
  order: number;
  capabilities: string[];
  limits: { maxVcpu: number; maxMemoryGb: number };
  credentials: string[][];
  docs: string;
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

export const site = data as unknown as {
  version: string;
  generatedAt: string;
  shapes: Shape[];
  providers: SiteProvider[];
  leaderboard: LeaderRow[];
  submissions: { date: string; label: string | null; platform: string; runs: number; providers: number }[];
};

export const REPO = "https://github.com/gigialc/sandboxrouter";
export const DEFAULT_SHAPE: Shape = "2x4";

export function shapeLabel(s: Shape) {
  const [v, m] = s.split("x");
  return `${v} vCPU · ${m} GB`;
}

export function usd(n: number) {
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export function provider(id: string) {
  return site.providers.find((p) => p.id === id);
}

export const cheapest = [...site.providers].sort((a, b) => a.prices[DEFAULT_SHAPE].usd - b.prices[DEFAULT_SHAPE].usd);

export const CAPABILITY_LABEL: Record<string, string> = {
  pause: "Pause / resume",
  gpu: "GPU",
  "custom-image": "Custom image",
  computers: "Desktops & phones",
};

export const PACKAGE: Record<string, string | null> = {
  maritime: null,
  e2b: "e2b",
  daytona: "@daytonaio/sdk",
  modal: "modal",
  vercel: "@vercel/sandbox",
  morph: "morphcloud",
  sprites: "@fly/sprites",
  blaxel: "@blaxel/core",
  tensorlake: "@tensorlakeai/tensorlake",
  runloop: "@runloop/api-client",
};
