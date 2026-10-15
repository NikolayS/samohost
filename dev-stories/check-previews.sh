#!/usr/bin/env bash
# dev-story: "open-PR previews are live and correct"
#
# Acceptance criteria (checked against the LIVE url — never the trigger's status
# log; logs are a hypothesis, the running surface is ground truth):
#   For every OPEN PR on each registered non-static app, the preview URL must:
#     1. return HTTP 200
#     2. report env=preview in /api/version
#     3. report branch == the PR's head branch
#   A PR with no preview env, or whose URL is unreachable / wrong env / wrong
#   branch, FAILS the story.
#
# Exit 0 = all open-PR previews healthy. Exit 1 = at least one failed (real,
# user-facing). Intended to run on a timer AND on demand.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"
APPS="$HOME/.samohost/apps.json"
ENVS="$HOME/.samohost/envs.json"
GH_TOKEN="$(gh auth token 2>/dev/null)"; export GH_TOKEN
ts() { date -u +%FT%TZ; }
RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS"' EXIT

echo "[$(ts)] DEV-STORY previews-reachable: START"

jq -r '.apps[] | select((.kind // "") != "static") | "\(.name)\t\(.repo)"' "$APPS" |
while IFS=$'\t' read -r app repo; do
  [ -z "${app:-}" ] && continue
  prs="$(gh pr list --repo "$repo" --state open --json number,headRefName 2>/dev/null)"
  [ -z "$prs" ] && prs='[]'
  n="$(jq 'length' <<<"$prs")"
  echo "  app=$app repo=$repo openPRs=$n"
  jq -c '.[]' <<<"$prs" | while read -r pr; do
    num="$(jq -r '.number' <<<"$pr")"
    branch="$(jq -r '.headRefName' <<<"$pr")"
    vhost="$(jq -r --arg a "$app" --arg b "$branch" \
      '.envs[] | select(.appName==$a and .branch==$b) | .vhost' "$ENVS" | head -1)"
    if [ -z "$vhost" ] || [ "$vhost" = "null" ]; then
      echo "FAIL PR#$num [$branch]: no preview env exists" | tee -a "$RESULTS"
      continue
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$vhost/api/version" 2>/dev/null)"
    body="$(curl -s --max-time 15 "https://$vhost/api/version" 2>/dev/null)"
    env="$(jq -r '.env // empty' <<<"$body" 2>/dev/null)"
    bbranch="$(jq -r '.branch // empty' <<<"$body" 2>/dev/null)"
    if [ "$code" = "200" ] && [ "$env" = "preview" ] && [ "$bbranch" = "$branch" ]; then
      echo "PASS PR#$num [$branch] -> https://$vhost (200, env=preview, branch ok)" | tee -a "$RESULTS"
    else
      echo "FAIL PR#$num [$branch] -> https://$vhost (HTTP $code, env=$env, branch=$bbranch)" | tee -a "$RESULTS"
    fi
  done
done

pass="$(grep -c '^PASS' "$RESULTS" 2>/dev/null || echo 0)"
fail="$(grep -c '^FAIL' "$RESULTS" 2>/dev/null || echo 0)"
echo "[$(ts)] DEV-STORY previews-reachable: $pass passed, $fail failed"
if [ "${fail:-0}" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY previews-reachable: FAIL — open-PR previews not healthy:"
  grep '^FAIL' "$RESULTS" | sed 's/^/    /'
  exit 1
fi
echo "[$(ts)] DEV-STORY previews-reachable: PASS"
exit 0
