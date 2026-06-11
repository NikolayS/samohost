/**
 * Pure deploy-script builder (SPEC-DELTA §3 "app module").
 *
 * `buildDeployScript` turns an {@link AppRecord} + a target SHA into a single
 * bash script string, designed to run over ONE pinned SSH connection via
 * `ssh ... bash -s` (stdin). It encodes deploy.sh's hard-won behaviors, emitting
 * phase markers around each phase so the caller can parse progress:
 *
 *     <<<SAMOHOST_PHASE:<name>:start>>>
 *     <<<SAMOHOST_PHASE:<name>:ok>>>     (or :fail)
 *
 * ---------------------------------------------------------------------------
 * DIVERGENCES FROM deploy.sh (intentional):
 *
 *  1. NO self-overwrite re-exec guard. deploy.sh copies ITSELF to a temp file
 *     and re-execs, because `git reset --hard` rewrites the very file bash is
 *     reading by byte offset (the splice bug). Here the script is PUSHED over
 *     ssh stdin to `bash -s`: bash reads it from the pipe into memory, and the
 *     remote working tree never contains this script, so a `git reset --hard`
 *     of the app checkout cannot rewrite the bytes bash is executing. Pushed
 *     scripts are immune to the git-reset splice bug by construction — no guard
 *     needed.
 *
 *  2. NO env-file bookkeeping. deploy.sh writes DEPLOYED_SHA / DEPLOY_FAILED_SHA
 *     (and rotated APP_DATABASE_URL) INTO the remote staging.env. samohost keeps
 *     all that in its own state (AppRecord.deployedSha / .failedSha); this
 *     script NEVER reads or writes the app's env file, and NEVER echoes secrets.
 *     The known-bad-SHA guard is enforced caller-side (samohost state), not in
 *     this script.
 *
 *  3. systemctl is ALWAYS the full path `sudo /usr/bin/systemctl`. The hardened
 *     host has `Defaults use_pty` + an exact-path NOPASSWD grant; a bare
 *     `sudo systemctl` would not match the grant and polkit would demand
 *     interactive auth on a TTY-less connection (issue #99). Never emit a bare
 *     `sudo systemctl`.
 *
 * The builder is PURE: no I/O, fully deterministic, snapshot-stable.
 * ---------------------------------------------------------------------------
 */

import type { AppRecord } from "../types.ts";

/** Marker prefix the parser keys on. */
export const PHASE_PREFIX = "<<<SAMOHOST_PHASE:";

/** Phase names, in deploy order. `rollback` is emitted only on failure. */
export type PhaseName =
  | "fetch"
  | "checkpoint"
  | "checkout"
  | "install"
  | "build"
  | "migrate"
  | "restart"
  | "health"
  | "assert-rls"
  | "seed"
  | "rollback";

export interface DeployTarget {
  /** Full 40-char git SHA to deploy. */
  sha: string;
}

/** Number of health-check attempts and the sleep between them. */
const HEALTH_RETRIES = 10;
const HEALTH_SLEEP_SEC = 3;
/** Settle time after a service restart before probing. */
const RESTART_SETTLE_SEC = 5;

/**
 * Single-quote a string for safe embedding in the generated bash. We only ever
 * interpolate values from the (operator-controlled) AppRecord and the target
 * SHA, never secrets — but quoting keeps the script robust against spaces and
 * shell metacharacters in paths/commands.
 */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Emit the start/ok/fail markers for a phase as bash helper lines. */
function marker(phase: PhaseName, status: "start" | "ok" | "fail"): string {
  return `echo "${PHASE_PREFIX}${phase}:${status}>>>"`;
}

/**
 * Build the remote deploy script. The result is one self-contained bash program
 * intended for `bash -s` over a single SSH connection.
 */
export function buildDeployScript(app: AppRecord, target: DeployTarget): string {
  const lines: string[] = [];
  const push = (...l: string[]): void => {
    for (const x of l) lines.push(x);
  };

  const sha = target.sha;
  const appDir = sq(app.appDir);
  const unit = sq(app.serviceUnit);
  const healthUrl = sq(app.healthUrl);
  const repo = sq(app.repo);
  const branch = sq(app.branch);

  push(
    "#!/usr/bin/env bash",
    "# samohost deploy script (generated; pushed over ssh stdin to `bash -s`).",
    "# PUSHED-SCRIPT NOTE: this script is read by bash from the ssh pipe into",
    "# memory, and never lives in the app working tree, so `git reset --hard`",
    "# below cannot rewrite the bytes bash is executing. deploy.sh's",
    "# self-overwrite re-exec guard is therefore unnecessary here.",
    "set -euo pipefail",
    "",
    `SAMOHOST_APP_DIR=${appDir}`,
    `SAMOHOST_SHA=${sq(sha)}`,
    `SAMOHOST_REPO=${repo}`,
    `SAMOHOST_BRANCH=${branch}`,
    `SAMOHOST_UNIT=${unit}`,
    `SAMOHOST_HEALTH_URL=${healthUrl}`,
    "",
    'cd "$SAMOHOST_APP_DIR"',
    "",
  );

  // ----- fetch -------------------------------------------------------------
  // git fetch, then verify the exact target SHA exists in the object store.
  push(
    "# --- fetch: bring the target SHA into the local object store ---",
    marker("fetch", "start"),
    "if git fetch origin --quiet \\",
    "   && git cat-file -e \"${SAMOHOST_SHA}^{commit}\" 2>/dev/null; then",
    `  ${marker("fetch", "ok")}`,
    "else",
    `  ${marker("fetch", "fail")}`,
    '  echo "fetch failed: target SHA ${SAMOHOST_SHA} not found after fetch" >&2',
    "  exit 1",
    "fi",
    "",
  );

  // ----- checkpoint --------------------------------------------------------
  // Record PRE_DEPLOY_SHA and preserve the current build dir for rollback.
  // Mirrors deploy.sh: rollback must restore git state AND the (gitignored)
  // dist/ together to avoid split-state corruption.
  push(
    "# --- checkpoint: record pre-deploy SHA + preserve current build ---",
    marker("checkpoint", "start"),
    "PRE_DEPLOY_SHA=$(git rev-parse HEAD)",
    'echo "pre-deploy sha: ${PRE_DEPLOY_SHA}"',
    'if [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then',
    '  rm -rf "${SAMOHOST_APP_DIR}/dist.prev"',
    '  cp -r "${SAMOHOST_APP_DIR}/dist" "${SAMOHOST_APP_DIR}/dist.prev"',
    "fi",
    marker("checkpoint", "ok"),
    "",
  );

  // A reusable rollback function. Invoked by the health / assert phases on
  // failure. Restores git to PRE_DEPLOY_SHA, restores dist.prev/ -> dist/,
  // restarts, re-probes health, emits the rollback marker, and exits 1.
  push(
    "# rollback(): restore the pre-deploy state coherently (git + dist), then",
    "# restart and re-health. Emits rollback:ok / rollback:fail and exits 1.",
    "rollback() {",
    "  git reset --hard \"${PRE_DEPLOY_SHA}\" || true",
    '  if [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then',
    '    rm -rf "${SAMOHOST_APP_DIR}/dist"',
    '    cp -r "${SAMOHOST_APP_DIR}/dist.prev" "${SAMOHOST_APP_DIR}/dist"',
    "  fi",
    // full-path systemctl: see header note (3).
    '  sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}" || true',
    `  sleep ${RESTART_SETTLE_SEC}`,
    "  local rb_code",
    '  rb_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)',
    '  if [[ "$rb_code" == "200" ]]; then',
    `    ${marker("rollback", "ok")}`,
    "  else",
    `    ${marker("rollback", "fail")}`,
    '    echo "rollback health re-check failed (HTTP $rb_code) — manual intervention required" >&2',
    "  fi",
    "  exit 1",
    "}",
    "",
  );

  // ----- checkout ----------------------------------------------------------
  push(
    "# --- checkout: hard reset the working tree to the target SHA ---",
    marker("checkout", "start"),
    'if git reset --hard "${SAMOHOST_SHA}"; then',
    `  ${marker("checkout", "ok")}`,
    "else",
    `  ${marker("checkout", "fail")}`,
    "  exit 1",
    "fi",
    "",
  );

  // ----- install -----------------------------------------------------------
  push(
    "# --- install: npm ci (clean, reproducible install) ---",
    marker("install", "start"),
    "if npm ci; then",
    `  ${marker("install", "ok")}`,
    "else",
    `  ${marker("install", "fail")}`,
    "  exit 1",
    "fi",
    "",
  );

  // ----- build -------------------------------------------------------------
  push(
    "# --- build ---",
    marker("build", "start"),
    `if ${app.buildCmd}; then`,
    `  ${marker("build", "ok")}`,
    "else",
    `  ${marker("build", "fail")}`,
    "  exit 1",
    "fi",
    "",
  );

  // ----- migrate (optional) ------------------------------------------------
  if (app.migrateCmd) {
    push(
      "# --- migrate: apply DB migrations before the new code boots ---",
      marker("migrate", "start"),
      `if ${app.migrateCmd}; then`,
      `  ${marker("migrate", "ok")}`,
      "else",
      `  ${marker("migrate", "fail")}`,
      "  exit 1",
      "fi",
      "",
    );
  }

  // ----- restart -----------------------------------------------------------
  // Full-path sudo systemctl, mandatory. See header note (3).
  push(
    "# --- restart: full-path sudo systemctl (NOPASSWD exact-path + use_pty) ---",
    marker("restart", "start"),
    'if sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}"; then',
    `  sleep ${RESTART_SETTLE_SEC}`,
    `  ${marker("restart", "ok")}`,
    "else",
    `  ${marker("restart", "fail")}`,
    "  exit 1",
    "fi",
    "",
  );

  // ----- health ------------------------------------------------------------
  // N retries with sleep; on exhaustion -> rollback.
  push(
    "# --- health: poll the health URL, retrying; rollback on failure ---",
    marker("health", "start"),
    "health_ok=0",
    `for attempt in $(seq 1 ${HEALTH_RETRIES}); do`,
    '  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)',
    '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
    `  sleep ${HEALTH_SLEEP_SEC}`,
    "done",
    'if [[ "$health_ok" == "1" ]]; then',
    `  ${marker("health", "ok")}`,
    "else",
    `  ${marker("health", "fail")}`,
    '  echo "health check failed after retries — rolling back" >&2',
    "  rollback",
    "fi",
    "",
  );

  // ----- assert-rls (optional) ---------------------------------------------
  // Probe that the app connects as a NON-superuser. Expects 'f'. On failure ->
  // rollback. We read connection params from the app's runtime environment
  // (RLS_DATABASE_URL / DATABASE_URL exported by the service env) WITHOUT this
  // script ever writing or echoing the secret value.
  if (app.assertions?.rlsNonSuperuser) {
    push(
      "# --- assert-rls: app must connect as a non-superuser (RLS not bypassed) ---",
      marker("assert-rls", "start"),
      // Prefer an explicit RLS URL, else fall back to DATABASE_URL from the env.
      'RLS_URL="${RLS_DATABASE_URL:-${DATABASE_URL:-}}"',
      'if [[ -z "$RLS_URL" ]]; then',
      `  ${marker("assert-rls", "fail")}`,
      '  echo "assert-rls: neither RLS_DATABASE_URL nor DATABASE_URL is set in the service environment" >&2',
      "  rollback",
      "fi",
      // psql reads the URL as its connection string; the secret stays in the
      // variable and is never echoed. Probe returns 'f' for non-superuser.
      'rls_result=$(psql "$RLS_URL" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" 2>&1 || echo CONNECTION_FAILED)',
      'if [[ "$rls_result" == "f" ]]; then',
      `  ${marker("assert-rls", "ok")}`,
      "else",
      `  ${marker("assert-rls", "fail")}`,
      '  echo "assert-rls FAILED: probe returned (not the literal value) — superuser or connection failure; RLS may be bypassed — rolling back" >&2',
      "  rollback",
      "fi",
      "",
    );
  }

  // ----- seed (optional) ---------------------------------------------------
  // Idempotent seed, run only after a healthy deploy. A seed failure is a hard
  // failure (non-zero exit) but NOT a rollback (the deploy is already healthy).
  if (app.seedCmd) {
    push(
      "# --- seed: idempotent post-deploy seed (only after healthy deploy) ---",
      marker("seed", "start"),
      `if ${app.seedCmd}; then`,
      `  ${marker("seed", "ok")}`,
      "else",
      `  ${marker("seed", "fail")}`,
      "  exit 1",
      "fi",
      "",
    );
  }

  push('echo "deploy complete: ${SAMOHOST_SHA}"', "");

  return lines.join("\n");
}
