# Contributing

Most useful, in order: **run a provider on a real account and send the result**, **fix a price**, **add a provider**. Bugs, docs and the website are welcome too.

## Setup

```bash
git clone https://github.com/gigialc/sandboxrouter && cd sandboxrouter
npm install
npm run typecheck && npm test           # every adapter against a local mock; no accounts needed
npm run test:py                         # Python client
cd web && npm install && npm run build  # website
```

Node 20+ (CI uses 22).

## Sending results

The real-account results on the site come from whoever has an account. With that provider's keys set (`npx tsx src/cli.ts providers` lists them):

```bash
npx tsx src/cli.ts check --provider modal --save --by YOUR_GITHUB_USERNAME     # does it work: results/conformance/modal.json
npx tsx src/cli.ts bench --provider modal --runs 5 --share --label "Berlin" --by YOUR_GITHUB_USERNAME   # cold starts: move the file into results/
npx tsx src/cli.ts cost run --provider modal --minutes 10 --by YOUR_GITHUB_USERNAME   # real bill: results/cost/; rerun `cost settle <file>` until it posts
```

Each costs a few cents and kills its sandboxes; `npx tsx src/cli.ts gc --all` cleans up after a crash. Run `npm run results:check`, then open a PR with the files. CI refuses keys, emails, IP addresses, street-address labels, unknown providers, impossible numbers, and edits to someone else's bench report. A maintainer reviews every result PR.

- `--by` credits you on the site. Results never include keys, env vars or error messages.
- Prices never come from result files; they come from the provider's pricing page (below).
- Providers whose terms forbid publishing benchmarks (`noBenchmarks` in [`src/catalog.ts`](src/catalog.ts), today Blaxel) are left out of shared files automatically.

Maintainers: `npm run secrets:push -- --init` writes a gitignored `.env.providers`; fill it in and run `npm run secrets:push` to load the keys into Actions secrets for the nightly check.

## Fixing a price

Edit the provider's entry in [`src/catalog.ts`](src/catalog.ts) (`vcpuHour`, `gbHour`, `note`, `source`, `checked` = today), link the pricing page in the PR, then regenerate:

```bash
node --import tsx scripts/readme-tables.ts --write && npm run site:data
```

Use the **public self-serve list price**: no negotiated rates, promos or credits. `npm run price:check` shows which pricing pages changed; a workflow runs it every Monday.

## Adding a provider

Copy an adapter close to the new one: [`koyeb.ts`](src/providers/koyeb.ts) or [`dedalus.ts`](src/providers/dedalus.ts) for plain REST, [`alibaba.ts`](src/providers/alibaba.ts) for an E2B-compatible API.

1. **`src/providers/<id>.ts`** implements `Provider` and `ProviderSandbox` from [`src/types.ts`](src/types.ts); its top comment names the protocol and links the docs.
   - `exec` honours `cwd`, `env` and `timeoutSeconds`, and streams through `onStdout`/`onStderr` when the provider can.
   - A command past its timeout must be **stopped**, and `exec` rejects with `timeoutError(id, seconds)`. [`src/util.ts`](src/util.ts) has the helpers: `wrapCommand`, `guardTimeout`, `killedByTimeout`.
   - Files are binary-safe. `pause()` only if the disk is kept; `connect(id)` resumes a paused sandbox.
   - Prefer `fetch`; an SDK loads through `optionalImport` and is an optional peer dependency.
2. **`test/<id>.test.ts`** mocks the provider's API, really runs commands with `sh`, and calls `describeConformance("<id>", …)` from [`test/conformance.ts`](test/conformance.ts) so the adapter meets the same contract as every other. It must pass on macOS and Linux (see `test/koyeb.test.ts` for the `timeout` shim).
3. **Register it:** `ProviderId` in `src/types.ts`, a catalog entry in `src/catalog.ts`, `defaultProviders()` in `src/router.ts`, an export in `src/index.ts`, and its npm package (or `null`) in `web/src/lib/site.ts`.
4. **Docs:** the provider list at the top of `README.md` and the Install note and adapter row in [`docs/reference.md`](docs/reference.md), then regenerate as above.

List only the capabilities the adapter implements and tests, not what the provider markets.

## Neutrality

Providers are ordered by list price (or your own measured cold starts), ties alphabetical. PRs that give a provider a better slot, a default or nicer copy won't be merged, including from providers. Provider teams are welcome to fix their own adapter.

## Pull requests

One thing per PR, with tests. `npm run typecheck && npm test` must pass (CI also runs the Python tests and the website build). By contributing you agree your work is released under the [MIT License](LICENSE).
