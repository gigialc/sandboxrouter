# Changelog

All notable changes. Versions follow [semver](https://semver.org/); while the version is 0.x, a minor bump can change the API.

## Unreleased (next: 0.3.0)

### Added
- First real-account runs: E2B, Daytona, Maritime and OpenScale pass all 13 steps; Blaxel passes 12 of 12 (no pause).
- LangSmith Sandboxes (LangChain) via the `langsmith` SDK (`LANGSMITH_API_KEY`; streaming needs `ws`). Memory is kept within the 2 to 6 GiB per vCPU LangSmith allows; `timeoutMinutes` becomes the idle stop, and a stopped sandbox is deleted a day later.
- Sign-up status for gated providers (`access` in the catalog, `accessLabel()`): InstaBox and Dedalus are waitlisted, Koyeb isn't taking new accounts since joining Mistral. `providers`, `route`, the README and the site say so. Routing is unchanged: anyone who already has a key still gets routed there.
- 16 more sandbox providers, for 31 cloud providers plus Docker:
  - Koyeb, Freestyle, Deno Sandbox, Beam, CodeSandbox (Together), Upstash Box, Novita, Alibaba Cloud, Azure Container Apps sessions, AWS Bedrock AgentCore (opt-in) and AWS Lambda MicroVMs.
  - YC sandbox startups: Agent37, InstaBox, OpenScale, Dedalus Machines (private beta) and Superserve.
- Desktops and phones from 6 more providers, routed by price per OS (Linux, Windows, Android, iOS): E2B Desktop, Daytona, Orgo, Mobilerun, Limrun and AWS WorkSpaces agent access.
- `sandboxrouter check --provider <id>`, plus `checkProvider()` from code: a 13-step test of one provider against a real account (output, env and cwd, UTF-8, streaming, binary and 1 MB files, missing-file errors, timeout, pause and resume, kill). `check --all --save` runs every configured provider and saves results/conformance/<id>.json, which the README's Compatibility table and each provider's page on the site are built from. A nightly workflow re-runs it with the repo's provider keys.
- Leak cleanup: routers record the sandboxes they start in a local ledger (~/.sandboxrouter/sandboxes.jsonl; `ledger: false` or SANDBOXROUTER_LEDGER=off to turn it off). `sandboxrouter ls` lists the ones never killed, with cost so far; `sandboxrouter gc` kills those past their lifetime (`--all`, `--older-than`, `--dry-run`). `sandboxrouter run` kills its sandbox on Ctrl-C.
- exe.dev: the VM powers itself off when its requested lifetime runs out (best effort), since exe.dev has no lifetime setting.
- Contributing guide, security policy, code of conduct, issue and PR templates, and a weekly price-page check.

### Changed
- Providers that can't take the requested size are listed after the ones that can, with the reason.
- Website: full-width layout, white page, black ink.

### Fixed
- Daytona: stdout and stderr came back merged, and pause always failed because sandboxes were created ephemeral (`autoDeleteInterval: 0`); a stopped sandbox is now deleted a minute later instead. Streaming commands that call `exit` no longer hang.
- Blaxel: pause removed (archiving is a preview Blaxel enables per workspace), `kill()` waits for the asynchronous delete, and API errors no longer read "[object Object]".
- Modal: the adapter asked for twice the CPU it meant to (Modal counts physical cores, 1 core = 2 vCPUs).
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
