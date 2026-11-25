#!/usr/bin/env bash
# samohost host-bootstrap for app 'my-static-site' — OS prep + DB + env + clone (PR-A1/A2).
# Generated; review before applying. NOT auto-executed by samohost.
# PR-A1 scope: runtimes, OS user, /opt layout, sudoers, MAIN unit,
#   sshd AllowUsers, Caddy base config.
# PR-A2 scope: DB bootstrap, base env file, token-safe repo clone, extended self-check.
# Token handling: read from FD 3 (if attached) or pre-placed 600 file at
#   /opt/my-static-site/.gh-token. NEVER from FD 0 (the script body is piped there via 'bash -s'),
#   NEVER in argv, NEVER in remote URL.
set -euo pipefail
# Commands run as other users (sudo -u) start in the working directory;
# the caller's folder (for example /home/<operator>, mode 750) can be closed
# to them, and find then exits 1. Run from /.
cd /

samohost_assert_static_tree_safe() {
  local checkout_real="$1" static_real="$2" relative="$3"
  local current="$checkout_real" segment first_link
  local -a segments=()
  if [[ -n "$relative" ]]; then
    IFS='/' read -r -a segments <<< "$relative"
    for segment in "${segments[@]}"; do
      current="$current/$segment"
      if [[ -L "$current" ]]; then
        echo "staticRoot path contains a symlink; refusing Caddy activation" >&2
        return 1
      fi
    done
  fi
  if ! first_link=$(/usr/bin/find -P "$static_real" -type l -print -quit); then
    echo "cannot inspect staticRoot for symlinks; refusing Caddy activation" >&2
    return 1
  fi
  if [[ -n "$first_link" ]]; then
    echo "staticRoot tree contains a symlink; refusing Caddy activation" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# §0. GitHub token: read from FD 3 (if attached) or '/opt/my-static-site/.gh-token' (pre-placed).
#     This script is piped to 'bash -s' on FD 0, so the token is NEVER read
#     from FD 0 (that would consume the script body itself — samohost#80).
#     A caller may attach the token on FD 3 ('bash -s 3< token'); otherwise
#     the pre-placed 600 file is used. NEVER echoed, logged, or placed in argv.
# ---------------------------------------------------------------------------

TOKEN_FILE='/opt/my-static-site/.gh-token'
# Root writes and chmods the token file in a folder the deploy user may own:
# refuse symbolic links at the folder and at the file.
if [[ -L '/opt/my-static-site' ]]; then echo 'ERROR: /opt/my-static-site is a symbolic link; refusing to write the token file through it' >&2; exit 1; fi
mkdir -p '/opt/my-static-site'
if [[ -L "$TOKEN_FILE" ]]; then echo "ERROR: $TOKEN_FILE is a symbolic link; refusing to write or chmod it as root" >&2; exit 1; fi
if [[ ! -s "$TOKEN_FILE" ]]; then
  # No token file yet: try FD 3 (a dedicated channel — never the FD 0 the
  # script itself is being read from). If FD 3 is not open the read is a
  # clean no-op and we fall through to the pre-placed-file path below.
  _tok=""
  if { IFS= read -r _tok <&3; } 2>/dev/null; then :; else _tok=""; fi
  if [[ -n "$_tok" ]]; then
    ( umask 077; printf '%s' "$_tok" > "$TOKEN_FILE" )
    unset _tok
    echo "GitHub token captured from FD 3 -> $TOKEN_FILE (600). [value not logged]"
  fi
fi
if [[ -s "$TOKEN_FILE" ]]; then
  chmod 600 "$TOKEN_FILE"
  echo "GitHub token present at $TOKEN_FILE."
else
  echo "WARNING: no GitHub token (FD 3 empty and $TOKEN_FILE absent). Clone step will be SKIPPED."
fi

# ---------------------------------------------------------------------------
# §1. Base packages (static site — Node.js NOT installed; not needed for file_server).
# ---------------------------------------------------------------------------

# Base tools (idempotent: apt is idempotent on already-installed packages).
apt-get update -qq
apt-get install -y --no-install-recommends \
  git build-essential openssl ca-certificates curl gnupg

# ---------------------------------------------------------------------------
# §3. Caddy via official apt repo (idempotent).
# ---------------------------------------------------------------------------

if command -v caddy >/dev/null 2>&1; then
  echo "Caddy already present — skipping apt install."
else
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

# ---------------------------------------------------------------------------
# §4. App OS user 'agent'.
#     useradd --create-home (not the interactive variant whose chfn step
#     fails on the hardened box's expired-password PAM configuration).
# ---------------------------------------------------------------------------

if id 'agent' >/dev/null 2>&1; then
  echo "User 'agent' already exists — skipping useradd."
else
  useradd --create-home --shell /bin/bash 'agent'
fi

# Copy the operator's authorized_keys to the app user so the same SSH key
# that provisioned the box can also authenticate as 'agent'.
# Prefer SUDO_USER's key (the actual operator); fall back to root's.
OPERATOR_KEYS=""
if [[ -n "${SUDO_USER:-}" ]] && [[ -f "/home/${SUDO_USER}/.ssh/authorized_keys" ]]; then
  OPERATOR_KEYS="/home/${SUDO_USER}/.ssh/authorized_keys"
elif [[ -f /root/.ssh/authorized_keys ]]; then
  OPERATOR_KEYS="/root/.ssh/authorized_keys"
fi
if [[ -n "${OPERATOR_KEYS}" ]]; then
  install -d -m 700 -o 'agent' -g 'agent' "/home/agent/.ssh"
  install -m 600 -o 'agent' -g 'agent' "${OPERATOR_KEYS}" \
    "/home/agent/.ssh/authorized_keys"
  echo "Copied ${OPERATOR_KEYS} -> /home/agent/.ssh/authorized_keys"
else
  echo "WARNING: no operator authorized_keys found; skipping key copy." >&2
fi

# ---------------------------------------------------------------------------
# §5. /opt/my-static-site directory layout (appBase, uploads, appDir).
# ---------------------------------------------------------------------------

install -d -m 755 -o 'agent' -g 'agent' '/opt/my-static-site'
install -d -m 755 -o 'agent' -g 'agent' '/opt/my-static-site/uploads'
install -d -m 755 -o 'agent' -g 'agent' '/opt/my-static-site/app'
echo "Layout: /opt/my-static-site/ (uploads/, app checkout at /opt/my-static-site/app)"

# ---------------------------------------------------------------------------
# §6. Deploy sudoers /etc/sudoers.d/my-static-site-agent (static app — no unit grants).
#     Defaults use_pty assumed in effect; every grant is an EXACT full path
#     (Defaults use_pty + exact-path NOPASSWD — issue #99).
# ---------------------------------------------------------------------------

cat > '/etc/sudoers.d/my-static-site-agent' <<SUDOERS
agent ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload
agent ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
agent ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy
agent ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy
agent ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy
agent ALL=(root) NOPASSWD: /usr/bin/journalctl *
agent ALL=(caddy) NOPASSWD: /usr/bin/caddy validate --config /etc/caddy/Caddyfile
SUDOERS
chmod 440 '/etc/sudoers.d/my-static-site-agent'
visudo -cf '/etc/sudoers.d/my-static-site-agent'
echo "Sudoers: /etc/sudoers.d/my-static-site-agent written and validated (static — no unit grants)."

# ---------------------------------------------------------------------------
# §8. sshd AllowUsers 09- drop-in for 'agent'.
#     Sorts before the hardening baseline 10-samohost.conf. Idempotent.
# ---------------------------------------------------------------------------

SSHD_DROPIN="/etc/ssh/sshd_config.d/09-my-static-site-app-user.conf"
if grep -q "AllowUsers" "${SSHD_DROPIN}" 2>/dev/null; then
  echo "sshd AllowUsers drop-in ${SSHD_DROPIN} already present — skipping."
else
  printf 'AllowUsers %s\n' 'agent' >> "${SSHD_DROPIN}"
  echo "sshd drop-in ${SSHD_DROPIN}: added AllowUsers agent"
fi
# Reload sshd to pick up the new AllowUsers entry.
/usr/bin/systemctl reload ssh || /usr/bin/systemctl reload sshd || true

# ---------------------------------------------------------------------------
# §9. Caddy base Caddyfile (import sites.d/*.caddy; tls=acme).
#     caddy validate runs before reload (catches syntax errors early).
# ---------------------------------------------------------------------------

mkdir -p /etc/caddy/sites.d

# Admin API: a server where a new-layout bootstrap ran keeps it on
# /var/lib/caddy/admin.sock, so no bootstrap of any app moves it back to TCP.
SAMOHOST_CADDY_ADMIN_SOCKET=0
if grep -Eq '^[[:space:]]*admin[[:space:]]+unix//var/lib/caddy/admin[.]sock([[:space:]]|$)' /etc/caddy/Caddyfile 2>/dev/null || grep -qsx split /var/lib/samohost/db-layout/*; then
  SAMOHOST_CADDY_ADMIN_SOCKET=1
fi
SAMOHOST_CADDYFILE_PREV="$(mktemp)"
if [[ -f /etc/caddy/Caddyfile ]]; then cp /etc/caddy/Caddyfile "$SAMOHOST_CADDYFILE_PREV"; fi

# Write a minimal-but-valid Caddyfile. Idempotent: overwrite with the
# deterministic content — no append-drift.
if [[ "$SAMOHOST_CADDY_ADMIN_SOCKET" == 1 ]]; then
cat > /etc/caddy/Caddyfile <<'CADDYFILE'
# Caddy global options (ACME TLS — default).
{
  admin unix//var/lib/caddy/admin.sock
}

import sites.d/*.caddy
CADDYFILE
else
cat > /etc/caddy/Caddyfile <<'CADDYFILE'
# Caddy global options (ACME TLS — default).

import sites.d/*.caddy
CADDYFILE
fi

# The switch from TCP to the socket: the running Caddy does not listen on
# the new address yet, so reload fails and Caddy is restarted.
SAMOHOST_CADDY_ADMIN_SWITCH=0
if grep -Eq '^[[:space:]]*admin[[:space:]]+unix//var/lib/caddy/admin[.]sock([[:space:]]|$)' /etc/caddy/Caddyfile && ! grep -Eq '^[[:space:]]*admin[[:space:]]+unix//var/lib/caddy/admin[.]sock([[:space:]]|$)' "$SAMOHOST_CADDYFILE_PREV"; then
  SAMOHOST_CADDY_ADMIN_SWITCH=1
fi
SAMOHOST_APP_CADDY_LOG='/var/log/caddy/my-static-site-prod.log'
if [[ -L "$SAMOHOST_APP_CADDY_LOG" ]]; then
  echo "WARNING: $SAMOHOST_APP_CADDY_LOG is a symbolic link; left as it is" >&2
elif [[ -f "$SAMOHOST_APP_CADDY_LOG" ]] && id -u caddy >/dev/null 2>&1 && [[ "$(stat -c %U "$SAMOHOST_APP_CADDY_LOG")" != caddy ]]; then
  chown -h caddy:caddy "$SAMOHOST_APP_CADDY_LOG"
  echo "Caddy: $SAMOHOST_APP_CADDY_LOG given to caddy (Caddy opens it as caddy)"
fi
# As the caddy user: a log file created by a root-run validation is one
# Caddy cannot open.
sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile
/usr/bin/systemctl enable caddy
if [[ "$SAMOHOST_CADDY_ADMIN_SWITCH" == 1 ]]; then
  # A failed restart must reach the restore below, not stop the script.
  /usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy || true
  # One reload over the socket: deploy and heal reload Caddy this way.
  if ! /usr/bin/systemctl is-active --quiet caddy || ! /usr/bin/systemctl reload caddy; then
    echo "ERROR: caddy is not running or does not accept a reload over the admin socket /var/lib/caddy/admin.sock after the admin socket change; restoring the previous Caddyfile. The admin socket needs Caddy 2.5.1 or later ('caddy version' shows the installed version)." >&2
    if [[ -s "$SAMOHOST_CADDYFILE_PREV" ]]; then cp "$SAMOHOST_CADDYFILE_PREV" /etc/caddy/Caddyfile; fi
    /usr/bin/systemctl restart caddy || true
    rm -f "$SAMOHOST_CADDYFILE_PREV"
    exit 1
  fi
else
  /usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy
fi
rm -f "$SAMOHOST_CADDYFILE_PREV"
echo "Caddy: Caddyfile written (tls=acme), validated, reloaded."

# ---------------------------------------------------------------------------
# §9c. Firewall (source-restricted; world-open ufw allow NEVER emitted).
#      Mirrors buildFirewallLines (env/script.ts). CF ranges fetched at run time.
# ---------------------------------------------------------------------------

# 4. Firewall: source-restricted rules so the origin only answers
#    requests arriving from expected sources (Cloudflare edge / control-plane).
#    /usr/sbin/ufw is the canonical path on Ubuntu 22.04/24.04.
#    Run directly (this whole script is the ONE-TIME root host-prep), so NO
#    NOPASSWD sudoers grant for ufw is added above: the env create/destroy
#    scripts (run later as the non-root agent user) never call ufw —
#    rules are opened once here, not per env.
#
#    :443 — Allow ONLY from Cloudflare IP ranges. Fetches the current
#    published ranges at host-prep time (https://www.cloudflare.com/ips-v4
#    and ips-v6 are the canonical sources; updated infrequently with advance
#    notice). Re-run host-prep after a CF range update to pick up new CIDRs.
#    Each range rule is idempotent (ufw deduplicates). If curl fails (no
#    internet at host-prep time), the loop body never runs and no :443 rules
#    are added — the host will reject CF edge connections until host-prep is
#    re-run with connectivity. '|| true' prevents script abort on curl failure.
for _cf4 in $(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 2>/dev/null || true); do
  /usr/sbin/ufw allow proto tcp from "$_cf4" to any port 443
done
for _cf6 in $(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 2>/dev/null || true); do
  /usr/sbin/ufw allow proto tcp from "$_cf6" to any port 443
done
#
#    :80 — Allow ONLY from the control-plane IP (CF→control-plane→VM:80
#    internal leg). World-open :80 is never emitted.
/usr/sbin/ufw allow proto tcp from '192.0.2.10' to any port 80

# ---------------------------------------------------------------------------
# §12. Full token-safe repo clone (PR-A2-f).
#      FULL clone (no --depth — deploys checkout SHAs).
#      Token is NEVER in argv or the remote URL. The credential helper reads
#      the token file BY ITS LITERAL PATH at runtime via 'cat /opt/my-static-site/.gh-token'
#      (NOT the unexported $TOKEN_FILE var — empty in git's sudo -u subshell).
#      git-safe.conf sidesteps GIT_DIR dubious-ownership warnings.
#      Idempotent: leaves an existing checkout in place.
# ---------------------------------------------------------------------------

GIT_SAFE_CONF='/opt/my-static-site/git-safe.conf'
APP_DIR='/opt/my-static-site/app'
REPO_URL='https://github.com/example/my-static-site.git'

# Write git-safe.conf so the app user can operate in the checkout
# without GIT_DIR dubious-ownership errors (directory owned by agent/root).
cat > "$GIT_SAFE_CONF" <<SAFEOF
[safe]
    directory = /opt/my-static-site/app
SAFEOF
chown 'agent':'agent' "$GIT_SAFE_CONF"
chmod 644 "$GIT_SAFE_CONF"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "clone: $APP_DIR already a git checkout — leaving in place."
elif [[ -s "$TOKEN_FILE" ]]; then
  echo "clone: full clone of example/my-static-site -> $APP_DIR (token via runtime credential helper)"
  chown 'agent':'agent' "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  # The inline credential helper reads the token file BY PATH at runtime.
  # The token value NEVER appears in argv, the remote URL, or git config.
  sudo -u 'agent' GIT_CONFIG_GLOBAL="$GIT_SAFE_CONF" git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat /opt/my-static-site/.gh-token)"; }; f' clone "$REPO_URL" "$APP_DIR"
  sudo -u 'agent' GIT_CONFIG_GLOBAL="$GIT_SAFE_CONF" git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  echo "clone: complete; origin set to public URL (token only via runtime helper)"
  # Persist the credential helper in the app user's global gitconfig so LATER
  # fetches (deploy, env-create clones) authenticate by reading the token file
  # by path at runtime (no FD 3 / stdin needed on later runs).
  sudo -u 'agent' git config --global \
    credential."https://github.com".helper \
    '!f() { echo username=x-access-token; echo "password=$(cat /opt/my-static-site/.gh-token)"; }; f'
else
  echo "clone: SKIPPED (no token). Place a 600 token at $TOKEN_FILE and re-run."
fi

# ---------------------------------------------------------------------------
# §9b. Production Caddy file_server vhost for 'my-static-site.example.com'.
#      Fresh host: canonical 'repository root' under appDir.
#      Post-deploy: validate and preserve the exact health-proven detached route.
#      Missing/corrupt deploy state fails closed; never switch back to appDir.
# ---------------------------------------------------------------------------

SAMOHOST_STATIC_ROOT=''
SAMOHOST_RELEASE_TAG_FORMAT=''
SAMOHOST_RELEASES_DIR='/opt/my-static-site/releases'
SAMOHOST_ACTIVE_STATE='/opt/my-static-site/releases/.samohost-active-static.json'
SAMOHOST_ACTIVE_ROUTE='/opt/my-static-site/releases/.samohost-active-static.caddy'
SAMOHOST_MAIN_VHOST='/etc/caddy/sites.d/00-main-my-static-site.caddy'
SAMOHOST_BOOTSTRAP_VALUES=""
SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE=""
SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=""
samohost_cleanup_bootstrap_static_route() {
  [[ -z "$SAMOHOST_BOOTSTRAP_VALUES" ]] || rm -f "$SAMOHOST_BOOTSTRAP_VALUES"
  [[ -z "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" ]] || rm -f "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE"
  [[ -z "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" ]] || rm -f "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN"
}
trap samohost_cleanup_bootstrap_static_route EXIT

if [[ -e "$SAMOHOST_ACTIVE_STATE" || -e "$SAMOHOST_ACTIVE_ROUTE" ]]; then
  [[ -f "$SAMOHOST_ACTIVE_STATE" && ! -L "$SAMOHOST_ACTIVE_STATE" && -r "$SAMOHOST_ACTIVE_STATE" && -f "$SAMOHOST_ACTIVE_ROUTE" && ! -L "$SAMOHOST_ACTIVE_ROUTE" && -r "$SAMOHOST_ACTIVE_ROUTE" ]] || { echo "active static deployment state/route is incomplete or unsafe; refusing bootstrap route change" >&2; exit 1; }
  SAMOHOST_BOOTSTRAP_VALUES=$(mktemp)
  if ! python3 - "$SAMOHOST_ACTIVE_STATE" 'my-static-site' "$SAMOHOST_STATIC_ROOT" "$SAMOHOST_RELEASE_TAG_FORMAT" > "$SAMOHOST_BOOTSTRAP_VALUES" <<'PY'
import datetime
import json
import re
import sys

path, expected_app, expected_root, expected_format_raw = sys.argv[1:]
expected_format = expected_format_raw or None
with open(path, encoding='utf-8') as source:
    state = json.load(source)
if state.get('schema') != 1 or state.get('appName') != expected_app or state.get('staticRoot') != expected_root or state.get('releaseTagFormat') != expected_format:
    raise SystemExit('active static deployment state does not match this app')
sha = state.get('sha')
tag = state.get('tag')
release_dir = state.get('releaseDir')
if not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{7,40}', sha) is None:
    raise SystemExit('active static deployment state has an invalid sha')
if not isinstance(tag, str) or not tag or len(tag) > 255 or any(ord(ch) < 32 for ch in tag):
    raise SystemExit('active static deployment state has an invalid tag')
if expected_format == 'date':
    match = re.fullmatch(r'v([0-9]{8})[.]([1-9][0-9]*)', tag)
    if match is None:
        raise SystemExit('active static deployment state has an invalid dated tag')
    datetime.datetime.strptime(match.group(1), '%Y%m%d')
if not isinstance(release_dir, str) or not release_dir.startswith('/') or any(ord(ch) < 32 for ch in release_dir):
    raise SystemExit('active static deployment state has an invalid releaseDir')
for value in (release_dir, sha, tag):
    sys.stdout.buffer.write(value.encode('utf-8') + b'\0')
PY
  then
    exit 1
  fi
  SAMOHOST_BOOTSTRAP_ACTIVE_VALUES=()
  mapfile -d "" -t SAMOHOST_BOOTSTRAP_ACTIVE_VALUES < "$SAMOHOST_BOOTSTRAP_VALUES"
  [[ "${#SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[@]}" == "3" ]] || { echo "active static deployment state is incomplete" >&2; exit 1; }
  SAMOHOST_ACTIVE_RELEASE_RAW="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[0]}"
  SAMOHOST_ACTIVE_SHA="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[1]}"
  SAMOHOST_ACTIVE_TAG="${SAMOHOST_BOOTSTRAP_ACTIVE_VALUES[2]}"
  SAMOHOST_RELEASES_REAL=$(realpath -e "$SAMOHOST_RELEASES_DIR") || { echo "static releases directory is missing" >&2; exit 1; }
  [[ ! -L "$SAMOHOST_ACTIVE_RELEASE_RAW" ]] || { echo "active static deployment path is a symlink" >&2; exit 1; }
  SAMOHOST_CHECKOUT_REAL=$(realpath -e "$SAMOHOST_ACTIVE_RELEASE_RAW") || { echo "active static deployment directory is missing" >&2; exit 1; }
  [[ "$SAMOHOST_ACTIVE_RELEASE_RAW" == "$SAMOHOST_CHECKOUT_REAL" ]] || { echo "active static deployment path is not canonical" >&2; exit 1; }
  case "$SAMOHOST_CHECKOUT_REAL" in "$SAMOHOST_RELEASES_REAL"/*) ;; *) echo "active static deployment escapes releases directory" >&2; exit 1 ;; esac
  [[ "$(git -C "$SAMOHOST_CHECKOUT_REAL" -c safe.directory="$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD)" == "$SAMOHOST_ACTIVE_SHA" ]] || { echo "active static deployment checkout does not match recorded sha" >&2; exit 1; }
  if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL"; fi
  SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "active staticRoot does not exist" >&2; exit 1; }
  case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "active staticRoot escapes deployment checkout" >&2; exit 1 ;; esac
  [[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "active staticRoot must contain index.html" >&2; exit 1; }
  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"
  python3 - "$SAMOHOST_STATIC_DIR/version.json" "$SAMOHOST_ACTIVE_SHA" "$SAMOHOST_ACTIVE_TAG" <<'PY'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as source:
    identity = json.load(source)
expected = {'version': sys.argv[3], 'tag': sys.argv[3], 'sha': sys.argv[2], 'environment': 'production'}
if identity != expected:
    raise SystemExit('active static deployment identity does not match state')
PY
  SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE=$(mktemp)
  printf 'root * "%s"\ntry_files {path} {path}/index.html =404\nfile_server\nencode gzip\n' "$SAMOHOST_STATIC_DIR" > "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE"
  cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" "$SAMOHOST_ACTIVE_ROUTE" || sed 's|try_files {path} {path}/ =404|try_files {path} {path}/index.html =404|' "$SAMOHOST_ACTIVE_ROUTE" | cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_ROUTE" - || { echo "active static route does not match structured deployment state" >&2; exit 1; }
  SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=$(mktemp)
  cat > "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" <<CADDY_SITE
# generated by samohost/src/caddy/render.ts — do not edit by hand
http://my-static-site.example.com {
	# samohost-worktree "${SAMOHOST_CHECKOUT_REAL}"
	root * "${SAMOHOST_STATIC_DIR}"
	route {
		@samohost_has_favicon file /favicon.ico
		@samohost_has_favicon_svg file /favicon.svg
		handle /favicon.svg {
			handle @samohost_has_favicon_svg {
				file_server
			}
			handle {
				header Content-Type image/svg+xml
				respond "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'><rect width='32' height='32' rx='6' fill='#9230a6'/><text x='16' y='22' font-family='Arial,sans-serif' font-size='18' font-weight='bold' text-anchor='middle' fill='white'>M</text></svg>" 200
			}
		}
		handle /favicon.ico {
			handle @samohost_has_favicon {
				file_server
			}
			handle {
				header Content-Type image/svg+xml
				respond "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'><rect width='32' height='32' rx='6' fill='#9230a6'/><text x='16' y='22' font-family='Arial,sans-serif' font-size='18' font-weight='bold' text-anchor='middle' fill='white'>M</text></svg>" 200
			}
		}
		@samohost_immutable path_regexp (?:^|/)[^/]*[._-][A-Za-z0-9_-]{8,}\.(?:avif|css|gif|ico|jpe?g|js|png|svg|webp|woff2?)$
		header @samohost_immutable Cache-Control "public, max-age=31536000, immutable"
		@samohost_documents path / */ *.html /config.js /version.json
		header @samohost_documents Cache-Control "no-cache"
		try_files {path} {path}/index.html =404
		file_server
		encode gzip
	}
}
CADDY_SITE
  [[ -f "$SAMOHOST_MAIN_VHOST" && ! -L "$SAMOHOST_MAIN_VHOST" ]] || { echo "active static main vhost is missing or unsafe; refusing bootstrap route change" >&2; exit 1; }
  cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST" || sed 's|try_files {path} {path}/ =404|try_files {path} {path}/index.html =404|' "$SAMOHOST_MAIN_VHOST" | cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" - || { echo "active static main vhost diverges from structured deployment state; refusing bootstrap route change" >&2; exit 1; }
  SAMOHOST_BOOTSTRAP_FINGERPRINT=$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" "$SAMOHOST_MAIN_VHOST" | sha256sum | awk '{print $1}')
  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"
  [[ "$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" "$SAMOHOST_MAIN_VHOST" | sha256sum | awk '{print $1}')" == "$SAMOHOST_BOOTSTRAP_FINGERPRINT" ]] || { echo "active static deployment changed during bootstrap; retry" >&2; exit 1; }
  echo "Caddy: health-proven static deployment route validated and preserved byte-for-byte."
else
  if grep -Fqs -- "import \"$SAMOHOST_ACTIVE_ROUTE\"" /etc/caddy/sites.d/10-domain-*.caddy 2>/dev/null; then
    echo "managed custom domain references missing active static deployment state; refusing bootstrap route change" >&2
    exit 1
  fi
  SAMOHOST_CHECKOUT_REAL=$(realpath -e "$APP_DIR") || { echo "static checkout is missing" >&2; exit 1; }
  if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$APP_DIR/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$APP_DIR"; fi
  SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "staticRoot does not exist: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }
  case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "staticRoot escapes the checkout: $SAMOHOST_STATIC_ROOT" >&2; exit 1 ;; esac
  [[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "staticRoot must contain index.html: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }
  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"
  SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=$(mktemp)
  cat > "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" <<CADDY_SITE
http://my-static-site.example.com {
	root * "${SAMOHOST_STATIC_DIR}"
	try_files {path} {path}/index.html =404
	file_server
	encode gzip
}
CADDY_SITE
  chmod 0644 "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN"
  if [[ -e "$SAMOHOST_MAIN_VHOST" ]]; then
    [[ -f "$SAMOHOST_MAIN_VHOST" && ! -L "$SAMOHOST_MAIN_VHOST" ]] && { cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST" || sed 's|try_files {path} {path}/ =404|try_files {path} {path}/index.html =404|' "$SAMOHOST_MAIN_VHOST" | cmp -s "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" -; } || { echo "main static vhost exists without authorized active state and is not the canonical fresh route; refusing bootstrap route change" >&2; exit 1; }
  else
    /usr/bin/mv -f "$SAMOHOST_BOOTSTRAP_EXPECTED_MAIN" "$SAMOHOST_MAIN_VHOST"
    SAMOHOST_BOOTSTRAP_EXPECTED_MAIN=""
  fi
  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"
  echo "Caddy: canonical fresh static route ready; no health-proven detached deployment exists yet."
fi
sudo -u caddy /usr/bin/caddy validate --config /etc/caddy/Caddyfile
/usr/bin/systemctl reload caddy || /usr/bin/systemctl restart caddy
samohost_cleanup_bootstrap_static_route
trap - EXIT

# ---------------------------------------------------------------------------
# §13. Self-check PASS/FAIL table (static app — no node/pg/unit/db rows).
# ---------------------------------------------------------------------------

echo ""
echo "=== samohost host-bootstrap self-check for my-static-site (static) ==="
FAILED=0

# Helper: print PASS/FAIL and accumulate failures.
chk() {
  local label="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then
    printf "  PASS  %s\n" "$label"
  else
    printf "  FAIL  %s\n" "$label" >&2
    FAILED=$(( FAILED + 1 ))
  fi
}

# caddy active (required for file_server)
caddy_ok=0
/usr/bin/systemctl is-active caddy >/dev/null 2>&1 && caddy_ok=1 || true
chk "caddy active" "$caddy_ok"

# sudo grant count for agent (static: expect >=3: daemon-reload + reload caddy + journalctl)
sudo_count=$(grep -c 'NOPASSWD' '/etc/sudoers.d/my-static-site-agent' 2>/dev/null || echo 0)
sudo_ok=0
if [[ "$sudo_count" -ge 3 ]]; then sudo_ok=1; fi
chk "sudoers grants count: $sudo_count (expect >=3)" "$sudo_ok"

# app clone present
clone_ok=0
if [[ -d "$APP_DIR/.git" ]]; then clone_ok=1; fi
chk "app clone at $APP_DIR/.git" "$clone_ok"

echo "==="
if [[ "$FAILED" -gt 0 ]]; then
  echo "FAIL: $FAILED check(s) failed. Resolve above before proceeding." >&2
  exit 1
fi
echo "All checks PASS — host bootstrap complete for my-static-site (static)."
