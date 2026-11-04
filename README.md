# sandboxrouter

**OpenRouter for sandboxes.** One API for every place an AI agent can run code: Maritime, E2B, Daytona, Modal, Vercel Sandbox, Morph, Fly.io Sprites, Blaxel, Tensorlake and Runloop. Routes on price, latency or capability, and falls back to the next provider when one is down or rate-limited. Also drives desktops and phones for computer-use agents.

```ts
import { Router } from "sandboxrouter";

const router = new Router();                       // reads provider keys from env
await using sbx = await router.create({ vcpu: 2, memoryGb: 4 });

const r = await sbx.exec("python3 -c 'print(6*7)'");
console.log(r.stdout, "ran on", sbx.provider);     // 42 ran on maritime
```

Change providers without changing code. If one returns a 429, the next one takes the sandbox.

## Why

Agents need a disposable computer: to run code a model wrote, install packages, run tests, scrape, or do an RL rollout. In 2026 there are more than a dozen sandbox providers, each with its own SDK, auth, lifecycle and price. A 2 vCPU / 4 GB box costs anywhere from **$0.022/hr to $0.34/hr** depending on where you start it.

So every agent team either locks into one provider or writes its own adapter layer. sandboxrouter is that adapter layer, done once, in the open:

- **One interface.** `create`, `exec`, `writeFile`, `readFile`, `pause`, `kill`, the same on every provider. `exec` streams stdout and stderr as they happen.
- **Routing.** `default` (catalog order), `cheapest` (by list price for your shape) or `fastest` (by your own measured cold starts).
- **Fallback.** A failed create moves to the next candidate, and every attempt is recorded on `sbx.attempts`.
- **Capability filters.** Ask for a GPU and only GPU-capable providers are tried. Ask for 32 vCPU and providers that can't do it are skipped, with the reason.
- **BYOK.** Your keys and your accounts. Nothing is proxied through a third party.
- **HTTP server and Python client.** Run `sandboxrouter serve` and any language gets the same API.
- **Computers.** Linux and Windows desktops and Android phones for computer-use models: actions, screenshots, and a takeover link for a person when the model hits a login.
- **Open leaderboard.** `bench --share` produces a report; the leaderboard is built from submitted reports in [`results/`](results/).

## Prices

Estimated list price while running, 2 vCPU / 4 GB (`npx sandboxrouter providers --vcpu 2 --memory 4`):

| Provider | $/hr | Notes | Source |
|---|---|---|---|
| **Maritime** | **$0.022** | Per second, disk included. Firecracker micro-VMs. Also runs stock E2B SDK code. | [pricing](https://maritime.sh/pricing) |
| Morph Cloud | $0.100 | $0.05 per MCU; an MCU-hour is the larger of 1 vCPU, 4 GB RAM or 16 GB disk. | [pricing](https://cloud.morph.so/web/pricing) |
| Fly.io Sprites | $0.165 | Bills actual CPU and memory use; this is the full-use price. Storage extra. | [pricing](https://fly.io/sprites) |
| E2B | $0.166 | Per second. Pro plan $150/mo. | [pricing](https://e2b.dev/pricing) |
| Daytona | $0.166 | Per second, plus disk above 5 GiB. | [pricing](https://www.daytona.io/pricing) |
| Blaxel | $0.166 | Billed on memory only; CPU scales with memory. | [pricing](https://blaxel.ai/pricing) |
| Tensorlake | $0.200 | Bills active CPU (20% floor); this is the full-use price. Pro plan is cheaper. | [pricing](https://www.tensorlake.ai/pricing) |
| Modal | $0.239 | Sandbox rates. GPUs available. | [pricing](https://modal.com/pricing) |
| Runloop | $0.317 | Per second, plus disk. Suspend/resume is a Pro feature. | [pricing](https://www.runloop.ai/pricing) |
| Vercel Sandbox | $0.341 | Bills active CPU only. This is the 100%-CPU price; mostly idle work costs less. | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |

Checked 2026-11-04. Prices live in [`src/catalog.ts`](src/catalog.ts). If one is wrong, open a PR with the source link.

**Why Maritime is the default:** it's first in catalog order because it's the cheapest per hour at every shape in this table (there's a test that checks this against the catalog), so `default` and `cheapest` agree. Don't take that on trust: run `sandboxrouter bench` on your own accounts and route with `strategy: "fastest"` if latency matters more to you than price.

## Install

```bash
npm i sandboxrouter
# then install the SDK of each provider you use (Maritime needs none, it's plain REST):
npm i e2b                 # E2B
npm i @daytonaio/sdk      # Daytona
npm i modal               # Modal
npm i @vercel/sandbox     # Vercel Sandbox
npm i morphcloud          # Morph Cloud
npm i @fly/sprites        # Fly.io Sprites (needs Node 24+ per its package)
npm i @blaxel/core        # Blaxel
npm i @tensorlakeai/tensorlake  # Tensorlake
npm i @runloop/api-client # Runloop
```

Set the keys for the providers you want. Unconfigured providers are skipped.

| Provider | Env |
|---|---|
| Maritime | `MARITIME_API_KEY` (an `mk_` key with the `sandboxes` scope: `maritime keys create`) |
| E2B | `E2B_API_KEY` |
| Daytona | `DAYTONA_API_KEY` |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`, or `~/.modal.toml` |
| Vercel | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` |
| Morph | `MORPH_API_KEY` |
| Fly.io Sprites | `SPRITES_TOKEN` |
| Blaxel | `BL_API_KEY` + `BL_WORKSPACE` (optional `BL_REGION`, default `us-pdx-1`) |
| Tensorlake | `TENSORLAKE_API_KEY` |
| Runloop | `RUNLOOP_API_KEY` |

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

For computer-use agents: a machine with a screen that your model drives with clicks and keys. Maritime provides Linux desktops, Windows desktops and Android phones on the same key. Actions use the Anthropic computer-use shape.

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
npx sandboxrouter desktop --os linux --user user_42 --control   # prints a takeover link
npx sandboxrouter screenshot maritime:<id> --out screen.png
```

## CLI

```bash
npx sandboxrouter providers                    # price table + which keys are set
npx sandboxrouter route --gpu T4               # dry run
npx sandboxrouter run "uname -a && nproc"      # start, run, print, kill
npx sandboxrouter run "pytest -q" --provider e2b,maritime --keep
npx sandboxrouter bench --runs 5               # cold start + exec latency table
npx sandboxrouter bench --share --label "us-east-1"   # also write a report for results/
npx sandboxrouter leaderboard results --out leaderboard.html
npx sandboxrouter serve --port 8787            # HTTP API
```

### Bench

`bench` starts real sandboxes on every configured provider, measures time to a usable sandbox and the round trip of `echo ok`, kills them, and prints a markdown leaderboard. Results are saved to `~/.sandboxrouter/bench.json`, which is what `strategy: "fastest"` routes on. Latency is measured from wherever you run it, so network distance counts.

`--share` writes a JSON report (timings, your label, Node version and platform; never keys, env or error text). Open a PR adding it to [`results/`](results/). `sandboxrouter leaderboard` builds one static HTML page from every report there, taking the median of each submission's medians so one submitter can't dominate. Host the page anywhere static files go.

## HTTP API

```bash
SANDBOXROUTER_TOKEN=secret npx sandboxrouter serve
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

Capabilities in the catalog describe what each **adapter** implements, not everything a provider sells. Size limits are self-serve defaults and may be higher on your plan.

## Roadmap

- [x] More providers: Morph, Fly.io Sprites, Blaxel, Tensorlake, Runloop
- [x] Desktops and phones (Maritime: Linux, Windows, Android)
- [x] Streaming exec output
- [x] Pause/resume where providers support it
- [x] Python client
- [x] Leaderboard built from `bench --share` reports
- [ ] Cloudflare Sandbox. Its SDK runs only inside a Worker with a Durable Object binding, so it needs a small Worker shim the router can call
- [ ] Computers on more providers (E2B Desktop, Daytona computer use)
- [ ] Snapshots and forks as a routed operation
- [ ] A hosted copy of the leaderboard page

## Website

[`web/`](web/) is the project site: home, a browsable Sandboxes list with live price-per-size, a page per provider, Rankings, Docs, and a Playground that drives your own `sandboxrouter serve` from the browser. Its data is generated from the library (`npm run site:data`), so prices never drift from the code.

```bash
cd web && npm i && npm run dev          # http://localhost:3000
# Playground without any provider keys (in-memory providers, nothing real starts):
node --import tsx test/demo-server.ts   # token: demo
# Playground against real providers:
SANDBOXROUTER_TOKEN=secret npx sandboxrouter serve --cors http://localhost:3000
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
