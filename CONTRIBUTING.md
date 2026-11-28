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

The real-account results on the site come from whoever has an account, from wherever they are: a run from a new city or cloud region is as useful as a new provider. The quickest way, with any provider keys set and the [GitHub CLI](https://cli.github.com) signed in:

```bash
npx @sandboxrouter/sdk bench --task --runs 3 --label "Tokyo" --submit
```

That runs the benchmark, writes the report and opens the pull request for you (forking the repo if needed). Only the report is sent; it never contains keys. Providers whose every run failed on your account (a bad key, no credit, a limit) are left out, and nothing is written if your connection drops. More detail, per provider:

```bash
npx tsx src/cli.ts check --provider modal --save --by YOUR_GITHUB_USERNAME     # does it work: results/conformance/modal.json
npx tsx src/cli.ts bench --provider modal --runs 5 --share --label "Berlin" --by YOUR_GITHUB_USERNAME   # cold starts: move the file into results/
npx tsx src/cli.ts cost run --provider agent37 --minutes 10 --by YOUR_GITHUB_USERNAME   # provider usage goes to results/cost/; rerun `cost settle <file>` until it posts
```

Starting from your own image, for providers that take a registry address directly (a public image, and a command whose output says which image it is):

```bash
node --import tsx scripts/image-bench.ts --image python:3.11-bookworm --verify "python3 --version" --contains "Python 3.11" \
  --providers daytona,modal --label "Berlin" --by YOUR_GITHUB_USERNAME --out results/image-2026-11-26-berlin-python.json
```

The first start can be measured once per image and account, so use a tag the account has not started before.

Speed over time: one sandbox per provider for 10 minutes, the same one-core job every 10 seconds:

```bash
node --import tsx scripts/steady-bench.ts --providers daytona,modal --label "Berlin" --by YOUR_GITHUB_USERNAME --out results/steady-2026-11-28-berlin.json
```

An assistant session: first answer, a file up and down, 20 short calls and a call after a minute idle, three sessions per provider:

```bash
node --import tsx scripts/assistant-bench.ts --providers daytona,modal --label "Berlin" --by YOUR_GITHUB_USERNAME --out results/assistant-2026-11-28-berlin.json
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

## If you work at the provider

You're welcome to add your own product. Say so in the pull request, as a disclosure.

A new provider is listed as "not run yet" until its real-account check passes on our own account, so results a vendor runs on its own account don't count toward that. To get yours checked quickly, send test credits or a promo code for a fresh account to [gigiialc on X](https://x.com/gigiialc) or gigialcaraz38@gmail.com. A few dollars covers the check and the benchmarks.

Credits pay for the test runs and nothing else. They don't change your position, your price or the wording on the site: providers are ordered by public list price, and benchmark results are published as measured, including failures.

## Neutrality

Providers are ordered by list price (or your own measured cold starts), ties alphabetical. PRs that give a provider a better slot, a default or nicer copy won't be merged, including from providers. Provider teams are welcome to fix their own adapter.

## Pull requests

One thing per PR, with tests. `npm run typecheck && npm test` must pass (CI also runs the Python tests and the website build). By contributing you agree your work is released under the [MIT License](LICENSE).
