#!/usr/bin/env bash
# dev-story: "demo environments are reachable and live"
#
# Every demo env (branch starting "demo/" in ~/.samohost/envs.json, e.g.
# demo/red-bg, demo/red-login) is shown to real people, so it MUST be live.
# This test verifies that against the LIVE url — never a status log; logs are a
# hypothesis, the running surface is ground truth.
#
# Acceptance criteria, for each demo env's vhost:
#   1. GET /api/version returns HTTP 200
#   2. the body is JSON reporting env=preview  (a static catch-all that returns
#      the homepage HTML with a 200 must NOT pass — HTTP 200 alone is not proof)
#   3. the body's branch == the demo's branch from envs.json
#
# READ-ONLY: this runner only reads envs.json, curls, and parses with jq. It
# mutates NOTHING (no env create/destroy, no systemctl, no ssh, no edits, no
# "fixing"). A failure is a FINDING to report, not something to touch.
#
# Exit 0 = all demo envs healthy. Exit 1 = at least one failed (prints PASS/FAIL
# per demo). Intended to run on demand.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"
ENVS="$HOME/.samohost/envs.json"
ts() { date -u +%FT%TZ; }
RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS"' EXIT

echo "[$(ts)] DEV-STORY demo-envs-reachable: START"

if [ ! -r "$ENVS" ]; then
  echo "[$(ts)] DEV-STORY demo-envs-reachable: FAIL — cannot read $ENVS"
  exit 1
fi

# Enumerate demo envs: branch begins with "demo/".
demos="$(jq -c '.envs[] | select((.branch // "") | startswith("demo/"))' "$ENVS")"
ndemos="$(printf '%s\n' "$demos" | grep -c . || true)"
echo "  demo envs found: $ndemos"

if [ "${ndemos:-0}" -eq 0 ]; then
  # No demos to check. The story is vacuously satisfied; report it plainly.
  echo "[$(ts)] DEV-STORY demo-envs-reachable: 0 passed, 0 failed (no demo envs in envs.json)"
  echo "[$(ts)] DEV-STORY demo-envs-reachable: PASS"
  exit 0
fi

printf '%s\n' "$demos" | while read -r env; do
  [ -z "${env:-}" ] && continue
  app="$(jq -r '.appName // empty' <<<"$env")"
  branch="$(jq -r '.branch // empty' <<<"$env")"
  vhost="$(jq -r '.vhost // empty' <<<"$env")"

  if [ -z "$vhost" ]; then
    echo "FAIL demo $app [$branch]: no vhost recorded in envs.json" | tee -a "$RESULTS"
    continue
  fi

  url="https://$vhost/api/version"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null)"
  ctype="$(curl -s -D - -o /dev/null --max-time 15 "$url" 2>/dev/null \
            | tr -d '\r' | awk 'tolower($1)=="content-type:"{sub(/;.*/,"",$2); print tolower($2)}' | head -1)"
  body="$(curl -s --max-time 15 "$url" 2>/dev/null)"
  env_field="$(jq -r '.env // empty' <<<"$body" 2>/dev/null)"
  bbranch="$(jq -r '.branch // empty' <<<"$body" 2>/dev/null)"

  if [ "$code" = "200" ] && [ "$env_field" = "preview" ] && [ "$bbranch" = "$branch" ]; then
    echo "PASS demo $app [$branch] -> $url (200, env=preview, branch ok)" | tee -a "$RESULTS"
  else
    # Distinguish "served HTML instead of version JSON" for a clearer finding.
    note=""
    case "$ctype" in *json*) ;; *) [ -n "$ctype" ] && note=", content-type=$ctype (not JSON)";; esac
    echo "FAIL demo $app [$branch] -> $url (HTTP $code, env=${env_field:-<none>}, branch=${bbranch:-<none>}$note)" | tee -a "$RESULTS"
  fi
done

pass="$(grep -c '^PASS' "$RESULTS" 2>/dev/null || echo 0)"
fail="$(grep -c '^FAIL' "$RESULTS" 2>/dev/null || echo 0)"
echo "[$(ts)] DEV-STORY demo-envs-reachable: $pass passed, $fail failed"
if [ "${fail:-0}" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY demo-envs-reachable: FAIL — demo envs not all live:"
  grep '^FAIL' "$RESULTS" | sed 's/^/    /'
  exit 1
fi
echo "[$(ts)] DEV-STORY demo-envs-reachable: PASS"
exit 0
