# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## 0.3.0 (2026-11-06)

### Added
- Price tables (README, `providers`, site) show what a price leaves out: **plan needed** (the monthly plan a provider requires before its API creates sandboxes, and whether it's credited back as usage; `plan` and `planLabel()` in the catalog, checked against each pricing page on 2026-11-06), **billing model** (`billing: "active-cpu"` prices are marked "up to" / ≤, since they assume every core busy), and each provider's **real-account check** status (`liveStatus()`): passed, failed last run, or not run yet (mock-tested only). The site's homepage says how many providers pass on real accounts.
- `listingOrder()`: the order tables list providers in. Open sign-ups come first, cheapest first; waitlisted or closed sign-ups follow, then providers that can't take the size, then Docker. Routing is unchanged.
- First real-account runs: E2B, Maritime, OpenScale and Docker pass all 14 steps; Blaxel passes 13 of 13 (no pause). Daytona passed its first run, but the nightly run on 2026-11-06 failed at create with an error from Daytona's side.
- First bench report (results/bench-2026-11-06-home-eu.json); the site's provider table shows its cold-start times.
- `npm run secrets:push -- --only <ids>` uploads just the providers whose accounts are ready.
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
- Fallback only moves on when a provider looks unavailable (timeout, network error, 429, 5xx, or no status). A setup error (400, 401, 402, 403, 404, 422: a bad key, no billing, a bad image or request) stops routing with a message saying so, instead of quietly sending the work to another, maybe pricier, provider. `fallback: "any"` (CLI `--fallback-any`) restores falling back on every error.
- The HTTP server needs `SANDBOXROUTER_TOKEN` when CORS is on (`createApp` throws) or when `serve --host` is not a loopback address (it refuses to start). The token is compared in constant time.
- Providers that can't take the requested size are listed after the ones that can, with the reason.
- Website: full-width layout, white page, black ink.
- README and docs quickstarts use `try` / `finally { await sbx.kill() }`, which runs as plain JavaScript on Node 20+. `await using` (TypeScript 5.2+ or Node 24+) is mentioned as the shorter form; before, the README's first example was a syntax error in plain JavaScript on Node 22.
- Examples no longer lead with one provider: README and docs examples use E2B and Daytona.
- E2B's catalog note mentions its free Hobby tier; Pro ($150/mo) is only needed for longer sessions.

### Fixed
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
