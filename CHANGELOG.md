# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## Unreleased (next: 0.3.0)

### Added
- 16 more sandbox providers, for 31 cloud providers plus Docker:
  - Koyeb, Freestyle, Deno Sandbox, Beam, CodeSandbox (Together), Upstash Box, Novita, Alibaba Cloud, Azure Container Apps sessions, AWS Bedrock AgentCore (opt-in) and AWS Lambda MicroVMs.
  - YC sandbox startups: Agent37, InstaBox, OpenScale, Dedalus Machines (private beta) and Superserve.
- Desktops and phones from 6 more providers, routed by price per OS (Linux, Windows, Android, iOS): E2B Desktop, Daytona, Orgo, Mobilerun, Limrun and AWS WorkSpaces agent access.
- `sandboxrouter check --provider <id>`, plus `checkProvider()` from code: a 14-step test of one provider against a real account (output, env and cwd, UTF-8, streaming, binary and 1 MB files, missing-file errors, timeout and that the timed-out command was stopped, pause and resume, kill). `check --all --save` runs every configured provider and saves results/conformance/<id>.json, which the README's Compatibility table and each provider's page on the site are built from. A nightly workflow re-runs it with the repo's provider keys.
- Leak cleanup: routers record the sandboxes they start in a local ledger (~/.sandboxrouter/sandboxes.jsonl; `ledger: false` or SANDBOXROUTER_LEDGER=off to turn it off). `sandboxrouter ls` lists the ones never killed, with cost so far; `sandboxrouter gc` kills those past their lifetime (`--all`, `--older-than`, `--dry-run`). `sandboxrouter run` kills its sandbox on Ctrl-C.
- exe.dev: the VM powers itself off when its requested lifetime runs out (best effort), since exe.dev has no lifetime setting.
- Contributing guide, security policy, code of conduct, issue and PR templates, and a weekly price-page check.
- `test/conformance.ts`: the sandbox contract as a shared test suite that every adapter runs against its mock, and mock tests for the 13 adapters that had none (Blaxel, Boat, Cloudflare, Docker, exe.dev, HOPX, Modal, Morph, Northflank, Runloop, Sprites, Tensorlake, Vercel) plus the E2B and Daytona sandbox paths.

### Changed
- Providers that can't take the requested size are listed after the ones that can, with the reason.
- Website: full-width layout, white page, black ink.

### Fixed
- Modal: the adapter asked for twice the CPU it meant to (Modal counts physical cores, 1 core = 2 vCPUs).
- The exec timeout contract now holds on every provider: a command that outlives `timeoutSeconds` is stopped inside the sandbox and `exec` rejects with `<provider>: command timed out after Ns`. Before, E2B (and OpenScale, Novita, Alibaba), Vercel, Morph, Docker, HOPX and Northflank left the process running after the client gave up; Lambda, Cloudflare, exe.dev, AgentCore, Azure, Boat, Maritime, Modal and Blaxel returned the kill as an ordinary exit code; Beam's non-streaming exec waited for the command before starting its timer. `RoutedSandbox.exec` also bounds every call at the timeout plus 30 s with the same error, should an adapter miss its deadline, and `sandboxrouter check` fails a provider that returns a timed-out command as a result or lets it keep running.
- `wrapCommand` (used by 17 adapters for cwd/env) ran the command in the wrong directory when `cwd` did not exist and `env` was set, because `cd` was joined with `;` to the exports. Every step is now chained with `&&` and the command is grouped, so a missing cwd stops it.
- Daytona's non-streaming exec merged stderr into stdout; every command now runs through a session, which keeps them apart.
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
