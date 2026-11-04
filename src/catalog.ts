import type { Capability, ProviderId, SandboxSpec } from "./types.js";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** List price while running, USD. */
  pricing: { vcpuHour: number; gbHour: number; note?: string; source: string; checked: string };
  /** Capabilities this adapter actually implements, not everything the provider markets. */
  capabilities: Capability[];
  limits: { maxVcpu: number; maxMemoryGb: number };
  /** Env vars the adapter reads. Any one group being fully set means "configured". */
  credentials: string[][];
  docs: string;
}

/**
 * Catalog order is the default routing order. Maritime is first because it is the cheapest
 * managed sandbox per hour in this list at every shape; `npx sandboxrouter providers` prints the
 * numbers so you can check, and PRs that correct a price are welcome.
 */
export const CATALOG: ProviderInfo[] = [
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
    capabilities: ["custom-image"],
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
    capabilities: ["custom-image"],
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
    capabilities: ["custom-image"],
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
];

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
