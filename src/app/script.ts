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
import {
  staticReleaseStatePaths,
  staticRootOf,
  staticTreeGuardFnLines,
} from "./static-root.ts";
import { staticMainVhostLines } from "./heal-script.ts";
import { databaseUrlVarsOf, migrateEnvFileOf, releaseEnvFileOf } from "./db-layout.ts";
import { buildModelPaths, buildStepScriptPath } from "./build-steps.ts";

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
  | "release"
  | "lock"
  | "restart"
  | "caddy-reload"
  | "health"
  | "assert-rls"
  | "seed"
  | "rollback";

export interface DeployTarget {
  /** Full 40-char git SHA to deploy. */
  sha: string;
  /** Resolved production release tag (required for release-channel static apps). */
  tag?: string;
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
  const staticRoot = staticRootOf(app);
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
  const releaseIdentity = target.tag ?? sha;
  // Node apps: the tag goes into the build environment and the release env
  // file (systemd EnvironmentFile syntax), so it must be a plain tag name.
  const nodeReleaseTag = target.tag ?? "";
  if (app.kind !== "static" && !/^[A-Za-z0-9._-]{0,128}$/.test(nodeReleaseTag)) {
    throw new Error(`invalid release tag for a node deploy: ${JSON.stringify(nodeReleaseTag)}`);
  }
  if (app.kind !== "static" && !/^[0-9a-f]{7,64}$/.test(sha)) {
    throw new Error(`invalid deploy sha: ${JSON.stringify(sha)}`);
  }
  const releaseEnvFile = app.kind !== "static" && app.envFile !== undefined
    ? releaseEnvFileOf(app.envFile)
    : undefined;
  const isStaticReleaseChannel =
    app.kind === "static" && app.releaseTagPattern !== undefined;
  const staticReleaseTagFormat = app.releaseTagFormat ?? "";
  if (app.kind === "static" && app.releaseTagPattern !== undefined && target.tag === undefined) {
    throw new Error("release-channel static deploy requires the resolved release tag");
  }
  if (app.kind === "static" && app.mainHost === undefined) {
    throw new Error("static production deploy requires mainHost");
  }
  const staticMainSnippet = app.kind === "static"
    ? `/etc/caddy/sites.d/00-main-${app.name}.caddy`
    : undefined;
  const staticStagedSnippet = staticMainSnippet === undefined
    ? undefined
    : `/etc/caddy/sites.d/.samohost-next-00-main-${app.name}.caddy`;
  const staticCaddyfile = "/etc/caddy/Caddyfile";
  const staticStagedCaddyfile = "/etc/caddy/.samohost-next-Caddyfile";
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const staticReleaseState = staticReleaseStatePaths(app.appDir);
  const staticReleasesDir = staticReleaseState.releasesDir;
  const staticServedDir = "${SAMOHOST_STATIC_DIR}";
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
    ...(app.kind === "static"
      ? [
          `SAMOHOST_RELEASE_TAG=${sq(releaseIdentity)}`,
          `SAMOHOST_RELEASE_TAG_FORMAT=${sq(staticReleaseTagFormat)}`,
          `SAMOHOST_STATIC_ROOT=${sq(staticRoot ?? "")}`,
          `SAMOHOST_ACTIVE_STATE=${sq(staticReleaseState.activeState)}`,
          `SAMOHOST_ACTIVE_ROUTE=${sq(staticReleaseState.activeRoute)}`,
        ]
      : []),
    ...(app.kind !== "static"
      ? [
          "# Release identity for the build (dist/build-info.json, /version.json) and,",
          "# through the release env file, for the running service.",
          `export SAMO_RELEASE_TAG=${sq(nodeReleaseTag)}`,
          `export SAMO_RELEASE_SHA=${sq(sha)}`,
        ]
      : []),
    "",
    ...(app.kind === "static" ? [...staticTreeGuardFnLines(), ""] : []),
    'cd "$SAMOHOST_APP_DIR"',
    // git >=2.35 dubious-ownership fix (issue #160): the deploy runs as OS user
    // 'samo' but the app dir is owned by a per-app OS user (e.g. 'friends-site').
    // git aborts with "fatal: detected dubious ownership in repository" before
    // emitting any phase marker, so parseDeployOutcome returns 'incomplete' and
    // the releaseTagCursor never advances. Writing to samo's ~/.gitconfig here
    // (git config --global) is self-contained, requires no external file, is
    // idempotent across deploys, and covers every git invocation in the script
    // (fetch, rev-parse, reset, worktree add/remove/prune) without needing to
    // thread the flag through each call site.
    'git config --global --add safe.directory "$SAMOHOST_APP_DIR"',
    "",
  );

  // ----- env (optional) ------------------------------------------------------
  // Source the registered env file READ-ONLY, exported, BEFORE install: a
  // pushed script inherits nothing from the service environment, and install/
  // build/migrate/seed/probes must all see the same app env (NODE_ENV,
  // DATABASE_URL, ...). Issue #2 bug 1: without this, migrate died with
  // "DATABASE_URL environment variable is required". The file is never
  // written and its values are never echoed.
  // Split env layout (src/app/db-layout.ts), detected on the server by the
  // presence of the migrate env file: database addresses stay in this shell
  // (export -n) so `npm ci`, install scripts and the build do not receive
  // them; only the migrate subshell exports them, together with the migrate
  // env file. Legacy apps (no migrate env file) keep the old behaviour.
  const splitLayout = app.kind !== "static" && app.envFile !== undefined
    ? { migrateEnvFile: migrateEnvFileOf(app.envFile), dbVars: databaseUrlVarsOf(app) }
    : undefined;
  if (app.envFile !== undefined) {
    push(
      "# --- env: source the app env file (READ-ONLY; never written, never echoed) ---",
      `set -a; . ${sq(app.envFile)}; set +a`,
      ...(splitLayout !== undefined
        ? [
            `SAMOHOST_MIGRATE_ENV_FILE=${sq(splitLayout.migrateEnvFile)}`,
            'if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then',
            `  export -n ${splitLayout.dbVars.join(" ")}`,
            "fi",
            "# split layout: the service runs as a separate runtime user, which reads",
            "# the checkout, node_modules and dist/ through their world-read bit.",
            'if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then umask 022; fi',
            "# Build model (src/app/build-steps.ts): a root-owned step script runs install,",
            "# build, migrate, release and seed as the build user; this script runs no",
            "# app command itself. Servers bootstrapped before it keep the steps below.",
            `SAMOHOST_STEP=${sq(buildStepScriptPath(app.name))}`,
            "SAMOHOST_RELEASE_MODEL=0",
            'if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" && -x "$SAMOHOST_STEP" ]]; then SAMOHOST_RELEASE_MODEL=1; fi',
            "# One deploy of this app at a time. A second deploy stops here, before any",
            "# change; the outcome is not a failed commit.",
            'if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then',
            `  exec 8>>"\${HOME:?}/.samohost-deploy-${app.name}.lock"`,
            "  if ! flock -n 8; then",
            `    ${marker("lock", "fail")}`,
            `    echo ${sq(`ERROR: another deploy of ${app.name} is running on this server; this deploy changed nothing. Try again when it has finished.`)} >&2`,
            "    exit 1",
            "  fi",
            "fi",
            "# No process of the build user outlives the deploy, whatever its outcome.",
            "# Every step gets stdin from /dev/null: this script reaches bash on stdin,",
            "# and code in a step must not read or consume the rest of it.",
            `if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then trap 'sudo "$SAMOHOST_STEP" cleanup </dev/null >/dev/null 2>&1 || true' EXIT; fi`,
          ]
        : []),
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
  // Node deploys preserve their mutable checkout/build as before. Static
  // deploys checkpoint only the routing file: the live checkout and its
  // version.json remain completely untouched until a new candidate is healthy.
  if (app.kind === "static") {
    push(
      "# --- checkpoint: preserve live static routing (served checkout stays untouched) ---",
      marker("checkpoint", "start"),
      "umask 022",
      'SAMOHOST_CANDIDATE_DIR=""',
      `SAMOHOST_RELEASES_DIR=${sq(staticReleasesDir)}`,
      'SAMOHOST_PREVIOUS_RELEASE_DIR=""',
      'SAMOHOST_PREVIOUS_ROUTE_ROOT=""',
      'SAMOHOST_VHOST_BACKUP="$(mktemp)"',
      `if [[ -f ${sq(staticMainSnippet!)} ]]; then cat ${sq(staticMainSnippet!)} > "$SAMOHOST_VHOST_BACKUP"; SAMOHOST_OLD_VHOST_PRESENT=1; else SAMOHOST_OLD_VHOST_PRESENT=0; fi`,
      'if [[ "$SAMOHOST_OLD_VHOST_PRESENT" == "1" ]]; then SAMOHOST_PREVIOUS_ROUTE_ROOT=$(sed -n \'s/^[[:space:]]*root \\* "\\(.*\\)"$/\\1/p\' "$SAMOHOST_VHOST_BACKUP" | head -n 1); SAMOHOST_PREVIOUS_RELEASE_DIR=$(sed -n \'s/^[[:space:]]*# samohost-worktree "\\(.*\\)"$/\\1/p\' "$SAMOHOST_VHOST_BACKUP" | head -n 1); fi',
      'if [[ -z "$SAMOHOST_PREVIOUS_RELEASE_DIR" && -n "$SAMOHOST_PREVIOUS_ROUTE_ROOT" ]]; then',
      '  if [[ -z "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_PREVIOUS_RELEASE_DIR="$SAMOHOST_PREVIOUS_ROUTE_ROOT";',
      '  elif [[ "$SAMOHOST_PREVIOUS_ROUTE_ROOT" == */"$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_PREVIOUS_RELEASE_DIR="${SAMOHOST_PREVIOUS_ROUTE_ROOT%/$SAMOHOST_STATIC_ROOT}"; fi',
      'fi',
      'SAMOHOST_ACTIVE_ROUTE_NEXT=""',
      'SAMOHOST_ACTIVE_STATE_NEXT=""',
      'SAMOHOST_ACTIVE_ROUTE_BACKUP="$(mktemp)"',
      'SAMOHOST_ACTIVE_STATE_BACKUP="$(mktemp)"',
      'if [[ -f "$SAMOHOST_ACTIVE_ROUTE" ]]; then cat "$SAMOHOST_ACTIVE_ROUTE" > "$SAMOHOST_ACTIVE_ROUTE_BACKUP"; SAMOHOST_HAD_ACTIVE_ROUTE=1; else SAMOHOST_HAD_ACTIVE_ROUTE=0; fi',
      'if [[ -f "$SAMOHOST_ACTIVE_STATE" ]]; then cat "$SAMOHOST_ACTIVE_STATE" > "$SAMOHOST_ACTIVE_STATE_BACKUP"; SAMOHOST_HAD_ACTIVE_STATE=1; else SAMOHOST_HAD_ACTIVE_STATE=0; fi',
      ...(isStaticReleaseChannel
        ? [
          'SAMOHOST_BASE_CHANGED=0',
          'SAMOHOST_BASE_BACKUP="$(mktemp)"',
          'SAMOHOST_BASE_FILTERED="$(mktemp)"',
          `cat ${sq(staticCaddyfile)} > "$SAMOHOST_BASE_BACKUP"`,
        ]
        : []),
      marker("checkpoint", "ok"),
      "",
    );
  } else {
    push(
      "# --- checkpoint: record pre-deploy SHA + preserve current build ---",
      marker("checkpoint", "start"),
      "PRE_DEPLOY_SHA=$(git rev-parse HEAD)",
      'echo "pre-deploy sha: ${PRE_DEPLOY_SHA}"',
      "# A previous release exists when dist/ is present before this deploy. Its copy",
      "# dist.prev/ is made here, before install and build (a build may delete dist/).",
      "SAMOHOST_HAS_PREVIOUS_RELEASE=0",
      ...(splitLayout !== undefined
        ? [
            "SAMOHOST_RELEASE_SWITCHED=0",
            "# build model: the previous release is the one the current link names.",
            'if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then',
            `  if [[ -L ${sq(buildModelPaths(appBase).currentLink)} ]]; then SAMOHOST_HAS_PREVIOUS_RELEASE=1; fi`,
            'elif [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then',
          ]
        : ['if [[ -d "${SAMOHOST_APP_DIR}/dist" ]]; then']),
      '  rm -rf "${SAMOHOST_APP_DIR}/dist.prev"',
      '  cp -r "${SAMOHOST_APP_DIR}/dist" "${SAMOHOST_APP_DIR}/dist.prev"',
      "  SAMOHOST_HAS_PREVIOUS_RELEASE=1",
      "fi",
      marker("checkpoint", "ok"),
      "",
    );
  }

  // A reusable rollback function. Invoked by the health / assert phases on
  // failure. Restores git to PRE_DEPLOY_SHA, restores dist.prev/ -> dist/,
  // then either reloads Caddy (static) or restarts the systemd unit (node),
  // re-probes health, emits the rollback marker, and exits 1.
  if (app.kind === "static") {
    push(
      "# rollback(): atomically restore the prior vhost and, on the first",
      "# release-channel activation, the legacy route in the base Caddyfile.",
      "# The previous checkout and public version.json were never modified, so",
      "# restoring the routes restores content and identity as one operation.",
      "# Emits rollback:ok / rollback:fail and exits 1.",
      "rollback() {",
      "  local rb_ok=1",
      "  local rb_route_ok=1",
      `  sudo /usr/bin/rm -f ${sq(staticStagedSnippet!)} || rb_route_ok=0`,
      '  if [[ "${SAMOHOST_OLD_VHOST_PRESENT:-0}" == "1" ]]; then',
      `    if sudo /usr/bin/tee ${sq(staticStagedSnippet!)} >/dev/null < "$SAMOHOST_VHOST_BACKUP"; then sudo /usr/bin/mv -- ${sq(staticStagedSnippet!)} ${sq(staticMainSnippet!)} || rb_route_ok=0; else rb_route_ok=0; fi`,
      `  else sudo /usr/bin/rm -f ${sq(staticMainSnippet!)} || rb_route_ok=0; fi`,
      ...(isStaticReleaseChannel
        ? [
          '  if [[ "${SAMOHOST_BASE_CHANGED:-0}" == "1" ]]; then',
          `    if sudo /usr/bin/tee ${sq(staticStagedCaddyfile)} >/dev/null < "$SAMOHOST_BASE_BACKUP"; then sudo /usr/bin/mv -- ${sq(staticStagedCaddyfile)} ${sq(staticCaddyfile)} || rb_route_ok=0; else rb_route_ok=0; fi`,
          `  else sudo /usr/bin/rm -f ${sq(staticStagedCaddyfile)} || rb_route_ok=0; fi`,
        ]
        : []),
      '  local rb_active_tmp=""',
      '  if [[ "${SAMOHOST_HAD_ACTIVE_ROUTE:-0}" == "1" ]]; then',
      '    rb_active_tmp=$(mktemp "${SAMOHOST_RELEASES_DIR}/.active-route.restore.XXXXXX") || rb_route_ok=0',
      '    if [[ -n "$rb_active_tmp" ]] && cp "$SAMOHOST_ACTIVE_ROUTE_BACKUP" "$rb_active_tmp" && chmod 0644 "$rb_active_tmp"; then /usr/bin/mv -f "$rb_active_tmp" "$SAMOHOST_ACTIVE_ROUTE" || rb_route_ok=0; else rb_route_ok=0; fi',
      '  else rm -f "$SAMOHOST_ACTIVE_ROUTE" || rb_route_ok=0; fi',
      '  rb_active_tmp=""',
      '  if [[ "${SAMOHOST_HAD_ACTIVE_STATE:-0}" == "1" ]]; then',
      '    rb_active_tmp=$(mktemp "${SAMOHOST_RELEASES_DIR}/.active-state.restore.XXXXXX") || rb_route_ok=0',
      '    if [[ -n "$rb_active_tmp" ]] && cp "$SAMOHOST_ACTIVE_STATE_BACKUP" "$rb_active_tmp" && chmod 0644 "$rb_active_tmp"; then /usr/bin/mv -f "$rb_active_tmp" "$SAMOHOST_ACTIVE_STATE" || rb_route_ok=0; else rb_route_ok=0; fi',
      '  else rm -f "$SAMOHOST_ACTIVE_STATE" || rb_route_ok=0; fi',
      "  caddy validate --config /etc/caddy/Caddyfile >/dev/null || rb_route_ok=0",
      // Static rollback: reload caddy, not restart a unit that doesn't exist.
      // full-path systemctl: see header note (3).
      '  if [[ "$rb_route_ok" == "1" ]]; then sudo /usr/bin/systemctl reload caddy || rb_ok=0; else rb_ok=0; fi',
      `  sleep ${RESTART_SETTLE_SEC}`,
      "  local rb_code",
      // -k: Caddy uses tls internal (self-signed origin cert); CF Full-mode proxies it.
      ...(app.mainHost !== undefined
        ? [`  rb_code=$(curl -s -k -H ${sq(`Host: ${app.mainHost}`)} -o /dev/null -w "%{http_code}" --max-time 10 ${app.mainListen === "cp-http80" ? "http" : "https"}://127.0.0.1/ || echo 000)`]
        : ['  rb_code=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 "${SAMOHOST_HEALTH_URL}" || echo 000)']),
      '  if [[ -n "${SAMOHOST_CANDIDATE_DIR:-}" && -d "$SAMOHOST_CANDIDATE_DIR" ]]; then',
      '    git -C "$SAMOHOST_APP_DIR" worktree remove --force "$SAMOHOST_CANDIDATE_DIR" || rm -rf -- "$SAMOHOST_CANDIDATE_DIR" || rb_ok=0',
      "  fi",
      '  git -C "$SAMOHOST_APP_DIR" worktree prune || true',
      '  if [[ "$rb_ok" == "1" && "$rb_code" == "200" ]]; then',
      `    ${marker("rollback", "ok")}`,
      "  else",
      `    ${marker("rollback", "fail")}`,
      '    echo "rollback health re-check failed (HTTP $rb_code) — manual intervention required" >&2',
      "  fi",
      `  sudo /usr/bin/rm -f ${sq(staticStagedSnippet!)} || true`,
      ...(isStaticReleaseChannel
        ? [`  sudo /usr/bin/rm -f ${sq(staticStagedCaddyfile)} || true`]
        : []),
      '  rm -f "${SAMOHOST_VERSION_NEXT:-}" "$SAMOHOST_VHOST_BACKUP" || true',
      ...(isStaticReleaseChannel
        ? ['  rm -f "$SAMOHOST_BASE_BACKUP" "$SAMOHOST_BASE_FILTERED" "${SAMOHOST_BASE_FILTERED}.status" || true']
        : []),
      '  [[ -z "${SAMOHOST_ACTIVE_ROUTE_NEXT:-}" ]] || rm -f "$SAMOHOST_ACTIVE_ROUTE_NEXT" || true',
      '  [[ -z "${SAMOHOST_ACTIVE_STATE_NEXT:-}" ]] || rm -f "$SAMOHOST_ACTIVE_STATE_NEXT" || true',
      '  rm -f "$SAMOHOST_ACTIVE_ROUTE_BACKUP" "$SAMOHOST_ACTIVE_STATE_BACKUP" || true',
      "  exit 1",
      "}",
      "",
    );
  } else {
    push(
      "# rollback(): restore the pre-deploy state coherently (git + dist), then",
      "# restart and re-health. Emits rollback:ok / rollback:fail and exits 1.",
      "# rollback before-restart: used when install, build or migrate failed. The",
      "# service was not restarted and still runs the previous release, so the",
      "# files are restored and its health is checked without a restart.",
      "# Database migrations that already ran are not undone.",
      "rollback() {",
      '  local rb_mode="${1:-}"',
      "  git reset --hard \"${PRE_DEPLOY_SHA}\" || true",
      ...(releaseEnvFile !== undefined
        ? [
            "  # Restore the previous release env file (or remove the one this deploy created).",
            '  if [[ "${SAMOHOST_RELEASE_ENV_WRITTEN:-0}" == "1" ]]; then',
            '    if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then',
            "      # split layout: root-owned directory; the exact sudo tee rule writes the file (empty on a first deploy).",
            '      if [[ "${SAMOHOST_RELEASE_ENV_HAD_PREVIOUS:-0}" == "1" ]]; then',
            "        printf '%s\\n' \"$SAMOHOST_RELEASE_ENV_PREVIOUS\" | sudo /usr/bin/tee \"$SAMOHOST_RELEASE_ENV_FILE\" >/dev/null || true",
            "      else",
            "        printf '' | sudo /usr/bin/tee \"$SAMOHOST_RELEASE_ENV_FILE\" >/dev/null || true",
            "      fi",
            '    elif [[ "${SAMOHOST_RELEASE_ENV_HAD_PREVIOUS:-0}" == "1" ]]; then',
            "      printf '%s\\n' \"$SAMOHOST_RELEASE_ENV_PREVIOUS\" > \"$SAMOHOST_RELEASE_ENV_FILE\" || true",
            "    else",
            '      rm -f "$SAMOHOST_RELEASE_ENV_FILE" || true',
            "    fi",
            "  fi",
          ]
        : []),
      ...(splitLayout !== undefined
        ? [
            "  # build model: switch the current link back when this deploy switched it.",
            '  if [[ "${SAMOHOST_RELEASE_MODEL:-0}" == 1 ]]; then',
            '    if [[ "${SAMOHOST_RELEASE_SWITCHED:-0}" == 1 ]]; then sudo "$SAMOHOST_STEP" rollback </dev/null || true; fi',
            '  elif [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then',
          ]
        : ['  if [[ -d "${SAMOHOST_APP_DIR}/dist.prev" ]]; then']),
      '    rm -rf "${SAMOHOST_APP_DIR}/dist"',
      '    cp -r "${SAMOHOST_APP_DIR}/dist.prev" "${SAMOHOST_APP_DIR}/dist"',
      "  fi",
      // full-path systemctl: see header note (3).
      '  if [[ "$rb_mode" != "before-restart" ]]; then',
      '    sudo /usr/bin/systemctl restart "${SAMOHOST_UNIT}" || true',
      `    sleep ${RESTART_SETTLE_SEC}`,
      "  fi",
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
  if (app.kind === "static") {
    push(
      "# --- checkout: stage target in a separate versioned detached worktree ---",
      "# The currently served appDir is never reset or otherwise rewritten.",
      marker("checkout", "start"),
      'if /usr/bin/install -d -m 0755 "$SAMOHOST_RELEASES_DIR" && SAMOHOST_CANDIDATE_DIR=$(mktemp -d "${SAMOHOST_RELEASES_DIR}/${SAMOHOST_SHA}.candidate.XXXXXX") && rmdir "$SAMOHOST_CANDIDATE_DIR" && git -C "$SAMOHOST_APP_DIR" worktree add --detach "$SAMOHOST_CANDIDATE_DIR" "$SAMOHOST_SHA" && chmod 0755 "$SAMOHOST_CANDIDATE_DIR" && SAMOHOST_CANDIDATE_REAL=$(realpath -e "$SAMOHOST_CANDIDATE_DIR"); then',
      '  if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CANDIDATE_DIR/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CANDIDATE_DIR"; fi',
      '  if ! SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE"); then echo "staticRoot does not exist: $SAMOHOST_STATIC_ROOT" >&2; rollback; fi',
      '  case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CANDIDATE_REAL"|"$SAMOHOST_CANDIDATE_REAL"/*) ;; *) echo "staticRoot escapes the candidate checkout: $SAMOHOST_STATIC_ROOT" >&2; rollback ;; esac',
      '  if [[ ! -d "$SAMOHOST_STATIC_DIR" || ! -f "$SAMOHOST_STATIC_DIR/index.html" ]]; then echo "staticRoot must be a directory containing index.html: $SAMOHOST_STATIC_ROOT" >&2; rollback; fi',
      '  samohost_assert_static_tree_safe "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" || rollback',
      `  ${marker("checkout", "ok")}`,
      "else",
      `  ${marker("checkout", "fail")}`,
      "  rollback",
      "fi",
      "",
    );
  } else {
    push(
      "# --- checkout: hard reset the working tree to the target SHA ---",
      marker("checkout", "start"),
      'if git reset --hard "${SAMOHOST_SHA}"; then',
      `  ${marker("checkout", "ok")}`,
      "else",
      `  ${marker("checkout", "fail")}`,
      "  exit 1",
      "fi",
      ...(splitLayout !== undefined
        ? [
            "# build model: the build user reads the checkout through the world-read bit;",
            "# this covers files an earlier clone or deploy left owner-only. Skips .git.",
            'if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then',
            '  find "$SAMOHOST_APP_DIR" -path "$SAMOHOST_APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} + \\',
            '    || echo "WARNING: could not make every file in $SAMOHOST_APP_DIR readable for the build user" >&2',
            "fi",
          ]
        : []),
      "",
    );
  }

  if (app.kind === "static") {
    // ===== STATIC SITE PATH =================================================
    // No Node.js install/build, no DB migrations, no systemd unit restart.
    // The only "activation" step is reloading Caddy so it picks up the new
    // static assets from the updated checkout. Health probe uses -k because
    // Caddy uses tls internal (self-signed origin cert) with CF Full-mode.
    // ========================================================================

    const address = app.mainListen === "cp-http80" ? `http://${app.mainHost}` : app.mainHost;
    push(
      "# --- static release identity + routing checkpoint ---",
      "# Publish identity inside the private candidate first. chmod 0644 is",
      "# mandatory: Caddy must be able to read /version.json after cutover.",
      `if ! SAMOHOST_VERSION_NEXT=$(mktemp "${staticServedDir}/.version.next.XXXXXX"); then rollback; fi`,
      `if printf '{"version":"%s","tag":"%s","sha":"%s","environment":"production"}\\n' "$SAMOHOST_RELEASE_TAG" "$SAMOHOST_RELEASE_TAG" "$SAMOHOST_SHA" > "$SAMOHOST_VERSION_NEXT" && chmod 0644 "$SAMOHOST_VERSION_NEXT" && [[ -r "$SAMOHOST_VERSION_NEXT" ]] && [[ "$(stat -c '%a' "$SAMOHOST_VERSION_NEXT")" == "644" ]] && /usr/bin/mv -f "$SAMOHOST_VERSION_NEXT" "${staticServedDir}/version.json" && [[ -r "${staticServedDir}/version.json" ]] && [[ "$(stat -c '%a' "${staticServedDir}/version.json")" == "644" ]]; then :; else rollback; fi`,
      "# Stage app-owned structured active-release state and the shared",
      "# Caddy route imported by every managed custom-domain vhost. The",
      "# route moves with the main vhost before reload; state commits only",
      "# after the candidate-specific health proof succeeds.",
      'SAMOHOST_ACTIVE_ROUTE_NEXT=$(mktemp "${SAMOHOST_RELEASES_DIR}/.active-route.next.XXXXXX") || rollback',
      'if printf \'root * "%s"\\ntry_files {path} {path}/ =404\\nfile_server\\nencode gzip\\n\' "$SAMOHOST_STATIC_DIR" > "$SAMOHOST_ACTIVE_ROUTE_NEXT" && chmod 0644 "$SAMOHOST_ACTIVE_ROUTE_NEXT"; then :; else rollback; fi',
      'SAMOHOST_ACTIVE_STATE_NEXT=$(mktemp "${SAMOHOST_RELEASES_DIR}/.active-state.next.XXXXXX") || rollback',
      `if ! python3 - "$SAMOHOST_ACTIVE_STATE_NEXT" ${sq(app.name)} "$SAMOHOST_SHA" "$SAMOHOST_RELEASE_TAG" "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_ROOT" "$SAMOHOST_RELEASE_TAG_FORMAT" <<'PY'`,
      "import json",
      "import os",
      "import sys",
      "",
      "path, app_name, sha, tag, release_dir, static_root, tag_format = sys.argv[1:]",
      "payload = {",
      "    'schema': 1,",
      "    'appName': app_name,",
      "    'sha': sha,",
      "    'tag': tag,",
      "    'releaseDir': release_dir,",
      "    'staticRoot': static_root,",
      "    'releaseTagFormat': tag_format or None,",
      "}",
      "with open(path, 'w', encoding='utf-8') as output:",
      "    json.dump(payload, output, sort_keys=True, separators=(',', ':'))",
      "    output.write('\\n')",
      "os.chmod(path, 0o644)",
      "PY",
      "then",
      "  rollback",
      "fi",
      ...(isStaticReleaseChannel
        ? [
          "# On the first tagged activation only, stage removal of one legacy",
          "# app-owned top-level route from the base Caddyfile. The parser fails",
          "# closed on ambiguity and preserves every unrelated byte and route.",
          `if ! python3 - ${sq(staticCaddyfile)} "$SAMOHOST_BASE_FILTERED" "${'$'}{SAMOHOST_BASE_FILTERED}.status" ${sq(appBase)} ${sq(app.mainHost!)} ${sq(app.mainListen ?? "tls")} <<'PY'`,
          "import re",
          "import sys",
          "",
          "source_path, output_path, status_path, app_base, main_host, main_listen = sys.argv[1:]",
          "with open(source_path, encoding=\"utf-8\", newline=\"\") as source:",
          "    lines = source.readlines()",
          "",
          "def structural_braces(line):",
          "    braces = []",
          "    quote = None",
          "    escaped = False",
          "    for index, char in enumerate(line):",
          "        if quote is not None:",
          "            if escaped:",
          "                escaped = False",
          "            elif char == \"\\\\\" and quote != \"`\":",
          "                escaped = True",
          "            elif char == quote:",
          "                quote = None",
          "            continue",
          "        if char in ('\"', \"'\", \"`\"):",
          "            quote = char",
          "        elif char == '#':",
          "            break",
          "        elif char in '{}':",
          "            braces.append((index, char))",
          "    return braces",
          "",
          "blocks = []",
          "depth = 0",
          "block_start = None",
          "block_header = None",
          "for line_number, line in enumerate(lines):",
          "    for column, brace in structural_braces(line):",
          "        if brace == '{':",
          "            if depth == 0:",
          "                block_start = line_number",
          "                block_header = line[:column].strip()",
          "            depth += 1",
          "        else:",
          "            depth -= 1",
          "            if depth < 0:",
          "                raise SystemExit('base Caddyfile has an unmatched closing brace')",
          "            if depth == 0 and block_start is not None:",
          "                blocks.append((block_start, line_number + 1, block_header or ''))",
          "                block_start = None",
          "                block_header = None",
          "if depth != 0:",
          "    raise SystemExit('base Caddyfile has an unmatched opening brace')",
          "",
          "if main_listen == 'cp-http80':",
          "    allowed_headers = {':80', 'http://:80', main_host, f'http://{main_host}', f'{main_host}:80', f'http://{main_host}:80'}",
          "else:",
          "    allowed_headers = {':443', 'https://:443', main_host, f'https://{main_host}', f'{main_host}:443', f'https://{main_host}:443'}",
          "root_re = re.compile(r'^\\s*root\\s+\\*\\s+(?:\"([^\"]+)\"|([^\\s#]+))')",
          "candidates = []",
          "for start, end, header in blocks:",
          "    if header not in allowed_headers:",
          "        continue",
          "    roots = []",
          "    for line in lines[start:end]:",
          "        match = root_re.match(line)",
          "        if match:",
          "            roots.append(match.group(1) or match.group(2))",
          "    if any(root == app_base or root.startswith(app_base.rstrip('/') + '/') for root in roots):",
          "        candidates.append((start, end))",
          "if len(candidates) > 1:",
          "    raise SystemExit('multiple app-owned legacy routes found in base Caddyfile; refusing ambiguous migration')",
          "",
          "if candidates:",
          "    start, end = candidates[0]",
          "    filtered = lines[:start] + lines[end:]",
          "    status = 'changed'",
          "else:",
          "    filtered = lines",
          "    status = 'unchanged'",
          "import_re = re.compile(r'^\\s*import\\s+(?:/etc/caddy/)?sites\\.d/\\*\\.caddy(?:\\s*(?:#.*)?)?$', re.MULTILINE)",
          "rendered = ''.join(filtered)",
          "if not import_re.search(rendered):",
          "    raise SystemExit('base Caddyfile is missing the required sites.d import after migration')",
          "with open(output_path, 'w', encoding='utf-8', newline='') as output:",
          "    output.write(rendered)",
          "with open(status_path, 'w', encoding='utf-8') as status_file:",
          "    status_file.write(status)",
          "PY",
          "then",
          "  rollback",
          "fi",
          `sudo /usr/bin/rm -f ${sq(staticStagedCaddyfile)} || rollback`,
          'if [[ "$(cat "${SAMOHOST_BASE_FILTERED}.status")" == "changed" ]]; then',
          "  SAMOHOST_BASE_CHANGED=1",
          `  sudo /usr/bin/tee ${sq(staticStagedCaddyfile)} >/dev/null < "$SAMOHOST_BASE_FILTERED" || rollback`,
          "fi",
          ]
        : []),
      'samohost_assert_static_tree_safe "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" || rollback',
      `sudo /usr/bin/rm -f ${sq(staticStagedSnippet!)} || rollback`,
      `sudo /usr/bin/tee ${sq(staticStagedSnippet!)} >/dev/null <<CADDY || rollback`,
      // staticMainVhostLines() is the shared three-way contract (deploy == heal == bootstrap).
      // Provenance header is line 1 so heal's provenance gate accepts the file on next cycle.
      ...staticMainVhostLines(
        address!,
        "${SAMOHOST_CANDIDATE_DIR}",
        "${SAMOHOST_STATIC_DIR}",
        app.mainListen !== "cp-http80",
        app.name,
      ),
      `CADDY`,
      'samohost_assert_static_tree_safe "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" || rollback',
      '/usr/bin/mv -f "$SAMOHOST_ACTIVE_ROUTE_NEXT" "$SAMOHOST_ACTIVE_ROUTE" || rollback',
      `sudo /usr/bin/mv -- ${sq(staticStagedSnippet!)} ${sq(staticMainSnippet!)} || rollback`,
      ...(isStaticReleaseChannel
        ? [
          `if [[ "$SAMOHOST_BASE_CHANGED" == "1" ]]; then sudo /usr/bin/mv -- ${sq(staticStagedCaddyfile)} ${sq(staticCaddyfile)} || rollback; fi`,
        ]
        : []),
      "caddy validate --config /etc/caddy/Caddyfile >/dev/null || rollback",
      "",
    );

    // ----- caddy-reload (static) -------------------------------------------
    // Full-path systemctl reload (not restart): see header note (3).
    push(
      "# --- caddy-reload: reload Caddy to serve the updated static assets ---",
      "# Static site: no Node.js unit to restart; Caddy serves the checkout directly.",
      "# Full-path systemctl: see header note (3) — bare sudo systemctl fails on hardened host.",
      marker("caddy-reload", "start"),
      'if samohost_assert_static_tree_safe "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" && sudo /usr/bin/systemctl reload caddy; then',
      `  sleep ${RESTART_SETTLE_SEC}`,
      `  ${marker("caddy-reload", "ok")}`,
      "else",
      `  ${marker("caddy-reload", "fail")}`,
      "  rollback",
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
      `  body=$(curl -s -k -H ${sq(`Host: ${app.mainHost}`)} --max-time 10 ${app.mainListen === "cp-http80" ? "http" : "https"}://127.0.0.1/version.json || true)`,
      '  if [[ "$body" == *"\\\"version\\\":\\\"${SAMOHOST_RELEASE_TAG}\\\""* && "$body" == *"\\\"tag\\\":\\\"${SAMOHOST_RELEASE_TAG}\\\""* && "$body" == *"\\\"sha\\\":\\\"${SAMOHOST_SHA}\\\""* && "$body" == *"\\\"environment\\\":\\\"production\\\""* ]]; then health_ok=1; break; fi',
      `  sleep ${HEALTH_SLEEP_SEC}`,
      "done",
      'if [[ "$health_ok" == "1" ]]; then',
      '  if samohost_assert_static_tree_safe "$SAMOHOST_CANDIDATE_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" && /usr/bin/mv -f "$SAMOHOST_ACTIVE_STATE_NEXT" "$SAMOHOST_ACTIVE_STATE"; then :; else',
      `    ${marker("health", "fail")}`,
      '    echo "healthy static deploy could not commit active state — rolling back" >&2',
      "    rollback",
      "  fi",
      `  ${marker("health", "ok")}`,
      '  if [[ -n "$SAMOHOST_PREVIOUS_RELEASE_DIR" && "$SAMOHOST_PREVIOUS_RELEASE_DIR" == "$SAMOHOST_RELEASES_DIR/"* && "$SAMOHOST_PREVIOUS_RELEASE_DIR" != "$SAMOHOST_CANDIDATE_DIR" ]]; then',
      '    git -C "$SAMOHOST_APP_DIR" worktree remove --force "$SAMOHOST_PREVIOUS_RELEASE_DIR" || true',
      "  fi",
      '  git -C "$SAMOHOST_APP_DIR" worktree prune || true',
      ...(isStaticReleaseChannel
        ? [`  sudo /usr/bin/rm -f ${sq(staticStagedCaddyfile)} || true`]
        : []),
      '  rm -f "$SAMOHOST_VHOST_BACKUP" || true',
      ...(isStaticReleaseChannel
        ? ['  rm -f "$SAMOHOST_BASE_BACKUP" "$SAMOHOST_BASE_FILTERED" "${SAMOHOST_BASE_FILTERED}.status" || true']
        : []),
      '  rm -f "$SAMOHOST_ACTIVE_ROUTE_BACKUP" "$SAMOHOST_ACTIVE_STATE_BACKUP" || true',
      "else",
      `  ${marker("health", "fail")}`,
      '  echo "health check failed after retries — rolling back" >&2',
      "  rollback",
      "fi",
      "",
    );
  } else {
    // ===== NODE PATH (default — existing behavior, unchanged) ===============

    // ----- release env (function) ---------------------------------------------
    // Defined here, called before install in the build model (the build steps
    // load the file through systemd) and before the restart otherwise.
    if (releaseEnvFile !== undefined) {
      push(
        "samohost_write_release_env() {",
        "  # --- release env: tag and sha for the running service (unit EnvironmentFile=-) ---",
        "  # No secret is written here. The previous content is kept in a variable for",
        "  # rollback. A failed write is a warning, not a failure: units written before",
        "  # this file existed do not load it, and the release runs without the values.",
        `  SAMOHOST_RELEASE_ENV_FILE=${sq(releaseEnvFile)}`,
        "  SAMOHOST_RELEASE_ENV_HAD_PREVIOUS=0",
        '  SAMOHOST_RELEASE_ENV_PREVIOUS=""',
        '  if [[ -f "$SAMOHOST_RELEASE_ENV_FILE" ]] && SAMOHOST_RELEASE_ENV_PREVIOUS="$(cat "$SAMOHOST_RELEASE_ENV_FILE")"; then SAMOHOST_RELEASE_ENV_HAD_PREVIOUS=1; fi',
        "  SAMOHOST_RELEASE_ENV_WRITTEN=0",
        "  # split layout: the env file's directory is root-owned; the exact sudo tee rule writes the file.",
        '  if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then',
        '    if printf \'SAMO_RELEASE_TAG=%s\\nSAMO_RELEASE_SHA=%s\\n\' "$SAMO_RELEASE_TAG" "$SAMO_RELEASE_SHA" | sudo /usr/bin/tee "$SAMOHOST_RELEASE_ENV_FILE" >/dev/null; then SAMOHOST_RELEASE_ENV_WRITTEN=1; fi',
        '  elif printf \'SAMO_RELEASE_TAG=%s\\nSAMO_RELEASE_SHA=%s\\n\' "$SAMO_RELEASE_TAG" "$SAMO_RELEASE_SHA" 2>/dev/null > "${SAMOHOST_RELEASE_ENV_FILE}.next" && chmod 0644 "${SAMOHOST_RELEASE_ENV_FILE}.next" && mv -f "${SAMOHOST_RELEASE_ENV_FILE}.next" "$SAMOHOST_RELEASE_ENV_FILE"; then',
        "    SAMOHOST_RELEASE_ENV_WRITTEN=1",
        "  fi",
        '  if [[ "$SAMOHOST_RELEASE_ENV_WRITTEN" != "1" ]]; then',
        '    rm -f "${SAMOHOST_RELEASE_ENV_FILE}.next" 2>/dev/null || true',
        '    echo "WARNING: could not write the release env file $SAMOHOST_RELEASE_ENV_FILE; the service starts without SAMO_RELEASE_TAG and SAMO_RELEASE_SHA" >&2',
        "  fi",
        "}",
        "",
      );
    }

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
      ...(splitLayout !== undefined && releaseEnvFile !== undefined
        ? ['if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then samohost_write_release_env; fi']
        : []),
      splitLayout !== undefined
        ? 'if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" install </dev/null; elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev; else npm install --include=dev; fi); then'
        : "if (if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --include=dev; else npm install --include=dev; fi); then",
      `  ${marker("install", "ok")}`,
      "else",
      `  ${marker("install", "fail")}`,
      '  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi',
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
      splitLayout !== undefined
        ? `if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" build </dev/null; else (cd "$SAMOHOST_APP_DIR" && ${app.buildCmd}); fi); then`
        : `if (cd "$SAMOHOST_APP_DIR" && ${app.buildCmd}); then`,
      `  ${marker("build", "ok")}`,
      "else",
      `  ${marker("build", "fail")}`,
      '  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi',
      "  exit 1",
      "fi",
      ...(splitLayout !== undefined
        ? [
            "# split layout: the service's runtime user reads the release through the",
            "# world-read bit; umask 022 covers new files, this covers files an earlier",
            "# clone or deploy left owner-only. Skips .git; does not follow links.",
            "# (The build model's service reads its own root-owned release instead.)",
            'if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" && "$SAMOHOST_RELEASE_MODEL" != 1 ]]; then',
            '  find "$SAMOHOST_APP_DIR" -path "$SAMOHOST_APP_DIR/.git" -prune -o ! -type l -exec chmod go+rX {} + \\',
            '    || echo "WARNING: could not make every file in $SAMOHOST_APP_DIR readable for the runtime user" >&2',
            "fi",
          ]
        : []),
      "",
    );

    // ----- migrate (optional) ------------------------------------------------
    if (app.migrateCmd) {
      push(
        "# --- migrate: apply DB migrations before the new code boots ---",
        "# subshell + cd: always runs from the app dir, whatever buildCmd cd'd into (issue #122).",
        ...(splitLayout !== undefined
          ? ["# split layout: only this subshell exports the database addresses and loads the migrate env file."]
          : []),
        marker("migrate", "start"),
        splitLayout !== undefined
          ? `if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" migrate </dev/null; else (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export ${splitLayout.dbVars.join(" ")}; fi && cd "$SAMOHOST_APP_DIR" && ${app.migrateCmd}); fi); then`
          : `if (cd "$SAMOHOST_APP_DIR" && ${app.migrateCmd}); then`,
        `  ${marker("migrate", "ok")}`,
        "else",
        `  ${marker("migrate", "fail")}`,
        '  if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi',
        "  exit 1",
        "fi",
        "",
      );
    }

    // ----- release (build model) ------------------------------------------------
    if (splitLayout !== undefined) {
      push(
        "# --- release (build model): root copies the build into a release folder and",
        "# switches the current link the service runs from ---",
        'if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then',
        `  ${marker("release", "start")}`,
        '  if sudo "$SAMOHOST_STEP" release </dev/null; then',
        "    SAMOHOST_RELEASE_SWITCHED=1",
        `    ${marker("release", "ok")}`,
        "  else",
        `    ${marker("release", "fail")}`,
        '    if [[ "$SAMOHOST_HAS_PREVIOUS_RELEASE" == "1" ]]; then rollback before-restart; fi',
        "    exit 1",
        "  fi",
        "fi",
        "",
      );
    }

    // ----- restart -----------------------------------------------------------
    // Full-path sudo systemctl, mandatory. See header note (3).
    if (releaseEnvFile !== undefined) {
      push(
        'if [[ "${SAMOHOST_RELEASE_MODEL:-0}" != 1 ]]; then samohost_write_release_env; fi',
        "",
      );
    }
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
        // The URL is split into PG* variables so that the password is not a
        // process argument (visible in ps). Probe returns 'f' for non-superuser.
        "# The address is passed to psql in PG* variables, not as an argument (ps shows",
        "# arguments). Only postgresql://user:password@host[:port]/db URLs are accepted.",
        "rls_result=CONNECTION_FAILED",
        'if [[ "$RLS_URL" =~ ^postgres(ql)?://([^:@/?#]+)(:([^@/?#]*))?@([^:@/?#]+)(:([0-9]+))?/([^?#]+) ]]; then',
        '  rls_pw="$(printf \'%b\' "${BASH_REMATCH[4]//%/\\x}")"',
        '  rls_result=$(PGHOST="${BASH_REMATCH[5]}" PGPORT="${BASH_REMATCH[7]:-5432}" PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="$rls_pw" PGDATABASE="${BASH_REMATCH[8]}" psql -X -w -tAc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user" 2>&1 || echo CONNECTION_FAILED)',
        "  unset rls_pw",
        "else",
        '  echo "assert-rls: the database address is not a postgresql://user:password@host/db URL" >&2',
        "fi",
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
        splitLayout !== undefined
          ? `if (if [[ "$SAMOHOST_RELEASE_MODEL" == 1 ]]; then sudo "$SAMOHOST_STEP" seed </dev/null; else (if [[ -f "$SAMOHOST_MIGRATE_ENV_FILE" ]]; then set -a; . "$SAMOHOST_MIGRATE_ENV_FILE"; set +a; export ${splitLayout.dbVars.join(" ")}; fi && cd "$SAMOHOST_APP_DIR" && ${app.seedCmd}); fi); then`
          : `if (cd "$SAMOHOST_APP_DIR" && ${app.seedCmd}); then`,
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
