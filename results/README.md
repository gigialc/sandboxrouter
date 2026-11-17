# Bench results

Each JSON file here is one `sandboxrouter bench --share` run. The leaderboard page is built from all of them:

```bash
npx @sandboxrouter/sdk bench --runs 5 --share --label "us-east-1 c7g.large" --by YOUR_GITHUB_USERNAME
# writes sandboxrouter-bench-YYYY-MM-DD-xxxxxx.json; move it here and open a PR
npx @sandboxrouter/sdk leaderboard results --out leaderboard.html
```

Rules for submissions:

- Run it unmodified, with your own provider accounts, at least 3 runs per provider.
- Say where you ran it in `--label` (cloud region or city), since network distance is part of the number.
- One file per run. Don't edit the numbers. CI refuses a PR that changes or deletes an existing bench report.
- `npm run results:check` runs the same checks as CI: no keys, emails, IP addresses or street addresses, no impossible numbers.

`conformance/` holds the last `check --save` run per provider and `cost/` holds `cost run` files; see [CONTRIBUTING.md](../CONTRIBUTING.md#sending-results).

A report holds the provider, request count, outcomes and median timings, plus your label, Node version and platform. New workload reports include the requested shape, nominal router shape and the number of verified completions. They keep limit refusals, first-command failures, workload failures and cleanup failures separate. Shared records exclude raw error messages.

The v1 workload series (including the Modal task reports and `gemini-primes-v1`) remains here as historical evidence. The current workload, agent and workload-burst rankings only use the new verification versions. Start-only and spread records remain available as timed requests. A spread requests the batch concurrently and kills each sandbox as it finishes.
