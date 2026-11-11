# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## 0.3.5 (2026-11-11)

### Fixed
- **Vercel: `kill()` now deletes the sandbox.** `@vercel/sandbox` v3 keeps sandboxes by default, and `stop()` only ends the session: the next SDK call started it again, so a killed sandbox could keep running and billing. Sandboxes are now created with `persistent: false`, and `kill()` calls `delete()`. The real-account check caught it ("killed sandbox is gone").
- **AgentCore: stdout and stderr are separate again.** The service runs commands in a terminal, so both streams came back as one (labelled stderr whenever the exit code wasn't 0), with `\r\n` line endings. stderr now goes to a file and comes back after a marker, and `stty -onlcr` keeps newlines as they are.
- **Modal: a command timeout is reported as one.** Newer SDKs end the output with "Deadline exceeded" at the deadline instead of a signal exit; that now becomes `command timed out after Ns`.
- **Sprites: a command timeout is reported as one.** Killing the command reported exit -1 before the timeout error could, so exec returned -1. The timeout now rejects first; the same race on SDK errors is fixed too.
- **Freestyle: commands can write in folders that `writeFile` created.** The file API runs as root, so folders it made were read-only to commands. `writeFile` now makes the folder with a command, as the command user.

### Changed
- Real-account checks: 16 cloud providers now pass, up from 5. New: Agent37, AWS AgentCore, AWS Lambda MicroVMs, Cloudflare Sandbox, Freestyle, Fly.io Sprites, Modal, Novita, OpenScale, Superserve and Vercel. The default route tries them before untested providers.
- New benchmarks: `results/bench-2026-11-11-home-eu.json` (11 providers) and `results/bench-2026-11-11-home-eu-b.json` (AgentCore, Freestyle, Modal, Sprites), 5 runs each at 2 vCPU / 4 GB.

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
