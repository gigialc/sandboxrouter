# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## Unreleased

### Added
- **Cooldowns in the router (on by default):** a provider that refuses for a limit (429, quota, concurrency cap) goes to the back of the line for 30 s, and one that fails 3 creates within a minute goes to the back for 60 s. It's still tried when nothing else can take the sandbox, and one success clears it. `router.troubled()` lists who's cooling and why, each plan entry says so in `cooling`, and `new Router({ cooldown: false })` turns it off. One provider's outage or rate limit no longer slows every request.
- **`sandboxrouter burst --spread`:** asks for N sandboxes at once over several providers together, dealt in proportion to each one's measured capacity (`--even` for equal shares). A provider that hits a limit hands the rest of its share to the next one with room. On our accounts, 1,000 at once over 12 providers started 1,000; the best single provider started 637.
- **Website: provider logos** in every table and on each provider page (each provider's own site icon, fetched by `scripts/fetch-logos.py` and served as inert images).
- **Website: "Find the best provider for your job"** at the top of the Benchmarks page: pick what you're running, how many at once and what matters most, and get the ranking from `recommend()`. The detailed results are now tabs (Prices, Real jobs, Real AI agent, At scale, Start time, Real bills); old `#section` links open the right tab.
- **`sandboxrouter recommend`** and **`recommend(PUBLISHED, options)`**: which provider for a job (`--job`, `--count`, `--priority value|cost|speed`), ranked from the published benchmarks that now ship in the package, per successful run, with start times under load for 10 or more at once.
- **Routing uses the published start times** when neither the router nor your bench file has timed a provider. `new Router({ published: false })` turns that off.
- **For agents on the website:** `/benchmarks.json`, `/llms.txt`, Markdown for every page (`Accept: text/markdown` or a `.md` path), a sitemap, and a public MCP server at `/mcp` with `recommend_provider`, `get_benchmarks`, `get_provider` and `list_providers`.
- **Rankings are per successful run:** the website's "Best value", "Cheapest" and "Fastest" orders divide cost and time by the success rate, so failing often costs a provider places. In a new sandbox, "Fastest" now counts the start too.
- **`sandboxrouter burst --n 100`**: asks one provider for N sandboxes at the same moment and reports how many started (refusals for an account limit counted apart), time to interactive at p50/p95/p99 from the burst's start, time until all finished, and what all of them cost. `--job python` runs a Python step in each (RL rollouts, evals); `--job agent` runs the agent loop in each (parallel agents). Reports are `sandboxrouter-burst` files in results/.
- **`sandboxrouter agentbench`**: a real model (Gemini, `GEMINI_API_KEY`) does the same task in a sandbox on each provider, with one tool that runs shell commands there; the key stays on the machine running it. Reports how often the task was done right, session time, the share spent waiting on the model, sandbox CPU and the sandbox's cost. Reports are `sandboxrouter-agent` files.
- **`bench --task --job repo`**: fetch Node 22 and a pinned commit of a real TypeScript project, `npm ci`, typecheck: what a coding agent does first.
- **`sbx.native`**: the provider SDK's own sandbox object (E2B and E2B-compatible providers, Daytona, Modal, Vercel, Blaxel, Beam, Deno, HopX, LangSmith, Morph, Runloop, Sprites, Tensorlake), for what the router doesn't cover: ports, background processes, snapshots. Undefined for providers driven over plain HTTP.
- **`bench --submit`**: runs the benchmark and opens the pull request with the report through the GitHub CLI, forking the repo if needed. Implies `--share`.
- **Weekly benchmark from GitHub's runners in the US** (`.github/workflows/bench.yml`), so results come from more than one place.

### Changed
- **Shared bench reports leave out providers whose every run failed on the runner's own account** (a setup error, payment, a limit), and say so; they'd otherwise be published as the provider failing.
- **The ledger compacts itself** once it passes 256 KB, so a long-lived server's file stays small, and the bench file is re-read only when it changes.

- **`bench --task --job agent`**: an agent loop with simulated model calls, 10 turns of a 6 s wait (the sandbox idle, as while the model thinks) and a short Python tool call. Its sandboxes start with `cpuUtilization: 0.1`.
- **Cost per job in one sandbox** (`TaskRow.reusedUsd`, and a switch on the website): the job in a sandbox that's already running, without its start, minimum charge or per-sandbox fee.
- **Per-core CPU readings**: `bench --task` records the busiest core's time (`medianTaskMaxCoreMs`) alongside the total.

### Fixed
- **Modal with `cpuUtilization`**: the adapter reserves that share of the CPU (at least 1/8 core) and lets the sandbox burst to the full size (`cpuLimit`), and Modal is priced on it (`reservesCpu`, `cpuFloor: 0.125`). Without a hint it reserves the full size as before.
- **Vercel's active CPU is metered per VM** (`cpuMeteredPerVm`): measured against Vercel's own per-sandbox meter, one busy core on 2 vCPUs is billed about twice its time, so jobs are priced as vCPUs x the busiest core's time.

## 0.10.0 (2026-11-17)

### Fixed
- **Active-CPU pricing.** Providers that bill CPU only while it's busy (Vercel, Cloudflare, Tensorlake, AgentCore, Sail, Sprites, Deno, Upstash) were always priced as if every core was busy, which overstated what an agent that mostly waits on model calls pays there, by 2–4x at 10% CPU. The new `cpuUtilization` spec field (0 to 1, default 1, so nothing changes unless you set it; `cpu_utilization` in Python) prices them at that share of their CPU plus full memory. Vercel's one-minute minimum now covers memory only, and Tensorlake's 20% CPU floor is respected.
- **Modal is billed as allocated capacity**, not active CPU: it bills the larger of its reservation and actual use, and the adapter reserves the size you ask for.
- **`bench --task` measures the CPU time each job used** (from `/proc/stat` inside the sandbox) and prices active-CPU providers by it.
- **A create that runs out of `deadlineSeconds` always says so.** When the last provider's own timeout fired at the same moment as the deadline, the error could report a provider timeout instead of `code: "timeout"` for the whole create.

### Added
- **`bench --task`**: a cost-per-task benchmark. Each sandbox also runs the same fixed job (hash 512 MB of zeros on one core, then 256 MB on each of two cores at once, then write and flush 256 MB to disk), using only tools every Linux image has, and the job is priced by how long it really took with each provider's billing rules (start plus task, minimum charge, billing step, per-sandbox fee). A slower CPU or disk makes the job longer and so costs more, which hourly prices can't show. Reports record `task: "v1"` with `medianTaskMs` and `taskPhasesMs` per provider; `taskTable(reports)` turns them into the table, and the website's Benchmarks page shows it as "Cost of a real task". `--long` runs the same job 40 times in a row (`task: "v1-long"`), for sustained speed and prices once minimum charges stop mattering.
- **`bench --task --job python`** (a pure-Python script, like a code-interpreter call) and **`--job download`** (the 53 MB Node.js release from nodejs.org's CDN): two more jobs for the cost-per-task table. Reports record `task: "python-v1"` or `"download-v1"`.
- **`bench --parallel N`**: bench N providers at once (each provider's own runs stay one after another).

## 0.9.0 (2026-11-15)

### Added
- **`maxHourlyUsd`**, a price cap (`--max-price` in the CLI, `max_hourly_usd` in Python). A provider is skipped when this run would cost more per hour there, counting its minimum charge, billing increment and per-sandbox charge over `expectedSeconds`, so Agent37's one-minute minimum puts it over a $0.03/h cap for a 10-second run though its hourly price is $0.0065. When the cap leaves nothing, the error names the cheapest provider and its price for the run.
- **`router.quote(spec, route)`**, `POST /v1/quote`, `client.quote()`, `sandboxrouter quote`: the provider a create would use, its price, and the run's estimated cost (minimum charge, increments and per-sandbox charge included), without starting anything.
- **`providerWithKey(id, key)`** and `KEYED_PROVIDERS`: an adapter that uses the key it is given and never one from the environment, for Agent37, Boat, Daytona, E2B, Freestyle, Maritime, Novita, OpenScale, Sail, Sprites, Superserve and Tensorlake. A test catches every request each makes (fetch, vendor SDKs with their own HTTP clients) and fails if any carries the environment's key. For services that let users bring their own keys.
- **`ServerHooks.routerFor(caller)`**: a router per caller for route, quote, create and every call on a sandbox.

### Changed
- **`strategy: "cheapest"` ranks by what the run costs**, not the hourly price alone: the same price the default ranks by (minimum charge, billing increment, per-sandbox charge over `expectedSeconds`), strictly by price. With `expectedSeconds: 10` it no longer puts Agent37, which bills a full minute, ahead of providers that bill by the second.
- `OPENSCALE_API_URL` overrides OpenScale's API address (for a proxy or a test server).

## 0.8.3 (2026-11-15)

### Added
- **`accountErrors: "fallback"`** on `RouterOptions`, for services that run sandboxes on their own provider accounts. A provider's 401 or 403, or a missing provider package, now moves the create to the next provider instead of failing it: a revoked key, a frozen workspace or a provider's creation cap is the service's problem, not the caller's. 400, 404 and 422 still stop, since those are usually the request. The default stays `"stop"`, because with your own keys a 401 is a key to fix, not something to hide. Found live: Fly.io Sprites answers 403 once a token reaches its creation cap, and the default router ended the request there even with other providers left to try.

### Fixed
- **`bench` asks every provider for the same size.** It said 2 vCPU / 4 GB but sent no size, so each provider started at its own default. It now asks for 2 vCPU / 4 GB (or `--vcpu`/`--memory`), except providers whose default image fixes the size (E2B, OpenScale, Daytona), which run at that size, and the shared report records the size.
- **The leaderboard uses each provider's latest run from each location**, not the median over every run ever submitted, so an old run can't outvote a newer one. Each row says when it was measured. Older runs stay listed on the benchmarks page.

## 0.8.2 (2026-11-14)

### Added
- **`expectedSeconds`** on the spec (`--expect SEC` in the CLI, `expected_seconds` in Python): how long you expect to use the sandbox. Ranking then uses what that run would really be billed: the provider's minimum charge and billing increment, plus any per-sandbox fee. Agent37 is cheapest per hour but bills at least a minute, so for runs under about 18 s at 2 vCPU / 4 GB, Maritime (per second, no minimum) now goes first. It's only a hint: the sandbox still lives until you kill it or `timeoutMinutes` runs out. `sandboxrouter route --expect 10` shows each provider's cost for the run.

- **Boat** passes all 14 real-account check steps and joins `VERIFIED`: 18 providers. It's in a new benchmark run with the other 15 funded providers, 5 runs each (`results/bench-2026-11-14-home-eu-b.json`): 1.6 s median create, the fastest exec round trip (114 ms), $0.018/h at 2 vCPU / 4 GB.

### Changed
- Ranking without `expectedSeconds` also rounds the lifetime up to each provider's minimum and increment. That changes nothing at the default 30 minutes, except Azure (billed by the hour), which now counts as a full hour on lifetimes under 60 minutes.

## 0.8.1 (2026-11-14)

### Fixed
- **Tensorlake pause.** Tensorlake made sandbox names immutable, so pausing an unnamed sandbox (which named it first) failed. Sandboxes are now named when they're created. Tensorlake passes all 14 real-account check steps and joins `VERIFIED`: 17 providers.

### Changed
- The site and README call it sandboxRouter, and the homepage links to the code on GitHub above the headline. Package, CLI and import names are unchanged.

## 0.8.0 (2026-11-14)

### Fixed
- **Sail's per-sandbox charge was counted as an hourly markup.** Its saved 10-minute cost run billed $0.0151: $0.0100 creation charge plus $0.0051 of running time. The router turned the total into "bills 46% over list" (`BILLED_VS_LIST` 1.458), so every hour of a Sail sandbox was estimated at $0.0904 for 2 vCPU / 4 GB. The fixed charge now comes out before the ratio is measured: Sail is $0.0307/h (0.495 of list: it bills the CPU and memory a box uses) plus $0.01 per sandbox.

### Added
- **Billing rules in the catalog.** `pricing.minSeconds`, `incrementSeconds` and `perSandboxUsd`: Agent37 and CodeSandbox bill whole minutes (at least one), Vercel at least a minute, Azure whole hours, Sail $0.01 per sandbox on its free plan. `billingRules(provider)` and `billedUsd(provider, hourlyUsd, seconds)` expose them. Measured on Agent37 on 14 Nov: a 16 s sandbox was billed 60 s; a 10-minute one exactly its list price.
- `Candidate.perSandboxUsd`. Ranking spreads it over the sandbox's lifetime (`timeoutMinutes`, default 30), so a provider with a fixed charge drops on short sandboxes; `sandboxrouter route` shows it (`+ $0.01/sandbox`).
- `sandboxrouter cost settle` reads Agent37's real bill (`/v1/usage`).

### Changed
- The homepage leads with the real-account check and shows `npm i` and an example; links use sandboxrouter.ai and api.sandboxrouter.ai. A provider whose SDK isn't installed where `check` runs is "not run", not a failure.

## 0.7.0 (2026-11-13)

### Changed
- **A provider that hangs is given up on sooner.** Once the router knows a provider's usual start time (3 of its own creates, or the bench file), a create that runs far past it moves to the next provider: after 5x the usual time (or 1.5x the slowest recent start, if longer), at least 10 s, instead of the full 120 s. A Daytona create that hung for 65 s on 13 Nov would have moved on after about 10 s. It never applies to the last provider left, or when the caller sets `createTimeoutSeconds`. `RouterOptions.quickFallback` tunes it (`{ factor, minSeconds }`) or turns it off (`false`). The timeout error says how long the provider usually takes.
- **`sandboxrouter check --retry`** runs a failed provider once more and keeps that result, so a one-off error doesn't mark a provider failing. **`--out FILE`** writes every report as JSON, with the first try's failure when it was retried.
- **The nightly check emails a summary when a provider needs a look:** what's broken (failed twice), which accounts are out of credit, and what only passed on the second try. It's a comment on one "Nightly live check" issue, which GitHub mails to the repo owner; nothing is sent on nights when everything passes, except one all-clear after an alarm. The run no longer fails on a provider failure, so there's one email, not two.

## 0.6.0 (2026-11-12)

### Added
- **`Idempotency-Key` on `POST /v1/sandboxes` and `/v1/computers`.** A create retried with the same key, from the same caller, returns the first one's answer for 24 hours instead of starting (and on a billing server, charging for) a second sandbox. A retry that arrives while the first is still starting waits for it, and the same key with a different body is refused (422). A failed create isn't remembered, so retrying it runs it again. With a key, a sandbox whose caller hung up mid-create is kept for 2 minutes (`ServerHooks.orphanGraceMs`) for the retry to collect, then killed. `Client.create(spec, route, { idempotencyKey })`, Python `create(idempotency_key=...)`; `RemoteSandbox.details.replayed` says whether the answer was a replay.

### Changed
- **Computers follow the sandbox rules.** `router.computer(spec, route)` takes `fallback`, `createTimeoutSeconds` (default 120) and `deadlineSeconds` (default 240). A setup error (400/401/403/404/422) stops instead of falling back, a computer that turns up after its provider timed out is deleted, and `RoutedComputer.attempts` lists every try. Errors are RouterErrors with codes. Computers go in the ledger (`kind: "computer"`, no lifetime), so `ls` shows them and `gc --all` deletes them; plain `gc` leaves them, since the same `externalUserId` is meant to get the same desktop back. `RoutedComputer` has `kill()` (same as `delete()`), `await using`, `estimatedHourlyUsd`, and `exec(command, { timeoutSeconds })` (a bare number still works).
- **`/v1/computers` on a multi-user server** (`authorize` set and `computers: true`) checks `owns` for computer ids and runs new hooks: `beforeCreateComputer`, `afterCreateComputer` (may add fields to the answer; throwing deletes the computer) and `afterDeleteComputer` (with `{ error }` when the provider's delete failed). The request body is checked like a sandbox's (`splitComputerRequest`), and unknown fields are refused.
- `Attempt.provider` and `LedgerEntry.provider` accept computer-only provider ids.

## 0.5.0 (2026-11-12)

A design pass after an outside review of the library and the hosted service.

### Fixed
- **A size that isn't a number no longer hangs the router.** `plan({ vcpu: "x" })` looped forever in 0.4.0's tie-break, and one `POST /v1/route` could stall a server. Every spec and route option is now checked first (`validate()`): sizes and times must be positive numbers, maps must be string maps, and strategy, fallback and provider ids must be known. The HTTP API also refuses fields it doesn't know (`{"memory": 64}` used to be ignored silently). The tie-break loop always moves on, whatever the prices.
- **A sandbox that starts after its HTTP caller hung up is killed,** instead of running (and, on a billing server, charging) with nobody holding its id.
- **A create can't outlast the client waiting for it.** New `deadlineSeconds` (default 240) bounds the whole create across every provider tried. Before, with the 120 s per-provider timeout, a few slow providers took longer than an HTTP client waits.
- **`fallback: false` with a list of providers never runs on one you didn't name first:** if the first can't take it, create throws `no_provider` instead of silently using the second.
- **On a multi-user server, `/v1/computers` is off unless turned on** (`ServerHooks.computers: true`): computers don't go through `owns` or the create hooks yet.
- `DELETE /v1/sandboxes/:id` on a sandbox the provider no longer has succeeds, so the caller isn't left paying for it.
- The create timeout message keeps fractions (`after 0.2s`, not `after 0s`).

### Changed
- **Prices.** `estimatedHourlyUsd` is now the expected cost everywhere it appears: list price times what the provider really billed against list, where measured. New `listHourlyUsd` (the published price), `billedVsList` (the ratio, on `Candidate`) and `size` (`{ vcpu, memoryGb }`: the provider's fixed image size, or what was asked for) are on `Candidate`, `RoutedSandbox`, the HTTP create answer, `RemoteSandbox` and the Python `Sandbox`. `effectiveHourlyUsd` from 0.4.0 is gone (it's now `estimatedHourlyUsd`). `strategy: "cheapest"` still means list price alone.
- **Errors carry a `code`.** `RouterError.code` is one of `bad_request`, `unsupported`, `no_provider`, `setup`, `all_failed`, `timeout`, and the HTTP API maps each to one status (400, 400, 422, 502, 503, 504; `ERROR_STATUS`) with `{ error, code, attempts }`. Before, every RouterError was 502. Command timeouts are 504. `ClientError.code` and the Python `SandboxRouterError.code` expose it. `Attempt.status` has each failed attempt's HTTP status.
- `router.get(id)` takes the price and size from this machine's ledger, and leaves them undefined otherwise (it used to report the default size's price for any sandbox). The ledger records list price and size.
- `strategy: "verified"` orders within each group by expected cost, like the default.

### Added
- `ServerHooks.afterCreate` may return fields to add to the create answer (a hosted service: what it charges, when it expires), `createFailed` releases whatever `beforeCreate` held, and `afterKill` gets `{ error }` when the provider's kill failed, so a service can stop charging and retry the kill itself.
- Exports: `VERIFIED`, `FAILING`, `BILLED_VS_LIST`, `PRICE_TIE`, `DEFAULT_CREATE_TIMEOUT_S`, `DEFAULT_CREATE_DEADLINE_S`, `balanced`, `sizeOf`, `validate`, `splitRequest`, `ERROR_STATUS`, and the types `Size`, `SandboxPrice`, `CreateResponse`.
- `RemoteSandbox`: `readText()`, `await using` (`Symbol.asyncDispose`), and `details` (the server's whole create answer). `Client.route()` returns full `Candidate`s. Python `Client(api_key=...)` as another name for `token`, and `deadline_seconds`.
- Docs: Sizes and prices, Routing and Errors sections in docs/reference.md.

## 0.4.0 (2026-11-11)

### Changed
- **The default route is cheapest real cost first, with speed breaking near-ties.** New strategy `balanced` (also what `"default"` means now). It ranks by list price for the size you asked for, times what the provider really billed against list price where that was measured (`BILLED_VS_LIST`, generated from `results/cost` into `src/billing.ts`; today only Sail, at 1.458x). Providers within 10% of each other on that price go fastest first, by this router's own recent create times (after 3 creates), else your `sandboxrouter bench` file. The published benchmarks are never used, since speed depends on where you run. Providers whose last real-account check failed (`FAILING`) go last, and still serve as fallback. Passing the check no longer moves a provider up: the old order is `strategy: "verified"`.
- `Candidate` has `effectiveHourlyUsd` (the ranked price) and `failing`. `estimatedHourlyUsd` stays the list price, and is still what `RoutedSandbox.estimatedHourlyUsd` reports.
- `strategy: "fastest"` also uses the router's own create times, so it works on a server that never ran `bench`.
- The bench file follows `$SANDBOXROUTER_HOME` like the ledger does (`$SANDBOXROUTER_BENCH_FILE` still wins).

### Added
- `RouterOptions.requireVerified`: only route to providers that passed the real-account check. For services that run sandboxes on their own accounts, where a provider that misbehaves without failing (keeps billing after kill, garbles output) costs money.
- `RouterOptions.failing` and `RouterOptions.billedVsList` replace the shipped lists.
- `sandboxrouter route` shows the billed price where it differs from list, start times, and failed checks.
- `check`: a create refused with 402 (the account running the check can't pay) is inconclusive, not a failure, and `--save` doesn't write it, so the provider keeps its last real result. A failed check now sends a provider last, so an empty balance on our side mustn't count against it. `Attempt.status` carries the HTTP status of each failed attempt.

## 0.3.5 (2026-11-11)

### Fixed
- **Vercel: `kill()` now deletes the sandbox.** `@vercel/sandbox` v3 keeps sandboxes by default, and `stop()` only ends the session: the next SDK call started it again, so a killed sandbox could keep running and billing. Sandboxes are now created with `persistent: false`, and `kill()` calls `delete()`. The real-account check caught it ("killed sandbox is gone").
- **AgentCore: stdout and stderr are separate again.** The service runs commands in a terminal, so both streams came back as one (labelled stderr whenever the exit code wasn't 0), with `\r\n` line endings. stderr now goes to a file and comes back after a marker, and `stty -onlcr` keeps newlines as they are.
- **Modal: a command timeout is reported as one.** Newer SDKs end the output with "Deadline exceeded" at the deadline instead of a signal exit; that now becomes `command timed out after Ns`.
- **Sprites: a command timeout is reported as one.** Killing the command reported exit -1 before the timeout error could, so exec returned -1. The timeout now rejects first; the same race on SDK errors is fixed too.
- **Freestyle: commands can write in folders that `writeFile` created.** The file API runs as root, so folders it made were read-only to commands. `writeFile` now makes the folder with a command, as the command user.

### Changed
- Real-account checks: 16 cloud providers now pass, up from 5. New: Agent37, AWS AgentCore, AWS Lambda MicroVMs, Cloudflare Sandbox, Freestyle, Fly.io Sprites, Modal, Novita, OpenScale, Superserve and Vercel. The default route tries them before untested providers.
- New benchmarks: `results/bench-2026-11-11-home-eu.json` (11 providers) and `results/bench-2026-11-11-home-eu-b.json` (AgentCore, Freestyle, Modal, Sprites), 5 runs each at each provider's default size.

## 0.3.4 (2026-11-10)

### Changed
- **The default route tries tested providers first.** New strategy `verified` (also what `"default"` means now): providers whose last real-account check passed go first, then the rest, each group cheapest first by list price, ties alphabetical. The list ships with each release as `VERIFIED` (`src/verified.ts`, generated from `results/conformance`); `new Router({ verified: [...] })` replaces it. `strategy: "cheapest"` keeps the old price-only order. `Candidate.verified` says which is which, and `sandboxrouter route` marks them "tested".

### Added
- `Client`: a TypeScript client for the HTTP API (create, exec with streaming, files, kill), for the hosted service or your own `serve`. Reads `SANDBOXROUTER_URL` and `SANDBOXROUTER_API_KEY`; the Python client reads `SANDBOXROUTER_API_KEY` too.
- `ServerHooks` on `createApp`: per-caller auth, checks before a create, sandbox ownership, and switches for computers and pause.
- `results:check` refuses `sr_live_` keys.

## 0.3.3 (2026-11-09)

### Changed
- Fallback moves on when an account can't pay (402: no balance, or a plan needed) instead of stopping, so one unfunded account no longer blocks a plain `create()`. The failed attempt stays on `attempts` (the CLI prints it). Bad keys, bad images and bad requests (400, 401, 403, 404, 422) still stop.
- Providers whose terms forbid publishing benchmarks (`noBenchmarks` in the catalog, `benchmarksPublishable()`; today Blaxel, under §2.6(f) of its terms) are left out of everything meant to be published: `bench --share` and `cost run` drop them from the files they write, `check --save` keeps their pass/fail but no timings, `results:check` refuses files with their numbers, and the website shows their list price and real-account check but no speed, size or bill. Blaxel's earlier numbers were removed from `results/`.

### Fixed
- `cost run` measured the size a sandbox gets from `nproc` and `MemTotal`, which on Daytona now show the host (64 CPUs, 755 GB) rather than the sandbox's 1 vCPU / 1 GB. It now reads the cgroup limits (v2 `cpu.max` / `memory.max`, or v1) when they're set.

## 0.3.2 (2026-11-07)

0.3.1 on npm was built before #21 and #22 were merged, so its CLI lacks `--by` and bad keys still fell back; 0.3.2 has both.

### Fixed
- Fallback stopped on a setup error only when the adapter attached an HTTP status itself, so a bad key on E2B, Daytona, Vercel, Modal, Blaxel or AWS (AgentCore, Lambda) quietly moved the work to the next provider. The router now reads the status the way each SDK reports it (`statusCode`, `status_code`, `response.status`, AWS `$metadata`, Modal's gRPC codes, E2B's `AuthenticationError` and AWS's `CredentialsProviderError` by name, or a `cause`), checked against each live API with a bad key.
- A provider SDK that isn't installed (`needs the "…" package: npm i …`) is a setup error too (new `SetupError`): the router stops and says what to install instead of falling back. `fallback: "any"` still falls back on everything.

### Added
- `--by GITHUB_USER` on `check --save`, `bench --share` and `cost run` puts the contributor's GitHub username on the result file, so the website can credit it.
- `npm run results:check` (and a CI step): every file in `results/` is checked for keys and tokens, emails, IP addresses, street-address labels, unknown providers and impossible numbers; on a pull request it also refuses edits to or deletions of an existing bench report. `validateResults()` in `src/results.ts`.
- Website: "Where the numbers come from" under the provider table (prices are list prices from each pricing page, bills are measured, tests and speed are contributed), price columns labelled as list prices, and on every provider page a "Measured on real accounts" panel (check, cold start, success rate, size you really get, billed vs list) with a "Help verify" box listing the commands for whatever is still missing.

## 0.3.1 (2026-11-07)

### Fixed
- A `create()` that names no size skipped E2B, Daytona and OpenScale, whose default images have a fixed size smaller than 2 vCPU / 4 GB. With only one of those keys set, the quickstart failed with "no provider can take this sandbox". With no size asked for, those providers now take the sandbox at their default image's size; only a `vcpu` or `memoryGb` you name can be too big for it.
- The error when no provider can take a sandbox leads with what to fix. With no keys set: "no provider keys found", and where to find the variables. With keys set: only the reasons the providers you have keys for were skipped, plus how many have no key, and for a provider skipped for its default image's size, how to use it anyway. A provider you name that has no key says which variables to set.

### Changed
- README, docs and website examples call `router.create()` with no size (`sr.create()` in Python, `{}` over HTTP), so they work with any one provider's key. The README and docs say what size you get.
- `sandboxrouter providers` prints a plain aligned table (id, provider, $/hr, plan, key, supports, note) with a legend, instead of Node's `console.table`. With no `--vcpu` / `--memory` it lists 2 vCPU / 4 GB, as before. `--json` is unchanged.
- The skip reason for a fixed default image reads "default image is 2 vCPU / 0.5 GB; a bigger size needs image.e2b".

## 0.3.0 (2026-11-06)

### Added
- `sandboxrouter cost run` / `cost settle`: a real-cost check. Runs a sandbox per provider for a fixed time with every core busy, records the size it really got, and compares the list-price prediction with what the provider billed (Daytona, Blaxel and Maritime usage APIs; E2B and OpenScale from the dashboard).
- Price tables (README, `providers`, site) show what a price leaves out: **plan needed** (the monthly plan a provider requires before its API creates sandboxes, and whether it's credited back as usage; `plan` and `planLabel()` in the catalog, checked against each pricing page on 2026-11-06), **billing model** (`billing: "active-cpu"` prices are marked "up to" / ≤, since they assume every core busy), and each provider's **real-account check** status (`liveStatus()`): passed, failed last run, or not run yet (mock-tested only). The site's homepage says how many providers pass on real accounts.
- `listingOrder()`: the order tables list providers in. Open sign-ups come first, cheapest first; waitlisted or closed sign-ups follow, then providers that can't take the size, then Docker. Routing is unchanged.
- First real-account runs: E2B, Maritime, OpenScale and Docker pass all 14 steps; Blaxel passes 13 of 13 (no pause). Daytona passed its first run, but the nightly run on 2026-11-06 failed at create with an error from Daytona's side.
- First bench report (results/bench-2026-11-06-home-eu.json); the site's provider table shows its cold-start times.
- `npm run secrets:push -- --only <ids>` uploads just the providers whose accounts are ready.
- Sail Research Sailboxes (`SAIL_API_KEY`), over Sail's plain HTTPS API: persistent VMs billed on what they use (CPU time, RAM held, disk), with pause and resume. The cost check reads Sail's real charge from `/sailboxes/spend`.
- LangSmith Sandboxes (LangChain) via the `langsmith` SDK (`LANGSMITH_API_KEY`; streaming needs `ws`). Memory is kept within the 2 to 6 GiB per vCPU LangSmith allows; `timeoutMinutes` becomes the idle stop, and a stopped sandbox is deleted a day later.
- Sign-up status for gated providers (`access` in the catalog, `accessLabel()`): InstaBox and Dedalus are waitlisted, Koyeb isn't taking new accounts since joining Mistral. `providers`, `route`, the README and the site say so. Routing is unchanged: anyone who already has a key still gets routed there.
- 16 more sandbox providers, for 31 cloud providers plus Docker:
  - Koyeb, Freestyle, Deno Sandbox, Beam, CodeSandbox (Together), Upstash Box, Novita, Alibaba Cloud, Azure Container Apps sessions, AWS Bedrock AgentCore (opt-in) and AWS Lambda MicroVMs.
  - YC sandbox startups: Agent37, InstaBox, OpenScale, Dedalus Machines (private beta) and Superserve.
- Desktops and phones from 6 more providers, routed by price per OS (Linux, Windows, Android, iOS): E2B Desktop, Daytona, Orgo, Mobilerun, Limrun and AWS WorkSpaces agent access.
- `sandboxrouter check --provider <id>`, plus `checkProvider()` from code: a 14-step test of one provider against a real account (output, env and cwd, UTF-8, streaming, binary and 1 MB files, missing-file errors, timeout and that the timed-out command was stopped, pause and resume, kill). `check --all --save` runs every configured provider and saves results/conformance/<id>.json, which the README's Compatibility table and each provider's page on the site are built from. A nightly workflow re-runs it with the repo's provider keys.
- Leak cleanup: routers record the sandboxes they start in a local ledger (~/.sandboxrouter/sandboxes.jsonl; `ledger: false` or SANDBOXROUTER_LEDGER=off to turn it off). `sandboxrouter ls` lists the ones never killed, with cost so far; `sandboxrouter gc` kills those past their lifetime (`--all`, `--older-than`, `--dry-run`). `sandboxrouter run` kills its sandbox on Ctrl-C.
- exe.dev: the VM powers itself off when its requested lifetime runs out (best effort), since exe.dev has no lifetime setting.
- Contributing guide, security policy, code of conduct, issue and PR templates, and a weekly price-page check.
- CI fails when the README tables or `web/src/data/site.json` do not match what the code generates.
- `test/conformance.ts`: the sandbox contract as a shared test suite that every adapter runs against its mock, and mock tests for the 13 adapters that had none (Blaxel, Boat, Cloudflare, Docker, exe.dev, HOPX, Modal, Morph, Northflank, Runloop, Sprites, Tensorlake, Vercel) plus the E2B and Daytona sandbox paths.

### Changed
- E2B, OpenScale and Daytona are skipped for requests bigger than their default image, and priced at that size. Measured inside real sandboxes, their default images give 2 vCPU / 0.5 GB (E2B), 2 vCPU / 1 GB (OpenScale) and 1 vCPU / 1 GB (Daytona) whatever size is asked for, so a 2 vCPU / 4 GB request used to be priced at 4 GB and handed a much smaller machine. Pass an image (`image.e2b` template, `image.openscale` template, `image.daytona` image) to get a bigger size; then the request is priced as asked. `check`, `bench` and `cost run` use the default size for these three. New catalog field `defaultSize`; `fixedSize()` and `fittingSpec()` in the catalog.
- Fallback only moves on when a provider looks unavailable (timeout, network error, 429, 5xx, or no status). A setup error (400, 401, 402, 403, 404, 422: a bad key, no billing, a bad image or request) stops routing with a message saying so, instead of quietly sending the work to another, maybe pricier, provider. `fallback: "any"` (CLI `--fallback-any`) restores falling back on every error.
- The HTTP server needs `SANDBOXROUTER_TOKEN` when CORS is on (`createApp` throws) or when `serve --host` is not a loopback address (it refuses to start). The token is compared in constant time.
- Providers that can't take the requested size are listed after the ones that can, with the reason.
- Website: full-width layout, white page, black ink.
- README and docs quickstarts use `try` / `finally { await sbx.kill() }`, which runs as plain JavaScript on Node 20+. `await using` (TypeScript 5.2+ or Node 24+) is mentioned as the shorter form; before, the README's first example was a syntax error in plain JavaScript on Node 22.
- Examples no longer lead with one provider: README and docs examples use E2B and Daytona.
- E2B's catalog note mentions its free Hobby tier; Pro ($150/mo) is only needed for longer sessions.

### Fixed
- Daytona: a sandbox Daytona created but couldn't start (state "error") is now deleted. The SDK throws without returning it, so each create is tagged and the tag is looked up on failure.
- The nightly live check installs the optional provider SDKs with `--legacy-peer-deps`, since Beam's SDK still pins TypeScript 5.
- A provider whose create never answered stalled `router.create` instead of falling back. Each create now has a time limit (`createTimeoutSeconds`, default 120; CLI `--create-timeout`); a sandbox that turns up after it is recorded in the ledger and killed, so it can't bill unseen. Maritime's HTTP requests also have deadlines (60 s; a command's timeout plus 30 s; 5 min for files).
- Daytona: pause always failed on a real account because sandboxes were created ephemeral (`autoDeleteInterval: 0`); a stopped sandbox is now deleted a minute later instead. Streaming commands that call `exit` no longer hang. Daytona's own timeout (a 408) is read as the contract's timeout error.
- Blaxel: pause removed (archiving is a preview Blaxel enables per workspace), `kill()` waits for the asynchronous delete, and API errors no longer read "[object Object]".
- Modal: the adapter asked for twice the CPU it meant to (Modal counts physical cores, 1 core = 2 vCPUs).
- The exec timeout contract now holds on every provider: a command that outlives `timeoutSeconds` is stopped inside the sandbox and `exec` rejects with `<provider>: command timed out after Ns`. Before, E2B (and OpenScale, Novita, Alibaba), Vercel, Morph, Docker, HOPX and Northflank left the process running after the client gave up; Lambda, Cloudflare, exe.dev, AgentCore, Azure, Boat, Maritime, Modal and Blaxel returned the kill as an ordinary exit code; Beam's non-streaming exec waited for the command before starting its timer. `RoutedSandbox.exec` also bounds every call at the timeout plus 30 s with the same error, should an adapter miss its deadline, and `sandboxrouter check` fails a provider that returns a timed-out command as a result or lets it keep running.
- `wrapCommand` (used by 17 adapters for cwd/env) ran the command in the wrong directory when `cwd` did not exist and `env` was set, because `cd` was joined with `;` to the exports. Every step is now chained with `&&` and the command is grouped, so a missing cwd stops it.
- Daytona's non-streaming exec merged stderr into stdout; stderr now goes to a temp file that is read back. Streaming commands run in a throwaway session, which keeps them apart too. Plain commands don't use a session, because on a real account session logs end output that has no trailing newline with one.
- Maritime and Blaxel: a real account reports a command past its limit as an error (Maritime: 504 `command_timeout`; Blaxel: 422 "process timed out"), which is now the contract's timeout error.
- Daytona: `connect()` only restarted a `stopped` sandbox. Daytona also archives and pauses idle sandboxes on its own, so those (and sandboxes caught mid-transition) are now brought back too, with a longer wait for an archived one, and a sandbox that cannot be started (destroyed, error) is reported instead of failing on the first command.
- Dedalus: `readFile` asked for 256 KiB chunks through an endpoint that returns at most 64 KiB per stream, so files over about 48 KiB came back corrupted; chunks now fit the cap, and command output past the cap is assembled from the events feed instead of being cut. A streamed command no longer repeats output when a page of events carries no cursor.
- E2B desktops: `hold_key` ran under the SDK's default 60 s command timeout, so a longer hold ended with the key still down; the command now gets a timeout past the hold, and holds over 100 s are refused.
- Deno: a command killed by a signal reported a negative exit code (Deno's convention); it is now 128 plus the signal number, like every other provider.
- Upstash: an `event: error` marker split across two network reads could leak into the output and hang the command; the hold-back window now covers the longer marker.
- Mobilerun: a phone that took longer than the server-side wait to boot failed with "did not become ready" instead of being waited on, because the SDK's timeout error carries no `name`; it is recognised by its class now.
- Orgo: `connectComputer()` returned while a resumed or started computer was still coming back (`/resume` and `/start` answer 202); it now polls until the computer is running.
- An unknown provider id in an explicit list made `Router.plan()` throw and the HTTP API answer 500; the planner now lists it as skipped ("unknown provider") and the API answers 400.
- Deno: a timed-out command no longer hangs when its child processes keep stdout open.
- Optional SDKs that aren't installed are reported as missing under bundlers (Vite, esbuild) too.

## 0.2.0 (2026-11-04)

### Changed
- **Neutral routing.** The default strategy is the lowest list price for the requested size, with ties broken alphabetically. No provider gets a privileged slot. Docker is local and never chosen automatically.

### Added
- Providers: Boat, exe.dev, Cloudflare (through a bridge Worker), HOPX, Northflank and Docker (local).
- Website: simpler home page built around the price table.

## 0.1.0 (2026-11-04)

First release, as `@sandboxrouter/sdk`.

- `Router` with `cheapest` and `fastest` strategies and automatic fallback.
- Providers: Maritime, E2B, Daytona, Modal, Vercel Sandbox, Morph, Fly.io Sprites, Blaxel, Tensorlake and Runloop.
- Streaming exec output, pause and resume, and files.
- CLI (`run`, `providers`, `bench`, `serve`), an HTTP server, and a Python client.
- Computers (desktops and phones) on Maritime.
- `bench --share` reports and the leaderboard built from them.
- Website: home, a page per provider, docs and a Playground.
