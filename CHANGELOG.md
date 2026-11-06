# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## Unreleased (next: 0.3.0)

### Added
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
- Providers that can't take the requested size are listed after the ones that can, with the reason.
- Website: full-width layout, white page, black ink.

### Fixed
- Modal: the adapter asked for twice the CPU it meant to (Modal counts physical cores, 1 core = 2 vCPUs).
- The exec timeout contract now holds on every provider: a command that outlives `timeoutSeconds` is stopped inside the sandbox and `exec` rejects with `<provider>: command timed out after Ns`. Before, E2B (and OpenScale, Novita, Alibaba), Vercel, Morph, Docker, HOPX and Northflank left the process running after the client gave up; Lambda, Cloudflare, exe.dev, AgentCore, Azure, Boat, Maritime, Modal and Blaxel returned the kill as an ordinary exit code; Beam's non-streaming exec waited for the command before starting its timer. `RoutedSandbox.exec` also bounds every call at the timeout plus 30 s with the same error, should an adapter miss its deadline, and `sandboxrouter check` fails a provider that returns a timed-out command as a result or lets it keep running.
- `wrapCommand` (used by 17 adapters for cwd/env) ran the command in the wrong directory when `cwd` did not exist and `env` was set, because `cd` was joined with `;` to the exports. Every step is now chained with `&&` and the command is grouped, so a missing cwd stops it.
- Daytona's non-streaming exec merged stderr into stdout; every command now runs through a session, which keeps them apart.
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
