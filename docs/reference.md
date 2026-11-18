# sandboxrouter reference

Everything the [README](../README.md) leaves out. The tables marked generated are rebuilt from the code (`node --import tsx scripts/readme-tables.ts --write`).

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

Cloudflare sandboxes only run inside a Cloudflare Worker, so you deploy a small bridge Worker to your own account first: see [`bridges/cloudflare`](../bridges/cloudflare).

Three providers need a one-time setup in your cloud account, described at the top of each adapter: Azure needs a Shell session pool ([`src/providers/azure.ts`](../src/providers/azure.ts)), Lambda MicroVMs need an image built from the bundled server ([`src/providers/lambda.ts`](../src/providers/lambda.ts), `writeLambdaMicrovmBundle()`), and AgentCore is opt-in: set `AGENTCORE_CODE_INTERPRETER_ID=aws.codeinterpreter.v1` so plain AWS credentials don't route work there by surprise.

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
const a = await router.create({ vcpu: 8, memoryGb: 16 }, { strategy: "cheapest" }); // lowest cost for the run, strictly by price; the default also breaks near-ties by speed

// GPU: only GPU-capable providers are tried (Modal today)
const b = await router.create({ gpu: "A10G", image: { modal: "pytorch/pytorch:latest" } });

// Pin providers in order; with fallback off it's the first one named or an error, never another
const c = await router.create({}, { provider: ["e2b", "daytona"], fallback: false });

// Fallback moves on when a provider is down: a timeout, a network error, 429 or 5xx, and a create
// that takes longer than createTimeoutSeconds (default 120; a sandbox that turns up later is
// killed, or left in the ledger for `gc`), and when an account can't pay (402: no balance, plan
// needed). A setup error (400, 401, 403, 404, 422: a bad key, a bad image or request) stops instead,
// so a mistake isn't hidden by a pricier provider. Every failed attempt is on sbx.attempts.
// fallback: "any" falls back on every error. deadlineSeconds (default 240) bounds the whole create.
// Once the router knows a provider's usual start time (3 of its own creates, or your bench file), it
// moves on sooner when a create runs far past it: 5x the usual time, at least 10 s, and never for the
// last provider left or when you set createTimeoutSeconds. new Router({ quickFallback: false }) turns
// that off; { factor, minSeconds } tunes it.
const e = await router.create({}, { fallback: "any", createTimeoutSeconds: 300, deadlineSeconds: 600 });

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

// For provider-specific features such as snapshots, use the connected provider SDK object.
// On providers driven over plain HTTP, use a.nativeId with the provider API.
if (a.provider === "e2b") console.log((a.native as import("e2b").Sandbox).sandboxId);

// Dry run: who would be tried, in what order, and why anything is skipped
console.table(router.plan({ vcpu: 32 }));

await a.kill();
```

### Sizes and prices

With no size, any provider can take the sandbox at the size it starts by default: 2 vCPU / 4 GB on most, but a fixed, smaller image on some (Daytona 1 vCPU / 1 GB, E2B 2 vCPU / 0.5 GB, OpenScale 2 vCPU / 1 GB). Set `vcpu` or `memoryGb` and only providers that can give that size are tried (those three need a custom `image` built at the size). Each candidate and each sandbox says what it gets:

| Field | On | Meaning |
|---|---|---|
| `size` | `Candidate`, `RoutedSandbox`, HTTP create | `{ vcpu, memoryGb }`: the fixed image size, or what you asked for. Some providers round up |
| `listHourlyUsd` | same | the provider's published price for that size |
| `estimatedHourlyUsd` | same | what it's expected to cost: list price times what the provider really billed against list, where we measured that (`billedVsList`, from `BILLED_VS_LIST`). This is what the default route ranks by, and what a service reselling sandboxes should charge from |
| `perSandboxUsd` | `Candidate` | a fixed charge per sandbox on top of running time, where the provider has one (Sail's free plan: $0.01) |

Some providers also round: Agent37 and CodeSandbox bill whole minutes (at least one), Vercel at least a minute, Azure whole hours. `billingRules(provider)` returns `{ minSeconds, incrementSeconds, perSandboxUsd }`, and `billedUsd(provider, hourlyUsd, seconds)` what one sandbox that ran that long costs. A service reselling sandboxes should charge from those, or it pays the difference on short sandboxes.

A handle from `router.get(id)` has these only if this machine's ledger recorded the create.

### Routing

`strategy` orders the providers you have keys for:

- `balanced` (default): cheapest for the run: `estimatedHourlyUsd` over `expectedSeconds` if you give it (else `timeoutMinutes`, default 30), rounded up to the provider's minimum charge and billing increment, plus any `perSandboxUsd`. So `expectedSeconds: 10` favors providers that bill by the second over ones that charge a full minute; providers within 10% of each other go fastest first, by this router's own recent create times (after 3), else your `bench` file. Providers whose last real-account check failed (`FAILING`) go last, still as fallback.
- `cheapest`: lowest cost for the run, priced as in `balanced` (minimum charge, billing increment, per-sandbox charge), strictly by price: no speed tie-break, and providers whose last check failed aren't moved last.
- `fastest`: lowest create time, then cheapest.
- `verified`: providers that passed the real-account check (`VERIFIED`) first, then the rest, each cheapest first.

`cpuUtilization` (0 to 1, default 1) says how busy the CPU will be. Providers that bill CPU only while it's busy (`billing: "active-cpu"`: Vercel, Cloudflare, Tensorlake, AgentCore, Sail, Sprites, Deno, Upstash) are priced at that share of their CPU plus their full memory, so `{ cpuUtilization: 0.1 }`, about what an agent waiting on model calls uses, makes them much cheaper than their full-CPU list price. Tensorlake never goes below its 20% CPU floor (`cpuFloor`), and Vercel's one-minute minimum covers memory only (`minimumCovers: "memory"`). Providers that bill allocated capacity, Modal included (it bills the larger of its reservation and actual use, and the adapter reserves the size you ask for), aren't affected. Candidates carry the CPU part as `cpuHourlyUsd`.

`maxHourlyUsd` caps the price: a provider is skipped (`skip: "over your price cap: …"`) when this run would cost more per hour there, priced the same way as ranking, so a provider that bills a full minute is over a cap that its hourly price alone would pass when `expectedSeconds` is short. When the cap leaves nothing, the error names the cheapest provider and its price for the run.

```ts
await router.create({ vcpu: 2, memoryGb: 4, expectedSeconds: 10 }, { maxHourlyUsd: 0.03 });
```

`router.quote(spec, route)` says where a create would land and what the run would cost, without starting anything: `{ provider, size, hourlyUsd, listHourlyUsd, runSeconds, runHourlyUsd, estimatedUsd, minimumSeconds?, billedInSecondsOf?, perSandboxUsd?, candidates }`. `sandboxrouter quote --expect 10` prints it.

`new Router({ requireVerified: true })` uses only providers that passed the check: for a service that runs sandboxes on its own accounts. Such a service should also pass `accountErrors: "fallback"`, so a provider's 401 or 403 (a revoked key, a frozen workspace, a creation cap) moves the work to the next provider instead of failing the request; by default those stop, since with your own keys they are a key to fix. `verified`, `failing` and `billedVsList` replace the shipped lists.

### Errors

`create`, `plan` and `get` throw a `RouterError` with a `code`, and `attempts` listing every provider tried and why each failed (`status` is the provider's HTTP status, where it gave one). The HTTP API returns `{ error, code, attempts }` with the matching status:

| `code` | HTTP | When | What to do |
|---|---|---|---|
| `bad_request` | 400 | an invalid spec, route option or id (sizes and times must be positive numbers; unknown fields are refused) | fix the request |
| `unsupported` | 400 | the provider can't do this, e.g. pause | create with `require: [...]` |
| `no_provider` | 422 | no provider you have keys for can take it; the message says why for each | add a key, change the size, or `plan()` to see |
| `setup` | 502 | a provider refused the key, image or request (400/401/403/404/422 from it) | fix the key or image; `fallback: "any"` moves on instead |
| `all_failed` | 503 | every provider tried was down, busy or out of credit | retry later |
| `timeout` | 504 | the create ran out of `deadlineSeconds` | retry, or raise it |

A command that outlives its `timeoutSeconds` rejects with `ProviderError("<provider>: command timed out after Ns")`, HTTP 504.

## Computers (desktops and phones)

For computer-use agents: a machine with a screen that your model drives with clicks and keys. `router.computer({ os }, route)` starts one on the cheapest provider for that OS among those you have keys for, ties alphabetical, with the same fallback rules as a sandbox: on to the next provider when one is down, slow or can't bill, a stop on a setup error, `createTimeoutSeconds` (default 120) and `deadlineSeconds` (default 240), and every attempt on `pc.attempts`. Actions use the Anthropic computer-use shape on every provider.

Computers go in the same ledger as sandboxes. They have no lifetime of their own (the same `externalUserId` gets the same desktop back), so `sandboxrouter ls` shows them and `gc --all` deletes them, but plain `gc` leaves them. `pc.delete()` (or `pc.kill()`, or `await using`) removes one and everything on it.

| Provider | Linux | Windows | Android | iOS | Default size | Live view |
|---|---|---|---|---|---|---|
| AWS WorkSpaces (agent access) | $0.138 | $0.150 | | | 2 vCPU · 4 GB | watch only |
| Daytona | $0.067 | | | | 1 vCPU · 1 GB | watch/control link |
| E2B Desktop | $0.533 | | | | 8 vCPU · 8 GB | watch/control link |
| Limrun | | | $3.00 | $6.00 | phone emulator / iPhone simulator | interactive link |
| Maritime | $0.120 | $0.180 | $0.150 | | 2 vCPU · 4 GB | view-only and takeover links |
| Mobilerun | | | $1.80 | | cloud phone | embedded player |
| Orgo | $0.055 | plan | | | 2 vCPU · 8 GB | VNC (full control) |

Per hour while awake, from each provider's pricing page (sources in [`src/computers.ts`](../src/computers.ts)). Sizes differ, so compare price and size together. Only Maritime and AWS enforce view-only on the server; on the others a "watch" link can be turned into control, so treat it like a password. Mobilerun and AWS have no shell; Limrun's iOS has no shell. AWS needs a fleet and stack you provision once (steps at the top of [`src/providers/workspaces.ts`](../src/providers/workspaces.ts)).

```ts
const desk = await router.computer({ os: "linux", externalUserId: "user_42" }); // same id, same desktop
const shot = await desk.act({ action: "screenshot" });            // { frameId, width, height, imageB64 }
await desk.act({ action: "left_click", coordinate: [412, 230] });
await desk.actBatch([{ action: "type", text: "hello" }, { action: "key", text: "Return" }]);
await desk.exec("ls /data", { timeoutSeconds: 20 });

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
npx @sandboxrouter/sdk bench --task                 # also time and price a fixed job in each sandbox
npx @sandboxrouter/sdk bench --task --long --parallel 4   # the job 40 times in a row, 4 providers at once
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

`burst --n 100 [--job python|agent]` asks each provider for N sandboxes at once and reports how many started, time to interactive at p50/p95/p99 counted from the burst's start, how long until all finished and what they cost; `--job python` runs a Python step in each (RL rollouts), `--job agent` the agent loop (parallel agents). `agentbench [--runs 5] [--model gemini-3.5-flash]` has a real model (`GEMINI_API_KEY`, kept on your machine) do the same task in a sandbox on each provider with one shell tool, and reports how often it was done right, session time, time waiting on the model and the sandbox's cost. `bench --task --job repo` installs and typechecks a real TypeScript project. All three take `--share`, `--label`, `--by` and `--submit`.

`bench --submit` runs the benchmark and opens a pull request with the report through the GitHub CLI (`gh`), forking the repo if needed; it implies `--share`. Shared reports leave out providers whose every run failed on your own account (a setup error, payment, a limit), and nothing is written when several providers fail on the network at once.

`bench --task` also runs the same fixed job in every sandbox, to compare what work costs rather than what an hour costs: hash 512 MB of zeros on one core, then 256 MB on each of two cores at once, then write and flush 256 MB to disk (`src/task.ts`). It uses only `head`, `sha256sum` and `dd`, which every Linux image has. Each step is timed from your machine minus the sandbox's round trip for an empty command, so network distance mostly drops out. The job is priced as the provider would bill it: the start plus the task, rounded up to its minimum charge and billing step, plus any per-sandbox fee. What it measures is CPU and disk speed for this job; it doesn't cover networking, package installs or GPUs. `--long` runs each step 40 times in a row (minutes instead of seconds), which shows whether a provider keeps its speed under steady load and how prices compare once minimum charges stop mattering. Reports made with `--share` record the task version (`task: "v1"`, or `"v1-long"`); changing the job bumps the version, and older reports stop counting. Each step also reads the sandbox's own CPU counters (`/proc/stat`) before and after, so the report records the CPU time the job really used (`medianTaskCpuMs`); providers that bill active CPU are priced by that, plus their memory for the whole run. `--job python` runs a pure-Python script instead (200,000 records through JSON, a regex and a sort, like a code-interpreter call; providers without `python3` fail it), and `--job download` downloads the 53 MB Node.js release from nodejs.org's CDN (curl, else wget, else python3). `--parallel N` benches N providers at once, which matters for the long job.

`--share` writes a JSON report (timings, your label, Node version and platform; never keys, env or error text), and `--by` adds your GitHub username so the website can credit you. Open a PR adding it to [`results/`](../results/); CI checks every result file for keys, addresses and impossible numbers (`npm run results:check`), see [Sending results](../CONTRIBUTING.md#sending-results). `sandboxrouter leaderboard` builds one static HTML page from every report there, taking the median of each submission's medians so one submitter can't dominate. Host the page anywhere static files go.

### Compare your own workload

`sandboxrouter compare "<cmd>" [--setup "<cmd>"] [--runs 3] [--provider a,b] [--seconds 600] [--json]` runs your own command in a new sandbox on each provider, a few times, after an optional setup command (installs, a clone). It reports how many runs worked, the median start, setup and command time, and the estimated cost of one run: the sandbox's whole life priced by that provider's billing rules, with every core busy. Times are measured; costs are estimates, marked where the provider's real bill has been measured. Failures aren't dropped: a provider where the sandbox didn't start, the setup failed or the command failed is listed with the count of each and the first error, which also shows which providers your environment works on. `compare({ providers, command, setup, runs })` does the same in code.

### Cooldowns

The router remembers trouble between creates. A provider that refuses for a limit (a 429, a quota, a concurrency cap) goes to the back of the line for 30 seconds, and one that fails 3 creates within a minute goes to the back for 60, so one provider's outage or rate limit doesn't slow every request. It's still tried when nothing else can take the sandbox, and one success clears it. `router.troubled()` lists the providers cooling and why; `plan()` entries carry `cooling`. Tune with `new Router({ cooldown: { limitSeconds, failures, windowSeconds, downSeconds } })`, or turn it off with `cooldown: false`.

`burst --spread --n 1000` measures this at scale: N sandboxes at once over all the providers you name, dealt in proportion to each one's capacity measured in the published bursts (`--even` for equal shares), with a provider that hits a limit handing its share to the next one with room.

### Which provider for a job

`recommend [--job short|long|python|download|agent|repo|start] [--count N] [--priority value|cost|speed] [--reuse] [--provider a,b] [--json]` ranks providers for a job from the published benchmarks, which ship in the package (`PUBLISHED`, generated from `results/` by `scripts/site-data.ts`). Costs and times are per successful run: each is divided by the provider's success rate. With `--count` of 10 or more, start times come from the burst of the largest measured size not above it; providers not measured at that size are listed after the ones that were. `recommend(PUBLISHED, options)` does the same in code, and the router uses the published start times for the speed tie-break and `strategy: "fastest"` when neither it nor your bench file has timed a provider (`new Router({ published: false })` turns that off).

The website serves the same data to agents: `/benchmarks.json`, `/llms.txt`, Markdown for any page (`Accept: text/markdown`, or a `.md` path), and a public MCP server at `https://www.sandboxrouter.ai/mcp` (Streamable HTTP, no auth) with `recommend_provider`, `get_benchmarks`, `get_provider` and `list_providers`. They all rank with the same `src/recommend.ts` (the site carries a generated copy).

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
| Agent37 | 14/14 passed; note: output arrived only at the end (no live streaming) | 2026-11-13, v0.7.0 |
| Boat | 14/14 passed | 2026-11-14, v0.8.1 |
| Maritime | 14/14 passed | 2026-11-13, v0.7.0 |
| Sailboxes (Sail Research) | 14/14 passed | 2026-11-14, v0.8.0 |
| Northflank | not run yet | |
| Morph Cloud | not run yet | |
| exe.dev | not run yet | |
| Novita AI Agent Sandbox | 14/14 passed | 2026-11-13, v0.7.0 |
| Freestyle | 14/14 passed; note: output arrived only at the end (no live streaming) | 2026-11-13, v0.7.0 |
| Beam | not run yet | |
| CodeSandbox SDK (Together) | not run yet | |
| Fly.io Sprites | 13/13 passed; n/a: pause and resume | 2026-11-13, v0.7.0 |
| Blaxel | 13/13 passed; n/a: pause and resume | 2026-11-13, v0.7.0 |
| HOPX | not run yet | |
| Superserve | 14/14 passed | 2026-11-13, v0.7.0 |
| Tensorlake | 14/14 passed | 2026-11-14, v0.8.0 |
| Upstash Box | not run yet | |
| Cloudflare Sandbox | 13/13 passed; n/a: pause and resume | 2026-11-13, v0.7.0 |
| Amazon Bedrock AgentCore Code Interpreter | 13/13 passed; n/a: pause and resume; note: output arrived only at the end (no live streaming) | 2026-11-13, v0.7.0 |
| Modal | 13/13 passed; n/a: pause and resume | 2026-11-13, v0.7.0 |
| AWS Lambda MicroVMs | 14/14 passed | 2026-11-13, v0.7.0 |
| Deno Sandbox | not run yet | |
| Runloop | not run yet | |
| Vercel Sandbox | 13/13 passed; n/a: pause and resume | 2026-11-13, v0.7.0 |
| InstaBox | not run yet | |
| Koyeb Sandboxes | not run yet | |
| Dedalus Machines | not run yet | |
| LangSmith Sandboxes | not run yet | |
| OpenScale Sandboxes | 14/14 passed | 2026-11-13, v0.7.0 |
| Azure Container Apps dynamic sessions | not run yet | |
| Daytona | 14/14 passed | 2026-11-13, v0.7.0 |
| Alibaba Cloud Agent Sandbox | not run yet | |
| E2B | 14/14 passed | 2026-11-13, v0.7.0 |
| Docker (local) | 14/14 passed | 2026-11-13, v0.7.0 |

## Preview URLs and background commands

`ports` declares the HTTP ports your application will listen on. Declaring any port requires the `ports` capability, which you can also select explicitly. Add `background` when you need a process handle as well as a preview URL. Vercel, Modal and Docker require the declaration at creation. Providers with dynamic previews can resolve or open a port on demand.

```ts
const sbx = await router.create({ ports: [3000], timeoutMinutes: 10 }, { require: ["ports", "background"] });
const server = await sbx.start("exec python3 -m http.server 3000 --bind 0.0.0.0", { cwd: "/tmp" });
const preview = await sbx.url(3000);
console.log(preview);
```

`start` returns when the provider accepts the command. Wait for your service to listen before sharing the link. Preview visibility and expiry depend on the provider. Deno opens a public URL when you call `url`. A signed link can grant access to the service. Docker publishes its previews on the Docker host's loopback address.

Call `await server.kill()` to stop the command and keep using the sandbox. Launch the server binary with `exec` so the handle tracks it. Providers can signal only the tracked process when a command spawns children. Call `await sbx.kill()` to release the sandbox and all its processes.

## HTTP API

```bash
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve
```

| Method | Path | Body |
|---|---|---|
| `GET` | `/v1/providers` | |
| `POST` | `/v1/route` | same as create; returns the candidate order |
| `POST` | `/v1/quote` | same as create; returns `router.quote()`: the provider a create would use and the run's estimated cost |
| `POST` | `/v1/sandboxes` | `{ vcpu, memoryGb, gpu, env, ports, timeoutMinutes, expectedSeconds, cpuUtilization, image, metadata, provider, strategy, fallback, createTimeoutSeconds, deadlineSeconds, require, maxHourlyUsd }`. Other fields are refused. Answers `{ id, provider, size, estimatedHourlyUsd, listHourlyUsd, attempts }` |
| `POST` | `/v1/sandboxes/:id/exec` | `{ cmd, cwd, env, timeoutSeconds, stream }`. With `stream: true` the answer is `text/event-stream`: `stdout` and `stderr` events, then `result` |
| `GET` | `/v1/sandboxes/:id/ports/:port` | Returns `{ url }` |
| `POST` | `/v1/sandboxes/:id/processes` | `{ cmd, cwd, env }`. Returns `201 { id }` |
| `DELETE` | `/v1/sandboxes/:id/processes/:processId` | Stops the command and returns `{ id, killed: true }` |
| `POST` | `/v1/sandboxes/:id/pause` | |
| `PUT` | `/v1/sandboxes/:id/files?path=` | raw bytes |
| `GET` | `/v1/sandboxes/:id/files?path=` | |
| `DELETE` | `/v1/sandboxes/:id` | |
| `POST` | `/v1/computers` | `{ os, externalUserId, name, screen, arch, provider, fallback, createTimeoutSeconds, deadlineSeconds }`. Other fields are refused. On a server with `authorize`, off unless `computers: true`, and then guarded by `owns` and the computer hooks |
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
# {"id":"maritime:sbx-…","provider":"maritime","size":{"vcpu":2,"memoryGb":4},"estimatedHourlyUsd":0.022,"listHourlyUsd":0.022,"attempts":[...]}
```

Errors are `{ error, code, attempts }` (see [Errors](#errors)). On a single server process, send `Idempotency-Key: <unique string>` on `POST /v1/sandboxes` or `/v1/computers`. While the original request is cached, the same key and request body return its first result (with `Idempotent-Replayed: true`). An in-progress retry waits and a different body returns 422. The cache keeps up to 10,000 requests for up to 24 hours and resets on restart. A failed create is removed from the cache. With a key, a disconnected caller has 2 minutes to retry before the server tries to clean up its sandbox. Without a key, the server attempts cleanup as soon as the interrupted create completes.

From TypeScript: `client.create(spec, route, { idempotencyKey })`. From Python: `create(idempotency_key=...)`. Provider keys stay on the server. Clients only hold `SANDBOXROUTER_TOKEN`. The server binds to `127.0.0.1` by default. Both `--cors` and a public `--host` require `SANDBOXROUTER_TOKEN`.

The self-hosted clients provide the same `sbx.start(...)`, process `kill()`, and `sbx.url(port)` methods. Process handles belong to the sandbox and the API server instance that started them. After an API server restart, delete the sandbox to clean up its processes.

### TypeScript client

`Client` talks to this API, so only the server holds provider keys:

```ts
import { Client } from "@sandboxrouter/sdk";

const sr = new Client({ baseUrl: "http://127.0.0.1:8787", apiKey: "secret" }); // or SANDBOXROUTER_URL / SANDBOXROUTER_API_KEY
const sbx = await sr.create({ vcpu: 2 });
await sbx.exec("npm test", { onStdout: (c) => process.stdout.write(c) });
await sbx.kill();
```

`createApp(router, token, cors, hooks)` takes `ServerHooks` (per-caller auth, checks before a create, ownership) for running it for many users. `routerFor(caller)` gives each caller their own router, e.g. one that also holds the caller's own provider keys: `providerWithKey(id, key)` builds an adapter that uses that key and never a key from the server's environment, for the providers in `KEYED_PROVIDERS` (a test checks every request each one makes). `client.quote(spec, route)` calls `/v1/quote`.

### Python

A standard-library client for the HTTP API lives in [`python/`](../python/):

```python
from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="secret")
with sr.create(strategy="cheapest") as sbx:
    sbx.exec("pip install rich && python -c 'import rich'", on_stdout=lambda c: print(c, end=""))

print(sr.quote(vcpu=2, memory_gb=4, expected_seconds=10, max_hourly_usd=0.03))
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
| Cloudflare | smallest instance type that fits | alarm in the bridge Worker | Dockerfile in the bridge | no | Through the bridge Worker you deploy ([`bridges/cloudflare`](../bridges/cloudflare)). |
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

[`web/`](../web/) is the project site: home, a browsable Sandboxes list with live price-per-size, a page per provider, Rankings, Docs, and a Playground that drives your own `sandboxrouter serve` from the browser. Its data is generated from the library (`npm run site:data`), so prices never drift from the code.

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

Prices are list prices copied from each provider's public pricing page, with the date they were checked. A GitHub workflow runs `price:check` every Monday and opens an issue when a pricing page changes or a price is more than 45 days old; a person then updates [`src/catalog.ts`](../src/catalog.ts).

See [CONTRIBUTING.md](../CONTRIBUTING.md) to test a provider, fix a price or add one, [SECURITY.md](../SECURITY.md) to report a vulnerability, and [CHANGELOG.md](../CHANGELOG.md) for releases.

[MIT](../LICENSE)
