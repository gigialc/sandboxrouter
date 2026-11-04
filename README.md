# sandboxrouter

**OpenRouter for sandboxes.** One API for every place an AI agent can run code: Maritime, E2B, Daytona, Modal and Vercel Sandbox. Routes on price, latency or capability, and falls back to the next provider when one is down or rate-limited.

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

- **One interface.** `create`, `exec`, `writeFile`, `readFile`, `kill`, the same on every provider.
- **Routing.** `default` (catalog order), `cheapest` (by list price for your shape) or `fastest` (by your own measured cold starts).
- **Fallback.** A failed create moves to the next candidate, and every attempt is recorded on `sbx.attempts`.
- **Capability filters.** Ask for a GPU and only GPU-capable providers are tried. Ask for 32 vCPU and providers that can't do it are skipped, with the reason.
- **BYOK.** Your keys and your accounts. Nothing is proxied through a third party.
- **HTTP server.** Run `sandboxrouter serve` and any language gets the same API.

## Prices

Estimated list price while running, 2 vCPU / 4 GB (`npx sandboxrouter providers --vcpu 2 --memory 4`):

| Provider | $/hr | Notes | Source |
|---|---|---|---|
| **Maritime** | **$0.022** | Per second, disk included. Firecracker micro-VMs. Also runs stock E2B SDK code. | [pricing](https://maritime.sh/pricing) |
| E2B | $0.166 | Per second. Pro plan $150/mo. | [pricing](https://e2b.dev/pricing) |
| Daytona | $0.166 | Per second, plus disk above 5 GiB. | [pricing](https://www.daytona.io/pricing) |
| Modal | $0.239 | Sandbox rates. GPUs available. | [pricing](https://modal.com/pricing) |
| Vercel Sandbox | $0.341 | Bills active CPU only. This is the 100%-CPU price; mostly idle work costs less. | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |

Checked 2026-11-04. Prices live in [`src/catalog.ts`](src/catalog.ts). If one is wrong, open a PR with the source link.

**Why Maritime is the default:** it's first in catalog order because it's the cheapest per hour at every shape in this table, so `default` and `cheapest` agree. Don't take that on trust: run `sandboxrouter bench` on your own accounts and route with `strategy: "fastest"` if latency matters more to you than price.

## Install

```bash
npm i sandboxrouter
# then install the SDK of each provider you use (Maritime needs none, it's plain REST):
npm i e2b                 # E2B
npm i @daytonaio/sdk      # Daytona
npm i modal               # Modal
npm i @vercel/sandbox     # Vercel Sandbox
```

Set the keys for the providers you want. Unconfigured providers are skipped.

| Provider | Env |
|---|---|
| Maritime | `MARITIME_API_KEY` (an `mk_` key with the `sandboxes` scope: `maritime keys create`) |
| E2B | `E2B_API_KEY` |
| Daytona | `DAYTONA_API_KEY` |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`, or `~/.modal.toml` |
| Vercel | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` |

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

// Ids are portable across processes: "provider:nativeId"
const again = await router.get(a.id);

// Dry run: who would be tried, in what order, and why anything is skipped
console.table(router.plan({ vcpu: 32 }));

await a.kill();
```

`create` throws a `RouterError` whose `attempts` lists every provider it tried and why each failed.

## CLI

```bash
npx sandboxrouter providers                    # price table + which keys are set
npx sandboxrouter route --gpu T4               # dry run
npx sandboxrouter run "uname -a && nproc"      # start, run, print, kill
npx sandboxrouter run "pytest -q" --provider e2b,maritime --keep
npx sandboxrouter bench --runs 5               # cold start + exec latency leaderboard
npx sandboxrouter serve --port 8787            # HTTP API
```

### Bench

`bench` starts real sandboxes on every configured provider, measures time to a usable sandbox and the round trip of `echo ok`, kills them, and prints a markdown leaderboard. Results are saved to `~/.sandboxrouter/bench.json`, which is what `strategy: "fastest"` routes on. Latency is measured from wherever you run it, so network distance counts. Post your table.

## HTTP API

```bash
SANDBOXROUTER_TOKEN=secret npx sandboxrouter serve
```

| Method | Path | Body |
|---|---|---|
| `GET` | `/v1/providers` | |
| `POST` | `/v1/route` | same as create; returns the candidate order |
| `POST` | `/v1/sandboxes` | `{ vcpu, memoryGb, gpu, env, timeoutMinutes, image, metadata, provider, strategy, fallback, require }` |
| `POST` | `/v1/sandboxes/:id/exec` | `{ cmd, cwd, env, timeoutSeconds }` |
| `PUT` | `/v1/sandboxes/:id/files?path=` | raw bytes |
| `GET` | `/v1/sandboxes/:id/files?path=` | |
| `DELETE` | `/v1/sandboxes/:id` | |

```bash
curl -s localhost:8787/v1/sandboxes -H "Authorization: Bearer secret" \
  -d '{"vcpu":2,"strategy":"cheapest"}'
# {"id":"maritime:sbx-k3m7q2ab","provider":"maritime","estimatedHourlyUsd":0.022,"attempts":[...]}
```

Provider keys stay on the server. Clients only hold `SANDBOXROUTER_TOKEN`. It binds to `127.0.0.1` by default.

## How each adapter maps the spec

| | vCPU / memory | Lifetime | Image | Notes |
|---|---|---|---|---|
| Maritime | `vcpu`, `memoryMib` | `timeLimitMinutes` (5 to 1,440) | `from` | REST. Files go through the shell as base64, because the public data plane documents `/commands` only. |
| E2B | set by the template | `timeoutMs` | template | Nonzero exits are returned as results, not thrown. |
| Daytona | only with `image.daytona` | `autoStopInterval` | `image` | stdout and stderr come back merged. |
| Modal | `cpu`, `memoryMiB`, `gpu` | `timeoutMs` | registry tag | Uses Modal app `sandboxrouter` (override with `SANDBOXROUTER_MODAL_APP`). |
| Vercel | `vcpus` (2 GB each) | `timeout` | `runtime` | Max 8 vCPU. |

Capabilities in the catalog describe what each **adapter** implements, not everything a provider sells. Size limits are self-serve defaults and may be higher on your plan.

## Roadmap

- [ ] More providers: Cloudflare Sandbox, Runloop, Morph, Blaxel, Fly Sprites, Tensorlake
- [ ] Desktops and phones (Maritime has Linux, Windows and Android computers on the same key)
- [ ] Streaming exec output
- [ ] Pause/resume and snapshots where providers support them
- [ ] Python client
- [ ] Hosted public leaderboard fed by `bench --share`

## Development

```bash
npm i
npm test          # router, HTTP server, and Maritime adapter against a contract mock
npm run build
npm run dev -- providers
```

Adding a provider means implementing `Provider` from [`src/types.ts`](src/types.ts) and adding a catalog entry with a pricing source link.

MIT
