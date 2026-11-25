# sandbox-routing

You put a project's agent sandboxes behind sandboxRouter (`@sandboxrouter/sdk`): one integration that runs on any sandbox provider the project has keys for, picks by cost and speed, and moves on when a provider is down. A run is judged on four things: the code uses the router's real API, nothing is tied to one provider without a stated reason, every sandbox is killed, and a real sandbox ran the project's smoke command. Reading the code proves none of these. The gate does.

## Tools

`node <the sandbox-routing skill's directory>/scripts/gate.mjs . [--next]` builds the project, scans it, runs the smoke command against a real sandbox with a private ledger, and exits non-zero on any failure. Exit 0 is the only definition of done. Load the `sandbox-routing` skill first: the skill tool reports its directory, and the gate runs from that absolute path. The directory is read-only and changes every run. Never copy the gate into the workspace.

`npx sandboxrouter providers` lists which provider keys are set. `npx sandboxrouter route` shows who would be tried, in order, and why anything is skipped, without starting a sandbox.

## Method

1. Load the `sandbox-routing` skill and read `references/api.md`. It is the API. Anything not in it does not exist.
2. Classify the task: a new integration, a migration off one provider's SDK, or a narrow edit. A narrow edit changes only what was asked.
3. Write `artifacts/evidence.json` before changing code: the files that create sandboxes, the build command, and the smoke command.
4. Make the change. Write the smoke script if the project has none.
5. Run the gate. Fix what fails. Run it again with `--next`.
6. Report.

Two gate passes are the budget. If the second fails on something outside the task (no provider key, a provider outage), stop and report it.

## Precedence

The user's stated scope beats every default here. Existing code sets the conventions: keep the project's module style, test runner and error handling. A project that pins one provider on purpose keeps the pin; record the reason in `allowDirect` or beside the `provider:` option.

## Invariants

- Every `create` has a `kill` in a `finally`, or uses `await using`. A sandbox that outlives its script bills until its lifetime runs out.
- Keys come from the environment. Never write a key into a file, a command, a log line or the report. Never read `.env` files to print or copy their values.
- Never edit the gate, `artifacts/run-*`, or the ledger it writes.
- Never remove a file from `entries` to make a check pass, and never list a provider SDK in `allowDirect` without a reason a reviewer would accept.
- The smoke command starts a real sandbox through the router. A smoke that mocks the router, or that only imports it, is a failed run.

## Field rules

**API**

- Import from `@sandboxrouter/sdk`. Each provider's own SDK is an optional package the router loads itself: install it (`npm i e2b`), never import it. The router's error names the package when one is missing.
- `create(spec, route)`: size and lifetime go in the first argument, the choice of provider in the second. `provider` in the spec is ignored.
- Sizes are `vcpu` and `memoryGb`. Not `cpu`, `cpus`, `memory`, `memoryMb` or `ram`. The library ignores a field it does not know, so a misspelled size silently gives the default 2 vCPU / 4 GB; the HTTP API refuses it with `bad_request`. Check `sbx.size` after the create.
- `exec` returns `{ exitCode, stdout, stderr, durationMs }` and does not throw on a non-zero exit. Check `exitCode`.
- Stream with `exec(cmd, { onStdout, onStderr })`. Do not poll a log file.
- A long-running server is `sbx.start(...)` with `require: ["background"]`, not `exec("... &")`. The address is `await sbx.url(port)` with `ports` declared at create.
- `image` is keyed by provider: `{ image: { modal: "python:3.13-slim" } }`. A bare string is refused. Only some providers start from a registry image; `references/api.md` lists them.

**Routing**

- Leave `provider` out unless the task names one. A hard-coded provider is the thing this work removes.
- A setup error (a bad key, a bad image, a bad request) stops the create on purpose. Do not reach for `fallback: "any"` to make an error go away: it hides a mistake behind a pricier provider. Fix the key or the image.
- Catch `RouterError` and branch on `code`. `no_provider` means no key or no provider fits the size: run `npx sandboxrouter route` and read the skip reasons. `all_failed` and `timeout` are worth a retry. `setup` is not.
- Need pause, ports or background commands? Put them in `require`. The router then only tries providers that have them.
- Set `timeoutMinutes` to what the job needs. It is the hard stop the provider enforces, and the default is 30.

**Migrating off a provider SDK**

- Map every call before deleting any. Calls with no router equivalent (snapshots, volumes, templates) stay on `sbx.native`, behind a check of `sbx.provider`, and go in the report.
- Working folders differ by provider. Use relative paths or `pwd`, never a provider's home directory as a literal.
- A provider template or snapshot id is not portable. Keep it under that provider's key in `image` and say in the report which providers the project can no longer reach because of it.

**Cleanup**

- A crashed script leaves sandboxes behind. `npx sandboxrouter ls` shows them, `npx sandboxrouter gc --all` kills them. Add `gc --all` to the end of the project's CI job when the project has one.

## Done means

- The gate exits 0 on the final run, and `artifacts/run-<n>/summary.json` shows every check passed.
- The summary's `smoke` item names the provider that ran it and shows zero sandboxes left open.
- No file imports a provider SDK except those in `allowDirect`, each with a reason.
- No key appears in the diff.

## Report

Failures first. Then: what changed, which provider the smoke ran on and how long the create took, what the gate reported per item, which calls stayed on `sbx.native` and why, and what could not be verified (providers with no key here were not run).
