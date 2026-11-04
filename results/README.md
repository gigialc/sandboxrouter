# Bench results

Each JSON file here is one `sandboxrouter bench --share` run. The leaderboard page is built from all of them:

```bash
npx sandboxrouter bench --runs 5 --share --label "us-east-1 c7g.large"
# writes sandboxrouter-bench-YYYY-MM-DD-xxxxxx.json; move it here and open a PR
npx sandboxrouter leaderboard results --out leaderboard.html
```

Rules for submissions:

- Run it unmodified, with your own provider accounts, at least 3 runs per provider.
- Say where you ran it in `--label` (cloud region or city), since network distance is part of the number.
- One file per run. Don't edit the numbers. A PR that changes someone else's file will be closed.

A report holds the provider, run count, failure count and median timings, plus your label, Node version and platform. It never includes keys, env vars, metadata or error messages.
