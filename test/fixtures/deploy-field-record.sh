#!/usr/bin/env bash
# samohost deploy script (generated; pushed over ssh stdin to `bash -s`).
# PUSHED-SCRIPT NOTE: this script is read by bash from the ssh pipe into
# memory, and never lives in the app working tree, so `git reset --hard`
# below cannot rewrite the bytes bash is executing. deploy.sh's
# self-overwrite re-exec guard is therefore unnecessary here.
set -euo pipefail

SAMOHOST_APP_DIR='/opt/field-record/app'
SAMOHOST_SHA='abc1234def5678901234567890abcdef12345678'
SAMOHOST_REPO='Tanya301/field-record-1'
SAMOHOST_BRANCH='main'
SAMOHOST_UNIT='field-record'
SAMOHOST_HEALTH_URL='http://localhost:3000/api/version'
# Release identity for the build (dist/build-info.json, /version.json) and,
# through the release env file, for the running service.
export SAMO_RELEASE_TAG=''
export SAMO_RELEASE_SHA='abc1234def5678901234567890abcdef12345678'

cd "$SAMOHOST_APP_DIR"
git config --global --add safe.directory "$SAMOHOST_APP_DIR"

# --- env: source the app env file (READ-ONLY; never written, never echoed) ---
set -a; . '/opt/field-record/staging.env'; set +a
SAMOHOST_MIGRATE_ENV_FILE='/opt/field-record/migrate.env'
if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then
  export -n DATABASE_URL APP_DATABASE_URL
fi
# split layout: the service runs as a separate runtime user, which reads
# the checkout, node_modules and dist/ through their world-read bit.
if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then umask 022; fi
# Build model (src/app/build-steps.ts): a root-owned step script runs install,
# build, migrate, release and seed as the build user; this script runs no
# app command itself. Servers bootstrapped before it keep the steps below.
SAMOHOST_STEP='/usr/local/lib/samohost/apps/field-record/step'
SAMOHOST_RELEASE_MODEL=0
if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" && -x "$SAMOHOST_STEP" ]]; then SAMOHOST_RELEASE_MODEL=1; fi
# One deploy of this app at a time. A second deploy stops here, before any
# change; the outcome is not a failed commit.
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then
  exec 8>>"${HOME:?}/.samohost-deploy-field-record.lock"
  if ! flock -n 8; then
    echo "<<<SAMOHOST_PHASE:lock:fail>>>"
    echo 'ERROR: another deploy of field-record is running on this server; this deploy changed nothing. Try again when it has finished.' >&2
    exit 1
  fi
fi
# A server with the build model but without the backup sudo rule predates database backups.
# Stop before fetch and checkout, so this commit is not recorded as failed.
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]] && ! sudo -n -l "$SAMOHOST_STEP" backup >/dev/null 2>&1; then
  echo "<<<SAMOHOST_PHASE:lock:fail>>>"
  echo 'ERROR: this server was set up before database backups existed; run `samohost app bootstrap` for this app again; this deploy changed nothing' >&2
  exit 1
fi
# No process of the build user outlives the deploy, whatever its outcome.
# Every step gets stdin from /dev/null: this script reaches bash on stdin,
# and code in a step must not read or consume the rest of it.
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then trap 'sudo "$SAMOHOST_STEP" cleanup </dev/null >/dev/null 2>&1 || true' EXIT; fi

# --- fetch: bring the target SHA into the local object store ---
echo "<<<SAMOHOST_PHASE:fetch:start>>>"
if git fetch origin --quiet \
   && git cat-file -e "${SAMOHOST_SHA}^{commit}" 2>/dev/null; then
  echo "<<<SAMOHOST_PHASE:fetch:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:fetch:fail>>>"
  echo "fetch failed: target SHA ${SAMOHOST_SHA} not found after fetch" >&2
  exit 1
fi

# --- checkpoint: record pre-deploy SHA + preserve current build ---
echo "<<<SAMOHOST_PHASE:checkpoint:start>>>"
PRE_DEPLOY_SHA=$(git rev-parse HEAD)
echo "pre-deploy sha: ${PRE_DEPLOY_SHA}"
# A previous release exists when dist/ is present before this deploy. Its copy
# dist.prev/ is made here, before install and build (a build may delete dist/).
SAMOHOST_HAS_PREVIOUS_RELEASE=0
SAMOHOST_RELEASE_SWITCHED=0
# build model: the previous release is the one the current link names.
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then
  if [[ -L '/opt/field-record/current' ]]; then SAMOHOST_HAS_PREVIOUS_RELEASE=1; fi
elif [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then
  rm -rf "${SAMOHOST_APP_DIR}/dist.prev"
  cp -r "${SAMOHOST_APP_DIR}/dist" "${SAMOHOST_APP_DIR}/dist.prev"
  SAMOHOST_HAS_PREVIOUS_RELEASE=1
fi
echo "<<<SAMOHOST_PHASE:checkpoint:ok>>>"

# rollback(): restore the pre-deploy state coherently (git + dist), then
# restart and re-health. Emits rollback:ok / rollback:fail and exits 1.
# rollback before-restart: used when install, build or migrate failed. The
# service was not restarted and still runs the previous release, so the
# files are restored and its health is checked without a restart.
# Database migrations that already ran are not undone.
rollback() {
  local rb_mode="${1:-}"
  git reset --hard "${PRE_DEPLOY_SHA}" || true
  # Restore the previous release env file (or remove the one this deploy created).
  if [[ "${SAMOHOST_RELEASE_ENV_WRITTEN:-0}" == "1" ]]; then
    if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then
      # split layout: root-owned directory; the exact sudo tee rule writes the file (empty on a first deploy).
      if [[ "${SAMOHOST_RELEASE_ENV_HAD_PREVIOUS:-0}" == "1" ]]; then
        printf '%s\n' "$SAMOHOST_RELEASE_ENV_PREVIOUS" | sudo /usr/bin/tee "$SAMOHOST_RELEASE_ENV_FILE" >/dev/null || true
      else
        printf '' | sudo /usr/bin/tee "$SAMOHOST_RELEASE_ENV_FILE" >/dev/null || true
      fi
    elif [[ "${SAMOHOST_RELEASE_ENV_HAD_PREVIOUS:-0}" == "1" ]]; then
      printf '%s\n' "$SAMOHOST_RELEASE_ENV_PREVIOUS" > "$SAMOHOST_RELEASE_ENV_FILE" || true
    else
      rm -f "$SAMOHOST_RELEASE_ENV_FILE" || true
    fi
  fi
  # build model: switch the current link back when this deploy switched it.
  if [[ "${SAMOHOST_RELEASE_MODEL:-0}" == 1 ]]; then
    if [[ "${SAMOHOST_RELEASE_SWITCHED:-0}" == 1 ]]; then
      # step rollback exits 3 when there is no previous release; it then removed
      # current. In both failure cases the deploy stops the service rather than
      # leave the failing release running. The unit stays enabled.
      SAMOHOST_RB_RC=0
      sudo "$SAMOHOST_STEP" rollback </dev/null || SAMOHOST_RB_RC=$?
      if [[ "$SAMOHOST_RB_RC" -ne 0 ]]; then
        if sudo /usr/bin/systemctl stop "${SAMOHOST_UNIT}"; then
          echo "<<<SAMOHOST_PHASE:stop:ok>>>"
          if [[ "$SAMOHOST_RB_RC" -eq 3 ]]; then
            echo "deploy failed after the release, and there is no previous release to roll back to; current was removed and the service ${SAMOHOST_UNIT} was stopped. It stays enabled and starts with the next successful deploy." >&2
          else
            echo "deploy failed after the release, and step rollback failed (exit $SAMOHOST_RB_RC); the service ${SAMOHOST_UNIT} was stopped; current still names the failed release" >&2
          fi
        else
          echo "<<<SAMOHOST_PHASE:stop:fail>>>"
          echo "<<<SAMOHOST_PHASE:rollback:fail>>>"
          echo "deploy failed after the release, the rollback did not complete (exit $SAMOHOST_RB_RC), and the service ${SAMOHOST_UNIT} could not be stopped — manual intervention required" >&2
        fi
        exit 1
      fi
    fi
  elif [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then
    rm -rf "${SAMOHOST_APP_DIR}/dist"
    cp -r "${SAMOHOST_APP_DIR}/dist.prev" "${SAMOHOST_APP_DIR}/dist"
  fi
  if [[ "$rb_mode" != "before-restart" ]]; then
    sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}" || true
    sleep 5
  fi
  local rb_code
  rb_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)
  if [[ "$rb_code" == "200" ]]; then
    echo "<<<SAMOHOST_PHASE:rollback:ok>>>"
  else
    echo "<<<SAMOHOST_PHASE:rollback:fail>>>"
    echo "rollback health re-check failed (HTTP $rb_code) — manual intervention required" >&2
  fi
  exit 1
}

# --- checkout: hard reset the working tree to the target SHA ---
echo "<<<SAMOHOST_PHASE:checkout:start>>>"
if git reset --hard "${SAMOHOST_SHA}"; then
  echo "<<<SAMOHOST_PHASE:checkout:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:checkout:fail>>>"
  exit 1
fi
# build model: the build user reads the checkout through the world-read bit;
# this covers files an earlier clone or deploy left owner-only. Skips .git.
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then
  find "$SAMOHOST_APP_DIR" -path "$SAMOHOST_APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} + \
    || echo "WARNING: could not make every file in $SAMOHOST_APP_DIR readable for the build user" >&2
fi

samohost_write_release_env() {
  # --- release env: tag and sha for the running service (unit EnvironmentFile=-) ---
  # No secret is written here. The previous content is kept in a variable for
  # rollback. A failed write is a warning, not a failure: units written before
  # this file existed do not load it, and the release runs without the values.
  SAMOHOST_RELEASE_ENV_FILE='/opt/field-record/release.env'
  SAMOHOST_RELEASE_ENV_HAD_PREVIOUS=0
  SAMOHOST_RELEASE_ENV_PREVIOUS=""
  if [[ -f "$SAMOHOST_RELEASE_ENV_FILE" ]] && SAMOHOST_RELEASE_ENV_PREVIOUS="$(cat "$SAMOHOST_RELEASE_ENV_FILE")"; then SAMOHOST_RELEASE_ENV_HAD_PREVIOUS=1; fi
  SAMOHOST_RELEASE_ENV_WRITTEN=0
  # split layout: the env file's directory is root-owned; the exact sudo tee rule writes the file.
  if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then
    if printf 'SAMO_RELEASE_TAG=%s\nSAMO_RELEASE_SHA=%s\n' "$SAMO_RELEASE_TAG" "$SAMO_RELEASE_SHA" | sudo /usr/bin/tee "$SAMOHOST_RELEASE_ENV_FILE" >/dev/null; then SAMOHOST_RELEASE_ENV_WRITTEN=1; fi
  elif printf 'SAMO_RELEASE_TAG=%s\nSAMO_RELEASE_SHA=%s\n' "$SAMO_RELEASE_TAG" "$SAMO_RELEASE_SHA" 2>/dev/null > "${SAMOHOST_RELEASE_ENV_FILE}.next" && chmod 0644 "${SAMOHOST_RELEASE_ENV_FILE}.next" && mv -f "${SAMOHOST_RELEASE_ENV_FILE}.next" "$SAMOHOST_RELEASE_ENV_FILE"; then
    SAMOHOST_RELEASE_ENV_WRITTEN=1
  fi
  if [[ "$SAMOHOST_RELEASE_ENV_WRITTEN" != "1" ]]; then
    rm -f "${SAMOHOST_RELEASE_ENV_FILE}.next" 2>/dev/null || true
    echo "WARNING: could not write the release env file $SAMOHOST_RELEASE_ENV_FILE; the service starts without SAMO_RELEASE_TAG and SAMO_RELEASE_SHA" >&2
  fi
}

# --- install: lockfile-aware install (npm ci if lockfile present, npm install otherwise) ---
# --include=dev: NODE_ENV=production drops devDeps (build toolchain: tsc, tsx) — issue #2 bug 3.
# lockfile fallback: apps without package-lock.json hard-fail npm ci (no-DB fixtures, greenfield).
echo "<<<SAMOHOST_PHASE:install:start>>>"
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then samohost_write_release_env; fi
if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" install </dev/null; elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev; else npm install --include=dev; fi); then
  echo "<<<SAMOHOST_PHASE:install:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:install:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi

# --- build ---
# subshell + cd: a buildCmd that cd's must not leak its cwd into later phases (issue #122).
echo "<<<SAMOHOST_PHASE:build:start>>>"
if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" build </dev/null; else (cd "$SAMOHOST_APP_DIR" && npm run build); fi); then
  echo "<<<SAMOHOST_PHASE:build:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:build:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi
# split layout: the service's runtime user reads the release through the
# world-read bit; umask 022 covers new files, this covers files an earlier
# clone or deploy left owner-only. Skips .git; does not follow links.
# (The build model's service reads its own root-owned release instead.)
if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" && "$SAMOHOST_RELEASE_MODEL" != 1 ]]; then
  find "$SAMOHOST_APP_DIR" -path "$SAMOHOST_APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} + \
    || echo "WARNING: could not make every file in $SAMOHOST_APP_DIR readable for the runtime user" >&2
fi

# --- backup: save the database before migrations change it ---
if [[ "${SAMOHOST_RELEASE_MODEL:-0}" == 1 ]]; then
echo "<<<SAMOHOST_PHASE:backup:start>>>"
if sudo -n "$SAMOHOST_STEP" backup </dev/null; then
  echo "<<<SAMOHOST_PHASE:backup:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:backup:fail>>>"
  echo "ERROR: the database backup failed and migrations did not run" >&2
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi
else
  echo "WARNING: no database backup was taken: this server does not use the build model" >&2
fi

# --- migrate: apply DB migrations before the new code boots ---
# subshell + cd: always runs from the app dir, whatever buildCmd cd'd into (issue #122).
# split layout: only this subshell exports the database addresses and loads the migrate env file.
echo "<<<SAMOHOST_PHASE:migrate:start>>>"
if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" migrate </dev/null; else (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export DATABASE_URL APP_DATABASE_URL; fi && cd "$SAMOHOST_APP_DIR" && node --import tsx/esm src/migration-runner-cli.ts); fi); then
  echo "<<<SAMOHOST_PHASE:migrate:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:migrate:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi

# --- release (build model): root copies the build into a release folder and
# switches the current link the service runs from ---
if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then
  echo "<<<SAMOHOST_PHASE:release:start>>>"
  if sudo "$SAMOHOST_STEP" release </dev/null; then
    SAMOHOST_RELEASE_SWITCHED=1
    echo "<<<SAMOHOST_PHASE:release:ok>>>"
  else
    echo "<<<SAMOHOST_PHASE:release:fail>>>"
    if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
    exit 1
  fi
fi

if [[ "${SAMOHOST_RELEASE_MODEL:-0}" != 1 ]]; then samohost_write_release_env; fi

# --- restart: full-path sudo systemctl (NOPASSWD exact-path + use_pty) ---
echo "<<<SAMOHOST_PHASE:restart:start>>>"
if sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}"; then
  sleep 5
  echo "<<<SAMOHOST_PHASE:restart:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:restart:fail>>>"
  exit 1
fi

# --- health: poll the health URL, retrying; rollback on failure ---
echo "<<<SAMOHOST_PHASE:health:start>>>"
health_ok=0
for attempt in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)
  if [[ "$code" == "200" ]]; then health_ok=1; break; fi
  sleep 3
done
if [[ "$health_ok" == "1" ]]; then
  echo "<<<SAMOHOST_PHASE:health:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:health:fail>>>"
  echo "health check failed after retries — rolling back" >&2
  rollback
fi

# --- assert-rls: app must connect as a non-superuser (RLS not bypassed) ---
echo "<<<SAMOHOST_PHASE:assert-rls:start>>>"
RLS_URL="${RLS_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$RLS_URL" ]]; then
  echo "<<<SAMOHOST_PHASE:assert-rls:fail>>>"
  echo "assert-rls: neither RLS_DATABASE_URL nor DATABASE_URL is set in the deploy environment" >&2
  rollback
fi
# The password goes to psql in PGPASSWORD, not as an argument (ps shows arguments).
samohost_pct_decode() {
  local s="$1" c h
  samohost_pct_out=""
  while [[ -n "$s" ]]; do
    c="${s:0:1}"
    if [[ "$c" == "%" ]]; then
      h="${s:1:2}"
      case "$h" in
        00) ;;
        [0123456789ABCDEFabcdef][0123456789ABCDEFabcdef])
          printf -v c "\\x$h"
          samohost_pct_out+="$c"; s="${s:3}"; continue ;;
      esac
    fi
    samohost_pct_out+="$c"; s="${s:1}"
  done
}
samohost_pg_split() {
  local a="$1" rest userspec user base q kv sep start k v c
  samohost_pg_conn=""; samohost_pg_pw=""
  case "$a" in
    postgresql://*|postgres://*)
      rest="${a#*://}"
      userspec="${rest%%[@/]*}"
      user=""
      if [[ "${rest:${#userspec}:1}" == "@" ]]; then
        rest="${rest:${#userspec}+1}"
        user="${userspec%%:*}"
        if [[ "$userspec" == *:* ]]; then samohost_pct_decode "${userspec#*:}"; samohost_pg_pw="$samohost_pct_out"; fi
        if [[ -n "$user" ]]; then user="$user@"; fi
      fi
      base="${rest%%[?]*}"
      if [[ "$rest" == *[?]* ]]; then
        q="${rest#*[?]}&"; sep="?"
        while [[ -n "$q" ]]; do
          kv="${q%%&*}"; q="${q#*&}"
          samohost_pct_decode "${kv%%=*}"
          if [[ "$samohost_pct_out" == password && "$kv" == *=* ]]; then
            samohost_pct_decode "${kv#*=}"; samohost_pg_pw="$samohost_pct_out"
          else
            base="$base$sep$kv"; sep="&"
          fi
        done
      fi
      samohost_pg_conn="${a%%://*}://$user$base"
      ;;
    *=*)
      rest="$a"
      while :; do
        rest="${rest#"${rest%%[![:space:]]*}"}"
        if [[ -z "$rest" ]]; then break; fi
        start="$rest"
        k="${rest%%[=[:space:]]*}"
        rest="${rest:${#k}}"; rest="${rest#"${rest%%[![:space:]]*}"}"
        if [[ -z "$k" || "${rest:0:1}" != "=" ]]; then return 2; fi
        rest="${rest:1}"; rest="${rest#"${rest%%[![:space:]]*}"}"
        v=""
        if [[ "${rest:0:1}" == "'" ]]; then
          rest="${rest:1}"
          while :; do
            if [[ -z "$rest" ]]; then return 1; fi
            c="${rest:0:1}"; rest="${rest:1}"
            if [[ "$c" == "'" ]]; then break; fi
            if [[ "$c" == "\\" ]]; then c="${rest:0:1}"; rest="${rest:1}"; fi
            v="$v$c"
          done
        else
          while [[ -n "$rest" ]]; do
            c="${rest:0:1}"
            if [[ "$c" == [[:space:]] ]]; then break; fi
            rest="${rest:1}"
            if [[ "$c" == "\\" ]]; then c="${rest:0:1}"; rest="${rest:1}"; fi
            v="$v$c"
          done
        fi
        if [[ "$k" == password ]]; then samohost_pg_pw="$v"; else samohost_pg_conn="$samohost_pg_conn ${start:0:${#start}-${#rest}}"; fi
      done
      samohost_pg_conn="${samohost_pg_conn# }"
      ;;
    *) samohost_pg_conn="$a" ;;
  esac
}
rls_result=CONNECTION_FAILED
samohost_pg_rc=0
samohost_pg_split "$RLS_URL" || samohost_pg_rc=$?
if [[ "$samohost_pg_rc" == 0 ]]; then
  rls_result=$(if [[ -n "$samohost_pg_pw" ]]; then export PGPASSWORD="$samohost_pg_pw"; fi; psql -X -w -tA -d "$samohost_pg_conn" -c "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user" 2>&1 || echo CONNECTION_FAILED)
elif [[ "$samohost_pg_rc" == 2 ]]; then
  echo "assert-rls: the database address has a key=value pair without =" >&2
else
  echo "assert-rls: the database address has a quoted value without its closing quote" >&2
fi
# Both variables may hold the decoded password.
unset samohost_pg_pw samohost_pct_out
if [[ "$rls_result" == "f" ]]; then
  echo "<<<SAMOHOST_PHASE:assert-rls:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:assert-rls:fail>>>"
  echo "assert-rls FAILED: probe returned (not the literal value) — superuser or connection failure; RLS may be bypassed — rolling back" >&2
  rollback
fi

# --- seed: idempotent post-deploy seed (only after healthy deploy) ---
# subshell + cd: always runs from the app dir, whatever earlier commands cd'd into (issue #122).
echo "<<<SAMOHOST_PHASE:seed:start>>>"
if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" seed </dev/null; else (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export DATABASE_URL APP_DATABASE_URL; fi && cd "$SAMOHOST_APP_DIR" && npm run db:seed); fi); then
  echo "<<<SAMOHOST_PHASE:seed:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:seed:fail>>>"
  exit 1
fi

echo "deploy complete: ${SAMOHOST_SHA}"
