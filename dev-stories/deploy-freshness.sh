#!/usr/bin/env bash
# dev-story: "production reflects the latest merge (deploy freshness)"
#
# For every registered NON-static app, the public PRODUCTION build must be
# consistent with the LATEST MERGED commit on its default branch. This catches
# the "tagged / merged but prod never updated" class of failure: CI green, PR
# merged, a deploy was *believed* to run, yet prod still serves a stale build.
# A "site is up" check can't see this — a stale build is up, healthy, and wrong.
#
# Ground truth:
#   - latest default-branch SHA  : GitHub via `gh api .../commits/<branch>`
#   - deployed SHA               : apps.json[].deployedSha (what samohost shipped)
#   - prod liveness/identity      : live curl of /api/version (never a log)
# Prod /api/version currently exposes NO commit SHA, so the SHA comparison is
# deployedSha vs latest-merge, with the live /api/version as the required
# reachability/identity anchor. If a deployedSha is absent (exact SHA mapping
# unavailable), we still assert prod is reachable+production and REPORT what prod
# shows vs the latest merge as a WARN finding (does not fail the run by itself).
#
# ABSOLUTE CONSTRAINT: read-only observability. This script ONLY reads / curls /
# gh-queries / ssh-cats / jq / greps. It NEVER mutates anything (no env
# create/destroy, no systemctl, no remote edits, no deploy, no re-deploy, no
# merge, no "fixing"). A stale prod is a FINDING to report, NOT something to
# touch.
#
# Exit 0 = every in-scope app is reachable+production and either FRESH or only
#          WARN (no deployedSha to compare).
# Exit 1 = any app unreachable / not-production / prod-host-undeterminable /
#          latest-SHA-unobtainable / STALE.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"
APPS="$HOME/.samohost/apps.json"
STATE="$HOME/.samohost/state.json"
PROD_DOMAIN_SUFFIX=".samo.team"   # production zone; previews live on samo.cat
ts() { date -u +%FT%TZ; }
RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS"' EXIT

echo "[$(ts)] DEV-STORY deploy-freshness: START"

if [ ! -r "$APPS" ]; then
  echo "[$(ts)] FAIL: cannot read $APPS" | tee -a "$RESULTS"
  echo "[$(ts)] DEV-STORY deploy-freshness: FAIL"; exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "[$(ts)] FAIL: gh CLI not on PATH — cannot read latest default-branch SHA" | tee -a "$RESULTS"
  echo "[$(ts)] DEV-STORY deploy-freshness: FAIL"; exit 1
fi

# Read-only, non-interactive ssh. Used ONLY to cat the prod Caddyfile to discover
# the public prod host. Never runs a mutating command.
ro_ssh() {  # $1=user $2=ip $3=port  (command on stdin)
  local user="$1" ip="$2" port="$3"
  timeout 25 ssh -p "$port" \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=12 -o BatchMode=yes \
    "${user}@${ip}" "$(cat)" 2>/dev/null
}

# Discover the public production host for an app, read-only.
#   1) explicit mainHost in apps.json wins
#   2) else derive from the prod VM's main Caddyfile: the *.samo.team site block
#      that reverse_proxies to the app's prod port (from healthUrl).
# Echoes the host on success; echoes nothing on failure.
discover_prod_host() {
  local app="$1" vmId="$2" prodPort="$3"

  local explicit
  explicit="$(jq -r --arg a "$app" \
    '.apps[] | select(.name==$a) | .mainHost // empty' "$APPS" 2>/dev/null)"
  if [ -n "$explicit" ] && [ "$explicit" != "null" ]; then
    case "$explicit" in
      *.samo.cat) : ;;                  # a preview host is NOT a prod host
      *) echo "$explicit"; return 0 ;;  # any non-samo.cat explicit host accepted
    esac
  fi

  [ ! -r "$STATE" ] && return 1
  local ip user port
  ip="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .ip // empty' "$STATE" 2>/dev/null)"
  user="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .sshUser // "agent"' "$STATE" 2>/dev/null)"
  port="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .sshPort // 22' "$STATE" 2>/dev/null)"
  [ -z "$ip" ] && return 1

  local host
  host="$(printf '%s\n' \
    "awk -v p=':${prodPort}' '
       /samo\.team[[:space:]]*\{/ { h=\$1 }
       \$0 ~ (\"reverse_proxy[[:space:]]+localhost\" p) { if (h!=\"\") { gsub(/^https?:\/\//,\"\",h); print h; exit } }
     ' /etc/caddy/Caddyfile 2>/dev/null" \
    | ro_ssh "$user" "$ip" "$port")"

  host="$(printf '%s' "$host" | tr -d '\r' | head -1)"
  case "$host" in
    *.samo.cat|"") return 1 ;;          # never a preview host, never empty
    *) echo "$host"; return 0 ;;
  esac
}

# Latest commit on a repo's branch, read-only via gh, in ONE call. Echoes
# "<sha>\t<isoDate>" only when the response is a real 40-hex commit SHA;
# otherwise echoes nothing (a 401/403/404/rate-limit JSON body can never leak
# into a finding). Caller treats empty SHA as "could not obtain latest SHA".
latest_commit() {  # $1=repo (owner/name) $2=branch
  local out sha date
  out="$(gh api "repos/$1/commits/$2" --jq '[.sha, .commit.committer.date] | @tsv' 2>/dev/null)"
  sha="$(printf '%s' "$out" | cut -f1 | tr -d '[:space:]')"
  date="$(printf '%s' "$out" | cut -f2 | tr -d '[:space:]')"
  case "$sha" in
    [0-9a-f]*) [ "${#sha}" -eq 40 ] || return 0 ;;   # require a real 40-hex SHA
    *) return 0 ;;
  esac
  # only emit a date that looks like an ISO timestamp; else blank it
  case "$date" in *T*Z|*T*+*|*T*-*) : ;; *) date="" ;; esac
  printf '%s\t%s' "$sha" "$date"
}

short() { printf '%s' "${1:0:8}"; }

# in-scope = non-static apps. Emit: name<TAB>repo<TAB>branch<TAB>vmId<TAB>prodPort<TAB>deployedSha
jq -r '
  .apps[]
  | select((.kind // "") != "static")
  | [ .name,
      (.repo // ""),
      (.branch // "main"),
      (.vmId // ""),
      ((.healthUrl // "") | capture("localhost:(?<p>[0-9]+)").p // "3000"),
      (.deployedSha // "")
    ] | @tsv
' "$APPS" |
while IFS=$'\t' read -r app repo branch vmId prodPort deployedSha; do
  [ -z "${app:-}" ] && continue
  [ -z "${branch:-}" ] && branch="main"
  [ -z "${prodPort:-}" ] && prodPort=3000

  # --- live anchor: prod must be reachable + report production -----------------
  host="$(discover_prod_host "$app" "$vmId" "$prodPort")"
  if [ -z "$host" ]; then
    echo "FAIL $app: production host undeterminable by read-only means (no mainHost in apps.json, no samo.team vhost on prod port :$prodPort in prod Caddyfile)" | tee -a "$RESULTS"
    continue
  fi
  url="https://${host}/api/version"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null)"
  body="$(curl -s --max-time 20 "$url" 2>/dev/null)"
  envf="$(jq -r '.env // empty' <<<"$body" 2>/dev/null)"
  disp="$(jq -r '.displayVersion // .version // empty' <<<"$body" 2>/dev/null)"
  prodSha="$(jq -r '.sha // .gitSha // .commit // empty' <<<"$body" 2>/dev/null)"  # future-proof if exposed
  if [ "$code" != "200" ] || [ "$envf" != "production" ]; then
    echo "FAIL $app -> $url not a live production surface (HTTP $code, env=${envf:-<none>}) — cannot assess freshness against a down/wrong prod" | tee -a "$RESULTS"
    continue
  fi

  # --- latest merged commit on the default branch ------------------------------
  if [ -z "$repo" ]; then
    echo "FAIL $app: no repo recorded in apps.json — cannot determine latest default-branch SHA" | tee -a "$RESULTS"
    continue
  fi
  lc="$(latest_commit "$repo" "$branch")"
  lsha="$(printf '%s' "$lc" | cut -f1)"
  ldate="$(printf '%s' "$lc" | cut -f2)"
  if [ -z "$lsha" ]; then
    echo "FAIL $app: could not obtain latest SHA for $repo@$branch via gh (repo missing / no access / branch gone / rate-limit)" | tee -a "$RESULTS"
    continue
  fi

  # --- freshness comparison ----------------------------------------------------
  # Prefer a SHA read back from the running build if prod ever exposes one;
  # otherwise use samohost's recorded deployedSha.
  cmpSha="$deployedSha"; cmpSrc="apps.json deployedSha"
  if [ -n "$prodSha" ] && [ "$prodSha" != "null" ]; then
    cmpSha="$prodSha"; cmpSrc="prod /api/version sha"
  fi

  if [ -z "$cmpSha" ] || [ "$cmpSha" = "null" ]; then
    # Exact SHA mapping unavailable: assert prod reachable (done) + REPORT what
    # prod shows vs latest merge. WARN finding, not a hard fail.
    echo "WARN $app -> $url (200, env=production, ${disp:-?}) — no deployedSha and prod /api/version exposes no sha; cannot confirm prod == latest merge. Latest $repo@$branch = $(short "$lsha") (${ldate:-?}). FINDING: SHA mapping unavailable for freshness check" | tee -a "$RESULTS"
    continue
  fi

  if [ "$cmpSha" = "$lsha" ]; then
    echo "PASS $app -> $url (200, env=production, ${disp:-?}) FRESH: $cmpSrc=$(short "$cmpSha") == latest $repo@$branch $(short "$lsha") (${ldate:-?})" | tee -a "$RESULTS"
  else
    # how far behind, read-only, best-effort. Accept ONLY if the whole response
    # is a pure integer; a 404 (deployed sha not in the repo) or any other body
    # is suppressed rather than scraped for stray digits.
    behind="$(gh api "repos/$repo/compare/${cmpSha}...${lsha}" --jq '.ahead_by' 2>/dev/null | tr -d '[:space:]')"
    bn=""; case "$behind" in ''|*[!0-9]*) : ;; *) bn=" ($behind commit(s) behind latest)" ;; esac
    echo "FAIL $app -> $url STALE: prod build $cmpSrc=$(short "$cmpSha") != latest $repo@$branch $(short "$lsha") (${ldate:-?})$bn — merged-but-prod-never-updated; live prod still shows ${disp:-?}" | tee -a "$RESULTS"
  fi
done

pass="$(grep -c '^PASS' "$RESULTS" 2>/dev/null || true)"; pass="${pass:-0}"
fail="$(grep -c '^FAIL' "$RESULTS" 2>/dev/null || true)"; fail="${fail:-0}"
warn="$(grep -c '^WARN' "$RESULTS" 2>/dev/null || true)"; warn="${warn:-0}"
echo "[$(ts)] DEV-STORY deploy-freshness: $pass passed, $fail failed, $warn warned"
if [ "$warn" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY deploy-freshness: WARN findings (reported, not failing the run):"
  grep '^WARN' "$RESULTS" | sed 's/^/    /'
fi
if [ "$fail" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY deploy-freshness: FAIL — prod not consistent with latest merge:"
  grep '^FAIL' "$RESULTS" | sed 's/^/    /'
  exit 1
fi
echo "[$(ts)] DEV-STORY deploy-freshness: PASS"
exit 0
