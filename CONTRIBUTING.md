# Contributing

Thanks for helping. sandboxrouter is a small, neutral router: every provider gets the same treatment, and the catalog is only as good as its prices and its tests. The most useful contributions are, in order:

1. **Run a provider for real** and report what broke (`sandboxrouter check --provider <id>`).
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

## Testing a provider against a real account

```bash
export KOYEB_API_TOKEN=...                       # the env vars for that provider: `npx tsx src/cli.ts providers`
npx tsx src/cli.ts check --provider koyeb        # 10 real steps; any FAIL line is a bug
npx tsx src/cli.ts bench --provider koyeb --share --label "your city"   # cold starts, writes results/*.json
```

Maintainers: `npm run secrets:push -- --init` writes a gitignored `.env.providers` with every key name; fill it in and run `npm run secrets:push` to load the keys into the repo's Actions secrets for the nightly tests.

Open an issue with the `check` output (it never prints your keys), and a PR with the `results/` file if you ran `bench --share`. Afterwards, check the provider's dashboard that nothing is left running.

## Fixing a price

Prices live in [`src/catalog.ts`](src/catalog.ts): `vcpuHour`, `gbHour`, a short `note`, the `source` URL and the date you `checked` it. Fixed-size providers also have a rule in `hourlyCost()`. Change the numbers, set `checked` to today, link the page in the PR, then regenerate the generated parts:

```bash
node --import tsx scripts/readme-tables.ts    # paste the two tables into README.md (Prices, Env)
npm run site:data                             # web/src/data/site.json
```

`npm run price:check` shows which pricing pages changed since the last check (a workflow runs it every Monday and opens an issue).

Please use the provider's **public list price** for self-serve accounts. No negotiated rates, no promos, no credits.

## Adding a provider

One adapter file, one test file, and a few one-line registrations. Copy a plain-REST adapter close to the new one, e.g. [`src/providers/dedalus.ts`](src/providers/dedalus.ts) or [`src/providers/koyeb.ts`](src/providers/koyeb.ts) (or [`alibaba.ts`](src/providers/alibaba.ts) for an E2B-compatible API).

1. `src/providers/<id>.ts`: a class implementing `Provider` and `ProviderSandbox` from [`src/types.ts`](src/types.ts). Start it with a comment that lists the wire protocol you used and links the docs.
   - `exec` must honor `cwd`, `env` and `timeoutSeconds` (throw `ProviderError` with `command timed out after Ns`), and call `onStdout`/`onStderr` as output arrives if the provider can stream.
   - `readFile`/`writeFile` must be binary-safe.
   - `pause()` only if the provider keeps the disk; `connect(id)` must resume a paused sandbox.
   - Prefer plain `fetch` over an SDK. If an SDK is required, load it with `optionalImport` and add it to `peerDependenciesMeta` as optional.
2. `test/<id>.test.ts`: a local mock HTTP server that follows the provider's API and really runs the commands in a temp dir. It must pass on macOS and Linux (CI runs Ubuntu). Kill whole process groups on timeouts.
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
