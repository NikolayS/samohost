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
if [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then
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
  if [[ -n "${SAMOHOST_RELEASE_ENV_BACKUP:-}" && -f "$SAMOHOST_RELEASE_ENV_BACKUP" ]]; then
    cp "$SAMOHOST_RELEASE_ENV_BACKUP" "$SAMOHOST_RELEASE_ENV_FILE" || true
  elif [[ "${SAMOHOST_RELEASE_ENV_WRITTEN:-0}" == "1" ]]; then
    rm -f "$SAMOHOST_RELEASE_ENV_FILE" || true
  fi
  if [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then
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

# --- install: lockfile-aware install (npm ci if lockfile present, npm install otherwise) ---
# --include=dev: NODE_ENV=production drops devDeps (build toolchain: tsc, tsx) — issue #2 bug 3.
# lockfile fallback: apps without package-lock.json hard-fail npm ci (no-DB fixtures, greenfield).
echo "<<<SAMOHOST_PHASE:install:start>>>"
if (if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev; else npm install --include=dev; fi); then
  echo "<<<SAMOHOST_PHASE:install:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:install:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi

# --- build ---
# subshell + cd: a buildCmd that cd's must not leak its cwd into later phases (issue #122).
echo "<<<SAMOHOST_PHASE:build:start>>>"
if (cd "$SAMOHOST_APP_DIR" && npm run build); then
  echo "<<<SAMOHOST_PHASE:build:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:build:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi

# --- migrate: apply DB migrations before the new code boots ---
# subshell + cd: always runs from the app dir, whatever buildCmd cd'd into (issue #122).
# split layout: only this subshell exports the database addresses and loads the migrate env file.
echo "<<<SAMOHOST_PHASE:migrate:start>>>"
if (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export DATABASE_URL APP_DATABASE_URL; fi && cd "$SAMOHOST_APP_DIR" && node --import tsx/esm src/migration-runner-cli.ts); then
  echo "<<<SAMOHOST_PHASE:migrate:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:migrate:fail>>>"
  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi
  exit 1
fi

# --- release env: tag and sha for the running service (unit EnvironmentFile=-) ---
# The previous file is kept for rollback. No secret is written here.
SAMOHOST_RELEASE_ENV_FILE='/opt/field-record/release.env'
SAMOHOST_RELEASE_ENV_BACKUP=""
if [[ -f "$SAMOHOST_RELEASE_ENV_FILE" ]]; then SAMOHOST_RELEASE_ENV_BACKUP="$(mktemp)"; cp "$SAMOHOST_RELEASE_ENV_FILE" "$SAMOHOST_RELEASE_ENV_BACKUP"; fi
if printf 'SAMO_RELEASE_TAG=%s\nSAMO_RELEASE_SHA=%s\n' "$SAMO_RELEASE_TAG" "$SAMO_RELEASE_SHA" > "${SAMOHOST_RELEASE_ENV_FILE}.next" && chmod 0644 "${SAMOHOST_RELEASE_ENV_FILE}.next" && mv -f "${SAMOHOST_RELEASE_ENV_FILE}.next" "$SAMOHOST_RELEASE_ENV_FILE"; then
  SAMOHOST_RELEASE_ENV_WRITTEN=1
else
  echo "could not write the release env file" >&2
  rollback
fi

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
rls_result=$(psql "$RLS_URL" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" 2>&1 || echo CONNECTION_FAILED)
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
if (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export DATABASE_URL APP_DATABASE_URL; fi && cd "$SAMOHOST_APP_DIR" && npm run db:seed); then
  echo "<<<SAMOHOST_PHASE:seed:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:seed:fail>>>"
  exit 1
fi

echo "deploy complete: ${SAMOHOST_SHA}"
