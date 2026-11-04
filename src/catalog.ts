import type { Capability, ProviderId, SandboxSpec } from "./types.js";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** List price while running, USD. */
  pricing: { vcpuHour: number; gbHour: number; note?: string; source: string; checked: string };
  /** Capabilities this adapter actually implements, not everything the provider markets. */
  capabilities: Capability[];
  limits: { maxVcpu: number; maxMemoryGb: number };
  /** Runs on your own machine (Docker). Never chosen automatically; name it to use it. */
  local?: boolean;
  /** Env vars the adapter reads. Any one group being fully set means "configured". */
  credentials: string[][];
  docs: string;
}

/**
 * Every provider is treated the same: the router orders candidates by list price for the requested
 * size (or by your measured cold starts), ties broken alphabetically. Nobody gets a better slot.
 * Prices come from each provider's public pricing page; PRs that correct one are welcome.
 */
const ENTRIES: ProviderInfo[] = [
  {
    id: "docker",
    name: "Docker (local)",
    pricing: {
      vcpuHour: 0,
      gbHour: 0,
      note: "runs on your own machine; free, but shares your kernel, so weaker isolation than a cloud micro-VM",
      source: "https://docs.docker.com/engine/",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 64, maxMemoryGb: 256 },
    local: true,
    credentials: [],
    docs: "https://docs.docker.com/engine/",
  },
  {
    id: "maritime",
    name: "Maritime",
    pricing: {
      vcpuHour: 0.0055,
      gbHour: 0.00275,
      note: "per second, disk included",
      source: "https://maritime.sh/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 16, maxMemoryGb: 64 },
    credentials: [["MARITIME_API_KEY"]],
    docs: "https://maritime.sh/docs/ephemeral-sandboxes",
  },
  {
    id: "e2b",
    name: "E2B",
    pricing: {
      vcpuHour: 0.0504,
      gbHour: 0.0162,
      note: "per second; Pro plan $150/mo",
      source: "https://e2b.dev/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 8 },
    credentials: [["E2B_API_KEY"]],
    docs: "https://e2b.dev/docs",
  },
  {
    id: "daytona",
    name: "Daytona",
    pricing: {
      vcpuHour: 0.0504,
      gbHour: 0.0162,
      note: "per second, plus disk above 5 GiB",
      source: "https://www.daytona.io/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 4, maxMemoryGb: 8 },
    credentials: [["DAYTONA_API_KEY"]],
    docs: "https://www.daytona.io/docs",
  },
  {
    id: "modal",
    name: "Modal",
    pricing: {
      vcpuHour: 0.07096,
      gbHour: 0.0242,
      note: "sandbox rates, GPUs extra; region pinning x1.15-1.75",
      source: "https://modal.com/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["gpu", "custom-image"],
    limits: { maxVcpu: 64, maxMemoryGb: 256 },
    credentials: [["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]],
    docs: "https://modal.com/docs/guide/sandbox",
  },
  {
    id: "vercel",
    name: "Vercel Sandbox",
    pricing: {
      vcpuHour: 0.128,
      gbHour: 0.0212,
      note: "bills active CPU only; this is the 100%-CPU price, idle work costs less",
      source: "https://vercel.com/docs/vercel-sandbox/pricing",
      checked: "2026-11-04",
    },
    capabilities: [],
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    credentials: [["VERCEL_OIDC_TOKEN"], ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]],
    docs: "https://vercel.com/docs/vercel-sandbox",
  },
  {
    id: "morph",
    name: "Morph Cloud",
    pricing: {
      vcpuHour: 0.05,
      gbHour: 0,
      note: "$0.05/MCU; MCU-hours = max(vCPU, RAM/4 GB, disk/16 GB); snapshots extra",
      source: "https://cloud.morph.so/web/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 64, maxMemoryGb: 256 },
    credentials: [["MORPH_API_KEY"]],
    docs: "https://cloud.morph.so/docs/developers",
  },
  {
    id: "sprites",
    name: "Fly.io Sprites",
    pricing: {
      vcpuHour: 0.0385,
      gbHour: 0.021875,
      note: "bills actual CPU and memory use; this is the full-use price; storage extra",
      source: "https://fly.io/sprites",
      checked: "2026-11-04",
    },
    capabilities: [],
    // Not published per sprite; 8 GB is what accounts report getting by default.
    limits: { maxVcpu: 8, maxMemoryGb: 8 },
    credentials: [["SPRITES_TOKEN"]],
    docs: "https://fly.io/sprites",
  },
  {
    id: "blaxel",
    name: "Blaxel",
    pricing: {
      vcpuHour: 0,
      gbHour: 0.0414,
      note: "billed on memory only ($0.0000115/GB-s), CPU scales with memory (~2 GB per core)",
      source: "https://blaxel.ai/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    // Self-serve caps are per-tier and not published; these are conservative.
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    credentials: [["BL_API_KEY", "BL_WORKSPACE"]],
    docs: "https://docs.blaxel.ai/Sandboxes/Overview",
  },
  {
    id: "tensorlake",
    name: "Tensorlake",
    pricing: {
      vcpuHour: 0.07,
      gbHour: 0.015,
      note: "bills active CPU (floor 20% of allocation); this is the full-use price; Pro plan is lower",
      source: "https://www.tensorlake.ai/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 4, maxMemoryGb: 16 },
    credentials: [["TENSORLAKE_API_KEY"]],
    docs: "https://docs.tensorlake.ai/sandboxes",
  },
  {
    id: "runloop",
    name: "Runloop",
    pricing: {
      vcpuHour: 0.108,
      gbHour: 0.0252,
      note: "per second, plus disk; pause (suspend) is a Pro-plan feature",
      source: "https://www.runloop.ai/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 16, maxMemoryGb: 64 },
    credentials: [["RUNLOOP_API_KEY"]],
    docs: "https://docs.runloop.ai",
  },
];

ENTRIES.push(
  {
    id: "northflank",
    name: "Northflank",
    pricing: {
      vcpuHour: 0.01667,
      gbHour: 0.00833,
      note: "per second on Northflank Cloud, ephemeral disk included; sandboxes run as deployment services (microVMs)",
      source: "https://northflank.com/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    credentials: [["NORTHFLANK_API_TOKEN", "NORTHFLANK_PROJECT_ID"]],
    docs: "https://northflank.com/docs/v1/application/overview",
  },
  {
    id: "hopx",
    name: "HOPX",
    pricing: {
      vcpuHour: 0.0504,
      gbHour: 0.0162,
      note: "per second, plus storage; size comes from the template, not the request",
      source: "https://hopx.ai/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    // HOPX takes no size at create; capped at the default size so bigger requests go elsewhere.
    limits: { maxVcpu: 2, maxMemoryGb: 4 },
    credentials: [["HOPX_API_KEY"]],
    docs: "https://docs.hopx.ai",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Sandbox",
    pricing: {
      vcpuHour: 0.072,
      gbHour: 0.009,
      note: "bills active CPU and provisioned memory of the instance type; this is the full-CPU price; needs Workers Paid ($5/mo) and the bridge Worker in bridges/cloudflare",
      source: "https://developers.cloudflare.com/containers/platform/pricing/",
      checked: "2026-11-04",
    },
    capabilities: [],
    limits: { maxVcpu: 4, maxMemoryGb: 12 },
    credentials: [["CLOUDFLARE_SANDBOX_URL", "CLOUDFLARE_SANDBOX_TOKEN"]],
    docs: "https://developers.cloudflare.com/sandbox/",
  },
);

export const CATALOG: ProviderInfo[] = [...ENTRIES].sort((a, b) => a.name.localeCompare(b.name));

/** Cloudflare only rents fixed instance types: https://developers.cloudflare.com/containers/platform/limits/ */
export const CLOUDFLARE_INSTANCES = [
  { name: "lite", vcpu: 1 / 16, memoryGb: 0.25 },
  { name: "basic", vcpu: 1 / 4, memoryGb: 1 },
  { name: "standard-1", vcpu: 1 / 2, memoryGb: 4 },
  { name: "standard-2", vcpu: 1, memoryGb: 6 },
  { name: "standard-3", vcpu: 2, memoryGb: 8 },
  { name: "standard-4", vcpu: 4, memoryGb: 12 },
] as const;

export function cloudflareInstance(vcpu: number, memoryGb: number) {
  return CLOUDFLARE_INSTANCES.find((t) => t.vcpu >= vcpu && t.memoryGb >= memoryGb) ?? CLOUDFLARE_INSTANCES[CLOUDFLARE_INSTANCES.length - 1];
}

export function info(id: ProviderId): ProviderInfo {
  const p = CATALOG.find((c) => c.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export const DEFAULT_VCPU = 2;
export const DEFAULT_MEMORY_GB = 4;

/** Estimated USD per hour for this spec on this provider (list price, while running). */
export function hourlyCost(id: ProviderId, spec: SandboxSpec = {}): number {
  const { pricing } = info(id);
  const vcpu = spec.vcpu ?? DEFAULT_VCPU;
  let mem = spec.memoryGb ?? DEFAULT_MEMORY_GB;
  // Vercel fixes memory at 2 GB per vCPU.
  if (id === "vercel") mem = Math.max(mem, vcpu * 2);
  // Blaxel sizes by memory, about 2 GB per core.
  if (id === "blaxel") mem = Math.max(mem, vcpu * 2);
  // Cloudflare bills the instance type that fits, not the exact request.
  if (id === "cloudflare") {
    const t = cloudflareInstance(vcpu, mem);
    return t.vcpu * pricing.vcpuHour + t.memoryGb * pricing.gbHour;
  }
  // Morph bills whole MCUs: the larger of vCPUs and 4 GB blocks of memory.
  if (id === "morph") return Math.max(vcpu, Math.ceil(mem / 4)) * pricing.vcpuHour;
  return vcpu * pricing.vcpuHour + mem * pricing.gbHour;
}

/** Why a provider can't take this spec, or null if it can. */
export function unfit(id: ProviderId, spec: SandboxSpec, require: Capability[] = []): string | null {
  const p = info(id);
  const needs = new Set(require);
  if (spec.gpu) needs.add("gpu");
  for (const c of needs) if (!p.capabilities.includes(c)) return `no ${c} support`;
  if ((spec.vcpu ?? DEFAULT_VCPU) > p.limits.maxVcpu) return `max ${p.limits.maxVcpu} vCPU`;
  if ((spec.memoryGb ?? DEFAULT_MEMORY_GB) > p.limits.maxMemoryGb) return `max ${p.limits.maxMemoryGb} GB memory`;
  return null;
}
