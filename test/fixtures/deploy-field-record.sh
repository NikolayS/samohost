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

cd "$SAMOHOST_APP_DIR"

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
if [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then
  rm -rf "${SAMOHOST_APP_DIR}/dist.prev"
  cp -r "${SAMOHOST_APP_DIR}/dist" "${SAMOHOST_APP_DIR}/dist.prev"
fi
echo "<<<SAMOHOST_PHASE:checkpoint:ok>>>"

# rollback(): restore the pre-deploy state coherently (git + dist), then
# restart and re-health. Emits rollback:ok / rollback:fail and exits 1.
rollback() {
  git reset --hard "${PRE_DEPLOY_SHA}" || true
  if [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then
    rm -rf "${SAMOHOST_APP_DIR}/dist"
    cp -r "${SAMOHOST_APP_DIR}/dist.prev" "${SAMOHOST_APP_DIR}/dist"
  fi
  sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}" || true
  sleep 5
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

# --- install: npm ci (clean, reproducible install) ---
echo "<<<SAMOHOST_PHASE:install:start>>>"
if npm ci; then
  echo "<<<SAMOHOST_PHASE:install:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:install:fail>>>"
  exit 1
fi

# --- build ---
echo "<<<SAMOHOST_PHASE:build:start>>>"
if npm run build; then
  echo "<<<SAMOHOST_PHASE:build:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:build:fail>>>"
  exit 1
fi

# --- migrate: apply DB migrations before the new code boots ---
echo "<<<SAMOHOST_PHASE:migrate:start>>>"
if node --import tsx/esm src/migration-runner-cli.ts; then
  echo "<<<SAMOHOST_PHASE:migrate:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:migrate:fail>>>"
  exit 1
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
  echo "assert-rls: neither RLS_DATABASE_URL nor DATABASE_URL is set in the service environment" >&2
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
echo "<<<SAMOHOST_PHASE:seed:start>>>"
if npm run db:seed; then
  echo "<<<SAMOHOST_PHASE:seed:ok>>>"
else
  echo "<<<SAMOHOST_PHASE:seed:fail>>>"
  exit 1
fi

echo "deploy complete: ${SAMOHOST_SHA}"
