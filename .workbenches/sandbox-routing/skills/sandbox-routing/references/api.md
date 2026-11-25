# sandboxRouter API

`npm i @sandboxrouter/sdk`, plus the SDK package of each provider you use (the router's error names it when one is missing). ES modules, Node 20+. Full reference: https://sandboxrouter.ai/docs.md

## Create, run, kill

```ts
import { Router, RouterError } from "@sandboxrouter/sdk";

const router = new Router(); // reads provider keys from the environment
const sbx = await router.create(
  { vcpu: 4, memoryGb: 8, timeoutMinutes: 20 }, // what the run needs
  { strategy: "balanced" },                     // how to choose the provider
);
try {
  const r = await sbx.exec("npm test", { cwd: "app", timeoutSeconds: 600, onStdout: (c) => process.stdout.write(c) });
  if (r.exitCode !== 0) throw new Error(r.stderr);
} finally {
  await sbx.kill();
}
```

## Spec (first argument)

Only these fields exist: `vcpu`, `memoryGb`, `gpu`, `env`, `ports`, `timeoutMinutes`, `expectedSeconds`, `cpuUtilization`, `image`, `metadata`.

- `vcpu`, `memoryGb`: default 2 and 4.
- `timeoutMinutes`: the hard lifetime the provider enforces. Default 30.
- `expectedSeconds`: how long the job runs, for pricing. Short jobs then favor providers that bill by the second.
- `cpuUtilization`: 0 to 1. About 0.1 for an agent that mostly waits on model calls.
- `env`, `metadata`: objects of strings.
- `ports`: HTTP ports the sandbox will serve.
- `image`: an object keyed by provider, never a string.

## Route (second argument)

Only these fields exist: `provider`, `strategy`, `fallback`, `require`, `createTimeoutSeconds`, `deadlineSeconds`, `maxHourlyUsd`.

- `strategy`: `balanced` (default: cheapest for the run, near-ties go to the faster one), `cheapest`, `fastest`, `verified`.
- `provider`: one id or a list in order. Leave out to let the router choose.
- `fallback`: `true` (default) moves on when a provider is down, slow, rate-limited or out of credit. `false` never moves on. `"any"` moves on for every error, including a bad key or image.
- `require`: capabilities the provider must have: `"pause"`, `"ports"`, `"background"`, `"custom-image"`, among others.
- `maxHourlyUsd`: skip providers that would cost more.

## The sandbox

- `sbx.id` (`provider:nativeId`), `sbx.provider`, `sbx.size`, `sbx.attempts` (every provider tried and why it failed).
- `exec(cmd, { cwd, env, timeoutSeconds, onStdout, onStderr })` returns `{ exitCode, stdout, stderr, durationMs }`. A non-zero exit does not throw. A command past `timeoutSeconds` does.
- `writeFile(path, content)`, `readFile(path)` (bytes), `readText(path)`.
- `start(cmd, { cwd, env })` runs a background command and returns a handle with `kill()`. Needs `require: ["background"]`.
- `url(port)` gives the preview address. Needs `ports` in the spec.
- `pause()`, then `router.get(id)` to wake it. Needs `require: ["pause"]`.
- `kill()`.
- `native`: the provider's own sandbox object, for features the router does not cover. Check `sbx.provider` before using it.

## Router

- `router.get(id)`: reconnect to a sandbox from another process.
- `router.plan(spec, route)`: who would be tried, in order, with the price and the reason for every skip. Starts nothing.
- `router.quote(spec, route)`: where a create would land and what the run would cost. Starts nothing.
- `router.copy(from, to, { path, exclude, encrypt })`: copy a folder from one sandbox to another, across providers.
- `router.move(sbx, { exclude, keep, encrypt })`: start a sandbox on another provider, copy the working folder, kill the old one. Files move. Processes, memory and environment variables do not.

## Errors

`create`, `plan` and `get` throw `RouterError` with `code` and `attempts`.

| `code` | Meaning | Do |
| --- | --- | --- |
| `bad_request` | Invalid spec or route | Fix the call |
| `unsupported` | The provider cannot do this | Create with `require` |
| `no_provider` | No provider with a key fits | Read `router.plan(...)` for the reasons |
| `setup` | A provider refused the key, image or request | Fix the key or image |
| `all_failed` | Every provider tried was down, busy or out of credit | Retry later |
| `timeout` | The create ran out of `deadlineSeconds` | Retry or raise it |

## Images

`image` is keyed by provider because each one names images differently.

These start straight from a registry image reference such as `ghcr.io/acme/app:1.2.0`: `modal`, `daytona`, `beam`, `northflank`, `koyeb`, `exedev`, and `docker` on the local machine. A large image takes about a minute the first time and about a second after that, so raise `createTimeoutSeconds` for the first create. The registry must be reachable by the provider's own image builder: a registry that blocks automated clients fails there even when `docker pull` works on a laptop.

`blaxel` takes an image reference too, but the image must contain Blaxel's sandbox server; a plain image is created and then never answers.

These take their own template, blueprint or snapshot id, built with the provider's tooling first: `e2b`, `novita`, `openscale`, `alibaba`, `hopx`, `superserve`, `runloop`, `morph`, `freestyle`, `boat`, `maritime`, `instabox`, `agent37`, `langsmith`, `codesandbox`, `tensorlake`.

A job that must start from one registry image on any provider lists the same reference under each provider in the first group and adds `require: ["custom-image"]`.

## Hosted key

With `SANDBOXROUTER_API_KEY` set and no provider keys, use the hosted client. It has the same `create`, `exec`, files, `copy` and `move`:

```ts
import { Client } from "@sandboxrouter/sdk";
const sr = new Client({ apiKey: process.env.SANDBOXROUTER_API_KEY });
```

## CLI

```bash
npx sandboxrouter providers        # prices, and which keys are set
npx sandboxrouter route --vcpu 4 --memory 8   # dry run
npx sandboxrouter run "uname -a"   # start, run, print, kill
npx sandboxrouter ls               # sandboxes started here and never killed
npx sandboxrouter gc --all         # kill them
```

The ledger of started sandboxes is `$SANDBOXROUTER_HOME/sandboxes.jsonl`, default `~/.sandboxrouter/`.
