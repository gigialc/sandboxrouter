# Contributing

Thanks for helping. sandboxrouter is a small, neutral router: every provider gets the same treatment, and the catalog is only as good as its prices and its tests. The most useful contributions are, in order:

1. **Run a provider for real** and send the result (see [Sending results](#sending-results)), or report what broke.
2. **Fix a price or a limit** that's out of date.
3. **Add a provider.**
4. Everything else: bugs, docs, the website, the Python client.

## Setup

```bash
git clone https://github.com/gigialc/sandboxrouter && cd sandboxrouter
npm install
npm run typecheck && npm test      # TypeScript: every adapter runs against a local mock server
npm run test:py                    # Python client
cd web && npm install && npm run build   # website
```

Node 20+ (CI uses 22; the Fly Sprites SDK wants 24). No provider accounts are needed for the tests.

## Sending results

Nobody can hold an account at every provider, so the real-account results on the website come from whoever has one. Three commands, each writing a file:

```bash
# the env vars for that provider: `npx tsx src/cli.ts providers`, or the provider's page on the website
export MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=...

npx tsx src/cli.ts check --provider modal --save --by YOUR_GITHUB_USERNAME
#   does it work: 14 real steps; writes results/conformance/modal.json
npx tsx src/cli.ts bench --provider modal --runs 5 --share --label "Berlin" --by YOUR_GITHUB_USERNAME
#   how fast it starts; writes sandboxrouter-bench-*.json: move it into results/
npx tsx src/cli.ts cost run --provider modal --minutes 10 --by YOUR_GITHUB_USERNAME
#   what it really billed; writes results/cost/cost-*.json. Bills post late, so run
#   `npx tsx src/cli.ts cost settle <that file>` again later until the bill shows
```

Each one starts real sandboxes on your account and kills them afterwards, for a few cents at most (a 10-minute cost run at 2 vCPU / 4 GB is about the list price for 10 minutes). `npx tsx src/cli.ts gc --all` kills anything a crashed run left behind; check the provider's dashboard afterwards anyway.

Then open a PR with the files, and run `npm run results:check` first. CI runs the same check on every PR. It refuses:

- anything that looks like a key or token, an email address or an IP address;
- a `--label` that looks like a street address: use a city or a cloud region;
- providers that aren't in the catalog, impossible numbers (fewer than 3 bench runs, timings over 15 minutes, negative bills), dates in the future;
- edits to or deletions of an existing bench report: a new run is a new file.

`--by` is optional and puts your GitHub username on the result, so the website can credit you. Results never include keys, env vars or error messages. Run the commands unmodified: a maintainer reviews every result PR, and numbers far from everyone else's get a second run before they're merged.

Prices are the exception: they always come from the provider's public pricing page (see below), never from a result file.

Maintainers: `npm run secrets:push -- --init` writes a gitignored `.env.providers` with every key name; fill it in and run `npm run secrets:push` to load the keys into the repo's Actions secrets for the nightly tests.

## Fixing a price

Prices live in [`src/catalog.ts`](src/catalog.ts): `vcpuHour`, `gbHour`, a short `note`, the `source` URL and the date you `checked` it. Fixed-size providers also have a rule in `hourlyCost()`. Change the numbers, set `checked` to today, link the page in the PR, then regenerate the generated parts:

```bash
node --import tsx scripts/readme-tables.ts --write   # regenerate the README tables (Prices, Env, Compatibility)
npm run site:data                             # web/src/data/site.json
```

`npm run price:check` shows which pricing pages changed since the last check (a workflow runs it every Monday and opens an issue).

Please use the provider's **public list price** for self-serve accounts. No negotiated rates, no promos, no credits.

## Adding a provider

One adapter file, one test file, and a few one-line registrations. Copy a plain-REST adapter close to the new one, e.g. [`src/providers/dedalus.ts`](src/providers/dedalus.ts) or [`src/providers/koyeb.ts`](src/providers/koyeb.ts) (or [`alibaba.ts`](src/providers/alibaba.ts) for an E2B-compatible API).

1. `src/providers/<id>.ts`: a class implementing `Provider` and `ProviderSandbox` from [`src/types.ts`](src/types.ts). Start it with a comment that lists the wire protocol you used and links the docs.
   - `exec` must honor `cwd`, `env` and `timeoutSeconds`, and call `onStdout`/`onStderr` as output arrives if the provider can stream.
   - A command that outlives `timeoutSeconds` must be **stopped** (not just abandoned) and `exec` must reject with `timeoutError(id, seconds)` from [`src/util.ts`](src/util.ts), i.e. `ProviderError("<id>: command timed out after Ns")`. The same file has the pieces: `wrapCommand` for cwd/env when the API lacks them, `guardTimeout` to run a command under coreutils `timeout` when the API cannot kill a running command, and `killedByTimeout` to recognise a timeout kill (exit 124/137/143 after the deadline) and tell it from a command that exits 124 by itself. The router adds a 30 s grace deadline on top (`EXEC_GRACE_S`), but that is a net, not the mechanism.
   - `readFile`/`writeFile` must be binary-safe.
   - `pause()` only if the provider keeps the disk; `connect(id)` must resume a paused sandbox.
   - Prefer plain `fetch` over an SDK. If an SDK is required, load it with `optionalImport` and add it to `peerDependenciesMeta` as optional.
2. `test/<id>.test.ts`: a local mock (an HTTP server following the provider's API, or `vi.mock` of its SDK) that really runs the commands with `sh` in a temp dir, honouring cwd, env and the vendor's timeout behaviour. Call `describeConformance("<id>", { provider, dir })` from [`test/conformance.ts`](test/conformance.ts) so the adapter is held to the same contract as every other (output, env and cwd, streaming, binary files, timeout kill, connect, pause and resume, kill), then add the vendor-specific checks (spec mapping, error mapping). It must pass on macOS and Linux (CI runs Ubuntu); macOS has no coreutils `timeout`, so mocks that need one add a shim (see `test/koyeb.test.ts`). Kill whole process groups on timeouts.
3. Register it: the id in `ProviderId` (`src/types.ts`), a catalog entry (and an `hourlyCost` rule for fixed sizes) in `src/catalog.ts`, `defaultProviders()` in `src/router.ts`, an export in `src/index.ts`, and the npm package (or `null`) in `web/src/lib/site.ts`.
4. Docs: the intro list, the Install note and the "How each adapter maps the spec" row in `README.md`, then regenerate the tables and site data as above.

Capabilities in the catalog describe what the **adapter** implements, not what the provider markets. Leave a capability out until it's implemented and tested.

## Neutrality

The router orders providers by list price (or your own measured cold starts) and breaks ties alphabetically. PRs that give any provider a better slot, a default, or nicer copy than the others won't be merged, including from providers. Provider teams are very welcome to review and fix their own adapter.

## Pull requests

- Keep each PR to one thing, and include tests.
- `npm run typecheck && npm test` must pass. CI also runs the Python tests and the website build.
- Write commit messages that say what changed and why.
- By contributing you agree your work is released under the [MIT License](LICENSE).
