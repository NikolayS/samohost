#!/usr/bin/env bash
# dev-story: "every non-static app's PRODUCTION site is up"
#
# THE most important user-facing surface. For every registered NON-static app,
# its public PRODUCTION url (on samo.team — NOT the samo.cat preview zone) must:
#   1. return HTTP 200 on /api/version
#   2. report env=production in /api/version
# An app whose prod host can't be found read-only, or whose prod url is
# unreachable / non-200 / wrong env, FAILS the story.
#
# Ground truth is the live URL response — never state.json, never a trigger
# action log. The running surface is truth.
#
# ABSOLUTE CONSTRAINT: read-only observability. This script ONLY reads / curls /
# ssh-cats / jq / greps. It NEVER mutates anything (no env create/destroy, no
# systemctl, no remote edits, no deploy, no merge, no "fixing"). A failure is a
# FINDING to report, not something to touch.
#
# Exit 0 = every in-scope production site is up and reports production.
# Exit 1 = at least one failed (real, user-facing). Runnable on a timer AND on
# demand.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/bin:/bin:${PATH:-}"
APPS="$HOME/.samohost/apps.json"
STATE="$HOME/.samohost/state.json"
PROD_DOMAIN_SUFFIX=".samo.team"   # production zone; previews live on samo.cat
ts() { date -u +%FT%TZ; }
RESULTS="$(mktemp)"; trap 'rm -f "$RESULTS"' EXIT

echo "[$(ts)] DEV-STORY prod-app-up: START"

if [ ! -r "$APPS" ]; then
  echo "[$(ts)] FAIL: cannot read $APPS" | tee -a "$RESULTS"
  echo "[$(ts)] DEV-STORY prod-app-up: FAIL"; exit 1
fi

# ssh that is strictly read-only and non-interactive. Used ONLY to cat the prod
# Caddyfile to discover the public prod host. Never runs a mutating command.
ro_ssh() {  # $1=user $2=ip $3=port  (command on stdin)
  local user="$1" ip="$2" port="$3"
  timeout 25 ssh -p "$port" \
    -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=12 -o BatchMode=yes \
    "${user}@${ip}" "$(cat)" 2>/dev/null
}

# Discover the public production host for an app, read-only.
#  1) explicit mainHost in apps.json wins
#  2) else derive from the prod VM's main Caddyfile: the *.samo.team site block
#     that reverse_proxies to the app's prod port (from healthUrl).
# Echoes the host on success; echoes nothing on failure.
discover_prod_host() {
  local app="$1" vmId="$2" prodPort="$3"

  # (1) explicit override if present in apps.json
  local explicit
  explicit="$(jq -r --arg a "$app" \
    '.apps[] | select(.name==$a) | .mainHost // empty' "$APPS" 2>/dev/null)"
  if [ -n "$explicit" ] && [ "$explicit" != "null" ]; then
    case "$explicit" in
      *.samo.cat) : ;;                  # a preview host is NOT a prod host
      *"$PROD_DOMAIN_SUFFIX") echo "$explicit"; return 0 ;;
      *) echo "$explicit"; return 0 ;;  # any non-samo.cat explicit host accepted
    esac
  fi

  # (2) derive from the prod VM's Caddyfile (read-only ssh cat/awk)
  local ip user port
  ip="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .ip // empty' "$STATE" 2>/dev/null)"
  user="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .sshUser // "agent"' "$STATE" 2>/dev/null)"
  port="$(jq -r --arg id "$vmId" '.records[] | select(.id==$id) | .sshPort // 22' "$STATE" 2>/dev/null)"
  [ -z "$ip" ] && return 1

  # awk: track the last "<host>.samo.team {" header, print it when we hit the
  # reverse_proxy line targeting the prod port. Read-only on the remote.
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

# in-scope = non-static apps. Emit: name<TAB>vmId<TAB>prodPort
jq -r '
  .apps[]
  | select((.kind // "") != "static")
  | [ .name,
      (.vmId // ""),
      ((.healthUrl // "") | capture("localhost:(?<p>[0-9]+)").p // "3000")
    ] | @tsv
' "$APPS" |
while IFS=$'\t' read -r app vmId prodPort; do
  [ -z "${app:-}" ] && continue
  [ -z "${prodPort:-}" ] && prodPort=3000

  host="$(discover_prod_host "$app" "$vmId" "$prodPort")"
  if [ -z "$host" ]; then
    echo "FAIL $app: production host undeterminable by read-only means (no mainHost in apps.json, no samo.team vhost on prod port :$prodPort in prod Caddyfile)" | tee -a "$RESULTS"
    continue
  fi

  url="https://${host}/api/version"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null)"
  body="$(curl -s --max-time 20 "$url" 2>/dev/null)"
  env="$(jq -r '.env // empty' <<<"$body" 2>/dev/null)"
  disp="$(jq -r '.displayVersion // .version // empty' <<<"$body" 2>/dev/null)"

  if [ "$code" = "200" ] && [ "$env" = "production" ]; then
    echo "PASS $app -> $url (HTTP 200, env=production, ${disp:-?})" | tee -a "$RESULTS"
  else
    echo "FAIL $app -> $url (HTTP $code, env=${env:-<none>})" | tee -a "$RESULTS"
  fi
done

pass="$(grep -c '^PASS' "$RESULTS" 2>/dev/null || true)"; pass="${pass:-0}"
fail="$(grep -c '^FAIL' "$RESULTS" 2>/dev/null || true)"; fail="${fail:-0}"
echo "[$(ts)] DEV-STORY prod-app-up: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "[$(ts)] DEV-STORY prod-app-up: FAIL — production site(s) not healthy:"
  grep '^FAIL' "$RESULTS" | sed 's/^/    /'
  exit 1
fi
echo "[$(ts)] DEV-STORY prod-app-up: PASS"
exit 0
