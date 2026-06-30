#!/usr/bin/env bash
# dev-story: "every open PR has a current preview-link comment"
#
# For every OPEN PR on a registered non-static app (apps.json kind != "static"),
# the samohost trigger is supposed to post exactly ONE preview-link comment — the
# client-facing affordance that hands the client/bot their clickable preview URL.
# This test asserts that comment exists on each open PR, read straight from the
# GitHub PR (ground truth), never from a status log / state.json / trigger action.
#
# A PR passes if any of its comments contains EITHER:
#   - the upsert marker  '<!-- samohost-preview -->'   OR
#   - the visible line   '🔎 Preview:'  ( "🔎 **Preview:** <url> ..." )
# AND that comment carries an http(s):// URL (the link the client clicks).
#
# READ-ONLY: this runner only reads apps.json and issues GET requests via gh
# (`gh pr list`, `gh api .../issues/<n>/comments`) and parses with jq/grep. It
# mutates NOTHING — it does not post/edit/delete comments, open/close/merge PRs,
# create/destroy envs, systemctl, ssh, edit, deploy, or "fix" anything. A missing
# comment is a FINDING to REPORT, not something to touch.
#
# Exit 0 = every open PR has a current preview-link comment.
# Exit 1 = at least one open PR is missing it (prints PASS/FAIL per PR).
# Intended to run on demand.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"
APPS="$HOME/.samohost/apps.json"
MARKER='<!-- samohost-preview -->'
ts() { date -u +%FT%TZ; }
RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS"' EXIT

echo "[$(ts)] DEV-STORY preview-comment-current: START"

if [ ! -r "$APPS" ]; then
  echo "[$(ts)] DEV-STORY preview-comment-current: FAIL — cannot read $APPS"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "[$(ts)] DEV-STORY preview-comment-current: FAIL — gh not on PATH"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "[$(ts)] DEV-STORY preview-comment-current: FAIL — gh not authenticated"
  exit 1
fi

# Registered non-static apps: name + repo.
apps="$(jq -c '.apps[] | select((.kind // "") != "static") | {name, repo}' "$APPS")"
napps="$(printf '%s\n' "$apps" | grep -c . || true)"
echo "  registered non-static apps: $napps"

if [ "${napps:-0}" -eq 0 ]; then
  echo "[$(ts)] DEV-STORY preview-comment-current: 0 passed, 0 failed (no non-static apps)"
  echo "[$(ts)] DEV-STORY preview-comment-current: PASS"
  exit 0
fi

printf '%s\n' "$apps" | while read -r app; do
  [ -z "${app:-}" ] && continue
  name="$(jq -r '.name // empty' <<<"$app")"
  repo="$(jq -r '.repo // empty' <<<"$app")"
  if [ -z "$repo" ]; then
    echo "FAIL app $name: no repo in apps.json" | tee -a "$RESULTS"
    continue
  fi

  # OPEN PRs from the app's OWN repo only (exclude fork/cross-repo PRs: the
  # trigger does not preview forks). headRepositoryOwner.login == repo owner.
  owner="${repo%%/*}"
  prs_json="$(gh pr list --repo "$repo" --state open --limit 100 \
                --json number,headRefName,url,isCrossRepository,headRepositoryOwner 2>/dev/null)"
  if [ -z "$prs_json" ] || ! jq -e . >/dev/null 2>&1 <<<"$prs_json"; then
    echo "FAIL app $name [$repo]: could not list open PRs (gh error)" | tee -a "$RESULTS"
    continue
  fi

  prs="$(jq -c --arg owner "$owner" \
          '.[] | select((.isCrossRepository // false) | not)
               | select((.headRepositoryOwner.login // $owner) == $owner)
               | {number, branch: .headRefName, url}' <<<"$prs_json")"
  nprs="$(printf '%s\n' "$prs" | grep -c . || true)"
  echo "  $name [$repo]: $nprs open same-repo PR(s)"

  [ "${nprs:-0}" -eq 0 ] && continue

  printf '%s\n' "$prs" | while read -r pr; do
    [ -z "${pr:-}" ] && continue
    num="$(jq -r '.number' <<<"$pr")"
    branch="$(jq -r '.branch' <<<"$pr")"

    # Read this PR's comments (issue comments). GET only — read-only.
    comments="$(gh api "repos/$repo/issues/$num/comments" --paginate 2>/dev/null \
                  | jq -r '.[].body' 2>/dev/null)"

    has_marker=0; has_line=0; url=""
    if printf '%s' "$comments" | grep -qF "$MARKER"; then has_marker=1; fi
    if printf '%s' "$comments" | grep -qF '🔎' \
       && printf '%s' "$comments" | grep -qiF 'Preview:'; then has_line=1; fi
    # Pull the URL out of the matching comment line (the clickable link).
    url="$(printf '%s' "$comments" | grep -F '🔎' \
            | grep -oE 'https?://[^[:space:]]+' | head -1)"

    if { [ "$has_marker" -eq 1 ] || [ "$has_line" -eq 1 ]; } && [ -n "$url" ]; then
      sig="marker"; [ "$has_marker" -eq 1 ] && [ "$has_line" -eq 1 ] && sig="marker+line"
      [ "$has_marker" -eq 0 ] && sig="line"
      echo "PASS $name PR #$num [$branch]: preview-link comment present ($sig) -> $url" | tee -a "$RESULTS"
    elif { [ "$has_marker" -eq 1 ] || [ "$has_line" -eq 1 ]; } && [ -z "$url" ]; then
      echo "FAIL $name PR #$num [$branch]: preview comment found but carries NO url" | tee -a "$RESULTS"
    else
      echo "FAIL $name PR #$num [$branch]: NO preview-link comment (client has no link)" | tee -a "$RESULTS"
    fi
  done
done

pass="$(grep -c '^PASS' "$RESULTS" 2>/dev/null || echo 0)"
fail="$(grep -c '^FAIL' "$RESULTS" 2>/dev/null || echo 0)"
echo "[$(ts)] DEV-STORY preview-comment-current: $pass passed, $fail failed"
if [ "${fail:-0}" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY preview-comment-current: FAIL — open PRs missing the preview-link comment:"
  grep '^FAIL' "$RESULTS" | sed 's/^/    /'
  exit 1
fi
echo "[$(ts)] DEV-STORY preview-comment-current: PASS"
exit 0
