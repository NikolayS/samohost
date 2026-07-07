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
 *     script NEVER writes the app's env file, and NEVER echoes secrets. It DOES
 *     source the registered envFile (read-only) before install — issue #2: a
 *     pushed script runs over `ssh ... bash -s` and inherits NOTHING from the
 *     systemd unit's environment, so without sourcing, migrate/seed/RLS probes
 *     ran with no app env at all (migrate died on "DATABASE_URL ... required").
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
  | "caddy-reload"
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
  // rlsUrlVar is interpolated into bash as `${<name>:-}` — it must be a valid
  // identifier (the CLI validates too; this guards hand-edited state files).
  if (
    app.rlsUrlVar !== undefined &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(app.rlsUrlVar)
  ) {
    throw new Error(
      `invalid rlsUrlVar (must be a valid env var name): ${app.rlsUrlVar}`,
    );
  }
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

  // ----- env (optional) ------------------------------------------------------
  // Source the registered env file READ-ONLY, exported, BEFORE install: a
  // pushed script inherits nothing from the service environment, and install/
  // build/migrate/seed/probes must all see the same app env (NODE_ENV,
  // DATABASE_URL, ...). Issue #2 bug 1: without this, migrate died with
  // "DATABASE_URL environment variable is required". The file is never
  // written and its values are never echoed.
  if (app.envFile !== undefined) {
    push(
      "# --- env: source the app env file (READ-ONLY; never written, never echoed) ---",
      `set -a; . ${sq(app.envFile)}; set +a`,
      "",
    );
  }

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
  // then either reloads Caddy (static) or restarts the systemd unit (node),
  // re-probes health, emits the rollback marker, and exits 1.
  if (app.kind === "static") {
    push(
      "# rollback(): restore the pre-deploy state coherently (git + dist), then",
      "# reload Caddy (static site — no systemd unit to restart).",
      "# Emits rollback:ok / rollback:fail and exits 1.",
      "rollback() {",
      "  git reset --hard \"${PRE_DEPLOY_SHA}\" || true",
      '  if [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then',
      '    rm -rf "${SAMOHOST_APP_DIR}/dist"',
      '    cp -r "${SAMOHOST_APP_DIR}/dist.prev" "${SAMOHOST_APP_DIR}/dist"',
      "  fi",
      // Static rollback: reload caddy, not restart a unit that doesn't exist.
      // full-path systemctl: see header note (3).
      "  sudo /usr/bin/systemctl reload caddy || true",
      `  sleep ${RESTART_SETTLE_SEC}`,
      "  local rb_code",
      // -k: Caddy uses tls internal (self-signed origin cert); CF Full-mode proxies it.
      '  rb_code=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)',
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
  } else {
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
  }

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

  if (app.kind === "static") {
    // ===== STATIC SITE PATH =================================================
    // No Node.js install/build, no DB migrations, no systemd unit restart.
    // The only "activation" step is reloading Caddy so it picks up the new
    // static assets from the updated checkout. Health probe uses -k because
    // Caddy uses tls internal (self-signed origin cert) with CF Full-mode.
    // ========================================================================

    // ----- caddy-reload (static) -------------------------------------------
    // Full-path systemctl reload (not restart): see header note (3).
    push(
      "# --- caddy-reload: reload Caddy to serve the updated static assets ---",
      "# Static site: no Node.js unit to restart; Caddy serves the checkout directly.",
      "# Full-path systemctl: see header note (3) — bare sudo systemctl fails on hardened host.",
      marker("caddy-reload", "start"),
      "if sudo /usr/bin/systemctl reload caddy; then",
      `  sleep ${RESTART_SETTLE_SEC}`,
      `  ${marker("caddy-reload", "ok")}`,
      "else",
      `  ${marker("caddy-reload", "fail")}`,
      "  exit 1",
      "fi",
      "",
    );

    // ----- health (static) -------------------------------------------------
    // -k: Caddy uses tls internal (self-signed origin cert); CF Full-mode proxies it.
    // Without -k, curl rejects the cert → HTTP 000 → deploy always rolls back.
    push(
      "# --- health: poll the health URL (-k for tls internal / CF Full-mode), retrying; rollback on failure ---",
      marker("health", "start"),
      "health_ok=0",
      `for attempt in $(seq 1 ${HEALTH_RETRIES}); do`,
      '  code=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)',
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
  } else {
    // ===== NODE PATH (default — existing behavior, unchanged) ===============

    // ----- install -----------------------------------------------------------
    // --include=dev is mandatory: the env file sourced above exports
    // NODE_ENV=production into this shell, and a plain `npm ci` would then drop
    // devDependencies — where the build/migrate toolchain (tsc, tsx) lives
    // (issue #2 bug 3: build died with "tsc: not found"). This flag is preserved
    // in BOTH branches of the lockfile check below.
    //
    // Lockfile-aware: apps without package-lock.json (no-DB fixtures, minimal
    // greenfield) hard-fail npm ci with "can only install with an existing
    // package-lock.json". Under set -euo pipefail that aborts the deploy before
    // .env/unit/Caddy are written → no :443 listener → CF 521. Fall back to
    // npm install --include=dev when no lockfile is present.
    push(
      "# --- install: lockfile-aware install (npm ci if lockfile present, npm install otherwise) ---",
      "# --include=dev: NODE_ENV=production drops devDeps (build toolchain: tsc, tsx) — issue #2 bug 3.",
      "# lockfile fallback: apps without package-lock.json hard-fail npm ci (no-DB fixtures, greenfield).",
      marker("install", "start"),
      "if (if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev; else npm install --include=dev; fi); then",
      `  ${marker("install", "ok")}`,
      "else",
      `  ${marker("install", "fail")}`,
      "  exit 1",
      "fi",
      "",
    );

    // ----- build -------------------------------------------------------------
    // Subshell + cd (issue #122): app-supplied commands may themselves cd
    // (e.g. "cd apps/web && bun run build" in a monorepo). Without the
    // subshell, that cd LEAKS into every later phase in this single shell
    // session, so a relative migrateCmd resolved against apps/web and died
    // with "Module not found" (broke samograph's prod cutover). Each
    // app-supplied command therefore runs in its own subshell, started from
    // SAMOHOST_APP_DIR — phases can no longer see each other's cwd.
    push(
      "# --- build ---",
      "# subshell + cd: a buildCmd that cd's must not leak its cwd into later phases (issue #122).",
      marker("build", "start"),
      `if (cd "$SAMOHOST_APP_DIR" && ${app.buildCmd}); then`,
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
        "# subshell + cd: always runs from the app dir, whatever buildCmd cd'd into (issue #122).",
        marker("migrate", "start"),
        `if (cd "$SAMOHOST_APP_DIR" && ${app.migrateCmd}); then`,
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

    // ----- assert-rls (optional) -------------------------------------------
    // Probe that the app connects as a NON-superuser. Expects 'f'. On failure ->
    // rollback. Connection params come from the deploy environment (the env file
    // sourced above) WITHOUT this script ever writing or echoing the secret
    // value. The var name is configurable per app (issue #2 bug 2): the app's
    // non-superuser URL may live under a different name (field-record:
    // APP_DATABASE_URL) while DATABASE_URL is the SUPERUSER url — consulting the
    // wrong var makes the probe see rolsuper=t and roll back a healthy deploy.
    // A configured var is consulted EXCLUSIVELY (no silent fallback: falling
    // back to DATABASE_URL is exactly the bug); the default keeps the
    // back-compat RLS_DATABASE_URL || DATABASE_URL chain.
    if (app.assertions?.rlsNonSuperuser) {
      const rlsLookup =
        app.rlsUrlVar !== undefined
          ? [
              `RLS_URL="\${${app.rlsUrlVar}:-}"`,
              'if [[ -z "$RLS_URL" ]]; then',
              `  ${marker("assert-rls", "fail")}`,
              `  echo "assert-rls: ${app.rlsUrlVar} (configured via --rls-url-var) is not set in the deploy environment" >&2`,
              "  rollback",
              "fi",
            ]
          : [
              'RLS_URL="${RLS_DATABASE_URL:-${DATABASE_URL:-}}"',
              'if [[ -z "$RLS_URL" ]]; then',
              `  ${marker("assert-rls", "fail")}`,
              '  echo "assert-rls: neither RLS_DATABASE_URL nor DATABASE_URL is set in the deploy environment" >&2',
              "  rollback",
              "fi",
            ];
      push(
        "# --- assert-rls: app must connect as a non-superuser (RLS not bypassed) ---",
        marker("assert-rls", "start"),
        ...rlsLookup,
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

    // ----- seed (optional) -------------------------------------------------
    // Idempotent seed, run only after a healthy deploy. A seed failure is a hard
    // failure (non-zero exit) but NOT a rollback (the deploy is already healthy).
    if (app.seedCmd) {
      push(
        "# --- seed: idempotent post-deploy seed (only after healthy deploy) ---",
        "# subshell + cd: always runs from the app dir, whatever earlier commands cd'd into (issue #122).",
        marker("seed", "start"),
        `if (cd "$SAMOHOST_APP_DIR" && ${app.seedCmd}); then`,
        `  ${marker("seed", "ok")}`,
        "else",
        `  ${marker("seed", "fail")}`,
        "  exit 1",
        "fi",
        "",
      );
    }
  } // end node path

  push('echo "deploy complete: ${SAMOHOST_SHA}"', "");

  return lines.join("\n");
}
