#!/usr/bin/env bash
set -euo pipefail

if [[ ${GITHUB_REF:-} != refs/heads/main ]]; then
  echo "Scheduled reports must be collected from main." >&2
  exit 1
fi

kind=$1
case "$kind" in
  bench|live-check|price-index|price-watch) ;;
  *) echo "Unknown scheduled report: $kind" >&2; exit 1 ;;
esac

if git diff --cached --quiet; then exit 0; fi

branch="report-$kind-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
git -c user.name="$kind" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -m "$2"

# The run and attempt identify this review branch. A retry can publish the same commit.
for attempt in 1 2 3; do
  if git push origin "HEAD:refs/heads/$branch"; then
    compare="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/compare/main...$branch?expand=1"
    printf 'Review the %s report on branch `%s`. [Compare and open a pull request](%s).\n' \
      "$kind" "$branch" "$compare" >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
done
exit 1
