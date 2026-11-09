# sandboxrouter

**One API for every sandbox.** A free, open-source router for the places an AI agent can run code: Agent37, Alibaba Cloud, AWS (Bedrock AgentCore and Lambda MicroVMs), Azure Container Apps, Beam, Blaxel, Boat, Cloudflare, CodeSandbox, Daytona, Dedalus Machines, Deno, E2B, exe.dev, Fly.io Sprites, Freestyle, HOPX, InstaBox, Koyeb, Maritime, Modal, Morph, Northflank, Novita, OpenScale, Runloop, Sail, Superserve, Tensorlake, Upstash Box and Vercel, plus Docker on your own machine. It picks a provider by price, speed or capability, and falls back to the next one when a provider is down or rate-limited.

```bash
npm i @sandboxrouter/sdk     # plus the SDK of each provider you use: see Install below
```

```ts
import { Router } from "@sandboxrouter/sdk";

const router = new Router();                       // uses whichever provider keys you've set
const sbx = await router.create();                 // or create({ vcpu: 2, memoryGb: 4 }) for a size
try {
  const r = await sbx.exec("python3 -c 'print(6*7)'");
  console.log(r.stdout, "ran on", sbx.provider);
} finally {
  await sbx.kill();
}
```

Runs as plain JavaScript on Node 20+. (In TypeScript 5.2+, or Node 24+, `await using sbx = ...` kills the sandbox for you.)

Set the keys of the providers you use. `create()` starts the sandbox on the cheapest one that fits, by public list price (ties alphabetical, and no provider pays for placement). If that provider is down, busy or out of credit, the next one takes it, and every attempt is on `sbx.attempts`. The sandbox stays on that provider until you `kill()` it.

Site and docs: [sandboxrouter.vercel.app](https://sandboxrouter.vercel.app) · npm: [`@sandboxrouter/sdk`](https://www.npmjs.com/package/@sandboxrouter/sdk)

## Why

AI agents need a disposable computer to run code a model wrote: install packages, run tests, do an RL rollout. Dozens of providers sell one, each with its own SDK and auth, and the same 2 vCPU / 4 GB sandbox costs from under a cent to over thirty cents an hour. sandboxrouter is one interface over all of them:

- **Same code everywhere.** `create`, `exec` (streamed), `writeFile`, `readFile`, `pause`, `kill`. Switch providers by changing which keys are set.
- **Cheapest first, with fallback.** Or `fastest`, by cold starts you measured, or a list of providers you name.
- **Your keys.** Your accounts and your bills; nothing is proxied through anyone else.
- **Cleanup.** A local ledger of every sandbox started, so `sandboxrouter gc` kills what a crashed script left behind.
- **TypeScript, Python, HTTP and a CLI.** Plus desktops and phones for computer-use models.

## Prices

List price while running, 2 vCPU / 4 GB, cheapest first; waitlisted sign-ups follow. "Up to" = CPU billed only while busy, shown with every core busy. "Not run yet" = built from the provider's docs and tested against mocks only. Details in [Reading the price table](https://sandboxrouter.vercel.app/docs#price-table).

| Provider | $/hr | Plan needed | Real-account check | Notes | Source |
|---|---|---|---|---|---|
| Agent37 | $0.007 | none | not run yet | Whole-minute billing: monthly shape total / 730 / 60; running estimate includes default disk (2 vCPU / 4 GB / 4 GB disk = $4.76/mo); sleeping/stopped disk $0.09/GB-mo; gVisor; $5 minimum top-up, wallet must hold one running day | [pricing](https://www.agent37.com/docs/agents-api/billing) |
| Boat | $0.018 | $20/mo (credited) | not run yet | Fixed sizes billed per second ($0.018/h for 2 vCPU / 4 GB up to $0.20/h for 16 / 32); needs a plan from $20/mo, paid back as VM time | [pricing](https://docs.boat.dev/pricing.md) |
| Maritime | $0.022 | $20/mo (credited) | passed (2026-11-09) | Per second, no minimum runtime; running disk included; Starter $20/mo incl. $20 usage; paused disk $0.08/GB-month (default idle action deletes sandbox) | [pricing](https://maritime.sh/pricing) |
| Sailboxes (Sail Research) | up to $0.062 | none | passed (2026-11-09) | Per second on what the box uses (CPU time, RAM it holds, disk $0.0007/GiB-h), billed per minute; RAM counts the VM's file cache, up to the 16 GiB minimum limit, so file-heavy work can hold more than you asked for; paused/sleeping free; creation $0.01 at 2-4 vCPU on the free plan ($5/mo credit with a card), waived on Pro $250/mo | [pricing](https://docs.sailresearch.com/sailboxes-pricing.md) |
| Northflank | $0.067 | none | not run yet | Per second on Northflank Cloud, ephemeral disk included; sandboxes run as deployment services (microVMs) | [pricing](https://northflank.com/pricing) |
| Morph Cloud | $0.100 | none | not run yet | $0.05/MCU; MCU-hours = max(vCPU, RAM/4 GB, disk/16 GB); snapshots extra | [pricing](https://cloud.morph.so/web/pricing) |
| exe.dev | $0.105 | $15/mo | not run yet | Standalone reserved size, per second: $0.105/h per 2 vCPU / 4 GiB unit; stopped CPU/RAM free, retained disk separate; Personal from $15/mo (up to 16 vCPU / 32 GiB), Work $75/mo (32 / 64 without approval) | [pricing](https://exe.dev/docs/standalone-vms.md) |
| Novita AI Agent Sandbox | $0.117 | none | not run yet | Per second ($0.0000098/vCPU/s, $0.0000032/GiB/s); size comes from the template; paused = storage only | [pricing](https://docs.novita.ai/guides/sandbox-pricing) |
| Freestyle | $0.134 | none | not run yet | Per second on allocated fixed snapshot size; estimate includes disk at $0.000086/GiB-h; free monthly 200 vCPU-h, 400 GiB-h RAM, 60,000 GiB-h disk; Hobby $50/mo incl. $50 (max 8/16), Pro $500 (max 32/64); paused storage only | [pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits) |
| Beam | $0.140 | $20/mo (credited) | not run yet | Per second, Performance tier (sandbox default); Developer plan $20/mo incl. $20 credits; GPUs billed separately | [pricing](https://www.beam.cloud/pricing) |
| CodeSandbox SDK (Together) | $0.149 | none | not run yet | Fixed tiers: Pico 2 vCPU / 1 GB $0.0743/h, Nano 2 / 4 $0.1486/h, up to 64 / 128 $4.7552/h; credits $0.01486, billed per started minute; Build free, 10 concurrent; Scale $170/mo incl. 1,100 credits | [pricing](https://docs.together.ai/docs/together-code-sandbox-legacy) |
| Fly.io Sprites | up to $0.164 | none | not run yet | Bills actual CPU and memory use; this is the full-use price; storage extra | [pricing](https://fly.io/sprites) |
| Blaxel | $0.166 | none | passed (2026-11-09) | Billed on memory only ($0.0000115/GB-s), CPU scales with memory (~2 GB per core) | [pricing](https://blaxel.ai/pricing) |
| HOPX | $0.166 | none | not run yet | Per second, plus storage; size comes from the template, not the request | [pricing](https://hopx.ai/pricing) |
| Superserve | $0.166 | maybe $20/mo (credited) | not run yet | Per second active; superserve/base fixed at 2 vCPU / 4 GiB / 8 GiB disk; retained storage $0.000108/GiB-h (shared template plus changed blocks); Developer $20/mo incl. $20, max 4/16 with team templates; recurring Free allowance not published on pricing page | [pricing](https://superserve.ai/pricing) |
| Tensorlake | up to $0.200 | none | not run yet | Bills active CPU (floor 20% of allocation); this is the full-use price; Pro plan is lower | [pricing](https://www.tensorlake.ai/pricing) |
| Upstash Box | up to $0.200 | none | not run yet | Billed per active CPU core-hour only (memory and idle time free); estimate assumes every core of the box busy; fixed sizes 2/4, 4/8, 8/16 | [pricing](https://upstash.com/pricing/box) |
| Cloudflare Sandbox | up to $0.216 | $5/mo | not run yet | 10 ms billing on active CPU and allocated instance memory; full-CPU estimate excludes allocated disk ($0.000252/GB-h), Worker and Durable Objects charges; needs Workers Paid ($5/mo) and bridges/cloudflare | [pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Amazon Bedrock AgentCore Code Interpreter | up to $0.217 | none | not run yet | Per second; CPU billed on actual use (I/O wait free), memory on peak; fixed 2 vCPU / 8 GB session, this is the 100%-CPU price | [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) |
| Modal | up to $0.238 | none | not run yet | Sandbox rates, per second ($0.00003942 per physical core = 2 vCPUs); GPUs extra; region pinning x1.15-1.75; Starter includes $30/mo credit | [pricing](https://modal.com/pricing) |
| AWS Lambda MicroVMs | $0.252 | none | not run yet | us-east-1 ARM; billed on the image's baseline size (2 GB per vCPU) while running, per-second burst up to 4x; suspended VMs pay snapshot storage; needs a MicroVM image you build once | [pricing](https://aws.amazon.com/lambda/pricing/) |
| Deno Sandbox | up to $0.300 | $20/mo | not run yet | Billed on CPU time, not wall clock (estimate assumes both vCPUs busy); fixed 2 vCPU, 0.75-4 GB, max 30 min lifetime; needs a paid Deno Deploy plan | [pricing](https://deno.com/sandbox) |
| Runloop | $0.317 | none | not run yet | Per second, plus disk; pause (suspend) is a Pro-plan feature | [pricing](https://www.runloop.ai/pricing) |
| Vercel Sandbox | up to $0.341 | none | not run yet | iad1; active CPU, provisioned RAM in minimum 1-minute increments (2 GB/vCPU); full-CPU estimate; Hobby free within quotas, Pro $20/mo usage credit; creations $0.60/million and retained snapshots $0.08/GB-month extra | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |
| InstaBox (sign-up waitlisted) | $0.017 | none | not run yet | Per second while running on fixed sizes (2/4, 4/8, 8/16); paused or stopped boxes bill only /data beyond the included disk ($0.00011/GiB-h); Pro $20/mo includes $20 credits; free plan: 1 box at 4/8 | [pricing](https://instabox.sh/docs/pricing.md) |
| Koyeb Sandboxes (not taking new accounts) | $0.058 | $29/mo | not run yet | Per second; fixed Standard instance sizes (1 vCPU + 1 GB = $0.0144/h); sandboxes need a paid plan (Pro $29/mo); public preview | [pricing](https://www.koyeb.com/docs/reference/instances) |
| Dedalus Machines (sign-up waitlisted) | $0.149 | none | not run yet | Per second while awake; sleeping machines bill storage only (10 GiB included on Hobby, 20 on Pro); Hobby plan max 4 vCPU / 16 GiB; private beta | [pricing](https://docs.dedaluslabs.ai/dcs/dm/pricing) |
| LangSmith Sandboxes (sign-up waitlisted) | $0.189 | none | not run yet | Per second; memory must be 2 to 6 GiB per vCPU; storage $0.000123/GiB-h; 8 LSU ($8) of sandbox usage a month included; Developer plan max 10 sandboxes | [pricing](https://www.langchain.com/pricing) |
| OpenScale Sandboxes | skipped (default image is 2 vCPU / 1 GB; a bigger size needs image.openscale) | none | failed 1 step (2026-11-09) | Per second on allocated size; no platform fee or minimum; paused = free; size comes from the template (E2B-compatible API); Singapore only; needs a pay-as-you-go key | [pricing](https://openscale.so/sandboxes) |
| Azure Container Apps dynamic sessions | skipped (max 1 vCPU) | none | not run yet | Flat $0.03 per session-hour (built-in Shell pools), billed per allocated session in 1-hour increments, East US; needs a session pool you create once | [pricing](https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions) |
| Daytona | skipped (default image is 1 vCPU / 1 GB; a bigger size needs image.daytona) | none | passed (2026-11-09) | Per second, plus disk above 5 GiB | [pricing](https://www.daytona.io/pricing) |
| Alibaba Cloud Agent Sandbox | skipped (max 2 GB memory) | none | not run yet | Per second; Default QoS, Hong Kong and regions outside mainland China; disk separately $0.00025308/GiB-h; code-interpreter-v1 template is 2 vCPU / 2 GiB with 10 GiB disk (E2B-compatible API) | [pricing](https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview) |
| E2B | skipped (default image is 2 vCPU / 0.5 GB; a bigger size needs image.e2b) | none | passed (2026-11-09) | Per second; free Hobby tier ($100 one-time credit, 1-hour sessions, 20 at once); Pro $150/mo for longer sessions | [pricing](https://e2b.dev/pricing) |
| Docker (local) | free | none | passed (2026-11-09) | Runs on your own machine; free, but shares your kernel, so weaker isolation than a cloud micro-VM | [pricing](https://docs.docker.com/engine/) |

Checked 2026-11-04 to 2026-11-06.

## Install

```bash
npm i @sandboxrouter/sdk
```

Then the SDK of each provider you use (many need none) and its keys: both are listed in [the reference](docs/reference.md#install). `npx @sandboxrouter/sdk providers` shows which keys are set.

## More

- [Docs](https://sandboxrouter.vercel.app/docs): routing, fallback, streaming, files, pause, the HTTP server and Python.
- [Reference](docs/reference.md): the full library, CLI and HTTP API, desktops and phones, the real-account compatibility table, and how each adapter maps the spec.
- [CONTRIBUTING.md](CONTRIBUTING.md): run a provider for real and send the result, fix a price, or add a provider.
- [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [MIT](LICENSE)
