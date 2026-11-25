---
name: sandbox-routing
description: Load at the start of every run in this Workbench, before reading or changing code. Use for adding sandboxRouter (@sandboxrouter/sdk) to a project, migrating code off one sandbox provider's SDK (E2B, Daytona, Modal, Blaxel, Northflank and others), choosing providers by cost or speed, starting sandboxes from an image, moving work between providers, and proving the result with the gate.
---

# sandbox-routing

This directory holds the API reference and the gate. It is a read-only, per-run copy: run its scripts by the absolute path the skill tool reported, and never write here.

## Order of work

1. Read [references/api.md](references/api.md) in full, once. It is the whole public API.
2. Find every place the project creates, uses or kills a sandbox: `grep -rnE "Sandbox|sandbox" --include="*.{ts,tsx,js,mjs,py}" . | grep -v node_modules`.
3. Write `artifacts/evidence.json` (below) before changing code.
4. Change the code. Copy [templates/smoke.mjs](templates/smoke.mjs) to the project if it has no smoke script, and edit the command it runs to one that proves this project's sandbox works.
5. Run the gate: `node <this directory>/scripts/gate.mjs .`
6. Open `artifacts/run-<n>/summary.json`. Fix each failed item, then run the gate with `--next`.

## The evidence manifest

`artifacts/evidence.json`, written by you, read by the gate:

```json
{
  "entries": ["src/agent/sandbox.ts"],
  "build": "npm run build",
  "smoke": "node scripts/sandbox-smoke.mjs",
  "allowDirect": [{ "file": "src/agent/snapshots.ts", "package": "e2b", "reason": "E2B snapshots have no router equivalent" }]
}
```

- `entries`: every file that creates a sandbox. The gate also finds them itself and fails when one is missing from the list.
- `build`: the project's build or typecheck command. Use `""` only when the project has neither, and say so in the report.
- `smoke`: a command that starts a real sandbox through the router, runs something, and kills it. Exit 0 means it worked.
- `allowDirect`: files that keep a provider SDK import, each with a reason.

## What the gate checks

| Item | Passes when |
| --- | --- |
| `manifest` | The manifest parses and every entry exists. |
| `entries` | Every file that calls the router's `create` is listed. |
| `build` | The build command exits 0. |
| `direct-sdk` | No file imports a provider SDK, except those in `allowDirect`. |
| `kill` | Every entry that creates a sandbox also kills it or uses `await using`. |
| `keys` | No file in the project contains something shaped like a provider key. |
| `smoke` | The smoke command exits 0, the private ledger shows at least one sandbox started, and none is left open. |

Keep the router's ledger on in the smoke script (`new Router()`, never `{ ledger: false }`): the ledger is how the gate knows a sandbox really started. The gate gives the smoke command its own ledger folder, reads which provider ran, and kills anything left open before it exits. With no provider key in the environment the `smoke` item fails with that reason: report it, do not work around it.

## Look before you report

After exit 0, open `summary.json` and the smoke output in `artifacts/run-<n>/smoke.log`. Check that the provider named is one the task expected, that the size is the size asked for, and that the output is the project's command and not a placeholder. A pass with a smoke that runs `echo ok` proves the router works, not the project.
