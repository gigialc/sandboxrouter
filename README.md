# sandboxrouter

**One API for every sandbox.** A free, open-source router for the places an AI agent can run code: Alibaba Cloud, AWS (Bedrock AgentCore and Lambda MicroVMs), Azure Container Apps, Beam, Blaxel, Boat, Cloudflare, CodeSandbox, Daytona, Deno, E2B, exe.dev, Fly.io Sprites, Freestyle, HOPX, Koyeb, Maritime, Modal, Morph, Northflank, Novita, Runloop, Tensorlake, Upstash Box and Vercel, plus Docker on your own machine. It picks a provider by price, speed or capability, and falls back to the next one when a provider is down or rate-limited.

```ts
import { Router } from "@sandboxrouter/sdk";

const router = new Router();                       // uses whichever provider keys you've set
await using sbx = await router.create({ vcpu: 2, memoryGb: 4 });

const r = await sbx.exec("python3 -c 'print(6*7)'");
console.log(r.stdout, "ran on", sbx.provider);
```

Change providers without changing code. If one returns a 429, the next one takes the sandbox.

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

Estimated list price while running, 2 vCPU / 4 GB (`npx @sandboxrouter/sdk providers --vcpu 2 --memory 4`), in the order the router would try them:

| Provider | $/hr | Notes | Source |
|---|---|---|---|
| Boat | $0.018 | Fixed sizes billed per second ($0.018/h for 2 vCPU / 4 GB up to $0.20/h for 16 / 32); needs a plan from $20/mo, paid back as VM time | [pricing](https://docs.boat.dev/pricing.md) |
| Maritime | $0.022 | Per second, disk included | [pricing](https://maritime.sh/pricing) |
| Koyeb Sandboxes | $0.058 | Per second; fixed Standard instance sizes (1 vCPU + 1 GB = $0.0144/h); sandboxes need a paid plan (Pro $29/mo); public preview | [pricing](https://www.koyeb.com/docs/reference/instances) |
| Northflank | $0.067 | Per second on Northflank Cloud, ephemeral disk included; sandboxes run as deployment services (microVMs) | [pricing](https://northflank.com/pricing) |
| Morph Cloud | $0.100 | $0.05/MCU; MCU-hours = max(vCPU, RAM/4 GB, disk/16 GB); snapshots extra | [pricing](https://cloud.morph.so/web/pricing) |
| exe.dev | $0.105 | $0.105/h per 2 vCPU + 4 GiB, per second, up to 2 GiB per vCPU; needs an exe.dev subscription | [pricing](https://exe.dev/docs/standalone-vms.md) |
| Novita AI Agent Sandbox | $0.117 | Per second ($0.0000098/vCPU/s, $0.0000032/GiB/s); size comes from the template; paused = storage only | [pricing](https://docs.novita.ai/guides/sandbox-pricing) |
| Freestyle | $0.134 | Per second on allocated size; sizes fixed by base snapshot, disk included; free tier 200 vCPU-h + 400 GiB-h/mo; paused VMs bill storage only | [pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits) |
| Beam | $0.140 | Per second, Performance tier (sandbox default); Developer plan $20/mo incl. $20 credits; GPUs billed separately | [pricing](https://www.beam.cloud/pricing) |
| CodeSandbox SDK (Together) | $0.149 | Fixed VM tiers, credits at $0.01486 billed per started minute ($0.1486/h for 2 vCPU / 4 GB up to $4.7552/h for 64 / 128); free Build plan allows 10 concurrent VMs | [pricing](https://docs.together.ai/docs/together-code-sandbox-legacy) |
| Fly.io Sprites | $0.164 | Bills actual CPU and memory use; this is the full-use price; storage extra | [pricing](https://fly.io/sprites) |
| Blaxel | $0.166 | Billed on memory only ($0.0000115/GB-s), CPU scales with memory (~2 GB per core) | [pricing](https://blaxel.ai/pricing) |
| Daytona | $0.166 | Per second, plus disk above 5 GiB | [pricing](https://www.daytona.io/pricing) |
| E2B | $0.166 | Per second; Pro plan $150/mo | [pricing](https://e2b.dev/pricing) |
| HOPX | $0.166 | Per second, plus storage; size comes from the template, not the request | [pricing](https://hopx.ai/pricing) |
| Tensorlake | $0.200 | Bills active CPU (floor 20% of allocation); this is the full-use price; Pro plan is lower | [pricing](https://www.tensorlake.ai/pricing) |
| Upstash Box | $0.200 | Billed per active CPU core-hour only (memory and idle time free); estimate assumes every core of the box busy; fixed sizes 2/4, 4/8, 8/16 | [pricing](https://upstash.com/pricing/box) |
| Cloudflare Sandbox | $0.216 | Bills active CPU and provisioned memory of the instance type; this is the full-CPU price; needs Workers Paid ($5/mo) and the bridge Worker in bridges/cloudflare | [pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Amazon Bedrock AgentCore Code Interpreter | $0.217 | Per second; CPU billed on actual use (I/O wait free), memory on peak; fixed 2 vCPU / 8 GB session, this is the 100%-CPU price | [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) |
| Modal | $0.239 | Sandbox rates, GPUs extra; region pinning x1.15-1.75 | [pricing](https://modal.com/pricing) |
| AWS Lambda MicroVMs | $0.252 | Us-east-1 ARM; billed on the image's baseline size (2 GB per vCPU) while running, per-second burst up to 4x; suspended VMs pay snapshot storage; needs a MicroVM image you build once | [pricing](https://aws.amazon.com/lambda/pricing/) |
| Deno Sandbox | $0.300 | Billed on CPU time, not wall clock (estimate assumes both vCPUs busy); fixed 2 vCPU, 0.75-4 GB, max 30 min lifetime; needs a paid Deno Deploy plan | [pricing](https://deno.com/sandbox) |
| Runloop | $0.317 | Per second, plus disk; pause (suspend) is a Pro-plan feature | [pricing](https://www.runloop.ai/pricing) |
| Vercel Sandbox | $0.341 | Bills active CPU only; this is the 100%-CPU price, idle work costs less | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |
| Azure Container Apps dynamic sessions | skipped (max 1 vCPU) | Flat $0.03 per session-hour (built-in Shell pools), billed per allocated session in 1-hour increments, East US; needs a session pool you create once | [pricing](https://learn.microsoft.com/en-us/azure/container-apps/billing#dynamic-sessions) |
| Alibaba Cloud Agent Sandbox | skipped (max 2 GB memory) | Per second; Default QoS class, Hong Kong and regions outside mainland China; disk above 15 GiB extra; size comes from the template (E2B-compatible API) | [pricing](https://www.alibabacloud.com/help/en/agent-sandbox/product-overview/billing-overview) |
| Docker (local) | free | Runs on your own machine; free, but shares your kernel, so weaker isolation than a cloud micro-VM | [pricing](https://docs.docker.com/engine/) |

Checked 2026-11-04.

## Install

```bash
npm i @sandboxrouter/sdk
# then the SDK of each provider you use (Azure, AgentCore, Boat, Cloudflare, exe.dev, Freestyle, Koyeb,
# Lambda, Maritime, Upstash and Docker need none; the AWS ones need the signing packages below):
npm i e2b                       # E2B
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
| Deno Sandbox | `DENO_DEPLOY_TOKEN` |
| Docker (local) | none: Docker running locally |
| E2B | `E2B_API_KEY` |
| exe.dev | `EXE_TOKEN` |
| Fly.io Sprites | `SPRITES_TOKEN` |
| Freestyle | `FREESTYLE_API_KEY` |
| HOPX | `HOPX_API_KEY` |
| Koyeb Sandboxes | `KOYEB_API_TOKEN` |
| Maritime | `MARITIME_API_KEY` |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` |
| Morph Cloud | `MORPH_API_KEY` |
| Northflank | `NORTHFLANK_API_TOKEN` + `NORTHFLANK_PROJECT_ID` |
| Novita AI Agent Sandbox | `NOVITA_API_KEY` |
| Runloop | `RUNLOOP_API_KEY` |
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
const c = await router.create({}, { provider: ["maritime", "e2b"], fallback: false });

// Per-provider images: each provider names its templates differently
const d = await router.create({ image: { maritime: "python", e2b: "code-interpreter-v1", modal: "python:3.13-slim" } });

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
npx @sandboxrouter/sdk screenshot maritime:<id> --out screen.png
```

## CLI

```bash
npx @sandboxrouter/sdk providers                    # price table + which keys are set
npx @sandboxrouter/sdk route --gpu T4               # dry run
npx @sandboxrouter/sdk run "uname -a && nproc"      # start, run, print, kill
npx @sandboxrouter/sdk run "pytest -q" --provider e2b,maritime --keep
npx @sandboxrouter/sdk bench --runs 5               # cold start + exec latency table
npx @sandboxrouter/sdk bench --share --label "us-east-1"   # also write a report for results/
npx @sandboxrouter/sdk leaderboard results --out leaderboard.html
npx @sandboxrouter/sdk serve --port 8787            # HTTP API
```

### Bench

`bench` starts real sandboxes on every configured provider, measures time to a usable sandbox and the round trip of `echo ok`, kills them, and prints a markdown leaderboard. Results are saved to `~/.sandboxrouter/bench.json`, which is what `strategy: "fastest"` routes on. Latency is measured from wherever you run it, so network distance counts.

`--share` writes a JSON report (timings, your label, Node version and platform; never keys, env or error text). Open a PR adding it to [`results/`](results/). `sandboxrouter leaderboard` builds one static HTML page from every report there, taking the median of each submission's medians so one submitter can't dominate. Host the page anywhere static files go.

Testing an adapter against a real account:

```bash
sandboxrouter check --provider koyeb    # create, exec, env/cwd, streaming, binary files, timeout, pause, kill
```

It prints one line per step and exits 1 if any fails. `checkProvider(router, id)` does the same from code.

## HTTP API

```bash
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve
```

| Method | Path | Body |
|---|---|---|
| `GET` | `/v1/providers` | |
| `POST` | `/v1/route` | same as create; returns the candidate order |
| `POST` | `/v1/sandboxes` | `{ vcpu, memoryGb, gpu, env, timeoutMinutes, image, metadata, provider, strategy, fallback, require }` |
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
# {"id":"maritime:sbx-k3m7q2ab","provider":"maritime","estimatedHourlyUsd":0.022,"attempts":[...]}
```

Provider keys stay on the server. Clients only hold `SANDBOXROUTER_TOKEN`. It binds to `127.0.0.1` by default.

### Python

A standard-library client for the HTTP API lives in [`python/`](python/):

```python
from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="secret")
with sr.create(vcpu=2, memory_gb=4, strategy="cheapest") as sbx:
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
| Fly.io Sprites | `cpus`, `ramMB` (may be ignored) | none: `kill()` deletes | no | no | Sprites idle for free on their own. |
| Blaxel | memory (CPU follows) | `ttl` | image | yes (archive, disk only) | Idle sandboxes go to free standby on their own. |
| Tensorlake | `cpus`, `memoryMb` | idle timeout | image | yes (memory + disk) | Output is line-based. |
| Runloop | snapped to Runloop's custom sizes | `keep_alive_time_seconds` (max 48 h) | blueprint | yes (Pro plan) | Commands start in the home directory. |
| HOPX | set by the template | timeout | template | yes (memory + disk) | Size requests aren't applied, so the router only sends default-size work. |
| Northflank | cheapest `nf-compute` plan that fits | `expiryTime` (5 min to 7 days) | any public image | no | Runs as a deployment service; files move as base64 over exec. |
| Cloudflare | smallest instance type that fits | alarm in the bridge Worker | Dockerfile in the bridge | no | Through the bridge Worker you deploy ([`bridges/cloudflare`](bridges/cloudflare)). |
| Boat | smallest of 4 fixed sizes that fits | auto-stop timer | saved snapshot | yes (stop: disk kept, processes end) | Plain REST. Commands that wait are capped at 600 s; files API up to 5 MiB. |
| exe.dev | `--cpu`, `--memory` (2 GiB per vCPU max) | none: `kill()` deletes | `--image` | no | Plain REST over exe.dev's `/exec`; long commands run detached and are polled. |
| Alibaba Cloud | set by the template | `timeoutMs` (max 24 h) | template | no (allowlist only) | E2B-compatible API via the `e2b` SDK; region from `ALIBABA_SANDBOX_REGION` (default ap-southeast-1). |
| AgentCore | fixed 2 vCPU / 8 GB | `sessionTimeoutSeconds` (max 8 h) | no | no | SigV4, plain fetch; files move as base64 over commands. Opt-in. |
| Azure sessions | fixed by the pool | pool cooldown (5 to 60 min idle) | no | no | Shell session pool; output over 4 KB is fetched from files. |
| Beam | `cpu`, `memory` | `keepWarmSeconds` | registry image | no | Uses Beam app `sandboxrouter` (override with `SANDBOXROUTER_BEAM_APP`). |
| CodeSandbox | smallest of 7 fixed tiers that fits | hibernation timeout | template | yes (hibernate: memory + disk) | Exec output goes through files because the SDK's terminal merges streams. |
| Deno | fixed 2 vCPU, 0.75 to 4 GB | up to 30 min | snapshot or volume | no | WebSocket RPC via `@deno/sandbox`. |
| Freestyle | smallest Ubuntu snapshot that fits | `ttlSeconds` | snapshot | yes (memory + disk) | Plain REST; long commands run as background requests and are polled. |
| Koyeb | smallest Standard instance that fits | auto-delete delay (max 24 h) | any Docker image | no | Plain REST; streams over SSE. Public preview. |
| Lambda MicroVMs | image baseline (2 GB per vCPU) | `maximumDurationInSeconds` | your MicroVM image | yes (suspend/resume) | Runs the bundled in-VM server for exec and files. |
| Novita | set by the template | `timeoutMs` | template | yes (memory + disk) | `novita-sandbox` SDK (an E2B fork). |
| Upstash Box | smallest of 3 fixed sizes that fits | TTL (max 3 days) | runtime name (node, python, ...) | no | Plain REST; billed on active CPU only. |
| Docker (local) | `--cpus`, `--memory` | container exits at the lifetime | any image | yes (`docker pause`) | Your machine, shared kernel. Never auto-routed; use `{ provider: "docker" }`. |

Capabilities in the catalog describe what each **adapter** implements, not everything a provider sells. Size limits are self-serve defaults and may be higher on your plan.

## Roadmap

- [x] More providers: Morph, Fly.io Sprites, Blaxel, Tensorlake, Runloop, HOPX, Northflank, Boat, exe.dev, Cloudflare (via a bridge Worker), Docker (local)
- [x] More providers: Koyeb, Freestyle, Deno, Beam, CodeSandbox, Upstash Box, Novita, Alibaba Cloud, Azure Container Apps sessions, AWS Bedrock AgentCore, AWS Lambda MicroVMs
- [ ] More E2B-compatible clouds (PPIO, UCloud, Baidu) and Google Agent Engine sandboxes
- [x] Neutral routing: price decides, ties alphabetical, no privileged slot
- [x] Desktops and phones from 7 providers (Linux, Windows, Android, iOS), routed by price per OS
- [ ] Windows 365 for Agents and Corellium as opt-in computer providers
- [x] Streaming exec output
- [x] Pause/resume where providers support it
- [x] Python client
- [x] Leaderboard built from `bench --share` reports
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
npm test          # router, HTTP server, leaderboard, Maritime sandboxes + computers against contract mocks
npm run test:py   # Python client against the real HTTP server
npm run build
npm run dev -- providers
```

Adding a provider means implementing `Provider` from [`src/types.ts`](src/types.ts) and adding a catalog entry with a pricing source link.

MIT
