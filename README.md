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

Set the keys of the providers you use. `create()` starts the sandbox on the cheapest one that fits: list price for the size you asked for, corrected where we measured what a provider really bills. Providers within 10% of each other on price go fastest first, by start times measured where you run the router. Providers that failed their last real-account check go last. Ties are alphabetical, and no provider pays for placement. If that provider is down, busy or out of credit, the next one takes it, and every attempt is on `sbx.attempts`. The sandbox stays on that provider until you `kill()` it.

Site and docs: [sandboxrouter.vercel.app](https://sandboxrouter.vercel.app) · npm: [`@sandboxrouter/sdk`](https://www.npmjs.com/package/@sandboxrouter/sdk)

## Why

AI agents need a disposable computer to run code a model wrote: install packages, run tests, do an RL rollout. Dozens of providers sell one, each with its own SDK and auth, and the same 2 vCPU / 4 GB sandbox costs from under a cent to over thirty cents an hour. sandboxrouter is one interface over all of them:

- **Same code everywhere.** `create`, `exec` (streamed), `writeFile`, `readFile`, `pause`, `kill`. Switch providers by changing which keys are set.
- **Cheapest real cost, then speed, with fallback.** Or `cheapest` for list price alone, `fastest` by start times, `verified` for tested providers first, or a list of providers you name. `requireVerified` limits a router to providers that passed the real-account check.
- **Errors you can act on.** Every failure has a `code` (`no_provider`, `setup`, `all_failed`, `timeout`, ...), an HTTP status, and the list of providers tried.
- **Your keys.** Your accounts and your bills; nothing is proxied through anyone else.
- **Cleanup.** A local ledger of every sandbox started, so `sandboxrouter gc` kills what a crashed script left behind.
- **TypeScript, Python, HTTP and a CLI.** Plus desktops and phones for computer-use models.

## Prices

List price while running, 2 vCPU / 4 GB, cheapest first; waitlisted sign-ups follow. The router ranks by these, corrected where we measured what a provider really bills, and tries providers whose last real-account check failed last. "Up to" = CPU billed only while busy, shown with every core busy. "Not run yet" = built from the provider's docs and tested against mocks only. Click a provider for its billing details; more in [Reading the price table](https://sandboxrouter.vercel.app/docs#price-table).

| Provider | $/hr | Plan needed | Real-account check | Source |
|---|---|---|---|---|
| [Agent37](https://sandboxrouter.vercel.app/providers/agent37) | $0.007 | none | passed (2026-11-11) | [pricing](https://www.agent37.com/docs/agents-api/billing) |
| [Boat](https://sandboxrouter.vercel.app/providers/boat) | $0.018 | $20/mo (credited) | not run yet | [pricing](https://docs.boat.dev/pricing.md) |
| [Maritime](https://sandboxrouter.vercel.app/providers/maritime) | $0.022 | $20/mo (credited) | passed (2026-11-13) | [pricing](https://maritime.sh/pricing) |
| [Sailboxes (Sail Research)](https://sandboxrouter.vercel.app/providers/sail) | up to $0.062 | none | passed (2026-11-13) | [pricing](https://docs.sailresearch.com/sailboxes-pricing.md) |
| [Northflank](https://sandboxrouter.vercel.app/providers/northflank) | $0.067 | none | not run yet | [pricing](https://northflank.com/pricing) |
| [Morph Cloud](https://sandboxrouter.vercel.app/providers/morph) | $0.100 | none | not run yet | [pricing](https://cloud.morph.so/web/pricing) |
| [exe.dev](https://sandboxrouter.vercel.app/providers/exedev) | $0.105 | $15/mo | not run yet | [pricing](https://exe.dev/docs/standalone-vms.md) |
| [Novita AI Agent Sandbox](https://sandboxrouter.vercel.app/providers/novita) | $0.117 | none | passed (2026-11-11) | [pricing](https://docs.novita.ai/guides/sandbox-pricing) |
| [Freestyle](https://sandboxrouter.vercel.app/providers/freestyle) | $0.134 | none | passed (2026-11-11) | [pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits) |
| [Beam](https://sandboxrouter.vercel.app/providers/beam) | $0.140 | $20/mo (credited) | not run yet | [pricing](https://www.beam.cloud/pricing) |
| [CodeSandbox SDK (Together)](https://sandboxrouter.vercel.app/providers/codesandbox) | $0.149 | none | not run yet | [pricing](https://docs.together.ai/docs/together-code-sandbox-legacy) |
| [Fly.io Sprites](https://sandboxrouter.vercel.app/providers/sprites) | up to $0.164 | none | passed (2026-11-11) | [pricing](https://fly.io/sprites) |
| [Blaxel](https://sandboxrouter.vercel.app/providers/blaxel) | $0.166 | none | passed (2026-11-13) | [pricing](https://blaxel.ai/pricing) |
| [HOPX](https://sandboxrouter.vercel.app/providers/hopx) | $0.166 | none | not run yet | [pricing](https://hopx.ai/pricing) |
| [Superserve](https://sandboxrouter.vercel.app/providers/superserve) | $0.166 | maybe $20/mo (credited) | passed (2026-11-11) | [pricing](https://superserve.ai/pricing) |
| [Tensorlake](https://sandboxrouter.vercel.app/providers/tensorlake) | up to $0.200 | none | not run yet | [pricing](https://www.tensorlake.ai/pricing) |
| [Upstash Box](https://sandboxrouter.vercel.app/providers/upstash) | up to $0.200 | none | not run yet | [pricing](https://upstash.com/pricing/box) |
| [Cloudflare Sandbox](https://sandboxrouter.vercel.app/providers/cloudflare) | up to $0.216 | $5/mo | passed (2026-11-11) | [pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| [Amazon Bedrock AgentCore Code Interpreter](https://sandboxrouter.vercel.app/providers/agentcore) | up to $0.217 | none | passed (2026-11-13) | [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) |
| [Modal](https://sandboxrouter.vercel.app/providers/modal) | up to $0.238 | none | passed (2026-11-11) | [pricing](https://modal.com/pricing) |
| [AWS Lambda MicroVMs](https://sandboxrouter.vercel.app/providers/lambda) | $0.252 | none | passed (2026-11-13) | [pricing](https://aws.amazon.com/lambda/pricing/) |
| [Deno Sandbox](https://sandboxrouter.vercel.app/providers/deno) | up to $0.300 | $20/mo | not run yet | [pricing](https://deno.com/sandbox) |
| [Runloop](https://sandboxrouter.vercel.app/providers/runloop) | $0.317 | none | not run yet | [pricing](https://www.runloop.ai/pricing) |
| [Vercel Sandbox](https://sandboxrouter.vercel.app/providers/vercel) | up to $0.341 | none | passed (2026-11-11) | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |
| [InstaBox (sign-up waitlisted)](https://sandboxrouter.vercel.app/providers/instabox) | $0.017 | none | not run yet | [pricing](https://instabox.sh/docs/pricing.md) |
| [Koyeb Sandboxes (not taking new accounts)](https://sandboxrouter.vercel.app/providers/koyeb) | $0.058 | $29/mo | not run yet | [pricing](https://www.koyeb.com/docs/reference/instances) |
| [Dedalus Machines (sign-up waitlisted)](https://sandboxrouter.vercel.app/providers/dedalus) | $0.149 | none | not run yet | [pricing](https://docs.dedaluslabs.ai/dcs/dm/pricing) |
| [LangSmith Sandboxes (sign-up waitlisted)](https://sandboxrouter.vercel.app/providers/langsmith) | $0.189 | none | not run yet | [pricing](https://www.langchain.com/pricing) |
| [OpenScale Sandboxes](https://sandboxrouter.vercel.app/providers/openscale) | skipped (default image is 2 vCPU / 1 GB; a bigger size needs image.openscale) | none | passed (2026-11-13) | [pricing](https://openscale.so/sandboxes) |
| [Azure Container Apps dynamic sessions](https://sandboxrouter.vercel.app/providers/azure) | skipped (max 1 vCPU) | none | not run yet | [pricing](https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions) |
| [Daytona](https://sandboxrouter.vercel.app/providers/daytona) | skipped (default image is 1 vCPU / 1 GB; a bigger size needs image.daytona) | none | failed 1 step (2026-11-13) | [pricing](https://www.daytona.io/pricing) |
| [Alibaba Cloud Agent Sandbox](https://sandboxrouter.vercel.app/providers/alibaba) | skipped (max 2 GB memory) | none | not run yet | [pricing](https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview) |
| [E2B](https://sandboxrouter.vercel.app/providers/e2b) | skipped (default image is 2 vCPU / 0.5 GB; a bigger size needs image.e2b) | none | passed (2026-11-13) | [pricing](https://e2b.dev/pricing) |
| [Docker (local)](https://sandboxrouter.vercel.app/providers/docker) | free | none | passed (2026-11-09) | [pricing](https://docs.docker.com/engine/) |

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
