# sandboxrouter

**One API for every sandbox.** A free, open-source router for the places an AI agent can run code: Agent37, Alibaba Cloud, AWS (Bedrock AgentCore and Lambda MicroVMs), Azure Container Apps, Beam, Blaxel, Boat, Cloudflare, CodeSandbox, Daytona, Dedalus Machines, Deno, E2B, exe.dev, Fly.io Sprites, Freestyle, HOPX, InstaBox, Koyeb, Maritime, Modal, Morph, Northflank, Novita, OpenScale, Runloop, Sail, Superserve, Tensorlake, Upstash Box and Vercel, plus Docker on your own machine. It picks a provider by price, speed or capability, and falls back to the next one when a provider is down or rate-limited.

Not every adapter has run against a real account yet. The [Prices](#prices) table shows which have passed the real-account check and which are built from docs and tested against mocks only.

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

With no size you get 2 vCPU / 4 GB, except on providers whose default image has a fixed size (Daytona 1 vCPU / 1 GB, E2B 2 vCPU / 0.5 GB, OpenScale 2 vCPU / 1 GB), where you get that. Ask for more than that and those providers are skipped unless you pass a custom `image` built at the size you need.

Switch providers by changing which keys are set, not your code (custom images are the exception: each provider names its own). If one returns a 429, the next one takes the sandbox.

Site: [sandboxrouter.vercel.app](https://sandboxrouter.vercel.app) · npm: [`@sandboxrouter/sdk`](https://www.npmjs.com/package/@sandboxrouter/sdk)

## Why

Agents need a disposable computer: to run code a model wrote, install packages, run tests, scrape, or do an RL rollout. There are more than a dozen sandbox providers, each with its own SDK, auth, lifecycle and price, and the same 2 vCPU / 4 GB box costs anywhere from a few cents to over thirty cents an hour.

So every agent team either locks into one provider or writes its own adapter layer. sandboxrouter is that adapter layer, done once, in the open:

- **One interface.** `create`, `exec`, `writeFile`, `readFile`, `pause`, `kill`, the same on every provider. `exec` streams stdout and stderr as they happen.
- **Routing.** `cheapest` (the default: lowest list price for your size) or `fastest` (lowest cold start you measured with `bench`), or name providers yourself.
- **Fallback.** A failed create moves to the next candidate, and every attempt is recorded on `sbx.attempts`.
- **Capability filters.** Ask for a GPU and only GPU-capable providers are tried. Ask for 32 vCPU and providers that can't do it are skipped, with the reason.
- **Your keys.** Your accounts, your bills. Nothing is proxied through a third party.
- **HTTP server and Python client.** Run `sandboxrouter serve` and any language gets the same API.
- **Computers.** Linux and Windows desktops, Android phones and iPhone simulators for computer-use models, from 7 providers, routed by price per OS: actions, screenshots, and (where the provider has one) a link for a person to watch or take over.
- **Open benchmark.** `bench --share` produces a report; cold starts on the site come from reports submitted to [`results/`](results/).

## Fair by construction

No provider gets a better slot, and none pays for placement.

- With no strategy, a sandbox goes to the **lowest list price for the size you asked for**, among providers you have keys for. Ties break **alphabetically**.
- `fastest` uses only cold starts **you** measured with `bench`, then price.
- Prices are each provider's public rate, with a source link, in [`src/catalog.ts`](src/catalog.ts). There's a test that the catalog has no privileged ordering.
- Docker is never picked automatically, because it always "costs" $0 and isolates less than a cloud micro-VM. Name it to use it.

If a price is wrong, open a PR with the source link.

## Prices

Estimated list price while running, 2 vCPU / 4 GB (`npx @sandboxrouter/sdk providers --vcpu 2 --memory 4`). Providers anyone can sign up for come first, cheapest first; waitlisted or closed sign-ups follow. The router uses the same price order, but only among providers you have keys for.

How to read it:

- **Up to $X** means the provider bills CPU only while it's busy, so this is the price with every core busy. An agent that mostly waits on its model pays less.
- **Plan needed** is the monthly plan you must be on before the API will create sandboxes. "Credited" means the fee comes back as usage. "None" means a free tier or plain pay-as-you-go works. For a small project, the plan can cost more than the usage.
- **Real-account check** is the last time the 14-step [`check`](#compatibility) passed against a real account. "Not run yet" means the adapter is built from the provider's docs and tested against mocks only.
- **Skipped** means the provider can't take 2 vCPU / 4 GB. One skipped for its default image's size is still used by a `create()` that names no size, at that image's size.

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
# then the SDK of each provider you use (Agent37, Azure, AgentCore, Boat, Cloudflare, Dedalus, exe.dev, Freestyle, InstaBox, Koyeb,
# Lambda, Maritime, Sail, Superserve, Upstash and Docker need none; the AWS ones need the signing packages below):
npm i e2b                       # E2B (also Alibaba Cloud and OpenScale)
npm i @daytonaio/sdk            # Daytona
npm i modal                     # Modal
npm i @vercel/sandbox           # Vercel Sandbox
npm i morphcloud                # Morph Cloud
npm i @fly/sprites              # Fly.io Sprites (its package asks for Node 24+)
npm i @blaxel/core              # Blaxel
npm i @tensorlakeai/tensorlake  # Tensorlake
npm i @runloop/api-client       # Runloop
npm i @hopx-ai/sdk              # HOPX
npm i @northflank/js-client     # Northflank
npm i @beamcloud/beam-js        # Beam
npm i @codesandbox/sdk          # CodeSandbox
npm i @deno/sandbox             # Deno Sandbox
npm i novita-sandbox            # Novita
                                # Alibaba Cloud uses the e2b package
npm i @smithy/signature-v4 @aws-crypto/sha256-js @aws-sdk/credential-provider-node  # AgentCore, Lambda MicroVMs
```

Cloudflare sandboxes only run inside a Cloudflare Worker, so you deploy a small bridge Worker to your own account first: see [`bridges/cloudflare`](bridges/cloudflare).

Three providers need a one-time setup in your cloud account, described at the top of each adapter: Azure needs a Shell session pool ([`src/providers/azure.ts`](src/providers/azure.ts)), Lambda MicroVMs need an image built from the bundled server ([`src/providers/lambda.ts`](src/providers/lambda.ts), `writeLambdaMicrovmBundle()`), and AgentCore is opt-in: set `AGENTCORE_CODE_INTERPRETER_ID=aws.codeinterpreter.v1` so plain AWS credentials don't route work there by surprise.

Set the keys for the providers you want. Providers without keys are skipped.

| Provider | Env |
|---|---|
| Agent37 | `AGENT37_API_KEY` |
| Alibaba Cloud Agent Sandbox | `ALIBABA_SANDBOX_API_KEY` |
| Amazon Bedrock AgentCore Code Interpreter | `AGENTCORE_CODE_INTERPRETER_ID` + `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AGENTCORE_CODE_INTERPRETER_ID` + `AWS_REGION` + `AWS_PROFILE` |
| AWS Lambda MicroVMs | `AWS_REGION` + `LAMBDA_MICROVM_IMAGE` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_REGION` + `LAMBDA_MICROVM_IMAGE` + `AWS_PROFILE` |
| Azure Container Apps dynamic sessions | `AZURE_SESSIONS_POOL_ENDPOINT` + `AZURE_SESSIONS_TOKEN`, or `AZURE_SESSIONS_POOL_ENDPOINT` + `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` |
| Beam | `BEAM_TOKEN` + `BEAM_WORKSPACE_ID` |
| Blaxel | `BL_API_KEY` + `BL_WORKSPACE` |
| Boat | `BOAT_API_KEY` |
| Cloudflare Sandbox | `CLOUDFLARE_SANDBOX_URL` + `CLOUDFLARE_SANDBOX_TOKEN` |
| CodeSandbox SDK (Together) | `CSB_API_KEY` |
| Daytona | `DAYTONA_API_KEY` |
| Dedalus Machines | `DEDALUS_API_KEY` |
| Deno Sandbox | `DENO_DEPLOY_TOKEN` |
| Docker (local) | none: Docker running locally |
| E2B | `E2B_API_KEY` |
| exe.dev | `EXE_TOKEN` |
| Fly.io Sprites | `SPRITES_TOKEN` |
| Freestyle | `FREESTYLE_API_KEY` |
| HOPX | `HOPX_API_KEY` |
| InstaBox | `INSTABOX_API_KEY` |
| Koyeb Sandboxes | `KOYEB_API_TOKEN` |
| LangSmith Sandboxes | `LANGSMITH_API_KEY` |
| Maritime | `MARITIME_API_KEY` |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` |
| Morph Cloud | `MORPH_API_KEY` |
| Northflank | `NORTHFLANK_API_TOKEN` + `NORTHFLANK_PROJECT_ID` |
| Novita AI Agent Sandbox | `NOVITA_API_KEY` |
| OpenScale Sandboxes | `OPENSCALE_API_KEY` |
| Runloop | `RUNLOOP_API_KEY` |
| Sailboxes (Sail Research) | `SAIL_API_KEY` |
| Superserve | `SUPERSERVE_API_KEY` |
| Tensorlake | `TENSORLAKE_API_KEY` |
| Upstash Box | `UPSTASH_BOX_API_KEY` |
| Vercel Sandbox | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` |

## Library

```ts
const router = new Router();

// Cheapest provider that can do 8 vCPU / 16 GB, falling back on failure
const a = await router.create({ vcpu: 8, memoryGb: 16 }, { strategy: "cheapest" });

// GPU: only GPU-capable providers are tried (Modal today)
const b = await router.create({ gpu: "A10G", image: { modal: "pytorch/pytorch:latest" } });

// Pin providers in order and turn fallback off
const c = await router.create({}, { provider: ["e2b", "daytona"], fallback: false });

// Fallback moves on when a provider is down: a timeout, a network error, 429 or 5xx, and a create
// that takes longer than createTimeoutSeconds (default 120; a sandbox that turns up later is
// killed, or left in the ledger for `gc`), and when an account can't pay (402: no balance, plan
// needed). A setup error (400, 401, 403, 404, 422: a bad key, a bad image or request) stops instead,
// so a mistake isn't hidden by a pricier provider. Every failed attempt is on sbx.attempts.
// fallback: "any" falls back on every error.
const e = await router.create({}, { fallback: "any", createTimeoutSeconds: 300 });

// Per-provider images: each provider names its templates differently
const d = await router.create({ image: { e2b: "code-interpreter-v1", modal: "python:3.13-slim" } });

// Files
await a.writeFile("/tmp/data.csv", "x,y\n1,2\n");
console.log(await a.readText("/tmp/data.csv"));

// Stream output as it happens (the full output is still returned)
await a.exec("npm test", { onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c) });

// Pause keeps the disk (and memory, where the provider snapshots it); router.get() resumes
const p = await router.create({}, { require: ["pause"] });
await p.pause();

// Ids are portable across processes: "provider:nativeId"
const again = await router.get(a.id);

// Dry run: who would be tried, in what order, and why anything is skipped
console.table(router.plan({ vcpu: 32 }));

await a.kill();
```

`create` throws a `RouterError` whose `attempts` lists every provider it tried and why each failed.

## Computers (desktops and phones)

For computer-use agents: a machine with a screen that your model drives with clicks and keys. `router.computer({ os })` starts one on the cheapest provider for that OS among those you have keys for, ties alphabetical, with fallback. Actions use the Anthropic computer-use shape on every provider.

| Provider | Linux | Windows | Android | iOS | Default size | Live view |
|---|---|---|---|---|---|---|
| AWS WorkSpaces (agent access) | $0.138 | $0.150 | | | 2 vCPU · 4 GB | watch only |
| Daytona | $0.067 | | | | 1 vCPU · 1 GB | watch/control link |
| E2B Desktop | $0.533 | | | | 8 vCPU · 8 GB | watch/control link |
| Limrun | | | $3.00 | $6.00 | phone emulator / iPhone simulator | interactive link |
| Maritime | $0.120 | $0.180 | $0.150 | | 2 vCPU · 4 GB | view-only and takeover links |
| Mobilerun | | | $1.80 | | cloud phone | embedded player |
| Orgo | $0.055 | plan | | | 2 vCPU · 8 GB | VNC (full control) |

Per hour while awake, from each provider's pricing page (sources in [`src/computers.ts`](src/computers.ts)). Sizes differ, so compare price and size together. Only Maritime and AWS enforce view-only on the server; on the others a "watch" link can be turned into control, so treat it like a password. Mobilerun and AWS have no shell; Limrun's iOS has no shell. AWS needs a fleet and stack you provision once (steps at the top of [`src/providers/workspaces.ts`](src/providers/workspaces.ts)).

```ts
const desk = await router.computer({ os: "linux", externalUserId: "user_42" }); // same id, same desktop
const shot = await desk.act({ action: "screenshot" });            // { frameId, width, height, imageB64 }
await desk.act({ action: "left_click", coordinate: [412, 230] });
await desk.actBatch([{ action: "type", text: "hello" }, { action: "key", text: "Return" }]);
await desk.exec("ls /data");

// Hit a login or CAPTCHA? Hand the desktop to a person, then carry on.
const { url } = await desk.viewer("control", { reason: "Please sign in" });
```

```bash
npx @sandboxrouter/sdk desktop --os linux --user user_42 --control   # prints a takeover link
npx @sandboxrouter/sdk screenshot <provider>:<id> --out screen.png
```

## CLI

```bash
npx @sandboxrouter/sdk providers                    # price table + which keys are set
npx @sandboxrouter/sdk route --gpu T4               # dry run
npx @sandboxrouter/sdk run "uname -a && nproc"      # start, run, print, kill
npx @sandboxrouter/sdk run "pytest -q" --provider e2b,daytona --keep
npx @sandboxrouter/sdk bench --runs 5               # cold start + exec latency table
npx @sandboxrouter/sdk bench --share --label "us-east-1"   # also write a report for results/
npx @sandboxrouter/sdk leaderboard results --out leaderboard.html
npx @sandboxrouter/sdk serve --port 8787            # HTTP API
npx @sandboxrouter/sdk ls                           # sandboxes started here that were never killed
npx @sandboxrouter/sdk gc                           # kill the ones past their lifetime (--all: every one)
```

### Cleaning up leaks

If a script crashes before `kill()`, its sandbox keeps billing. Every router keeps a ledger of the sandboxes it starts in `~/.sandboxrouter/sandboxes.jsonl` (set `SANDBOXROUTER_HOME` to move it, `SANDBOXROUTER_LEDGER=off` or `new Router({ ledger: false })` to turn it off), and `kill()` closes the entry.

```bash
sandboxrouter ls                    # id, age, lifetime left, cost so far
sandboxrouter gc --dry-run          # what would be killed
sandboxrouter gc                    # kill sandboxes past their requested lifetime
sandboxrouter gc --all              # kill every open one (end of a CI job)
sandboxrouter gc --older-than 60    # kill those up for an hour or more
```

A sandbox the provider already stopped is just dropped from the ledger. `sandboxrouter run` kills its sandbox on Ctrl-C. The ledger only knows sandboxes started on this machine (or wherever `SANDBOXROUTER_HOME` points), so run `gc --all` at the end of CI jobs. Every adapter hands `timeoutMinutes` to the provider, which stops, deletes or pauses the sandbox when it runs out (the table under "How each adapter maps the spec" says which), except Fly.io Sprites, which has none (an idle sprite stops billing CPU but keeps its storage), and exe.dev, where the VM powers itself off when the lifetime runs out (best effort; a stopped VM bills disk until it's deleted).

### Bench

`bench` starts real sandboxes on every configured provider, measures time to a usable sandbox and the round trip of `echo ok`, kills them, and prints a markdown leaderboard. Results are saved to `~/.sandboxrouter/bench.json`, which is what `strategy: "fastest"` routes on. Latency is measured from wherever you run it, so network distance counts.

`--share` writes a JSON report (timings, your label, Node version and platform; never keys, env or error text), and `--by` adds your GitHub username so the website can credit you. Open a PR adding it to [`results/`](results/); CI checks every result file for keys, addresses and impossible numbers (`npm run results:check`), see [Sending results](CONTRIBUTING.md#sending-results). `sandboxrouter leaderboard` builds one static HTML page from every report there, taking the median of each submission's medians so one submitter can't dominate. Host the page anywhere static files go.

### Real cost

Prices in the catalog are list prices. `cost` checks them against real bills: it starts one sandbox per provider at a known size, records the size the sandbox really has (`nproc` and `MemTotal`), keeps every core busy for a fixed time (some providers bill active CPU only), kills it, and predicts the cost from list price × wall time. `cost settle` then reads what the provider charged for that sandbox, from Daytona's usage analytics, Blaxel's metrics API, Maritime's metered usage and Sail's spend API. E2B and OpenScale have no billing API, so their bill is read from the dashboard. Bills post late on some providers (Daytona can take up to 48 h), so rerun `settle` until every row has one.

```bash
sandboxrouter cost run --minutes 10           # every configured cloud provider, 2 vCPU / 4 GB
sandboxrouter cost settle results/cost/cost-2026-11-06-16-58.json
```

### Compatibility

`check` runs the same 14 steps against a real account: create; stdout, stderr and exit code; env and cwd; UTF-8 output; live streaming; a binary file round-trip; a 1 MB file; reading a missing file is an error; files written by `writeFile` are visible to commands and the other way round; a command timeout rejects with the contract's error; the timed-out command was really stopped; pause and resume; kill; and the killed sandbox is really gone.

```bash
sandboxrouter check --provider koyeb    # one provider
sandboxrouter check --all --save        # every configured provider; writes results/conformance/<id>.json
```

It prints one line per step and exits 1 if any fails. `checkProvider(router, id)` does the same from code. Saved runs make this table (`node --import tsx scripts/readme-tables.ts --write`), and a nightly workflow re-runs it with the repo's provider keys, committing only when a result changes (so the date is when the current result was first seen). Every adapter also has mock-API tests in `npm test`; this table is only real runs.

| Provider | Real-account check (14 steps) | Result since |
|---|---|---|
| Agent37 | not run yet | |
| Boat | not run yet | |
| Maritime | 14/14 passed | 2026-11-09, v0.3.3 |
| Sailboxes (Sail Research) | 14/14 passed | 2026-11-09, v0.3.3 |
| Northflank | not run yet | |
| Morph Cloud | not run yet | |
| exe.dev | not run yet | |
| Novita AI Agent Sandbox | not run yet | |
| Freestyle | not run yet | |
| Beam | not run yet | |
| CodeSandbox SDK (Together) | not run yet | |
| Fly.io Sprites | not run yet | |
| Blaxel | 13/13 passed; n/a: pause and resume | 2026-11-09, v0.3.3 |
| HOPX | not run yet | |
| Superserve | not run yet | |
| Tensorlake | not run yet | |
| Upstash Box | not run yet | |
| Cloudflare Sandbox | not run yet | |
| Amazon Bedrock AgentCore Code Interpreter | not run yet | |
| Modal | not run yet | |
| AWS Lambda MicroVMs | not run yet | |
| Deno Sandbox | not run yet | |
| Runloop | not run yet | |
| Vercel Sandbox | not run yet | |
| InstaBox | not run yet | |
| Koyeb Sandboxes | not run yet | |
| Dedalus Machines | not run yet | |
| LangSmith Sandboxes | not run yet | |
| OpenScale Sandboxes | 0/14 passed; failed: create | 2026-11-09, v0.3.3 |
| Azure Container Apps dynamic sessions | not run yet | |
| Daytona | 14/14 passed | 2026-11-09, v0.3.3 |
| Alibaba Cloud Agent Sandbox | not run yet | |
| E2B | 14/14 passed | 2026-11-09, v0.3.3 |
| Docker (local) | 14/14 passed | 2026-11-09, v0.3.3 |

## HTTP API

```bash
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve
```

| Method | Path | Body |
|---|---|---|
| `GET` | `/v1/providers` | |
| `POST` | `/v1/route` | same as create; returns the candidate order |
| `POST` | `/v1/sandboxes` | `{ vcpu, memoryGb, gpu, env, timeoutMinutes, image, metadata, provider, strategy, fallback, createTimeoutSeconds, require }` |
| `POST` | `/v1/sandboxes/:id/exec` | `{ cmd, cwd, env, timeoutSeconds, stream }`. With `stream: true` the answer is `text/event-stream`: `stdout` and `stderr` events, then `result` |
| `POST` | `/v1/sandboxes/:id/pause` | |
| `PUT` | `/v1/sandboxes/:id/files?path=` | raw bytes |
| `GET` | `/v1/sandboxes/:id/files?path=` | |
| `DELETE` | `/v1/sandboxes/:id` | |
| `POST` | `/v1/computers` | `{ os, externalUserId, name, screen, arch, provider }` |
| `POST` | `/v1/computers/:id/actions` | one action, or `{ actions: [...] }` (up to 50) |
| `GET` | `/v1/computers/:id/screenshot` | image bytes (`?format=jpeg&quality=80`) |
| `POST` | `/v1/computers/:id/exec` | `{ command, timeoutSeconds }` (max 30 s) |
| `PUT` / `GET` | `/v1/computers/:id/files?path=` | raw bytes |
| `POST` | `/v1/computers/:id/viewer` | `{ mode: "watch" \| "control", ttlSeconds, reason }` |
| `POST` | `/v1/computers/:id/sleep` | |
| `DELETE` | `/v1/computers/:id` | |

```bash
curl -s localhost:8787/v1/sandboxes -H "Authorization: Bearer secret" \
  -d '{"vcpu":2,"strategy":"cheapest"}'
# {"id":"e2b:iz5sb5a4bt3pmjx7c5ms2","provider":"e2b","estimatedHourlyUsd":0.1656,"attempts":[...]}
```

Provider keys stay on the server. Clients only hold `SANDBOXROUTER_TOKEN`. It binds to `127.0.0.1` by default. Without a token it only starts on a loopback address with CORS off: `--cors` (any browser page could otherwise start sandboxes on your keys) and a public `--host` both need `SANDBOXROUTER_TOKEN`.

### Python

A standard-library client for the HTTP API lives in [`python/`](python/):

```python
from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="secret")
with sr.create(strategy="cheapest") as sbx:
    sbx.exec("pip install rich && python -c 'import rich'", on_stdout=lambda c: print(c, end=""))
```

## How each adapter maps the spec

| | vCPU / memory | Lifetime | Image | Pause | Notes |
|---|---|---|---|---|---|
| Maritime | `vcpu`, `memoryMib` | `timeLimitMinutes` (5 to 1,440) | `from` | yes | Plain REST, no SDK. Streams over SSE. Any data-plane call resumes a paused sandbox. |
| E2B | set by the template | `timeoutMs` | template | yes (memory + disk) | Nonzero exits are returned as results, not thrown. |
| Daytona | only with `image.daytona` | `autoStopInterval` | `image` | yes (stop/start, disk only) | Non-streaming exec merges stdout and stderr; streaming uses a session and keeps them apart. |
| Modal | `cpu`, `memoryMiB`, `gpu` | `timeoutMs` | registry tag | no | Uses Modal app `sandboxrouter` (override with `SANDBOXROUTER_MODAL_APP`). |
| Vercel | `vcpus` (2 GB each) | `timeout` | `runtime` | no | Max 8 vCPU. |
| Morph | via a cached base snapshot per shape | `ttlSeconds` | snapshot id | yes (memory + disk) | First create of a new shape builds a snapshot. Files over SSH. |
| Fly.io Sprites | `cpus`, `ramMB` (may be ignored) | none: `kill()` or `gc` deletes | no | no | Sprites idle for free on their own. |
| Blaxel | memory (CPU follows) | `ttl` | image | no (archiving is a per-workspace preview) | Idle sandboxes go to free standby on their own. |
| Tensorlake | `cpus`, `memoryMb` | idle timeout | image | yes (memory + disk) | Output is line-based. |
| Runloop | snapped to Runloop's custom sizes | `keep_alive_time_seconds` (max 48 h) | blueprint | yes (Pro plan) | Commands start in the home directory. |
| HOPX | set by the template | timeout | template | yes (memory + disk) | Size requests aren't applied, so the router only sends default-size work. |
| Northflank | cheapest `nf-compute` plan that fits | `expiryTime` (5 min to 7 days) | any public image | no | Runs as a deployment service; files move as base64 over exec. |
| Cloudflare | smallest instance type that fits | alarm in the bridge Worker | Dockerfile in the bridge | no | Through the bridge Worker you deploy ([`bridges/cloudflare`](bridges/cloudflare)). |
| Boat | smallest of 4 fixed sizes that fits | auto-stop timer | saved snapshot | yes (stop: disk kept, processes end) | Plain REST. Commands that wait are capped at 600 s; files API up to 5 MiB. |
| exe.dev | `--cpu`, `--memory` (2 GiB per vCPU max) | the VM powers itself off (best effort); `kill()` or `gc` deletes | `--image` | no | Plain REST over exe.dev's `/exec`; long commands run detached and are polled. |
| Agent37 | smallest of 4 fixed shapes that fits (max 4 vCPU) | auto-sleep after idle (5 min to 24 h) | template (`agent37-base` default) | yes (sleep: memory + disk) | Plain REST; no streaming; files move as base64 over exec in chunks. |
| Alibaba Cloud | set by the template | `timeoutMs` (max 24 h) | template | no (allowlist only) | E2B-compatible API via the `e2b` SDK; region from `ALIBABA_SANDBOX_REGION` (default ap-southeast-1). |
| AgentCore | fixed 2 vCPU / 8 GB | `sessionTimeoutSeconds` (max 8 h) | no | no | SigV4, plain fetch; files move as base64 over commands. Opt-in. |
| Azure sessions | fixed by the pool | pool cooldown (5 to 60 min idle) | no | no | Shell session pool; output over 4 KB is fetched from files. |
| Beam | `cpu`, `memory` | `keepWarmSeconds` | registry image | no | Uses Beam app `sandboxrouter` (override with `SANDBOXROUTER_BEAM_APP`). |
| CodeSandbox | smallest of 7 fixed tiers that fits | hibernation timeout | template | yes (hibernate: memory + disk) | Exec output goes through files because the SDK's terminal merges streams. |
| Dedalus Machines | `vcpu`, `memory_mib` | autosleep after idle (compute stops, disk kept) | no | yes (sleep/wake) | Plain REST; streams by polling the events feed; files move as base64 over stdin/stdout. Private beta. |
| Deno | fixed 2 vCPU, 0.75 to 4 GB | up to 30 min | snapshot or volume | no | WebSocket RPC via `@deno/sandbox`. |
| Freestyle | smallest Ubuntu snapshot that fits | `ttlSeconds` | snapshot | yes (memory + disk) | Plain REST; long commands run as background requests and are polled. |
| InstaBox | smallest fixed size that fits (2/4, 4/8, 8/16; free plan falls back to 4/8) | `deleteAfterSeconds` (60 s to 24 h) | template or snapshot (`sn_...`) | yes (suspend: memory + disk) | Plain REST; exec via `bash -lc`, max 600 s, SSE streaming; files API raw bytes. Pauses itself after 30 idle min. |
| Koyeb | smallest Standard instance that fits | auto-delete delay (max 24 h) | any Docker image | no | Plain REST; streams over SSE. Public preview. |
| Lambda MicroVMs | image baseline (2 GB per vCPU) | `maximumDurationInSeconds` | your MicroVM image | yes (suspend/resume) | Runs the bundled in-VM server for exec and files. |
| Novita | set by the template | `timeoutMs` | template | yes (memory + disk) | `novita-sandbox` SDK (an E2B fork). |
| Sail | `vcpu_count`; memory is a limit of at least 16 GiB | `max_lifetime_seconds` (counts paused time) | `debian` (default) or `devbox` base | yes (memory + disk) | Plain REST, no SDK. Streams NDJSON. Billed on what the box uses, not the limits. A paused box resumes on the next call. |
| Upstash Box | smallest of 3 fixed sizes that fits | TTL (max 3 days) | runtime name (node, python, ...) | no | Plain REST; billed on active CPU only. |
| Docker (local) | `--cpus`, `--memory` | container exits at the lifetime | any image | yes (`docker pause`) | Your machine, shared kernel. Never auto-routed; use `{ provider: "docker" }`. |

Capabilities in the catalog describe what each **adapter** implements, not everything a provider sells. Size limits are self-serve defaults and may be higher on your plan.

## Roadmap

- [x] More providers: Morph, Fly.io Sprites, Blaxel, Tensorlake, Runloop, HOPX, Northflank, Boat, exe.dev, Cloudflare (via a bridge Worker), Docker (local)
- [x] More providers: Koyeb, Freestyle, Deno, Beam, CodeSandbox, Upstash Box, Novita, Alibaba Cloud, Azure Container Apps sessions, AWS Bedrock AgentCore, AWS Lambda MicroVMs
- [x] YC sandbox startups: Agent37 (F26), Dedalus Machines (S25), InstaBox (P26), OpenScale (S22), Superserve (F26)
- [x] Sail Research Sailboxes
- [ ] More E2B-compatible clouds (PPIO, UCloud, Baidu) and Google Agent Engine sandboxes
- [x] Neutral routing: price decides, ties alphabetical, no privileged slot
- [x] Desktops and phones from 7 providers (Linux, Windows, Android, iOS), routed by price per OS
- [ ] Windows 365 for Agents and Corellium as opt-in computer providers
- [x] Streaming exec output
- [x] Pause/resume where providers support it
- [x] Python client
- [x] Leaderboard built from `bench --share` reports
- [x] Leak cleanup: a local ledger, `ls` and `gc`
- [x] One 14-step real-account check for every adapter, with a compatibility table and a nightly run
- [ ] Every adapter run against a real account (see the Compatibility table)
- [ ] Snapshots and forks as a routed operation
- [ ] A hosted copy of the leaderboard page

## Website

[`web/`](web/) is the project site: home, a browsable Sandboxes list with live price-per-size, a page per provider, Rankings, Docs, and a Playground that drives your own `sandboxrouter serve` from the browser. Its data is generated from the library (`npm run site:data`), so prices never drift from the code.

```bash
cd web && npm i && npm run dev          # http://localhost:3000
# Playground without any provider keys (in-memory providers, nothing real starts):
node --import tsx test/demo-server.ts   # token: demo
# Playground against real providers:
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve --cors http://localhost:3000
```

## Development

```bash
npm i
npm test             # router, HTTP server, and every adapter against a local mock of its API
npm run test:py      # Python client against the real HTTP server
npm run build
npm run dev -- providers
npm run price:check  # compare every provider's pricing page with the last check
node --import tsx scripts/readme-tables.ts --write   # regenerate the README's Prices, Env and Compatibility tables
```

Prices are list prices copied from each provider's public pricing page, with the date they were checked. A GitHub workflow runs `price:check` every Monday and opens an issue when a pricing page changes or a price is more than 45 days old; a person then updates [`src/catalog.ts`](src/catalog.ts).

See [CONTRIBUTING.md](CONTRIBUTING.md) to test a provider, fix a price or add one, [SECURITY.md](SECURITY.md) to report a vulnerability, and [CHANGELOG.md](CHANGELOG.md) for releases.

[MIT](LICENSE)
