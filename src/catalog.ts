import type { Capability, ProviderId, SandboxSpec } from "./types.js";
import { KOYEB_INSTANCES, koyebInstance } from "./providers/koyeb.js";
import { AGENT37_SHAPES, agent37Shape } from "./providers/agent37.js";
import { INSTABOX_SIZES, instaboxSize } from "./providers/instabox.js";
import { FREESTYLE_SIZES, freestyleSize } from "./providers/freestyle.js";
import { langsmithSize } from "./providers/langsmith.js";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** List price while running, USD. */
  pricing: { vcpuHour: number; gbHour: number; note?: string; source: string; checked: string };
  /** Capabilities this adapter actually implements, not everything the provider markets. */
  capabilities: Capability[];
  limits: { maxVcpu: number; maxMemoryGb: number };
  /**
   * The size every sandbox gets unless a custom image (template, snapshot) is passed, whatever
   * vcpu/memoryGb ask for. Measured inside real sandboxes (nproc, MemTotal). The router skips the
   * provider for requests bigger than this and prices it at this size.
   */
  defaultSize?: { vcpu: number; memoryGb: number; measured: string };
  /** Runs on your own machine (Docker). Never chosen automatically; name it to use it. */
  local?: boolean;
  /** Env vars the adapter reads. Any one group being fully set means "configured". */
  credentials: string[][];
  docs: string;
  /**
   * Set when you can't just sign up and get a key: "waitlist" (invite or beta only) or "closed"
   * (not taking new accounts). Existing accounts keep working, so routing is unchanged: the router
   * only ever uses providers you have keys for.
   */
  access?: { status: "waitlist" | "closed"; note: string; checked: string };
  /**
   * "allocated": you pay for the size you asked for while it runs. "active-cpu": CPU is charged only
   * while it's busy, so the listed price (every core busy) is the most an hour can cost; idle agents pay less.
   */
  billing: "allocated" | "active-cpu";
  /**
   * The cheapest monthly plan you need before you can create sandboxes through the API. Absent when a
   * free tier or plain pay-as-you-go works. `credited`: the fee comes back as usage credit.
   * `unclear`: the pricing page doesn't say whether a free tier can use the API.
   */
  plan?: { usdMonth: number; credited: boolean; unclear?: boolean; note: string; checked: string };
}

/** Short label for a gated provider's sign-up status, or null when anyone can sign up. */
export function accessLabel(id: ProviderId): string | null {
  const a = CATALOG.find((c) => c.id === id)?.access;
  return a ? (a.status === "waitlist" ? "sign-up waitlisted" : "not taking new accounts") : null;
}

/** Short label for the plan a provider needs before you can use it: "none", "$20/mo (credited)", "$5/mo". */
export function planLabel(id: ProviderId): string {
  const p = CATALOG.find((c) => c.id === id)?.plan;
  if (!p) return "none";
  return `${p.unclear ? "maybe " : ""}$${p.usdMonth}/mo${p.credited ? " (credited)" : ""}`;
}

/**
 * The order tables list providers in (README, CLI, website): providers anyone can sign up for that can
 * take this size, cheapest first, ties alphabetical; then waitlisted or closed sign-ups; then providers
 * that can't take the size; then Docker. The router uses the same price order, but only among providers
 * you have keys for, so a gated provider only gets work if you already have an account there.
 */
export function listingOrder(spec: SandboxSpec = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB }): ProviderInfo[] {
  const rank = (c: ProviderInfo) => (c.local ? 3 : unfit(c.id, spec) ? 2 : c.access ? 1 : 0);
  return [...CATALOG].sort((a, b) => rank(a) - rank(b) || hourlyCost(a.id, spec) - hourlyCost(b.id, spec) || a.id.localeCompare(b.id));
}

/**
 * Every provider is treated the same: the router orders candidates by list price for the requested
 * size (or by your measured cold starts), ties broken alphabetically. Nobody gets a better slot.
 * Prices come from each provider's public pricing page; PRs that correct one are welcome.
 */
const ENTRIES: Omit<ProviderInfo, "billing" | "plan">[] = [
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
      note: "per second, no minimum runtime; running disk included; Starter $20/mo incl. $20 usage; paused disk $0.08/GB-month (default idle action deletes sandbox)",
      source: "https://maritime.sh/pricing",
      checked: "2026-11-05",
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
      note: "per second; free Hobby tier ($100 one-time credit, 1-hour sessions, 20 at once); Pro $150/mo for longer sessions",
      source: "https://e2b.dev/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 8 },
    // The default template; a bigger size needs a template built with --cpu-count / --memory-mb.
    defaultSize: { vcpu: 2, memoryGb: 0.5, measured: "2026-11-06" },
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
    // The default snapshot; resources only apply when creating from an image (image.daytona).
    defaultSize: { vcpu: 1, memoryGb: 1, measured: "2026-11-06" },
    credentials: [["DAYTONA_API_KEY"]],
    docs: "https://www.daytona.io/docs",
  },
  {
    id: "modal",
    name: "Modal",
    pricing: {
      vcpuHour: 0.070956,
      gbHour: 0.024012,
      note: "sandbox rates, per second ($0.00003942 per physical core = 2 vCPUs); GPUs extra; region pinning x1.15-1.75; Starter includes $30/mo credit",
      source: "https://modal.com/pricing",
      checked: "2026-11-05",
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
      note: "iad1; active CPU, provisioned RAM in minimum 1-minute increments (2 GB/vCPU); full-CPU estimate; Hobby free within quotas, Pro $20/mo usage credit; creations $0.60/million and retained snapshots $0.08/GB-month extra",
      source: "https://vercel.com/docs/vercel-sandbox/pricing",
      checked: "2026-11-05",
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
    capabilities: ["custom-image"],
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
    id: "boat",
    name: "Boat",
    pricing: {
      vcpuHour: 0.009,
      gbHour: 0,
      note: "fixed sizes billed per second ($0.018/h for 2 vCPU / 4 GB up to $0.20/h for 16 / 32); needs a plan from $20/mo, paid back as VM time",
      source: "https://docs.boat.dev/pricing.md",
      checked: "2026-11-04",
    },
    // "pause" here is Boat's stop: the disk is kept, running processes end.
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 16, maxMemoryGb: 32 },
    credentials: [["BOAT_API_KEY"]],
    docs: "https://docs.boat.dev",
  },
  {
    id: "exedev",
    name: "exe.dev",
    pricing: {
      vcpuHour: 0.0525,
      gbHour: 0,
      note: "standalone reserved size, per second: $0.105/h per 2 vCPU / 4 GiB unit; stopped CPU/RAM free, retained disk separate; Personal from $15/mo (up to 16 vCPU / 32 GiB), Work $75/mo (32 / 64 without approval)",
      source: "https://exe.dev/docs/standalone-vms.md",
      checked: "2026-11-05",
    },
    capabilities: ["custom-image"],
    // 16 / 32 is the biggest Personal plan; Work allows 32 / 64, but the router can't tell which plan you have.
    limits: { maxVcpu: 16, maxMemoryGb: 32 },
    credentials: [["EXE_TOKEN"]],
    docs: "https://exe.dev/docs/https-api.md",
  },
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
      note: "10 ms billing on active CPU and allocated instance memory; full-CPU estimate excludes allocated disk ($0.000252/GB-h), Worker and Durable Objects charges; needs Workers Paid ($5/mo) and bridges/cloudflare",
      source: "https://developers.cloudflare.com/containers/platform/pricing/",
      checked: "2026-11-05",
    },
    capabilities: [],
    limits: { maxVcpu: 4, maxMemoryGb: 12 },
    credentials: [["CLOUDFLARE_SANDBOX_URL", "CLOUDFLARE_SANDBOX_TOKEN"]],
    docs: "https://developers.cloudflare.com/sandbox/",
  },
);

ENTRIES.push(
  {
    id: "agentcore",
    name: "Amazon Bedrock AgentCore Code Interpreter",
    pricing: {
      vcpuHour: 0.0895,
      gbHour: 0.00945,
      note: "per second; CPU billed on actual use (I/O wait free), memory on peak; fixed 2 vCPU / 8 GB session, this is the 100%-CPU price",
      source: "https://aws.amazon.com/bedrock/agentcore/pricing/",
      checked: "2026-11-04",
    },
    capabilities: [],
    limits: { maxVcpu: 2, maxMemoryGb: 8 },
    credentials: [
      ["AGENTCORE_CODE_INTERPRETER_ID", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      ["AGENTCORE_CODE_INTERPRETER_ID", "AWS_REGION", "AWS_PROFILE"],
    ],
    docs: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-api-reference-examples.html",
  },
  {
    id: "azure",
    name: "Azure Container Apps dynamic sessions",
    pricing: {
      vcpuHour: 0.03,
      gbHour: 0,
      note: "flat $0.03 per session-hour (built-in Shell pools), billed per allocated session in 1-hour increments, East US; needs a session pool you create once",
      source: "https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions",
      checked: "2026-11-04",
    },
    capabilities: [],
    // Per-session size isn't published; placeholder until measured with nproc / free.
    limits: { maxVcpu: 1, maxMemoryGb: 2 },
    credentials: [
      ["AZURE_SESSIONS_POOL_ENDPOINT", "AZURE_SESSIONS_TOKEN"],
      ["AZURE_SESSIONS_POOL_ENDPOINT", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
    ],
    docs: "https://learn.microsoft.com/en-us/azure/container-apps/sessions-tutorial-shell",
  },
  {
    id: "lambda",
    name: "AWS Lambda MicroVMs",
    pricing: {
      vcpuHour: 0.09969984,
      gbHour: 0.01320012,
      note: "us-east-1 ARM; billed on the image's baseline size (2 GB per vCPU) while running, per-second burst up to 4x; suspended VMs pay snapshot storage; needs a MicroVM image you build once",
      source: "https://aws.amazon.com/lambda/pricing/",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 4, maxMemoryGb: 8 },
    credentials: [
      ["AWS_REGION", "LAMBDA_MICROVM_IMAGE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      ["AWS_REGION", "LAMBDA_MICROVM_IMAGE", "AWS_PROFILE"],
    ],
    docs: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html",
  },
  {
    id: "agent37",
    name: "Agent37",
    pricing: {
      vcpuHour: 0.8 / 730,
      gbHour: 0.7 / 730,
      note: "whole-minute billing: monthly shape total / 730 / 60; running estimate includes default disk (2 vCPU / 4 GB / 4 GB disk = $4.76/mo); sleeping/stopped disk $0.09/GB-mo; gVisor; $5 minimum top-up, wallet must hold one running day",
      source: "https://www.agent37.com/docs/agents-api/billing",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 4, maxMemoryGb: 32 },
    credentials: [["AGENT37_API_KEY"]],
    docs: "https://www.agent37.com/docs/agents-api/overview",
  },
  {
    id: "alibaba",
    name: "Alibaba Cloud Agent Sandbox",
    pricing: {
      vcpuHour: 0.017856,
      gbHour: 0.008928,
      note: "per second; Default QoS, Hong Kong and regions outside mainland China; disk separately $0.00025308/GiB-h; code-interpreter-v1 template is 2 vCPU / 2 GiB with 10 GiB disk (E2B-compatible API)",
      source: "https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview",
      checked: "2026-11-05",
    },
    capabilities: ["custom-image"],
    // No published maximum; the default template is 2 vCPU / 2 GB, so bigger requests go elsewhere.
    limits: { maxVcpu: 2, maxMemoryGb: 2 },
    credentials: [["ALIBABA_SANDBOX_API_KEY"]],
    docs: "https://www.alibabacloud.com/help/en/agent-sandbox/e2b-sdk-integration-parameter-description",
  },
  {
    id: "beam",
    name: "Beam",
    pricing: {
      vcpuHour: 0.05,
      gbHour: 0.01,
      note: "per second, Performance tier (sandbox default); Developer plan $20/mo incl. $20 credits; GPUs billed separately",
      source: "https://www.beam.cloud/pricing",
      checked: "2026-11-04",
    },
    capabilities: ["custom-image"],
    // Not documented per sandbox: 30 is the Developer plan's concurrent vCPU cap.
    limits: { maxVcpu: 30, maxMemoryGb: 64 },
    credentials: [["BEAM_TOKEN", "BEAM_WORKSPACE_ID"]],
    docs: "https://docs.beam.cloud/v2/reference/ts-sdk",
  },
  {
    id: "codesandbox",
    name: "CodeSandbox SDK (Together)",
    pricing: {
      vcpuHour: 0.0743,
      gbHour: 0,
      note: "fixed tiers: Pico 2 vCPU / 1 GB $0.0743/h, Nano 2 / 4 $0.1486/h, up to 64 / 128 $4.7552/h; credits $0.01486, billed per started minute; Build free, 10 concurrent; Scale $170/mo incl. 1,100 credits",
      source: "https://docs.together.ai/docs/together-code-sandbox-legacy",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 64, maxMemoryGb: 128 },
    credentials: [["CSB_API_KEY"]],
    docs: "https://codesandbox.io/docs/sdk",
  },
  {
    id: "superserve",
    name: "Superserve",
    pricing: {
      vcpuHour: 0.0504,
      gbHour: 0.0162,
      note: "per second active; superserve/base fixed at 2 vCPU / 4 GiB / 8 GiB disk; retained storage $0.000108/GiB-h (shared template plus changed blocks); Developer $20/mo incl. $20, max 4/16 with team templates; recurring Free allowance not published on pricing page",
      source: "https://superserve.ai/pricing",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 2, maxMemoryGb: 4 },
    credentials: [["SUPERSERVE_API_KEY"]],
    docs: "https://docs.superserve.ai",
  },
  {
    id: "sail",
    name: "Sailboxes (Sail Research)",
    pricing: {
      vcpuHour: 0.015,
      gbHour: 0.008,
      note: "per second on what the box uses (CPU time, RAM it holds, disk $0.0007/GiB-h), billed per minute; RAM counts the VM's file cache, up to the 16 GiB minimum limit, so file-heavy work can hold more than you asked for; paused/sleeping free; creation $0.01 at 2-4 vCPU on the free plan ($5/mo credit with a card), waived on Pro $250/mo",
      source: "https://docs.sailresearch.com/sailboxes-pricing.md",
      checked: "2026-11-06",
    },
    capabilities: ["pause"],
    limits: { maxVcpu: 64, maxMemoryGb: 512 },
    credentials: [["SAIL_API_KEY"]],
    docs: "https://docs.sailresearch.com/sailboxes.md",
  },
  {
    id: "openscale",
    name: "OpenScale Sandboxes",
    pricing: {
      vcpuHour: 0.0065,
      gbHour: 0.001,
      note: "per second on allocated size; no platform fee or minimum; paused = free; size comes from the template (E2B-compatible API); Singapore only; needs a pay-as-you-go key",
      source: "https://openscale.so/sandboxes",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    // The "base" template; size comes from the template.
    defaultSize: { vcpu: 2, memoryGb: 1, measured: "2026-11-06" },
    credentials: [["OPENSCALE_API_KEY"]],
    docs: "https://openscale.so/sandboxes",
  },
  {
    id: "dedalus",
    name: "Dedalus Machines",
    pricing: {
      vcpuHour: 0.04536,
      gbHour: 0.01458,
      note: "per second while awake; sleeping machines bill storage only (10 GiB included on Hobby, 20 on Pro); Hobby plan max 4 vCPU / 16 GiB; private beta",
      source: "https://docs.dedaluslabs.ai/dcs/dm/pricing",
      checked: "2026-11-05",
    },
    capabilities: ["pause"],
    limits: { maxVcpu: 16, maxMemoryGb: 64 },
    credentials: [["DEDALUS_API_KEY"]],
    docs: "https://docs.dedaluslabs.ai/dcs/dm/quickstart",
    access: { status: "waitlist", note: "private beta: your organization has to be admitted before keys work", checked: "2026-11-05" },
  },
  {
    id: "deno",
    name: "Deno Sandbox",
    pricing: {
      vcpuHour: 0.1,
      gbHour: 0.025,
      note: "billed on CPU time, not wall clock (estimate assumes both vCPUs busy); fixed 2 vCPU, 0.75-4 GB, max 30 min lifetime; needs a paid Deno Deploy plan",
      source: "https://deno.com/sandbox",
      checked: "2026-11-04",
    },
    capabilities: ["custom-image"],
    limits: { maxVcpu: 2, maxMemoryGb: 4 },
    credentials: [["DENO_DEPLOY_TOKEN"]],
    docs: "https://docs.deno.com/sandbox/",
  },
  {
    id: "freestyle",
    name: "Freestyle",
    pricing: {
      vcpuHour: 0.04032,
      gbHour: 0.0129,
      note: "per second on allocated fixed snapshot size; estimate includes disk at $0.000086/GiB-h; free monthly 200 vCPU-h, 400 GiB-h RAM, 60,000 GiB-h disk; Hobby $50/mo incl. $50 (max 8/16), Pro $500 (max 32/64); paused storage only",
      source: "https://www.freestyle.sh/docs/vms/pricing-and-limits",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 32, maxMemoryGb: 64 },
    credentials: [["FREESTYLE_API_KEY"]],
    docs: "https://www.freestyle.sh/docs/vms",
  },
  {
    id: "instabox",
    name: "InstaBox",
    pricing: {
      vcpuHour: 0.004,
      gbHour: 0.00225,
      note: "per second while running on fixed sizes (2/4, 4/8, 8/16); paused or stopped boxes bill only /data beyond the included disk ($0.00011/GiB-h); Pro $20/mo includes $20 credits; free plan: 1 box at 4/8",
      source: "https://instabox.sh/docs/pricing.md",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    credentials: [["INSTABOX_API_KEY"]],
    docs: "https://instabox.sh/docs/api.md",
    access: { status: "waitlist", note: "new accounts go on a waitlist before they can create boxes or keys", checked: "2026-11-05" },
  },
  {
    id: "koyeb",
    name: "Koyeb Sandboxes",
    pricing: {
      vcpuHour: 0.0144,
      gbHour: 0,
      note: "per second; fixed Standard instance sizes (1 vCPU + 1 GB = $0.0144/h); sandboxes need a paid plan (Pro $29/mo); public preview",
      source: "https://www.koyeb.com/docs/reference/instances",
      checked: "2026-11-04",
    },
    capabilities: ["custom-image"],
    limits: { maxVcpu: 40, maxMemoryGb: 128 },
    credentials: [["KOYEB_API_TOKEN"]],
    docs: "https://www.koyeb.com/docs/sandboxes",
    access: {
      status: "closed",
      note: "Koyeb is joining Mistral; a new account's dashboard only shows that notice, with no way to create sandboxes or tokens. Existing accounts are unaffected",
      checked: "2026-11-05",
    },
  },
  {
    id: "langsmith",
    name: "LangSmith Sandboxes",
    pricing: {
      vcpuHour: 0.0576,
      gbHour: 0.01845,
      note: "per second; memory must be 2 to 6 GiB per vCPU; storage $0.000123/GiB-h; 8 LSU ($8) of sandbox usage a month included; Developer plan max 10 sandboxes",
      source: "https://www.langchain.com/pricing",
      checked: "2026-11-05",
    },
    capabilities: ["pause", "custom-image"],
    // Not published; 16 vCPU / 96 GiB stays inside the 6 GiB per vCPU band. Real runs will tell.
    limits: { maxVcpu: 16, maxMemoryGb: 96 },
    credentials: [["LANGSMITH_API_KEY"]],
    docs: "https://docs.langchain.com/langsmith/sandboxes",
    access: {
      status: "waitlist",
      note: "Sandboxes are a private preview: until LangChain enables them for your organization, the API answers \"Sandbox feature is not enabled for this organization\"",
      checked: "2026-11-07",
    },
  },
  {
    id: "novita",
    name: "Novita AI Agent Sandbox",
    pricing: {
      vcpuHour: 0.03528,
      gbHour: 0.01152,
      note: "per second ($0.0000098/vCPU/s, $0.0000032/GiB/s); size comes from the template; paused = storage only",
      source: "https://docs.novita.ai/guides/sandbox-pricing",
      checked: "2026-11-04",
    },
    capabilities: ["pause", "custom-image"],
    limits: { maxVcpu: 8, maxMemoryGb: 8 },
    credentials: [["NOVITA_API_KEY"]],
    docs: "https://docs.novita.ai/guides/sandbox-overview",
  },
  {
    id: "upstash",
    name: "Upstash Box",
    pricing: {
      vcpuHour: 0.1,
      gbHour: 0,
      note: "billed per active CPU core-hour only (memory and idle time free); estimate assumes every core of the box busy; fixed sizes 2/4, 4/8, 8/16",
      source: "https://upstash.com/pricing/box",
      checked: "2026-11-04",
    },
    capabilities: [],
    limits: { maxVcpu: 8, maxMemoryGb: 16 },
    credentials: [["UPSTASH_BOX_API_KEY"]],
    docs: "https://upstash.com/docs/box/overall/ephemeral-box",
  },
);

/**
 * How each provider bills, and the monthly plan it needs before the API will create sandboxes.
 * Every provider must be listed (the Record type checks it). Plan fees come from each pricing page,
 * checked 2026-11-06; prepaid top-ups that turn into usage aren't fees, so they don't count.
 */
const P = "2026-11-06";
const BILLING: Record<ProviderId, Pick<ProviderInfo, "billing" | "plan">> = {
  docker: { billing: "allocated" },
  agent37: { billing: "allocated" },
  agentcore: { billing: "active-cpu" },
  alibaba: { billing: "allocated" },
  azure: { billing: "allocated" },
  beam: { billing: "allocated", plan: { usdMonth: 20, credited: true, note: "Developer plan; no free plan", checked: P } },
  blaxel: { billing: "allocated" },
  boat: { billing: "allocated", plan: { usdMonth: 20, credited: true, note: "plan paid back as VM time; 7-day trial needs a card", checked: P } },
  cloudflare: {
    billing: "active-cpu",
    plan: { usdMonth: 5, credited: false, note: "Workers Paid; includes usage allowances, not credit", checked: P },
  },
  codesandbox: { billing: "allocated" },
  daytona: { billing: "allocated" },
  dedalus: { billing: "allocated" },
  deno: {
    billing: "active-cpu",
    plan: { usdMonth: 20, credited: false, note: "the free Deno Deploy plan has no sandboxes; Pro includes allowances, not credit", checked: P },
  },
  e2b: { billing: "allocated" },
  exedev: { billing: "allocated", plan: { usdMonth: 15, credited: false, note: "Personal plan; VMs are metered on top; 7-day trial", checked: P } },
  freestyle: { billing: "allocated" },
  hopx: { billing: "allocated" },
  instabox: { billing: "allocated" },
  koyeb: { billing: "allocated", plan: { usdMonth: 29, credited: false, note: "sandboxes need a paid plan; Pro includes $10 of compute", checked: P } },
  lambda: { billing: "allocated" },
  langsmith: { billing: "allocated" },
  maritime: { billing: "allocated", plan: { usdMonth: 20, credited: true, note: "Starter plan; no free tier; 7-day trial needs a card", checked: P } },
  modal: { billing: "active-cpu" },
  morph: { billing: "allocated" },
  northflank: { billing: "allocated" },
  novita: { billing: "allocated" },
  openscale: { billing: "allocated" },
  runloop: { billing: "allocated" },
  sprites: { billing: "active-cpu" },
  sail: { billing: "active-cpu" },
  superserve: {
    billing: "allocated",
    plan: { usdMonth: 20, credited: true, unclear: true, note: "Developer plan; the page offers a free start but doesn't say what it includes", checked: P },
  },
  tensorlake: { billing: "active-cpu" },
  upstash: { billing: "active-cpu" },
  vercel: { billing: "active-cpu" },
};

export const CATALOG: ProviderInfo[] = ENTRIES.map((e) => ({ ...e, ...BILLING[e.id] })).sort((a, b) => a.name.localeCompare(b.name));

/** Cloudflare only rents fixed instance types: https://developers.cloudflare.com/containers/platform/limits/ */
export const CLOUDFLARE_INSTANCES = [
  { name: "lite", vcpu: 1 / 16, memoryGb: 0.25 },
  { name: "basic", vcpu: 1 / 4, memoryGb: 1 },
  { name: "standard-1", vcpu: 1 / 2, memoryGb: 4 },
  { name: "standard-2", vcpu: 1, memoryGb: 6 },
  { name: "standard-3", vcpu: 2, memoryGb: 8 },
  { name: "standard-4", vcpu: 4, memoryGb: 12 },
] as const;

/** CodeSandbox VM tiers: https://docs.together.ai/docs/together-code-sandbox-legacy (Pico supports 2 vCPU / 1 GB). */
export const CODESANDBOX_TIERS = [
  { name: "Pico", vcpu: 2, memoryGb: 1, usdHour: 0.0743 },
  { name: "Nano", vcpu: 2, memoryGb: 4, usdHour: 0.1486 },
  { name: "Micro", vcpu: 4, memoryGb: 8, usdHour: 0.2972 },
  { name: "Small", vcpu: 8, memoryGb: 16, usdHour: 0.5944 },
  { name: "Medium", vcpu: 16, memoryGb: 32, usdHour: 1.1888 },
  { name: "Large", vcpu: 32, memoryGb: 64, usdHour: 2.3776 },
  { name: "XLarge", vcpu: 64, memoryGb: 128, usdHour: 4.7552 },
] as const;

/** Smallest tier with at least the requested vCPUs and memory (the largest if nothing fits). */
export function codesandboxTier(vcpu: number, memoryGb: number) {
  return CODESANDBOX_TIERS.find((t) => t.vcpu >= vcpu && t.memoryGb >= memoryGb) ?? CODESANDBOX_TIERS[CODESANDBOX_TIERS.length - 1];
}

/** Upstash Box sizes (https://upstash.com/docs/box/overall/how-it-works.md#box-size). */
export const UPSTASH_SIZES = [
  { size: "small", vcpu: 2, memoryGb: 4 },
  { size: "medium", vcpu: 4, memoryGb: 8 },
  { size: "large", vcpu: 8, memoryGb: 16 },
] as const;

export function upstashSize(vcpu: number, memoryGb: number) {
  return UPSTASH_SIZES.find((s) => s.vcpu >= vcpu && s.memoryGb >= memoryGb) ?? UPSTASH_SIZES[UPSTASH_SIZES.length - 1];
}

/** Boat's fixed machine sizes and hourly prices: https://docs.boat.dev/machines.md */
export const BOAT_SIZES = [
  { type: "small", vcpu: 2, memoryGb: 4, usdHour: 0.018 },
  { type: "default", vcpu: 4, memoryGb: 8, usdHour: 0.036 },
  { type: "large", vcpu: 8, memoryGb: 16, usdHour: 0.072 },
  { type: "xlarge", vcpu: 16, memoryGb: 32, usdHour: 0.2 },
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
/** The size the sandbox will really have when it's fixed by the default image, else null. */
export function fixedSize(id: ProviderId, spec: SandboxSpec = {}): { vcpu: number; memoryGb: number } | null {
  const d = info(id).defaultSize;
  return d && !spec.image?.[id] ? { vcpu: d.vcpu, memoryGb: d.memoryGb } : null;
}

/** A spec this provider can take as-is: its default size if it has one, else the router default. */
export function fittingSpec(id: ProviderId): { vcpu: number; memoryGb: number } {
  return fixedSize(id) ?? { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
}

export function hourlyCost(id: ProviderId, spec: SandboxSpec = {}): number {
  const { pricing } = info(id);
  // You get, and pay for, the default image's size whatever you asked for.
  const fixed = fixedSize(id, spec);
  if (fixed) return fixed.vcpu * pricing.vcpuHour + fixed.memoryGb * pricing.gbHour;
  const vcpu = spec.vcpu ?? DEFAULT_VCPU;
  let mem = spec.memoryGb ?? DEFAULT_MEMORY_GB;
  // Vercel fixes memory at 2 GB per vCPU.
  if (id === "vercel") mem = Math.max(mem, vcpu * 2);
  // Blaxel sizes by memory, about 2 GB per core.
  if (id === "blaxel") mem = Math.max(mem, vcpu * 2);
  // Boat rents the smallest fixed size that fits.
  if (id === "boat") {
    const s = BOAT_SIZES.find((b) => b.vcpu >= vcpu && b.memoryGb >= mem) ?? BOAT_SIZES[BOAT_SIZES.length - 1];
    return s.usdHour;
  }
  // exe.dev bills per vCPU with up to 2 GiB each, so memory beyond that adds vCPUs.
  if (id === "exedev") return Math.max(Math.ceil(vcpu), Math.ceil(mem / 2)) * pricing.vcpuHour;
  // Cloudflare bills the instance type that fits, not the exact request.
  if (id === "cloudflare") {
    const t = cloudflareInstance(vcpu, mem);
    return t.vcpu * pricing.vcpuHour + t.memoryGb * pricing.gbHour;
  }
  // Azure bills a flat rate per allocated session.
  if (id === "azure") return pricing.vcpuHour;
  // Lambda MicroVMs bill the smallest baseline image size that fits (2 GB per vCPU).
  if (id === "lambda") {
    const size = [0.5, 1, 2, 4, 8].find((s) => s >= Math.max(mem, vcpu * 2)) ?? 8;
    return size * pricing.gbHour + (size / 2) * pricing.vcpuHour;
  }
  // Superserve system templates are a fixed 2 vCPU / 4 GiB, billed whole.
  if (id === "superserve") return 2 * pricing.vcpuHour + 4 * pricing.gbHour;
  // InstaBox bills the fixed size that fits.
  if (id === "instabox") {
    const s = instaboxSize(vcpu, mem) ?? INSTABOX_SIZES[INSTABOX_SIZES.length - 1];
    return s.vcpu * pricing.vcpuHour + s.memoryGb * pricing.gbHour;
  }
  // Agent37 publishes total running shapes per 730-hour month, including their default disk.
  if (id === "agent37") return (agent37Shape(vcpu, mem) ?? AGENT37_SHAPES[AGENT37_SHAPES.length - 1]).usdMonth / 730;
  if (id === "codesandbox") return codesandboxTier(vcpu, mem).usdHour;
  if (id === "koyeb") return (koyebInstance(vcpu, mem) ?? KOYEB_INSTANCES[KOYEB_INSTANCES.length - 1]).usdHour;
  if (id === "freestyle") return (freestyleSize(vcpu, mem) ?? FREESTYLE_SIZES[FREESTYLE_SIZES.length - 1]).usdHour;
  // Upstash bills active core-hours on the box size that fits; this assumes every core is busy.
  if (id === "upstash") return upstashSize(vcpu, mem).vcpu * pricing.vcpuHour;
  // Deno bills CPU time on a fixed 2 vCPU box, with at least 768 MB of memory.
  if (id === "deno") return 2 * pricing.vcpuHour + Math.max(mem, 0.75) * pricing.gbHour;
  // LangSmith runs 2 to 6 GiB per vCPU, so a request outside that band is widened.
  if (id === "langsmith") {
    const s = langsmithSize(vcpu, mem);
    return s.vcpu * pricing.vcpuHour + s.memoryGb * pricing.gbHour;
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
  // A default image's size is fixed. With no size asked for you get that size, so only a size you
  // name can be too big for it.
  const fixed = fixedSize(id, spec);
  if (fixed && ((spec.vcpu ?? 0) > fixed.vcpu || (spec.memoryGb ?? 0) > fixed.memoryGb))
    return `default image is ${fixed.vcpu} vCPU / ${fixed.memoryGb} GB; a bigger size needs image.${id}`;
  return null;
}
