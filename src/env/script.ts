/**
 * Pure script builders for preview environments (SPEC-DELTA §4).
 *
 * Like `app/script.ts`, every builder returns one self-contained bash program
 * meant for `bash -s` over ONE pinned SSH connection, emitting the same
 * `<<<SAMOHOST_PHASE:...>>>` markers so callers can parse progress. All
 * builders are PURE: no I/O, deterministic, snapshot-stable.
 *
 * Secret handling (the load-bearing design decision): samohost NEVER sees env
 * values. The create script composes the env file ON THE HOST from an
 * operator-managed template (`/opt/<app>/envs.template.env`), appends the
 * per-env PORT, and — per-env database wiring, issue #11 — rewrites the
 * db-name path component of every env var listed in the app's `envDbVars`
 * (default `["DATABASE_URL"]`) so it points at the per-env database while
 * keeping scheme/user/password/host/port/query untouched. For the template
 * backend the env keeps the SAME database roles as production (no per-env
 * role): template-copied grants and RLS policies apply unchanged. Nothing
 * secret transits samohost's stdout parsing: the script never echoes the env
 * file or any URL value.
 *
 * Privilege model: the hardened host has `Defaults use_pty` + exact-path
 * NOPASSWD grants, so every privileged line is a full-path `sudo /usr/bin/...`
 * (never bare `sudo systemctl` — issue #99). The one-time grants and the
 * systemd template unit are NOT applied by these scripts: `buildHostPrepScript`
 * renders them for an operator with root to review and apply once per (vm,app).
 */

import type { AppRecord, EnvDbBackend, EnvRecord } from "../types.ts";
import { staticCacheHeaderLines } from "../static-cache.ts";
import { servicesOf } from "../app/services.ts";
import { assertOptionalLinuxAppUser } from "../app/linux-user.ts";
import {
  staticReleaseStatePaths,
  staticRootOf,
  staticTreeGuardFnLines,
} from "../app/static-root.ts";
import { planFromEnv, renderVhost } from "../caddy/render.ts";

/** Same marker prefix as deploy scripts — one parser convention everywhere. */
export const ENV_PHASE_PREFIX = "<<<SAMOHOST_PHASE:";

/** Env-create phases, in order. Destroy uses the destroy phases. */
export type EnvPhaseName =
  | "port-check"
  | "clone"
  | "install"
  | "build"
  | "db-preflight"
  | "db"
  | "envfile"
  | "secrets-preflight"
  | "secrets"
  | "migrate"
  | "unit"
  | "vhost"
  | "health"
  | "unit-stop"
  | "vhost-remove"
  | "db-drop"
  | "dir-remove";

const HEALTH_RETRIES = 10;
const HEALTH_SLEEP_SEC = 3;

/** Default DB var mapping when the app declares none (issue #11). */
export const DEFAULT_ENV_DB_VARS: readonly string[] = ["DATABASE_URL"];

/**
 * Default DBLab clone lease: 20160 minutes = 14 days.
 *
 * Passed as `--protected <minutes>` to `dblab clone create` so the engine
 * never auto-expires a clone underneath a running preview env.  Without this
 * flag the engine applies its own `maxIdleMinutes` (which operators sometimes
 * set as low as 45 min), causing the preview app to lose its database mid-life
 * and return Internal Server Error.  14 days exceeds the samohost idle-reap
 * threshold (also 14 days) so samohost always destroys the whole env before
 * the clone can auto-expire at the engine.
 *
 * Override at script-generation time via SAMOHOST_DBLAB_LEASE_MINUTES env var.
 */
export const DBLAB_LEASE_DEFAULT_MINUTES = 20160; // 14 days

/**
 * Read the DBLab clone lease in minutes from SAMOHOST_DBLAB_LEASE_MINUTES,
 * falling back to DBLAB_LEASE_DEFAULT_MINUTES (20160 = 14 days).
 * Value is resolved at script-generation time and baked into the generated
 * bash script (the script is pushed over SSH — no process.env on the host).
 */
export function readDblabLeaseMinutes(): number {
  const raw = process.env["SAMOHOST_DBLAB_LEASE_MINUTES"];
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DBLAB_LEASE_DEFAULT_MINUTES;
}

/**
 * Bash helper: read /proc/<pid>/cgroup for a given PID. Extracted as a named
 * function so tests can stub it without real /proc access.
 *
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
const READ_CGROUP_FN_LINES: string[] = [
  "samohost_read_cgroup_for_pid() {",
  '  cat "/proc/$1/cgroup" 2>/dev/null || true',
  "}",
];

/**
 * Bash function: check whether the allocated port is free for this env.
 * Returns 0 (ok — proceed) when:
 *   a) nothing is listening on the port at all, OR
 *   b) the port is held by OUR own active unit (fast path — idempotent
 *      re-create of an already-running env), OR
 *   c) the port is held by ANY process whose cgroup contains the env-name
 *      suffix `@<envName>.service` — this covers:
 *        • a FAILED same-env unit (systemctl is-active → 1) that systemd is
 *          about to restart, or
 *        • a SIBLING service of the same multi-service env that happens to
 *          hold the port (e.g. all listeners share the same port value due
 *          to a port-allocation regression — Bug A on samograph 2026-07-16).
 *      In both cases the port belongs to OUR env; deleting the Caddy vhost
 *      is the wrong action.
 * Returns non-zero (fail — abort) when a FOREIGN process holds the port.
 *
 * Detection uses `ss -ltnH` (no sudo on Ubuntu). Ownership signal:
 *   1. `systemctl is-active "$unit"` returning active (fast path).
 *   2. For each PID listening on the port: `/proc/<pid>/cgroup` contains
 *      `@<envName>.service` (cgroup path written by systemd for every
 *      process spawned by a unit — readable without sudo).
 * A truly foreign process would have none of our env's unit names in its
 * cgroup path.
 *
 * Parameters:
 *   $1 — port number
 *   $2 — primary unit instance (e.g. "samograph-live@env.service")
 *   $3 — env name (e.g. "samograph-env-name"); used for cgroup matching
 *
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
const PORT_CHECK_FN_LINES: string[] = [
  "samohost_port_check_ok() {",
  '  local port="$1" unit="$2" env_name="${3:-}"',
  "  # Match every local-address form ss prints for a listener on this port:",
  "  #   IPv4 wildcard/loopback: 0.0.0.0:PORT, 127.0.0.1:PORT",
  "  #   IPv6 wildcard/loopback: [::]:PORT, [::1]:PORT, and the bare *:PORT form.",
  "  # An IPv6-only squatter would otherwise be a false negative (port-check",
  "  # passes, then the unit dies with EADDRINUSE) — the exact silent-serve class",
  "  # this phase exists to stop. The address column ends at the port, anchored on",
  "  # trailing whitespace.",
  '  if ! ss -ltnH 2>/dev/null | grep -qE "(0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|\\[::1\\]|\\*):${port}[[:space:]]"; then',
  "    # Nothing listening on this port — free to proceed.",
  "    return 0",
  "  fi",
  "  # Fast path: port held by our own ACTIVE unit — idempotent re-create, allow.",
  '  if systemctl is-active "$unit" >/dev/null 2>&1; then',
  "    return 0",
  "  fi",
  "  # Cgroup fallback: port may be held by a sibling unit of the same env (e.g.",
  "  # a multi-service app where all listeners share one port value) or by this",
  "  # exact unit in FAILED/activating state. Check every PID listening on the",
  "  # port; if any has a cgroup containing @<envName>.service, it is ours.",
  "  #",
  "  # PID extraction uses `grep -oP 'pid=\\K[0-9]+'` (GNU grep, always present",
  "  # on Ubuntu). The 3-argument match() form used previously is a gawk extension",
  "  # that silently fails on mawk (Ubuntu default awk alternative) — the PIDs",
  "  # would never be extracted, the cgroup check skipped, and the function would",
  "  # fall through to return 1 (foreign squatter), reproducing the exact bug this",
  "  # fix is meant to prevent. grep -oP has no such portability issue.",
  '  if [[ -n "$env_name" ]]; then',
  "    local pid",
  '    while IFS= read -r pid; do',
  '      [[ -z "$pid" ]] && continue',
  '      local cgroup',
  '      cgroup=$(samohost_read_cgroup_for_pid "$pid")',
  '      if echo "$cgroup" | grep -qF "@${env_name}.service"; then',
  "        # Port held by a process from our own env — treat as ours.",
  "        return 0",
  "      fi",
  "    done < <(",
  "      ss -tlnHp 2>/dev/null |",
  "      grep -F \":${port} \" |",
  "      grep -oP 'pid=\\K[0-9]+'",
  "    )",
  "  fi",
  "  # Foreign process holds the port — fail CLOSED.",
  "  return 1",
  "}",
];

/**
 * Build the bash function `samohost_clone_env_dir` — two-strategy branch
 * checkout (issue #11 finding 5). A `git clone --reference` off the
 * production checkout is cheap, but git rejects SHALLOW (or otherwise
 * unusable) reference repos; explicit fallback to a plain clone of the same
 * origin URL, with a message NAMING which strategy failed and why.
 *
 * Issue #97 fix: when `appUser` is supplied all git operations run as that
 * user via `sudo -u <appUser> GIT_CONFIG_GLOBAL=<gitSafeConf> /usr/bin/git`
 * instead of plain `git` (the SSH user). Two failure modes prevented:
 *   1. `fatal: detected dubious ownership in repository` — git ≥ 2.35.2
 *      rejects a checkout whose directory owner differs from the calling
 *      process user; running as the owner avoids this.
 *   2. The 600 `.gh-token` is unreadable by the SSH user; running as appUser
 *      (which bootstrap wrote the token for) enables the credential helper.
 * The credential helper embeds the token file path as a LITERAL string (not
 * `$TOKEN_FILE`) so it is available in the credential helper subprocess even
 * without an exported variable.
 *
 * When `appUser` is absent: backward-compatible plain-`git` behavior (for
 * AppRecords that predate the appUser field).
 *
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
function buildCloneFnLines(
  appUser?: string,
  tokenFile?: string,
): string[] {
  // Issue #163: the runner now SSHes AS appUser (when set), so git already runs
  // as the dir owner — no sudo-u delegation needed. Use plain git in all cases.
  // (The prior 'sudo -u appUser GIT_CONFIG_GLOBAL=... /usr/bin/git' form relied
  // on a NOPASSWD grant that is not present on hardened VMs.)
  const gitCmd = "git";

  // Inline credential helper: embeds the token file path as a LITERAL so
  // the helper subprocess can read it without $TOKEN_FILE in scope (proven
  // bootstrap.ts §12 / samorev #83 pattern). Only emitted when appUser is
  // set — without an appUser the old path had no token handling either.
  const credHelper = appUser !== undefined && tokenFile !== undefined
    ? ` -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$(cat ${tokenFile})"; }; f'`
    : "";

  return [
    "samohost_clone_env_dir() {",
    "  local origin_url",
    `  origin_url="$(${gitCmd} -C "$SAMOHOST_APP_DIR" remote get-url origin)" || {`,
    '    echo "samohost: cannot read the origin URL from $SAMOHOST_APP_DIR" >&2',
    "    return 1",
    "  }",
    '  if [[ -d "$SAMOHOST_ENV_DIR/.git" ]]; then',
    // Issue #98 follow-up: the fetch path must also carry the credential helper
    // so that private-repo re-fetches authenticate. The clone strategies already
    // carry credHelper; the fetch path was the odd one out (samorev finding).
    `    ${gitCmd}${credHelper} -C "$SAMOHOST_ENV_DIR" fetch origin "$SAMOHOST_BRANCH" \\`,
    `      && ${gitCmd} -C "$SAMOHOST_ENV_DIR" checkout -fB "$SAMOHOST_BRANCH" "origin/$SAMOHOST_BRANCH"`,
    "    return",
    "  fi",
    `  if ${gitCmd}${credHelper} clone --reference "$SAMOHOST_APP_DIR" --dissociate \\`,
    '       --branch "$SAMOHOST_BRANCH" --single-branch \\',
    '       "$origin_url" "$SAMOHOST_ENV_DIR"; then',
    "    return 0",
    "  fi",
    '  echo "samohost: strategy 1 (git clone --reference $SAMOHOST_APP_DIR) failed — the production checkout is unusable as a clone reference (e.g. a shallow checkout); falling back to a plain clone of $origin_url" >&2',
    '  rm -rf "$SAMOHOST_ENV_DIR"',
    `  if ${gitCmd}${credHelper} clone --branch "$SAMOHOST_BRANCH" --single-branch \\`,
    '       "$origin_url" "$SAMOHOST_ENV_DIR"; then',
    "    return 0",
    "  fi",
    '  echo "samohost: strategy 2 (plain git clone of $origin_url, branch $SAMOHOST_BRANCH) ALSO failed — clone phase cannot proceed" >&2',
    "  return 1",
    "}",
  ];
}

/**
 * Bash function: rewire each mapped DB env var (issue #11 findings 1+2+3)
 * inside the composed .env so its URL points at the per-env database. A
 * faithful operator template otherwise wires previews straight into the
 * PRODUCTION database (proven at runtime in the issue's sandbox evidence).
 * All parsing happens ON THE HOST; values are never echoed. Handled URL
 * shape: `scheme://user:pass@host[:port]/dbname[?params]` (port and params
 * optional; value optionally double-quoted). ONLY the db-name path component
 * changes. Original lines are STRIPPED (not just overridden): systemd
 * EnvironmentFile is last-wins, but dotenv loaders are app-dependent, so
 * append-only composition is unsafe. (Closing brace at column 0 — tests
 * extract and execute this function against prod-shaped fixtures.)
 */
const REWIRE_DB_VARS_FN_LINES: string[] = [
  "samohost_rewire_db_vars() {",
  '  local envfile="$1" var line val rewritten',
  '  for var in "${SAMOHOST_ENV_DB_VARS[@]}"; do',
  '    line="$(grep -E "^${var}=" "$envfile" | tail -n 1 || true)"',
  '    if [[ -z "$line" ]]; then',
  "      echo \"samohost: env template is missing ${var} (declared in the app's envDbVars) — refusing to compose an env that could inherit the production database\" >&2",
  "      return 1",
  "    fi",
  '    val="${line#*=}"',
  "    if ! printf '%s' \"$val\" | grep -Eq '^\"?[A-Za-z0-9+]+://[^/]+/'; then",
  '      echo "samohost: ${var} in the env template is not a URL with a database path component — cannot rewire it to the per-env database" >&2',
  "      return 1",
  "    fi",
  "    rewritten=\"$(printf '%s' \"$val\" | sed -E 's|^(\"?[A-Za-z0-9+]+://[^/]+/)[^?\"]*|\\1'\"$SAMOHOST_DB_NAME\"'|')\"",
  '    grep -vE "^${var}=" "$envfile" > "${envfile}.rewired" || true',
  "    printf '%s=%s\\n' \"$var\" \"$rewritten\" >> \"${envfile}.rewired\"",
  '    mv "${envfile}.rewired" "$envfile"',
  '    chmod 600 "$envfile"',
  "  done",
  "}",
];

/**
 * Bash lines: resolve the dblab CLI into SAMOHOST_DBLAB_BIN (issue #7). The
 * runbook installs the client to ~agent/bin/dblab, which is NOT on PATH in
 * non-login shells (`bash -s` over ssh) — so PATH first, then $HOME/bin.
 * Every later dblab call goes through "$SAMOHOST_DBLAB_BIN".
 */
const DBLAB_BIN_RESOLVE_LINES: string[] = [
  "# Resolve the dblab CLI: PATH first, then ~/bin (runbook install location).",
  'SAMOHOST_DBLAB_BIN="$(command -v dblab || true)"',
  'if [[ -z "$SAMOHOST_DBLAB_BIN" && -x "$HOME/bin/dblab" ]]; then',
  '  SAMOHOST_DBLAB_BIN="$HOME/bin/dblab"',
  "fi",
];

/**
 * Bash function: extract the clone's host port from `dblab clone status`
 * JSON (issue #7). Runtime-verified against DBLab v4.1.3: the port is a
 * STRING nested at `.db.port` (see test/fixtures/dblab-clone-status.json,
 * captured from the live engine) — NOT a top-level `"port"` number, which is
 * what the previous sed looked for. python3 (ubiquitous on Ubuntu hosts) does
 * the honest JSON parse; the fallback sed is anchored to the `"db"` object so
 * it cannot match ports in other objects. No jq: not guaranteed on hosts.
 * (Closing brace at column 0 — tests extract and execute this function
 * against the captured prod-shaped fixture.)
 */
const CLONE_PORT_FN_LINES: string[] = [
  "samohost_clone_port() {",
  "  local status_json",
  '  status_json="$("$SAMOHOST_DBLAB_BIN" clone status "$SAMOHOST_CLONE_ID" 2>/dev/null)" || return 1',
  "  if command -v python3 >/dev/null; then",
  "    printf '%s' \"$status_json\" \\",
  "      | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"db\"][\"port\"])'",
  "  else",
  "    printf '%s' \"$status_json\" | tr -d '\\n' \\",
  '      | sed -n \'s/.*"db"[[:space:]]*:[[:space:]]*{[^}]*"port"[[:space:]]*:[[:space:]]*"\\{0,1\\}\\([0-9][0-9]*\\)"\\{0,1\\}.*/\\1/p\'',
  "  fi",
  "}",
];

/**
 * Bash function: rewire each mapped DB env var (the PR #12 TODO, closed by
 * issue #7) inside the composed .env so its URL points at the DBLab clone.
 * Unlike the template backend (which rewrites the DB NAME), the clone is a
 * full Postgres instance on its own port holding prod's database under the
 * SAME name — and the db phase's globals sync (above) guarantees prod's
 * roles/password-hashes/grants/policies exist inside it. So ONLY host:port
 * is rewritten (to 127.0.0.1:$SAMOHOST_DB_PORT, the engine's
 * cloneAccessAddresses + port pool); scheme/user/password/dbname/query carry
 * over from the operator template, preserving the prod URL contract
 * (e.g. "DATABASE_URL bypasses RLS, APP_DATABASE_URL is the app role").
 * Same strip-then-append composition and hard-fail rules as the template
 * rewire. (Closing brace at column 0 — tests extract and execute it.)
 */
const REWIRE_DB_HOSTPORT_FN_LINES: string[] = [
  "samohost_rewire_db_hostport() {",
  '  local envfile="$1" var line val rewritten',
  '  for var in "${SAMOHOST_ENV_DB_VARS[@]}"; do',
  '    line="$(grep -E "^${var}=" "$envfile" | tail -n 1 || true)"',
  '    if [[ -z "$line" ]]; then',
  "      echo \"samohost: env template is missing ${var} (declared in the app's envDbVars) — refusing to compose an env that could inherit the production database\" >&2",
  "      return 1",
  "    fi",
  '    val="${line#*=}"',
  "    if ! printf '%s' \"$val\" | grep -Eq '^\"?[A-Za-z0-9+]+://[^/]+/'; then",
  '      echo "samohost: ${var} in the env template is not a URL with a host component — cannot rewire it to the DBLab clone" >&2',
  "      return 1",
  "    fi",
  "    rewritten=\"$(printf '%s' \"$val\" | sed -E 's|^(\"?[A-Za-z0-9+]+://)([^/]*@)?[^/?\"]*|\\1\\2127.0.0.1:'\"$SAMOHOST_DB_PORT\"'|')\"",
  // UMASK FIX: pre-create the temp file at 0600 with install before the bare `>`
  // redirect fills it. A bare `>` creates the file at umask permissions (typically
  // 0644 on stock Ubuntu), briefly exposing all env secrets as world-readable.
  // `install -m 600 /dev/null` creates the file at exactly 0600 before any content
  // is written — the same pattern used for .env.baseurl in the envfile phase.
  '    install -m 600 /dev/null "${envfile}.rewired"',
  '    grep -vE "^${var}=" "$envfile" > "${envfile}.rewired" || true',
  "    printf '%s=%s\\n' \"$var\" \"$rewritten\" >> \"${envfile}.rewired\"",
  '    mv "${envfile}.rewired" "$envfile"',
  '    chmod 600 "$envfile"',
  "  done",
  "}",
];

/**
 * Bash function: set a password on the clone's app role using the privileged
 * clone role (samohost_env). Called from the db phase &&-chain AFTER
 * samohost_sync_clone_globals (so the app role already exists in the clone).
 *
 * Security model — TWO vectors closed (samorev blocker, PR #142):
 *
 * 1. ARGV VECTOR: The prior implementation passed the SQL via `-c "ALTER ROLE
 *    ... PASSWORD '$PW'"`, exposing the plaintext password in the psql process
 *    argv (/proc/<pid>/cmdline, `ps aux`) for the lifetime of the process.
 *    Fix: SQL is fed via STDIN (`-f -`), so the psql argv contains only
 *    connection flags — the secret is never on the command line.
 *
 * 2. SERVER-LOG VECTOR: When log_statement=ddl/all is set in postgresql.conf
 *    the server logs every DDL statement including ALTER ROLE … PASSWORD,
 *    storing the plaintext password in the pg log. Fix: `SET log_statement TO
 *    'none'` and `SET log_min_duration_statement TO -1` are prepended in the
 *    SAME session stdin batch before the ALTER ROLE, so the privileged session
 *    never logs the secret-bearing statement.
 *    Additionally, `SET log_min_error_statement TO 'panic'` prevents the server
 *    from logging the failing statement text (which may carry the password) if
 *    the ALTER ROLE itself raises an error (e.g., role does not yet exist).
 *    Approach rationale: client-side SCRAM verifier computation would also close
 *    this vector (server never sees the plaintext), but SCRAM-SHA-256 verifier
 *    generation is not reliably available in pure bash on target hosts without
 *    additional tooling. Session-local SET is deterministic on all Postgres
 *    versions ≥ 9.6 and requires no extra packages.
 *
 * Other invariants (unchanged):
 *   - Password is generated once per env via samohost-secrets 'init' (reuse
 *     semantics), so clone RESETS re-apply the SAME password → DATABASE_URL
 *     stays stable across rebuilds.
 *   - Password is read back via 'get' action (root helper, no file-read grant
 *     needed for the SSH user).
 *   - >/dev/null suppresses psql rowcount/notice output only; it does NOT
 *     protect from the argv vector — that is the job of -f - above.
 *
 * Hardening (retro-gate 77358aa):
 *   - [[ -n "$SAMOHOST_CLONE_APP_DBROLE" ]] guard before all SQL work: fails
 *     loud (non-zero + marker message) if the extraction pipeline produced an
 *     empty role, preventing a silent ALTER ROLE with an empty name.
 *   - -v ON_ERROR_STOP=1 on psql: SQL errors cause psql to exit non-zero so
 *     the db phase fails instead of silently proceeding with an unset password.
 */
const SET_CLONE_ROLE_PASSWORD_FN_LINES: string[] = [
  "samohost_set_clone_role_password() {",
  "  # GUARD: fail loud if DBROLE is empty (extraction pipeline produced no output,",
  "  # e.g. because the template URL has no user component, or a future sed regression).",
  "  # Catching this here surfaces the configuration error before any psql call and",
  "  # prevents a silent password-set failure on an empty role name.",
  "  [[ -n \"$SAMOHOST_CLONE_APP_DBROLE\" ]] || {",
  "    echo \"samohost: SAMOHOST_CLONE_APP_DBROLE is empty — the databaseUrlEnv URL in the operator template has no user component; cannot set clone-role password\" >&2",
  "    return 1",
  "  }",
  "  # Init the clone-role password (reuse-or-generate; 'init' preserves the existing",
  "  # value so a clone RESET re-applies the SAME password → DATABASE_URL stays stable).",
  "  sudo /usr/local/sbin/samohost-secrets init \"$SAMOHOST_ENV_NAME\" \"$SAMOHOST_SECRETS_ENV_USER\" SAMOHOST_CLONE_ROLE_PW",
  "  SAMOHOST_CLONE_ROLE_PW=\"$(sudo /usr/local/sbin/samohost-secrets get \"$SAMOHOST_ENV_NAME\" SAMOHOST_CLONE_ROLE_PW)\"",
  "  # Apply the password to the clone's app role via the privileged clone role (samohost_env).",
  "  # ARGV FIX: SQL is fed via STDIN (-f -), never via -c, so the secret is absent",
  "  #   from /proc/<pid>/cmdline and 'ps aux' for the lifetime of the psql process.",
  "  # SERVER-LOG FIX: SET log_statement/log_min_duration_statement suppress DDL",
  "  #   logging in this session BEFORE the ALTER ROLE, so the plaintext password",
  "  #   never reaches the pg server log even when log_statement=ddl/all is set.",
  "  #   SET log_min_error_statement TO 'panic' additionally prevents the failing",
  "  #   statement text (which may include the password) from being written to the",
  "  #   pg server log when an error occurs in this session (e.g., role not found).",
  "  # -v ON_ERROR_STOP=1: SQL errors cause psql to exit non-zero so the caller",
  "  #   knows ALTER ROLE failed and does not silently proceed with an unset password.",
  "  # >/dev/null suppresses psql rowcount/notice output only (NOT the argv-leak",
  "  #   protection — that comes from -f - above; >/dev/null alone does not close",
  "  #   the /proc/<pid>/cmdline surface).",
  "  printf \"SET log_statement TO 'none';\\nSET log_min_duration_statement TO -1;\\nSET log_min_error_statement TO 'panic';\\nALTER ROLE %s WITH LOGIN PASSWORD '%s';\\n\" \\",
  "    \"$SAMOHOST_CLONE_APP_DBROLE\" \"$SAMOHOST_CLONE_ROLE_PW\" \\",
  "    | PGPASSWORD=\"$SAMOHOST_DB_PASSWORD\" /usr/bin/psql -h 127.0.0.1 -p \"$SAMOHOST_DB_PORT\" \\",
  "        -U samohost_env -d postgres -X -v ON_ERROR_STOP=1 -f - >/dev/null",
  "}",
];

/**
 * Bash function: rewrite the credentialed DATABASE_URL (the specific var named
 * by manifest `databaseUrlEnv`) to include the clone-role password. Called in
 * the envfile phase AFTER samohost_rewire_db_hostport has already rewritten
 * host:port.
 *
 * Placed AFTER the db phase in the generated script so the first occurrence
 * of the function name is post-db:ok (ordering test invariant).
 *
 * Uses strip-then-append composition (same pattern as rewire_db_hostport) to
 * prevent duplicate env var entries. Output is suppressed (no stdout).
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
const REWIRE_DB_CREDENTIALED_FN_LINES: string[] = [
  "samohost_rewire_db_credentialed() {",
  "  local envfile=\"$1\"",
  "  # No-op when credential rewire is not configured (no databaseUrlEnv on the app).",
  "  [[ -n \"${SAMOHOST_CLONE_CRED_VAR:-}\" ]] || return 0",
  "  local var=\"$SAMOHOST_CLONE_CRED_VAR\"",
  "  local line val scheme dbpath rewritten",
  "  line=\"$(grep -E \"^${var}=\" \"$envfile\" | tail -n 1 || true)\"",
  "  if [[ -z \"$line\" ]]; then",
  "    echo \"samohost: envfile is missing ${var} (declared as databaseUrlEnv) — cannot rewrite credentialed URL\" >&2",
  "    return 1",
  "  fi",
  "  val=\"${line#*=}\"",
  "  # Extract scheme component (e.g. 'postgresql://'), stripping optional leading quote.",
  "  scheme=\"$(printf '%s' \"$val\" | sed -nE 's|^(\"?[A-Za-z0-9+]+://).*|\\1|p')\"",
  "  scheme=\"${scheme#\\\"}\"",
  "  # Extract DB path: /dbname[?params] — everything after the host:port component.",
  "  dbpath=\"$(printf '%s' \"$val\" | sed -nE 's|^\"?[A-Za-z0-9+]+://[^/]*(/[^\"]*)$|\\1|p')\"",
  "  # Build the credentialed URL: scheme + role:password@127.0.0.1:port + /dbname.",
  "  rewritten=\"${scheme}${SAMOHOST_CLONE_APP_DBROLE}:${SAMOHOST_CLONE_ROLE_PW}@127.0.0.1:${SAMOHOST_DB_PORT}${dbpath}\"",
  "  # Strip-then-append prevents duplicate entries (same pattern as rewire_db_hostport).",
  // UMASK FIX: pre-create the temp file at 0600 with install before the bare `>`
  // redirect fills it. A bare `>` creates the file at umask permissions (typically
  // 0644 on stock Ubuntu), briefly exposing the credentialed URL as world-readable.
  "  install -m 600 /dev/null \"${envfile}.credrew\"",
  "  grep -vE \"^${var}=\" \"$envfile\" > \"${envfile}.credrew\" || true",
  "  printf '%s=%s\\n' \"$var\" \"$rewritten\" >> \"${envfile}.credrew\"",
  "  mv \"${envfile}.credrew\" \"$envfile\"",
  "  chmod 600 \"$envfile\"",
  "}",
];

/**
 * Bash function: print the role component of every mapped envDbVars URL in
 * the operator template, one per line (PR #22 review finding 2). These are,
 * by definition, the roles the app signs in as — the seed of the scoped
 * app-role set the clone role replay is limited to. Values are parsed
 * ON THE HOST and only the ROLE NAME (never password/host/db) is printed.
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
const APP_URL_ROLES_FN_LINES: string[] = [
  "samohost_app_url_roles() {",
  "  local var line",
  '  for var in "${SAMOHOST_ENV_DB_VARS[@]}"; do',
  '    line="$(grep -E "^${var}=" "$SAMOHOST_ENV_TEMPLATE" | tail -n 1)"',
  '    [[ -n "$line" ]] || continue',
  "    printf '%s\\n' \"${line#*=}\" \\",
  "      | sed -nE 's|^\"?[A-Za-z0-9+]+://([^:/@?\"]+)(:[^@/]*)?@.*|\\1|p'",
  "  done",
  "}",
];

/**
 * Bash function: turn prod pg_authid rows (`rolname|rolcanlogin|rolpassword`,
 * the exact `psql -At` shape, dry-run-verified on prod 2026-06-12) into role
 * DDL for the clone — but ONLY for roles listed in the scoped app-role file
 * ($1), and ALWAYS stripped of every cluster superpower (PR #22 review
 * finding 2: the old replay copied prod's SUPERUSER/BYPASSRLS/CREATEROLE
 * bits into the preview clone for every non-builtin role — a privilege
 * escalation surface). A preview app role needs LOGIN + its grants + its
 * RLS-subject status, never cluster superpowers; prod's table-OWNER role
 * keeps owner-bypass RLS semantics without BYPASSRLS. Password hashes are
 * kept (sign-in with prod credentials must work) for the scoped roles only;
 * they flow stdin->stdout only and are never echoed in messages. The
 * CREATE-then-ALTER split makes the strip authoritative even on engines
 * whose retrieval already carried the role (CREATE fails as a duplicate,
 * ALTER still applies). (Closing brace at column 0 — tests execute this.)
 */
const EMIT_SCOPED_ROLE_SQL_FN_LINES: string[] = [
  "samohost_emit_scoped_role_sql() {",
  '  local scoped_file="$1" rolname canlogin hash login',
  "  while IFS='|' read -r rolname canlogin hash; do",
  '    [[ -n "$rolname" ]] || continue',
  '    grep -qxF "$rolname" "$scoped_file" || continue',
  '    if ! [[ "$rolname" =~ ^[a-z_][a-z0-9_]*$ ]]; then',
  '      echo "samohost: clone role replay: skipping a role whose name is not a plain identifier" >&2',
  "      continue",
  "    fi",
  "    if [[ \"$hash\" == *\"'\"* || \"$hash\" == *\"\\\\\"* ]]; then",
  '      echo "samohost: clone role replay: skipping role ${rolname} — its hash contains quoting metacharacters" >&2',
  "      continue",
  "    fi",
  '    if [[ "$canlogin" == "t" ]]; then login=" LOGIN"; else login=" NOLOGIN"; fi',
  "    printf 'CREATE ROLE \"%s\";\\n' \"$rolname\"",
  '    if [[ -n "$hash" ]]; then',
  "      printf 'ALTER ROLE \"%s\" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION%s PASSWORD \\047%s\\047;\\n' \"$rolname\" \"$login\" \"$hash\"",
  "    else",
  "      printf 'ALTER ROLE \"%s\" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION%s;\\n' \"$rolname\" \"$login\"",
  "    fi",
  "  done",
  "}",
];

/**
 * Bash function: numeric parity gate between prod and the clone for one
 * counting query (PR #22 review finding 1). FAILS CLOSED: both counts must
 * capture successfully AND be numeric before any comparison happens — the
 * old inline gate let an empty prod count degrade `clone -ge ""` into
 * `-ge 0`, serving a clone with missing RLS (the exact #11 bypass class the
 * gate exists to stop). Count reads suppress stderr (psql error text can
 * quote SQL); the failure message reports only validated numerics, never
 * raw query output. (Closing brace at column 0 — tests execute this.)
 */
const PARITY_CHECK_FN_LINES: string[] = [
  "samohost_parity_check() {",
  '  local what="$1" sql="$2" prod clone',
  '  prod="$(sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "$sql" 2>/dev/null)" || prod=""',
  '  if ! [[ "$prod" =~ ^[0-9]+$ ]]; then',
  '    echo "samohost: clone globals parity gate (${what}): could not read a numeric PRODUCTION count — failing CLOSED (an unverifiable clone is never served)" >&2',
  "    return 1",
  "  fi",
  '  clone="$(PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -At -c "$sql" 2>/dev/null)" || clone=""',
  '  if ! [[ "$clone" =~ ^[0-9]+$ ]]; then',
  '    echo "samohost: clone globals parity gate (${what}): could not read a numeric CLONE count — failing CLOSED" >&2',
  "    return 1",
  "  fi",
  '  if [[ "$prod" -gt 0 && "$clone" -eq 0 ]] || [[ "$clone" -lt "$prod" ]]; then',
  '    echo "samohost: clone globals parity gate (${what}) FAILED (prod=${prod}, clone=${clone}) — the clone would not honor the app\'s RLS/credentials contract" >&2',
  "    return 1",
  "  fi",
  "  return 0",
  "}",
];

/**
 * Bash function: replay prod's cluster globals into the clone (issue #7,
 * live-verified gap). The engine's LOGICAL retrieval mode (pg_dump/pg_restore
 * of the database only) does NOT carry cluster globals: a fresh clone held
 * prod's tables but none of its roles — and because grant/policy DDL inside
 * the dump references those roles, the restore silently dropped ALL grants
 * and ALL RLS policies too. Rewiring envDbVars at a clone in that state hands
 * the app a database its own credentials cannot use.
 *
 * Post-review (PR #22) shape:
 *   0. Derive prod_db from envDbVars[0] and VALIDATE it (finding 4); a
 *      mis-parse can capture credentials, so the derived value is never
 *      echoed. Then derive the SCOPED app-role set: envDbVars URL roles +
 *      every grantee/owner referenced by the grant/policy replay (computed
 *      from the prod catalogs; dry-run-verified read-only on prod).
 *   1. Roles: scoped to that set, every cluster superpower stripped, hashes
 *      kept (finding 2) — host-side only, both psql ends silenced.
 *   2./3. Table ownership + grants: idempotent DDL applied under
 *      ON_ERROR_STOP; failures are COUNTED via exit codes (never echoed —
 *      error text can quote DDL) and fail the phase (finding 3).
 *   4. RLS policies: duplicates fail on engines whose retrieval carries
 *      policies, so errors stay ignored — the parity gate is the authority.
 *   5./6. Fail-closed gates: apply-failure count, then policy/grant/ownership
 *      parity via samohost_parity_check (finding 1).
 * (Closing brace at column 0 — tests extract this function.)
 */
const SYNC_CLONE_GLOBALS_FN_LINES: string[] = [
  "samohost_sync_clone_globals() {",
  "  local prod_db scoped_roles apply_failures=0",
  "  # The production database the operator template points at (path component",
  "  # of the first mapped var) — the same database name exists in the clone.",
  '  prod_db="$(grep -E "^${SAMOHOST_ENV_DB_VARS[0]}=" "$SAMOHOST_ENV_TEMPLATE" | tail -n 1 \\',
  "    | sed -nE 's|^[^=]*=\"?[A-Za-z0-9+]+://[^/]+/([^?\"]*).*|\\1|p')\"",
  '  if ! [[ "$prod_db" =~ ^[A-Za-z0-9_][A-Za-z0-9_-]*$ ]]; then',
  '    echo "samohost: cannot derive a valid production database name from ${SAMOHOST_ENV_DB_VARS[0]} in the env template (no plain database path component; the derived value is never echoed because a mis-parse can capture credentials) — refusing the globals sync" >&2',
  "    return 1",
  "  fi",
  "  # 0. The app-role set this env actually needs: the role components of the",
  "  #    mapped envDbVars URLs plus every grantee/owner the grant+policy",
  "  #    replay below references. Anything else (ops/CI/dump roles, prod",
  "  #    superusers) stays OUT of the preview clone.",
  '  scoped_roles="$(mktemp)"',
  "  {",
  "    samohost_app_url_roles",
  '    sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT DISTINCT r FROM (SELECT unnest(roles)::text AS r FROM pg_policies UNION SELECT grantee FROM information_schema.table_privileges WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\') UNION SELECT tableowner FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')) s" 2>/dev/null',
  "  } | grep -E '^[a-z_][a-z0-9_]*$' | grep -vE '^(postgres|public)$' | grep -v '^pg_' | sort -u > \"$scoped_roles\"",
  '  if ! [[ -s "$scoped_roles" ]]; then',
  '    rm -f "$scoped_roles"',
  '    echo "samohost: clone role replay derived an EMPTY app-role set (envDbVars URL roles + grant/policy grantees) — failing CLOSED" >&2',
  "    return 1",
  "  fi",
  "  # 1. Roles: hashes replayed for the SCOPED app roles only, superpowers",
  "  #    stripped. Hashes move host-side only; both psql ends silenced because",
  "  #    error text can quote failing DDL.",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT rolname, rolcanlogin, rolpassword FROM pg_authid WHERE rolname NOT LIKE \'pg\\_%\' AND rolname <> \'postgres\'" 2>/dev/null \\',
  '    | samohost_emit_scoped_role_sql "$scoped_roles" \\',
  '    | PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d postgres -f - >/dev/null 2>&1 || true',
  "  # 1.5. Role-assumption replay: for each login role L (envDbVars URL roles) and",
  "  #      each scoped role R (R≠L), if prod pg_has_role(L, R, 'USAGE') is true,",
  "  #      emit GRANT R TO L into the clone. pg_has_role covers both explicit",
  "  #      membership AND the superuser-in-prod case, so SET ROLE works on the",
  "  #      clone without granting SUPERUSER (step 1 stripped it). This closes the",
  "  #      gap where the app's tenant queries run SET LOCAL ROLE <app_role> and the",
  "  #      clone login role — stripped of superuser — cannot assume it.",
  "  #      No cluster privilege is granted: GRANT R TO L is pure role membership.",
  "  #",
  "  #      PARITY GATE (emitted-count scoped): grants are written to a temp file",
  "  #      so the count is captured BEFORE applying (a pipe subshell loses the",
  "  #      count). After applying, the clone's pg_auth_members is queried SCOPED",
  "  #      to the L roles (login roles from envDbVars URLs) only — neither",
  "  #      vacuous (superuser-prod has prod cluster count=0 → OLD gate 0>=0 was",
  "  #      a no-op even when grants didn't land) nor cluster-wide / brick-risk",
  "  #      (unrelated memberships on other apps' roles don't inflate the count).",
  '  _ra_grants_file="$(mktemp)"',
  "  emitted_grants=0",
  "  while IFS= read -r _ra_l; do",
  '    [[ "$_ra_l" =~ ^[a-z_][a-z0-9_]*$ ]] || continue',
  "    while IFS= read -r _ra_r; do",
  '      [[ "$_ra_l" == "$_ra_r" ]] && continue',
  '      _ra_has="$(sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT pg_has_role(\'${_ra_l}\',\'${_ra_r}\',\'USAGE\')" 2>/dev/null || echo f)"',
  '      [[ "$_ra_has" == "t" ]] || continue',
  '      printf \'GRANT "%s" TO "%s";\\n\' "$_ra_r" "$_ra_l" >> "$_ra_grants_file"',
  "      emitted_grants=$((emitted_grants+1))",
  '    done < "$scoped_roles"',
  "  done < <(samohost_app_url_roles)",
  '  if [[ -s "$_ra_grants_file" ]]; then',
  '    PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d postgres -f - < "$_ra_grants_file" >/dev/null 2>&1 || apply_failures=$((apply_failures+1))',
  "  fi",
  '  rm -f "$_ra_grants_file"',
  "  # 1.5-gate. Scoped parity: verify that all emitted GRANTs landed in the clone.",
  "  #   Build an IN-clause from the login roles (L side) for a scoped clone query.",
  "  #   This is neither vacuous (emitted count is authoritative: even when",
  "  #   prod_cluster.pg_auth_members=0 for a superuser prod, we still emitted grants",
  "  #   and the clone must have them) nor cluster-wide / brick-prone (the IN-clause",
  "  #   scopes the count to only the app's login roles — unrelated roles on the same",
  "  #   cluster are invisible to the query).",
  '  _ra_login_in=""',
  "  while IFS= read -r _ra_l; do",
  '    [[ "$_ra_l" =~ ^[a-z_][a-z0-9_]*$ ]] || continue',
  "    _ra_login_in=\"${_ra_login_in:+${_ra_login_in},}'${_ra_l}'\"",
  "  done < <(samohost_app_url_roles)",
  '  _ra_clone_cnt="$(PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d postgres -At -c "SELECT count(*) FROM pg_auth_members m JOIN pg_roles mr ON mr.oid = m.member WHERE mr.rolname IN (${_ra_login_in:-\'__none__\'})" 2>/dev/null)" || _ra_clone_cnt=""',
  '  if ! [[ "$_ra_clone_cnt" =~ ^[0-9]+$ ]]; then',
  '    echo "samohost: role-assumption parity: cannot read scoped clone membership count — failing CLOSED" >&2',
  "    return 1",
  "  fi",
  '  if [[ "$_ra_clone_cnt" -lt "$emitted_grants" ]]; then',
  '    echo "samohost: role-assumption parity FAILED (emitted=${emitted_grants}, clone_scoped=${_ra_clone_cnt}) — emitted GRANTs did not all land in the clone" >&2',
  "    return 1",
  "  fi",
  "  # 1.6. RLS-bypass replay: for each login role L (envDbVars URL roles), if",
  "  #      prod L effectively bypasses RLS (rolsuper OR rolbypassrls), emit",
  "  #      ALTER ROLE \"L\" BYPASSRLS on the clone. This closes the auth gap where",
  "  #      the app runs a query BEFORE SET ROLE that relies on FORCE ROW LEVEL",
  "  #      SECURITY bypass on the login role (GOLD proof 2026-07-10: login failed",
  "  #      on the clone until a manual ALTER ROLE samo BYPASSRLS was applied).",
  "  #      FAITHFUL: only BYPASSRLS is granted — never SUPERUSER. The clone is",
  "  #      ephemeral + localhost. Prod side is SELECT-only. L is regex-validated",
  "  #      (same discipline as the 1.5 loop above).",
  "  #",
  "  #      PARITY GATE (emitted-count scoped): ALTER statements are written to a",
  "  #      temp file so the count is captured BEFORE applying (pipe subshell loses",
  "  #      it). After applying, the clone's pg_roles is queried SCOPED to the",
  "  #      emitted login roles via an IN-clause — not cluster-wide. The gate is",
  "  #      skipped when emitted=0 (no bypass roles on prod); it is never vacuous",
  "  #      when emitted>0 (emitted count is authoritative: if ALTER didn't land,",
  "  #      clone_count < emitted → FAIL CLOSED).",
  '  _rls_bypass_file="$(mktemp)"',
  '  _rls_bypass_in=""',
  "  emitted_bypass=0",
  "  while IFS= read -r _rls_l; do",
  '    [[ "$_rls_l" =~ ^[a-z_][a-z0-9_]*$ ]] || continue',
  '    _rls_row="$(sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = \'${_rls_l}\'" 2>/dev/null || echo "f|f")"',
  '    _rls_super="${_rls_row%%|*}"',
  '    _rls_bypass="${_rls_row##*|}"',
  '    if [[ "$_rls_super" == "t" || "$_rls_bypass" == "t" ]]; then',
  "      printf 'ALTER ROLE \"%s\" BYPASSRLS;\\n' \"$_rls_l\" >> \"$_rls_bypass_file\"",
  "      emitted_bypass=$((emitted_bypass+1))",
  "      _rls_bypass_in=\"${_rls_bypass_in:+${_rls_bypass_in},}'${_rls_l}'\"",
  "    fi",
  "  done < <(samohost_app_url_roles)",
  '  if [[ -s "$_rls_bypass_file" ]]; then',
  '    PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d postgres -f - < "$_rls_bypass_file" >/dev/null 2>&1 || apply_failures=$((apply_failures+1))',
  "  fi",
  '  rm -f "$_rls_bypass_file"',
  "  # 1.6-gate. Parity: verify emitted BYPASSRLS attributes landed in the clone.",
  '  if [[ "$emitted_bypass" -gt 0 ]]; then',
  '    _rls_clone_cnt="$(PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d postgres -At -c "SELECT count(*) FROM pg_roles WHERE rolbypassrls AND rolname IN (${_rls_bypass_in:-\'__none__\'})" 2>/dev/null)" || _rls_clone_cnt=""',
  '    if ! [[ "$_rls_clone_cnt" =~ ^[0-9]+$ ]]; then',
  '      echo "samohost: RLS-bypass parity: cannot read clone bypass count — failing CLOSED" >&2',
  "      return 1",
  "    fi",
  '    if [[ "$_rls_clone_cnt" -lt "$emitted_bypass" ]]; then',
  '      echo "samohost: RLS-bypass parity FAILED (emitted=${emitted_bypass}, clone=${_rls_clone_cnt}) — BYPASSRLS attribute did not land on all required login roles" >&2',
  "      return 1",
  "    fi",
  "  fi",
  "  # 2. Table ownership (prod's owner role; owner-bypass RLS semantics match).",
  "  #    Idempotent DDL: ON_ERROR_STOP failures are real and counted by exit",
  "  #    code only — output stays suppressed.",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'ALTER TABLE IF EXISTS \'||quote_ident(schemaname)||\'.\'||quote_ident(tablename)||\' OWNER TO \'||quote_ident(tableowner)||\';\' FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')" \\',
  '    | PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -f - >/dev/null 2>&1 || apply_failures=$((apply_failures+1))',
  "  # 2.5. Schema grants (USAGE/CREATE ON SCHEMA): missing from logical dump",
  "  #      because pg_database_owner=UC only applies to the actual DB owner.",
  "  #      In the clone the DB owner is postgres, so the prod DB-owner role",
  "  #      (e.g. field_record) loses CREATE on public — causing migrations to",
  "  #      fail with 'permission denied for schema public'. One batch per scoped",
  "  #      role avoids grep-pattern nested-quote issues and keeps each failure",
  "  #      isolated. Temp schemas excluded in SQL (session-private, not in clone).",
  "  while IFS= read -r _sr_role; do",
  '    sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'GRANT \'||priv||\' ON SCHEMA \'||quote_ident(n.nspname)||\' TO \'||quote_ident(r.rolname)||\';\' FROM pg_namespace n CROSS JOIN pg_roles r CROSS JOIN (VALUES(\'USAGE\'),(\'CREATE\')) pv(priv) WHERE n.nspname NOT IN (\'pg_catalog\',\'information_schema\',\'pg_toast\') AND n.nspname NOT LIKE \'pg_temp_%\' AND n.nspname NOT LIKE \'pg_toast_temp_%\' AND r.rolname = \'$_sr_role\' AND has_schema_privilege(r.rolname, n.nspname, priv)" 2>/dev/null \\',
  '      | PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -f - >/dev/null 2>&1 || apply_failures=$((apply_failures+1))',
  '  done < "$scoped_roles"',
  '  rm -f "$scoped_roles"',
  "  # 3-pre. Clone-present table IN-clause: used by step 3 and the step-6",
  "  #    parity gates below to scope both to tables that already exist on the",
  "  #    clone. Tables absent from the snapshot (created by prod migrations that",
  "  #    post-date the last DBLab refresh) are silently skipped; the migrate",
  "  #    phase creates them and their grants must be part of the migration DDL.",
  "  #",
  "  #    FAIL-CLOSED: the psql exit status is captured explicitly via ||.",
  "  #    A FAILED read (connection error, auth failure, etc.) causes an immediate",
  "  #    return 1 — the same fail-closed discipline used by the 1.5/1.6 gates and",
  "  #    every other capture in this function. The previous '|| echo ...' fallback",
  "  #    converted a query FAILURE into 'zero tables', neutering BOTH the step-3",
  "  #    grant apply (IN('__none__') → 0 grants) AND the step-6 parity gates",
  "  #    (0==0 on both sides), serving a zero-grant preview as 'success'.",
  "  #    Distinguish: query FAILURE (non-zero psql exit) → fail closed;",
  "  #    query SUCCESS but zero rows (COALESCE returns '__none__') → continue.",
  '  _clone_tab_in="$(PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -At -c "SELECT COALESCE(string_agg(quote_literal(table_schema||\'.\' ||table_name),\',\'),quote_literal(\'__none__\')) FROM information_schema.tables WHERE table_schema NOT IN (\'pg_catalog\',\'information_schema\') AND table_type=\'BASE TABLE\'" 2>/dev/null)" \\',
  '    || { echo "samohost: clone globals sync: step 3-pre failed to read clone table list — failing CLOSED" >&2; return 1; }',
  '  [[ -z "$_clone_tab_in" ]] && _clone_tab_in="\'__none__\'"',
  "  # 3. Table grants — scoped to tables that exist on the clone.",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'GRANT \'||privilege_type||\' ON \'||quote_ident(table_schema)||\'.\'||quote_ident(table_name)||\' TO \'||quote_ident(grantee)||\';\' FROM information_schema.table_privileges WHERE grantee NOT IN (\'postgres\',\'PUBLIC\') AND table_schema NOT IN (\'pg_catalog\',\'information_schema\') AND (table_schema||\'.\' ||table_name) IN ($_clone_tab_in)" \\',
  '    | PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -f - >/dev/null 2>&1 || apply_failures=$((apply_failures+1))',
  "  # 4. RLS policies (deparsed; restore dropped them with the roles missing).",
  "  #    CREATE POLICY duplicates FAIL on engines whose retrieval already",
  "  #    carries policies, so errors stay ignored — parity below is the gate.",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'CREATE POLICY \'||quote_ident(policyname)||\' ON \'||quote_ident(schemaname)||\'.\'||quote_ident(tablename)||\' AS \'||permissive||\' FOR \'||cmd||\' TO \'||(SELECT string_agg(CASE WHEN r=\'public\' THEN \'PUBLIC\' ELSE quote_ident(r) END, \', \') FROM unnest(roles) AS r)||COALESCE(\' USING (\'||qual||\')\',\'\')||COALESCE(\' WITH CHECK (\'||with_check||\')\',\'\')||\';\' FROM pg_policies" \\',
  '    | PGPASSWORD="$SAMOHOST_DB_PASSWORD" psql -h 127.0.0.1 -p "$SAMOHOST_DB_PORT" -U samohost_env -d "$prod_db" -f - >/dev/null 2>&1 || true',
  "  # 5. Apply-failure gate: failures are counted, never echoed.",
  '  if [[ "$apply_failures" -gt 0 ]]; then',
  '    echo "samohost: clone globals sync: ${apply_failures} ownership/grant apply batch(es) failed inside the clone — failing CLOSED (details suppressed: psql error text can quote DDL)" >&2',
  "    return 1",
  "  fi",
  "  # 6. Parity gates (fail CLOSED): an env whose clone cannot honor the",
  "  #    app's RLS/grant contract is never composed.",
  "  #    Role-assumption membership parity is handled in section 1.5-gate",
  "  #    (scoped emitted-count gate) rather than here, because a cluster-wide",
  "  #    prod pg_auth_members count is (a) vacuous for superuser-prod (count=0",
  "  #    even when membership is implied) and (b) brick-prone when unrelated",
  "  #    apps/roles on the same cluster inflate the prod count above the clone's",
  "  #    scoped count. The scoped gate at 1.5 is authoritative.",
  '  samohost_parity_check "RLS policies" "SELECT count(*) FROM pg_policies" \\',
  '    && samohost_parity_check "table grants" "SELECT count(*) FROM information_schema.table_privileges WHERE grantee NOT IN (\'postgres\',\'PUBLIC\') AND table_schema NOT IN (\'pg_catalog\',\'information_schema\') AND (table_schema||\'.\' ||table_name) IN ($_clone_tab_in)" \\',
  '    && samohost_parity_check "table ownership" "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\') AND tableowner <> \'postgres\' AND (schemaname||\'.\'||tablename) IN ($_clone_tab_in)"',
  "}",
];

/** Single-quote for safe embedding in generated bash (same as app/script.ts). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function marker(phase: EnvPhaseName, status: "start" | "ok" | "fail"): string {
  return `echo "${ENV_PHASE_PREFIX}${phase}:${status}>>>"`;
}

/**
 * Body lines of the /usr/local/sbin/samohost-secrets root helper.
 *
 * Installed by buildHostPrepScript (as a single-quoted heredoc so no shell
 * expansion occurs during host-prep).  Called by env-create, rotate, and
 * destroy scripts via ONE exact-path sudoers NOPASSWD grant — no user-
 * controlled wildcard remains in the grant or in any sudo call.
 *
 * Validates the env-name argument against [a-z0-9][a-z0-9-]* before
 * constructing any path, preventing path-separator and glob-char injection.
 *
 * Actions:
 *   init   <env-name> <env-user> [name...]  — reuse-or-generate (create path)
 *   rotate <env-name> <env-user> [name...]  — rm-then-generate-all (no reuse)
 *   clean  <env-name>                       — rm -rf the env secrets dir
 */
const SAMOHOST_SECRETS_HELPER_LINES: string[] = [
  "#!/usr/bin/env bash",
  "# samohost-secrets — per-env secrets helper, run as root via ONE sudoers grant.",
  "# Usage:",
  "#   samohost-secrets init   <env-name> <env-user> [name1 name2 ...]",
  "#   samohost-secrets rotate <env-name> <env-user> [name1 name2 ...]",
  "#   samohost-secrets clean  <env-name>",
  "set -euo pipefail",
  "",
  "ACTION=\"${1:-}\"",
  "ENV_NAME=\"${2:-}\"",
  "",
  "# Validate env-name: only [a-z0-9][a-z0-9-]* — no path separators, no globs,",
  "# no spaces, no .. — confines all operations to /var/lib/samohost/envs/<name>/.",
  "if [[ -z \"$ENV_NAME\" ]] || [[ ! \"$ENV_NAME\" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then",
  "  echo \"samohost-secrets: invalid env name '${ENV_NAME}' — only [a-z0-9-] allowed; no path separators, globs, or spaces\" >&2",
  "  exit 1",
  "fi",
  "",
  "SECRETS_DIR=\"/var/lib/samohost/envs/${ENV_NAME}\"",
  "SECRETS_FILE=\"${SECRETS_DIR}/secrets.env\"",
  "",
  "case \"$ACTION\" in",
  "  init)",
  "    ENV_USER=\"${3:-root}\"",
  "    shift 3 2>/dev/null || true",
  "    mkdir -p \"$SECRETS_DIR\"",
  "    if [[ ! -f \"$SECRETS_FILE\" ]]; then",
  "      install -m 600 -o \"$ENV_USER\" /dev/null \"$SECRETS_FILE\"",
  "    fi",
  "    for _name in \"$@\"; do",
  "      if ! grep -qE \"^${_name}[=]\" \"$SECRETS_FILE\" 2>/dev/null; then",
  "        _val=\"$(openssl rand -hex 32)\"",
  "        printf '%s=%s\\n' \"$_name\" \"$_val\" >> \"$SECRETS_FILE\"",
  "        unset _val",
  "      fi",
  "    done",
  "    chmod 600 \"$SECRETS_FILE\"",
  "    ;;",
  "  rotate)",
  "    ENV_USER=\"${3:-root}\"",
  "    shift 3 2>/dev/null || true",
  "    mkdir -p \"$SECRETS_DIR\"",
  "    rm -f \"$SECRETS_FILE\"",
  "    install -m 600 -o \"$ENV_USER\" /dev/null \"$SECRETS_FILE\"",
  "    for _name in \"$@\"; do",
  "      _val=\"$(openssl rand -hex 32)\"",
  "      printf '%s=%s\\n' \"$_name\" \"$_val\" >> \"$SECRETS_FILE\"",
  "      unset _val",
  "    done",
  "    chmod 600 \"$SECRETS_FILE\"",
  "    ;;",
  "  clean)",
  "    rm -rf \"$SECRETS_DIR\"",
  "    ;;",
  "  get)",
  "    _get_var=\"${3:-}\"",
  "    if [[ -z \"$_get_var\" ]]; then",
  "      echo \"samohost-secrets: get requires a secret name argument\" >&2",
  "      exit 1",
  "    fi",
  "    if [[ ! -f \"$SECRETS_FILE\" ]]; then",
  "      echo \"samohost-secrets: secrets file not found for env '${ENV_NAME}' — run init first\" >&2",
  "      exit 1",
  "    fi",
  "    _line=\"$(grep -E \"^${_get_var}[=]\" \"$SECRETS_FILE\" | tail -n 1 || true)\"",
  "    if [[ -z \"$_line\" ]]; then",
  "      echo \"samohost-secrets: secret '${_get_var}' not found in ${SECRETS_FILE}\" >&2",
  "      exit 1",
  "    fi",
  "    printf '%s\\n' \"${_line#*=}\"",
  "    ;;",
  "  *)",
  "    echo \"samohost-secrets: unknown action '${ACTION}' — use init|rotate|clean|get\" >&2",
  "    exit 1",
  "    ;;",
  "esac",
];

/** Wrap a phase body in start/ok/fail markers with exit-on-fail. */
function phaseBlock(
  phase: EnvPhaseName,
  comment: string,
  body: string[],
  onFail: string[] = ["  exit 1"],
): string[] {
  return [
    `# --- ${phase}: ${comment} ---`,
    marker(phase, "start"),
    ...body,
    "then",
    `  ${marker(phase, "ok")}`,
    "else",
    `  ${marker(phase, "fail")}`,
    ...onFail,
    "fi",
    "",
  ];
}

/**
 * Inputs for an env create/destroy script that are decided by the command
 * layer (allocation results), not stored on the AppRecord.
 */
export interface EnvScriptTarget {
  /** Sanitized env name (env/name.ts) — instance name, dir name, vhost label. */
  name: string;
  /** Raw git branch the env tracks. */
  branch: string;
  /**
   * Allocated port for the DEFAULT listener (back-compat).
   * For multi-service apps this equals ports[defaultListener].
   */
  port: number;
  /**
   * Per-listener allocated ports for multi-service apps, keyed by listener name.
   * Absent for legacy single-service apps (use `port` instead).
   * When present, every listener in servicesOf(app) has an entry here.
   */
  ports?: Record<string, number>;
  /** Full vhost (e.g. `field-record-1-feat-x.samo.cat`). */
  vhost: string;
  dbBackend: EnvDbBackend;
  /** dblab clone id / template-backend database name. Required unless `none`. */
  dbName?: string;
  /** Template database for the `template` backend (default `<app>_template`). */
  templateDb?: string;
}

/** Root dir of all envs for an app: `<appDir-parent>/envs`. */
export function envsRoot(app: AppRecord): string {
  // appDir is the production checkout (e.g. /opt/field-record/app); envs live
  // beside it (e.g. /opt/field-record/envs/<name>).
  const parent = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return `${parent || ""}/envs`;
}

/**
 * Build the env CREATE script for a STATIC site (issue #36). Clones the branch
 * into the env dir then writes a Caddy file_server vhost (bare block, ACME
 * HTTPS). Skips install/build/db/envfile/unit phases entirely: there is no
 * service to start, no DB, no env file. Health probe uses a Host-header curl
 * against local Caddy (nothing listens on the allocated port for static sites).
 */
function buildStaticEnvCreateScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
  const staticRoot = staticRootOf(app);
  const servedDir = "$SAMOHOST_STATIC_DIR";
  const cacheHeadersPrintf = staticCacheHeaderLines("\\t").join("\\n");
  const root = envsRoot(app);
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# samohost env-create script (generated; static-site path; pushed over ssh stdin to `bash -s`).",
    "set -euo pipefail",
    "",
    `SAMOHOST_ENV_NAME=${sq(t.name)}`,
    `SAMOHOST_BRANCH=${sq(t.branch)}`,
    // NOTE: a port is still allocated from the pool (commands/env.ts machinery)
    // but a static env does NOT use it for a service. The allocation keeps the
    // port pool consistent (no gaps) and is harmless.
    `SAMOHOST_PORT=${sq(String(t.port))}`,
    `SAMOHOST_VHOST=${sq(t.vhost)}`,
    `SAMOHOST_ENVS_ROOT=${sq(root)}`,
    `SAMOHOST_ENV_DIR=${sq(`${root}/${t.name}`)}`,
    `SAMOHOST_REPO=${sq(app.repo)}`,
    `SAMOHOST_APP_DIR=${sq(app.appDir)}`,
    `SAMOHOST_STATIC_ROOT=${sq(staticRoot ?? "")}`,
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
    ...staticTreeGuardFnLines(),
    "",
  ];

  // ----- clone: embed credential helper path derived from appDir -----------
  // Issue #163: SSH runs AS appUser so plain git is used; the credential
  // helper still reads the token from the bootstrap-written path.
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const tokenFile = `${appBase}/.gh-token`;
  lines.push(...buildCloneFnLines(app.appUser, tokenFile), "");
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      "if samohost_clone_env_dir; ",
    ]),
  );

  lines.push(
    "# Resolve the served directory only after clone and fail closed if a",
    "# repository symlink escapes the checkout.",
    'SAMOHOST_CHECKOUT_REAL=$(realpath -e "$SAMOHOST_ENV_DIR") || { echo "static checkout is missing" >&2; exit 1; }',
    'if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_ENV_DIR/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_ENV_DIR"; fi',
    'SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "staticRoot does not exist: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
    'case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "staticRoot escapes the checkout: $SAMOHOST_STATIC_ROOT" >&2; exit 1 ;; esac',
    '[[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "staticRoot must be a directory containing index.html: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
    'samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" || exit 1',
    'cd "$SAMOHOST_ENV_DIR"',
    "",
  );

  // ----- config.js: write the preview-env marker for the SPA banner -----------
  // The SPA reads window.__GC1_CONFIG__ from /config.js; the banner fires when
  // preview is true. The repo commits a default config.js with preview:false, so
  // we OVERWRITE it (>) — never append. config.js is a public static asset (644
  // under the default umask) and file_server serves it fine; NO chmod 600.
  // Placed as bare lines (not inside the phaseBlock body): the phaseBlock
  // convention wraps body in `if ...; then ok else fail fi` — inserting
  // arbitrary commands in the body array would break that contract. Under
  // `set -euo pipefail` a failed write here aborts the script, so no extra
  // phase marker is required.
  // $SAMOHOST_BRANCH is already sq()-escaped at the top of the script; a slash
  // in the branch value (e.g. demo/red-bg) is safe inside a JS string literal.
  //
  // Issue #163 — runner now SSHes AS appUser (when set) so the SSH session is
  // already the dir owner; no sudo-u delegation needed.  Use the atomic
  // mktemp/mv form in ALL cases (appUser and no-appUser alike).
  //
  // The #162 'sudo -u <appUser> /usr/bin/tee' form is removed: it relied on a
  // sudoers grant that was never emitted by buildHostPrepScript (the missing
  // /usr/bin/tee path for config.js), and only worked via the cloud-init
  // NOPASSWD:ALL backdoor.  With SSH-as-appUser the SSH user owns $SAMOHOST_STATIC_DIR
  // directly and the plain redirect succeeds without any extra grant.
  lines.push(
    "# --- config.js: overwrite with preview marker so the SPA banner fires ---",
    `SAMOHOST_CONFIG_NEXT=$(mktemp "${servedDir}/.config.next.XXXXXX")`,
    `if printf 'window.__GC1_CONFIG__ = { version: "", preview: true, branch: "%s" };\\n' "$SAMOHOST_BRANCH" > "$SAMOHOST_CONFIG_NEXT" && chmod 0644 "$SAMOHOST_CONFIG_NEXT" && /usr/bin/mv -f "$SAMOHOST_CONFIG_NEXT" "${servedDir}/config.js"; then :; else rm -f "$SAMOHOST_CONFIG_NEXT"; exit 1; fi`,
    "",
  );

  // ----- vhost: Caddy file_server (tls internal — CF Full-mode proxied origin)
  // The record is PROXIED (orange cloud), so CF edge fronts the origin. Caddy
  // uses `tls internal` (self-signed cert); CF Full mode accepts a self-signed
  // origin cert. No browser ever sees the self-signed cert — CF terminates the
  // real edge cert. ACME is NOT used: it cannot complete on a CF-locked :443
  // (port firewalled to CF IPs only) and the host has no DNS-01 plugin.
  // The health probe below uses `curl -k --resolve` which works against
  // `tls internal` — unchanged.
  lines.push(
    ...phaseBlock(
      "vhost",
      "Caddy file_server vhost snippet + reload (sites.d include applied in host-prep)",
      [
        'if samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" \\',
        `   && printf '%s {\\n\\ttls internal\\n\\troot * %s\\n${cacheHeadersPrintf}\\n\\ttry_files {path} {path}/ =404\\n\\tfile_server\\n\\tencode gzip\\n}\\n' \\`,
        `     "$SAMOHOST_VHOST" "${servedDir}" \\`,
        '   | sudo /usr/bin/tee "$SAMOHOST_CADDY_SNIPPET" >/dev/null \\',
        "   && sudo /usr/bin/systemctl reload caddy; ",
      ],
    ),
  );

  // ----- health: prove Caddy SERVES index.html via --resolve curl -----------
  // Nothing listens on $SAMOHOST_PORT for a static env, so we cannot poll
  // localhost:$PORT. Instead, curl Caddy's local HTTPS listener using
  // --resolve so that BOTH the TCP connection (127.0.0.1) AND the TLS SNI
  // are set to the vhost name. This is critical: the old form
  //   -H "Host: $SAMOHOST_VHOST" https://127.0.0.1/
  // sent SNI=127.0.0.1, for which Caddy has no cert → TLS handshake failure
  // → 000 → false health-fail even when the site serves a real 200 externally.
  // --resolve "$SAMOHOST_VHOST:443:127.0.0.1" makes curl connect to 127.0.0.1
  // while presenting the vhost as both the SNI and the Host header, so Caddy
  // selects the right cert/site and the probe reflects actual site health.
  // -k skips the self-signed cert check (tls internal) — correct behaviour.
  lines.push(
    `# --- health: prove Caddy serves the static vhost (--resolve curl, SNI=vhost) ---`,
    marker("health", "start"),
    "health_ok=0",
    `for attempt in $(seq 1 ${HEALTH_RETRIES}); do`,
    `  code=$(curl -s -k -o /dev/null -w "%{http_code}" --max-time 10 --resolve "$SAMOHOST_VHOST:443:127.0.0.1" "https://$SAMOHOST_VHOST/" || echo 000)`,
    '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
    `  sleep ${HEALTH_SLEEP_SEC}`,
    "done",
    'if [[ "$health_ok" == "1" ]]; then',
    `  ${marker("health", "ok")}`,
    "else",
    `  ${marker("health", "fail")}`,
    '  echo "static env health check failed — caddy may not yet be serving the vhost; destroy to clean up" >&2',
    "  exit 1",
    "fi",
    "",
    'echo "env ready: https://${SAMOHOST_VHOST} (static file_server)"',
    "",
  );

  return lines.join("\n");
}

/**
 * Generate the envfile phase body lines for the scoped file-write approach
 * (samorev security fix for issue #101).
 *
 * Issue #163: the runner now SSHes AS appUser, so the SSH session is already
 * the dir owner.  Plain /usr/bin/install, /usr/bin/tee and chmod work directly
 * without any sudo-u delegation.  The .env content is still composed in a
 * scratch temp file (/tmp, owned by the SSH user) and written to the final
 * appUser-owned path in three steps for security:
 *
 *   1. /usr/bin/install -m 600 /dev/null <envfile>
 *      Pre-create the envfile at mode 600 BEFORE tee writes content, closing
 *      the brief world-readable window that bare tee would leave (tee creates
 *      files at umask-derived 644 if the file is absent).
 *
 *   2. /usr/bin/tee <envfile> >/dev/null < <tmpfile>
 *      Write the composed content atomically from stdin.  The file already
 *      exists at 600 so tee does not change permissions.
 *
 *   3. chmod 600 <envfile>
 *      Belt-and-suspenders re-assertion of mode 600.
 *
 * No sudoers grants are required for these ops (SSH user IS appUser).
 * The rewire functions (samohost_rewire_db_vars / samohost_rewire_db_hostport)
 * operate on the scratch temp file in /tmp — defined in the outer bash from
 * the db-phase setup for template/dblab backends.
 */
function buildEnvfileScopedBodyLines(
  app: AppRecord,
  t: EnvScriptTarget,
  portMap: Map<string, number>,
  allListeners: Array<{ listener: import("../types.ts").ListenerSpec; unit: string }>,
): string[] {
  const root = envsRoot(app);
  const envDir = `${root}/${t.name}`;
  const templatePath = `${root}.template.env`;
  const envFile = `${envDir}/.env`;

  // Build the &&-chain as the body of the `if` condition that phaseBlock wraps.
  // All intermediate operations (cp, printf, grep, mv) run as samo on a
  // samo-owned temp file in /tmp; only the final install/tee/chmod write to
  // the appUser-owned envfile.
  const lines: string[] = [
    // Create a samo-owned temp file (mktemp mode 600 by default).
    `if _sh_env="$(mktemp)" \\`,
    `   && cp ${sq(templatePath)} "$_sh_env" \\`,
    `   && chmod 600 "$_sh_env" \\`,
  ];

  // Per-listener portEnv strip-then-append in the samo-owned temp file.
  // Operator templates carry prod port values; strip-then-append prevents
  // duplicate entries and ensures the allocated preview port wins.
  for (const { listener } of allListeners) {
    const allocatedPort = portMap.get(listener.name) ?? t.port;
    lines.push(
      `   && _sh_env2="$(mktemp)" \\`,
      `   && { grep -vE ${sq(`^${listener.portEnv}=`)} "$_sh_env" >> "$_sh_env2" || true; } \\`,
      `   && mv "$_sh_env2" "$_sh_env" \\`,
      `   && chmod 600 "$_sh_env" \\`,
      `   && printf ${sq(`${listener.portEnv}=${String(allocatedPort)}\\n`)} >> "$_sh_env" \\`,
    );
  }

  // Rewire functions are already defined in the outer bash (db-phase setup).
  // SAMOHOST_ENV_DB_VARS and SAMOHOST_DB_NAME / SAMOHOST_DB_PORT are set there.
  if (t.dbBackend === "template") {
    lines.push(`   && samohost_rewire_db_vars "$_sh_env" \\`);
  } else if (t.dbBackend === "dblab") {
    // SAMOHOST_DB_PORT is already in the outer bash from samohost_clone_port.
    // No KEY=val forwarding prefix needed.
    lines.push(`   && samohost_rewire_db_hostport "$_sh_env" \\`);
    if (app.databaseUrlEnv !== undefined) {
      // Credentialed URL rewrite: replaces user:pw@host:port in the var named
      // by databaseUrlEnv with the clone-role credentials (set in the db phase).
      // Runs AFTER hostport rewire so the host:port is already correct.
      lines.push(`   && samohost_rewire_db_credentialed "$_sh_env" \\`);
    }
  }

  lines.push(
    `   && printf '\\nSAMO_ENV=preview\\nSAMO_BRANCH=%s\\n' ${sq(t.branch)} >> "$_sh_env" \\`,
    // BASE_URL strip: use a second temp file to avoid in-place rewrite on an
    // appUser-owned file. Both temp files are samo-owned (mktemp creates 600).
    `   && _sh_env2="$(mktemp)" \\`,
    `   && { grep -vE '^BASE_URL=' "$_sh_env" >> "$_sh_env2" || true; } \\`,
    `   && mv "$_sh_env2" "$_sh_env" \\`,
    `   && chmod 600 "$_sh_env" \\`,
    `   && printf 'BASE_URL=https://%s\\n' ${sq(t.vhost)} >> "$_sh_env" \\`,
    // Issue #163: runner SSHes AS appUser, so the SSH session is already the
    // dir owner.  Plain install/tee/chmod work directly — no sudo-u needed.
    // Pre-create the envfile at 600 before tee writes content (avoids the brief
    // world-readable window that bare tee creates when creating a new file).
    `   && /usr/bin/install -m 600 /dev/null ${sq(envFile)} \\`,
    // Write composed content from stdin via tee (file already 600).
    `   && /usr/bin/tee ${sq(envFile)} >/dev/null < "$_sh_env" \\`,
    // Belt-and-suspenders re-assertion of 600 after tee.
    `   && chmod 600 ${sq(envFile)} \\`,
    // Clean up samo-owned temp files.
    `   && rm -f "$_sh_env" "$_sh_env2"; `,
  );

  return lines;
}

/**
 * Build the env CREATE script: fresh shallow clone of the branch, install +
 * build, per-env database (dblab clone / template createdb / none), env file
 * composed on-host, systemd template instance start, Caddy vhost write +
 * reload, localhost health probe. Failure exits non-zero; partial state is
 * cleaned by the destroy script (idempotent), not by rollback here.
 *
 * When `app.kind === "static"` the static path is used (no install/build/db/
 * envfile/unit phases; Caddy file_server vhost; Host-header health probe).
 */
export function buildEnvCreateScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
  assertOptionalLinuxAppUser(app.appUser);
  staticRootOf(app);
  // issue #36: branch on kind for static sites.
  if (app.kind === "static") {
    return buildStaticEnvCreateScript(app, t);
  }

  const root = envsRoot(app);

  // Resolve the service topology via servicesOf() so that legacy single-service
  // apps and multi-service apps share one code path. For a legacy app (no
  // services field), servicesOf() synthesizes the single "web" service from
  // healthUrl, keeping the external behaviour identical.
  const { services } = servicesOf(app);

  // Flat list of (listener, owning service) pairs in declaration order.
  // Declaration order is preserved throughout: port-check, envfile, health.
  const allListeners = services.flatMap((svc) =>
    svc.listeners.map((l) => ({ listener: l, unit: svc.unit })),
  );

  // Listener-name → allocated preview port.
  // Multi-service: read from target.ports; legacy: all listeners share target.port.
  const portMap = new Map<string, number>();
  if (t.ports !== undefined) {
    for (const [name, port] of Object.entries(t.ports)) {
      portMap.set(name, port);
    }
  } else {
    for (const { listener } of allListeners) {
      portMap.set(listener.name, t.port);
    }
  }

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# samohost env-create script (generated; pushed over ssh stdin to `bash -s`).",
    "set -euo pipefail",
    "",
    `SAMOHOST_ENV_NAME=${sq(t.name)}`,
    `SAMOHOST_BRANCH=${sq(t.branch)}`,
    `SAMOHOST_PORT=${sq(String(t.port))}`,
    `SAMOHOST_VHOST=${sq(t.vhost)}`,
    `SAMOHOST_ENVS_ROOT=${sq(root)}`,
    `SAMOHOST_ENV_DIR=${sq(`${root}/${t.name}`)}`,
    `SAMOHOST_REPO=${sq(app.repo)}`,
    `SAMOHOST_APP_DIR=${sq(app.appDir)}`,
    `SAMOHOST_ENV_TEMPLATE=${sq(`${root}.template.env`)}`,
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
  ];

  // Emit per-listener portEnv shell variables immediately after the header
  // globals so the BUILD phase (and every phase that follows) can reference
  // them. Example: APP_API_ORIGIN=http://127.0.0.1:${APP_API_PORT} in a
  // buildCmd — without this, build ran before the portEnvs were written to
  // .env (envfile phase), causing a prod-leak: the variable was unset so the
  // build would fall back to the service's default prod port instead of the
  // allocated per-env port.
  //
  // Values are taken from portMap — the SAME source that the envfile phase
  // uses when it writes printf 'PORTENV=PORT\n' to .env — so both phases are
  // guaranteed to carry identical values (single source of truth).
  //
  // Single-service (legacy) apps: portMap holds { web → t.port }; the
  // synthesized listener has portEnv="PORT", so PORT='<t.port>' is emitted
  // here. The envfile strip-then-append for PORT is unchanged.
  for (const { listener } of allListeners) {
    const allocatedPort = portMap.get(listener.name) ?? t.port;
    lines.push(`${listener.portEnv}=${sq(String(allocatedPort))}`);
  }
  lines.push("");

  // ----- port-check: FIRST phase — fail CLOSED if any listener port is held
  // by a foreign process. Loops all allocated listener ports. Detection uses
  // `ss -ltnH` (no sudo on Ubuntu). If a port is held by OUR OWN active
  // systemd unit (idempotent re-create) it is allowed; any other occupant
  // from the SAME env (detected via /proc/<pid>/cgroup containing
  // @<envName>.service) is also allowed — fixes Bug A where a FAILED or
  // sibling same-env unit was misclassified as a foreign squatter, causing
  // the Caddy snippet to be deleted on every heal cycle. A truly foreign
  // occupant fails CLOSED, removes the stale snippet (URL goes DARK), exits 1.
  // Reuses the existing sudo rm/reload caddy grants from host-prep sudoers.
  lines.push(
    ...READ_CGROUP_FN_LINES,
    "",
    ...PORT_CHECK_FN_LINES,
    "",
    `# --- port-check: abort if any foreign process holds a listener port ---`,
    marker("port-check", "start"),
    "port_check_all_ok=1",
  );
  for (const { listener, unit } of allListeners) {
    const allocatedPort = portMap.get(listener.name) ?? t.port;
    const unitInstance = `${unit}@${t.name}.service`;
    lines.push(
      `if ! samohost_port_check_ok ${sq(String(allocatedPort))} ${sq(unitInstance)} ${sq(t.name)}; then`,
      `  echo "samohost: port-check FAILED — a foreign process is already listening on port ${allocatedPort} (listener ${listener.name}, unit ${unitInstance}); allocate a different port or clean up the occupant before retrying" >&2`,
      "  port_check_all_ok=0",
      "fi",
    );
  }
  lines.push(
    'if [[ "$port_check_all_ok" == "1" ]]; then',
    `  ${marker("port-check", "ok")}`,
    "else",
    `  ${marker("port-check", "fail")}`,
    "  # Remove any stale Caddy snippet so the URL goes DARK (not serving the squatter).",
    '  sudo /usr/bin/rm -f "$SAMOHOST_CADDY_SNIPPET"',
    "  sudo /usr/bin/systemctl reload caddy || true",
    "  exit 1",
    "fi",
    "",
  );

  // ----- clone: reference clone from the production checkout (cheap) with an
  // explicit plain-clone fallback for shallow/unusable references (issue #11
  // finding 5); existing env dirs take the fetch+checkout path.
  // Issue #163: SSH runs AS appUser so plain git is used; credential helper
  // still reads the token from the bootstrap-written path.
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const tokenFile = `${appBase}/.gh-token`;
  lines.push(...buildCloneFnLines(app.appUser, tokenFile), "");
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      "if samohost_clone_env_dir; ",
    ]),
  );

  lines.push('cd "$SAMOHOST_ENV_DIR"', "");

  // Lockfile-aware install: use npm ci when a lockfile is present (reproducible,
  // faster), fall back to npm install when it is absent (no-DB fixtures and
  // minimal greenfield apps ship without package-lock.json; npm ci hard-fails
  // with "can only install with an existing package-lock.json", which under
  // set -euo pipefail aborts the whole script before .env/systemd/Caddy are
  // written → no :443 listener → CF 521).
  //
  // Issue #163: runner SSHes AS appUser so the SSH session is already the
  // dir owner — no sudo-u delegation needed.  Use plain 'npm' in all cases.
  const npmPrefix = "npm";
  lines.push(
    ...phaseBlock(
      "install",
      "lockfile-aware install (npm ci if lockfile present, npm install otherwise)",
      [
        `if (if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then ${npmPrefix} ci; else ${npmPrefix} install; fi); `,
      ],
    ),
  );

  // Issue #163: SSH user IS appUser; plain buildCmd runs as the dir owner.
  const buildCmdExpr = `if ${app.buildCmd}; `;
  lines.push(
    ...phaseBlock("build", "build", [buildCmdExpr]),
  );

  // ----- db ------------------------------------------------------------------
  if (t.dbBackend === "dblab") {
    const dbName = t.dbName ?? t.name;
    const envDbVars = app.envDbVars ?? [...DEFAULT_ENV_DB_VARS];
    const leaseMinutes = readDblabLeaseMinutes();
    lines.push(
      ...DBLAB_BIN_RESOLVE_LINES,
      "",
      // Runtime-verified contract (issue #7): the engine runs as the
      // dblab_server docker container; the legacy dblab.service unit's
      // ExecStart binary does not exist. Liveness = the engine's own healthz
      // endpoint answering, drivability = the CLI resolving (PATH or ~/bin).
      ...phaseBlock(
        "db-preflight",
        "DBLab engine must be RUNNING (healthz) and drivable (CLI), not merely installed-shape",
        [
          "if curl -fsS --max-time 5 http://127.0.0.1:2345/healthz >/dev/null \\",
          '   && [[ -n "$SAMOHOST_DBLAB_BIN" ]]; ',
        ],
        [
          '  echo "DBLab engine not confirmed running: healthz (http://127.0.0.1:2345/healthz) did not answer, or no dblab CLI on PATH / at ~/bin/dblab — refusing to attempt a clone." >&2',
          // SAFETY: do NOT suggest `--db none` for apps that declare a
          // migrateCmd or explicit envDbVars. Using --db none skips all DB
          // rewiring — migrateCmd would run against the PROD DATABASE_URL and
          // envDbVars URLs would still point at PROD. Point those apps to
          // installing dblab or using --db template (a real per-env DB) only.
          // Apps with neither migrateCmd nor envDbVars (e.g. static sites) are
          // safe with the full fallback list.
          ...((app.migrateCmd !== undefined || (app.envDbVars !== undefined && app.envDbVars.length > 0))
            ? ['  echo "Diagnose with: samohost env preflight <vm>; install per docs/dblab-install-runbook.md (apps with migrateCmd or envDbVars require a real per-env DB; use --db template if dblab is unavailable)" >&2']
            : ['  echo "Diagnose with: samohost env preflight <vm>; install per docs/dblab-install-runbook.md (or use --db template|none)" >&2']),
          "  exit 1",
        ],
      ),
      `SAMOHOST_CLONE_ID=${sq(dbName)}`,
      "# Per-clone admin credentials are generated ON THE HOST and never echoed.",
      "# (clone create's --username/--password add ONE extra superuser-ish role",
      "# on the clone — the script's own handle for the globals sync below; the",
      "# app keeps using the template's prod credentials, which the sync makes",
      "# valid inside the clone.)",
      'SAMOHOST_DB_PASSWORD="$(openssl rand -hex 16)"',
      "# Env vars whose URLs are repointed at the clone (AppRecord.envDbVars).",
      `SAMOHOST_ENV_DB_VARS=(${envDbVars.map(sq).join(" ")})`,
      "",
      ...CLONE_PORT_FN_LINES,
      "",
      ...APP_URL_ROLES_FN_LINES,
      "",
      ...EMIT_SCOPED_ROLE_SQL_FN_LINES,
      "",
      ...PARITY_CHECK_FN_LINES,
      "",
      ...SYNC_CLONE_GLOBALS_FN_LINES,
      "",
      ...REWIRE_DB_HOSTPORT_FN_LINES,
      "",
      // Clone-role password setup: when databaseUrlEnv is declared, emit the
      // variables and function that set a password on the clone's app role.
      // The SET_CLONE_ROLE_PASSWORD function is defined BEFORE the db phase
      // (must be in scope when the db &&-chain calls it). The companion
      // REWIRE_DB_CREDENTIALED function is defined AFTER the db phase so its
      // first occurrence in the script is post-db:ok (ordering test invariant).
      ...(app.databaseUrlEnv !== undefined
        ? [
            // The specific env var to rewrite with credentials.
            `SAMOHOST_CLONE_CRED_VAR=${sq(app.databaseUrlEnv)}`,
            // User to own the secrets file (same as the app user for secrets[]).
            `SAMOHOST_SECRETS_ENV_USER=${sq(app.appUser ?? "root")}`,
            // Derive the app role name from the template's databaseUrlEnv URL.
            // Parsed at runtime: strips VAR= prefix then extracts the user component.
            `SAMOHOST_CLONE_APP_DBROLE="$(grep -E "^${app.databaseUrlEnv}=" "$SAMOHOST_ENV_TEMPLATE" | tail -n 1 | sed -E 's/^[^=]+=//' | sed -nE 's|^"?[A-Za-z0-9+]+://([^:/@?"]+)(:[^@/]*)?@.*|\\1|p')"`,
            "",
            ...SET_CLONE_ROLE_PASSWORD_FN_LINES,
            "",
          ]
        : []),
      // Idempotent re-create (issue #59): destroy any prior clone of this id
      // FIRST, so a re-create over an existing clone succeeds instead of failing
      // at the engine with "clone already exists". This mirrors the template
      // backend's `dropdb --if-exists && createdb`: a re-create gives a FRESH
      // clone matching the deploy (previews are disposable; reusing the old
      // clone would serve stale data). The destroy tolerates an ABSENT clone
      // (first create, or the engine already expired it) — same `2>/dev/null ||
      // true` posture as the destroy script (issue #7) — so it never aborts the
      // create on a missing-clone error.
      //
      // Issue #134 fix: preview clones are created with --protected <minutes> so
      // they survive the GC between 3-minute trigger cycles. dblab clone destroy
      // rejects a protected clone with "clone is protected" (non-zero exit).
      // Because the error was swallowed by `|| true`, the subsequent clone create
      // failed with "already exists" → db:fail → outcome=failed → no
      // lastDeployedSha stamp → needDeploy=true every cycle.
      //
      // dblab has NO --force flag on destroy. The fix is:
      //   1. dblab clone update --protected false <ID>  (removes protection; no-op
      //      on an absent clone via || true)
      //   2. dblab clone destroy <ID>                   (now succeeds)
      // Protection is re-established immediately by the following clone create
      // --protected <minutes> call — the new clone is always protected.
      //
      // Verified against the live samograph VM (116.203.249.135:2223):
      //   `dblab clone destroy --help` — no --force flag
      //   `dblab clone update --help` — has --protected value flag
      '# Pre-create: unprotect (if protected) then drop any existing clone of this id',
      '# so re-create is idempotent (issue #59, #134).',
      '"$SAMOHOST_DBLAB_BIN" clone update --protected false "$SAMOHOST_CLONE_ID" 2>/dev/null || true',
      '"$SAMOHOST_DBLAB_BIN" clone destroy "$SAMOHOST_CLONE_ID" 2>/dev/null || true',
      "",
      ...phaseBlock(
        "db",
        "DBLab thin clone (destroy-if-exists + create) + .db.port extraction + prod globals sync (issue #7, #59)",
        [
          'if "$SAMOHOST_DBLAB_BIN" clone create --id "$SAMOHOST_CLONE_ID" \\',
          '     --username samohost_env --password "$SAMOHOST_DB_PASSWORD" \\',
          `     --protected ${leaseMinutes} \\`,
          "     >/dev/null \\",
          '   && SAMOHOST_DB_PORT="$(samohost_clone_port)" \\',
          '   && [[ "$SAMOHOST_DB_PORT" =~ ^[0-9]+$ ]] \\',
          // When databaseUrlEnv is set, extend the &&-chain to set the clone-role
          // password AFTER the globals sync (roles must exist before ALTER ROLE).
          ...(app.databaseUrlEnv !== undefined
            ? ["   && samohost_sync_clone_globals \\", "   && samohost_set_clone_role_password"]
            : ["   && samohost_sync_clone_globals"]),
        ],
        [
          '  echo "samohost: dblab clone create/status failed, no numeric port at .db.port in the clone status JSON, or the prod globals sync failed parity" >&2',
          "  exit 1",
        ],
      ),
      // Credentialed rewrite function placed AFTER the db phase so the first
      // occurrence of "samohost_rewire_db_credentialed" in the script is
      // post-db:ok (ordering test invariant: envfile phase follows db phase).
      ...(app.databaseUrlEnv !== undefined ? ["", ...REWIRE_DB_CREDENTIALED_FN_LINES, ""] : []),
    );
  } else if (t.dbBackend === "template") {
    const dbName = t.dbName ?? t.name.replace(/-/g, "_");
    const tpl = t.templateDb ?? `${app.name.replace(/-/g, "_")}_template`;
    const envDbVars = app.envDbVars ?? [...DEFAULT_ENV_DB_VARS];
    lines.push(
      `SAMOHOST_DB_NAME=${sq(dbName)}`,
      `SAMOHOST_TEMPLATE_DB=${sq(tpl)}`,
      "# Env vars whose URLs are rewired to the per-env db (AppRecord.envDbVars).",
      `SAMOHOST_ENV_DB_VARS=(${envDbVars.map(sq).join(" ")})`,
      "",
      ...REWIRE_DB_VARS_FN_LINES,
      "",
      // NO per-env role / password (issue #11 findings 2+3): the env keeps the
      // SAME roles as production, so template-copied grants and RLS policies
      // apply unchanged. Isolation between envs on the same host is accepted
      // as weaker for the SOLO plan (documented in SPEC-DELTA §4).
      ...phaseBlock(
        "db",
        "drop-if-exists + fresh template copy (re-run idempotent; a re-run RESETS env data — previews are disposable)",
        [
          // Exact-path sudo: grants are listed in the host-prep script.
          'if sudo -u postgres /usr/bin/dropdb --if-exists "$SAMOHOST_DB_NAME" \\',
          '   && sudo -u postgres /usr/bin/createdb --template="$SAMOHOST_TEMPLATE_DB" "$SAMOHOST_DB_NAME"; ',
        ],
      ),
    );
  }

  // ----- envfile ---------------------------------------------------------------
  // Issue #101: when `appUser` is registered the env dir is owned by appUser
  // (the sudo-u-appUser clone created it); running cp/chmod/printf/install/mv
  // as the SSH user (samo) → EACCES.
  //
  // samorev security fix: the prior approach used a broad
  // `sudo -u appUser /usr/bin/bash -s << 'HEREDOC'` that let samo run
  // arbitrary commands as appUser. Replaced by composing .env content in a
  // samo-owned temp file (mktemp, /tmp) and writing it via scoped ops:
  //   install -m 600 /dev/null → pre-create at 600
  //   tee < tmpfile >/dev/null → write content
  //   chmod 600                → re-assert mode
  // See buildEnvfileScopedBodyLines() for full design rationale.
  //
  // When appUser is absent: the original &&-chain body is used unchanged
  // (backward compatibility for AppRecords that predate the appUser field).
  let envfileBody: string[];
  if (app.appUser !== undefined) {
    envfileBody = buildEnvfileScopedBodyLines(app, t, portMap, allListeners);
  } else {
    // Original &&-chain body (no appUser — backward compat).
    // Set the preview-env marker so the banner fires. env create is
    // preview-ONLY by construction (prod ships via app/script.ts, a separate
    // path). SAMO_BRANCH uses $SAMOHOST_BRANCH (already sq()-escaped at the
    // top of the script) so branch values with slashes (e.g. demo/red-login)
    // are interpolated safely without further quoting in an env-file value.
    // BASE_URL: the app builds the magic-link sign-in URL as
    //   `${BASE_URL}/api/auth/magic-link/verify?token=...`
    // (field-record src/app.ts). The operator template carries PROD's BASE_URL
    // (e.g. https://field-record-1.samo.team), so a verbatim copy makes every
    // preview magic link point at PROD — clicking it logs the user into prod,
    // not the preview. Rewrite BASE_URL to the preview's OWN vhost. STRIP any
    // template BASE_URL first (dotenv loaders are not all last-wins;
    // append-only is unsafe). The intermediate file is PRE-CREATED at mode 600
    // (install -m 600 /dev/null) BEFORE the redirect: a bare `> file` would
    // create it under the umask (typically 644 = world-readable), and it
    // carries every credential except BASE_URL. `grep -v` exits non-zero when
    // NO line matches (template carries no BASE_URL at all — current prod
    // template state); `|| true` keeps the && chain alive under `set -e`.
    envfileBody = [
      "if cp \"$SAMOHOST_ENV_TEMPLATE\" \"$SAMOHOST_ENV_DIR/.env\" \\",
      "   && chmod 600 \"$SAMOHOST_ENV_DIR/.env\" \\",
    ];
    // Per-listener portEnv strip-then-append: operator templates legitimately
    // carry prod port values (e.g. WS_HUB_PORT=8788); append-only would let
    // dotenv order decide the winner (unsafe). Strip the stale prod value first,
    // then append the allocated preview port. Same idiom as the BASE_URL strip.
    for (const { listener } of allListeners) {
      const allocatedPort = portMap.get(listener.name) ?? t.port;
      envfileBody.push(
        `   && _sh_env_tmp="$(mktemp)" \\`,
        `   && { grep -vE ${sq(`^${listener.portEnv}=`)} "$SAMOHOST_ENV_DIR/.env" >> "$_sh_env_tmp" || true; } \\`,
        `   && mv "$_sh_env_tmp" "$SAMOHOST_ENV_DIR/.env" \\`,
        `   && chmod 600 "$SAMOHOST_ENV_DIR/.env" \\`,
        `   && printf ${sq(`${listener.portEnv}=${String(allocatedPort)}\\n`)} >> "$SAMOHOST_ENV_DIR/.env" \\`,
      );
    }
    if (t.dbBackend === "template") {
      // Rewire every mapped var to the per-env db ON THE HOST (issue #11).
      envfileBody.push('   && samohost_rewire_db_vars "$SAMOHOST_ENV_DIR/.env" \\');
    } else if (t.dbBackend === "dblab") {
      // Rewire every mapped var's host:port at the clone ON THE HOST (issue #7,
      // closing the PR #12 TODO): the clone is a physical copy of prod, so the
      // template's credentials and database name stay valid inside it.
      envfileBody.push(
        '   && samohost_rewire_db_hostport "$SAMOHOST_ENV_DIR/.env" \\',
      );
      if (app.databaseUrlEnv !== undefined) {
        // Credentialed URL rewrite: replaces user:pw@host:port with clone-role
        // credentials (set in the db phase via samohost_set_clone_role_password).
        // Runs AFTER hostport rewire so the host:port is already correct.
        envfileBody.push(
          '   && samohost_rewire_db_credentialed "$SAMOHOST_ENV_DIR/.env" \\',
        );
      }
    }
    envfileBody.push(
      '   && printf \'\\nSAMO_ENV=preview\\nSAMO_BRANCH=%s\\n\' "$SAMOHOST_BRANCH" >> "$SAMOHOST_ENV_DIR/.env" \\',
    );
    envfileBody.push(
      '   && install -m 600 /dev/null "$SAMOHOST_ENV_DIR/.env.baseurl" \\',
    );
    envfileBody.push(
      '   && { grep -vE \'^BASE_URL=\' "$SAMOHOST_ENV_DIR/.env" >> "$SAMOHOST_ENV_DIR/.env.baseurl" || true; } \\',
    );
    envfileBody.push('   && mv "$SAMOHOST_ENV_DIR/.env.baseurl" "$SAMOHOST_ENV_DIR/.env" \\');
    envfileBody.push(
      '   && printf \'BASE_URL=https://%s\\n\' "$SAMOHOST_VHOST" >> "$SAMOHOST_ENV_DIR/.env" \\',
    );
    envfileBody.push('   && chmod 600 "$SAMOHOST_ENV_DIR/.env" \\');
    envfileBody.push("   && true; ");
  }
  lines.push(
    ...phaseBlock(
      "envfile",
      "compose .env ON-HOST from the operator template (samohost never sees values)",
      envfileBody,
    ),
  );

  // ----- secrets-preflight + secrets ------------------------------------------
  // When app.secrets is non-empty:
  //   1. PREFLIGHT: verify that every service unit template on this host already
  //      carries the EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env line.
  //      If not, the host-prep has not been re-run after PR-B shipped.  Fail
  //      LOUD with an actionable message rather than silently booting the app
  //      without secrets.  (BLOCKER 1b fix.)
  //   2. SECRETS: call the samohost-secrets helper (installed by host-prep) via
  //      ONE exact-path sudo grant.  The helper validates the env-name, creates
  //      the 0600 file, reuses existing values (REBUILD REUSE), and generates
  //      new ones via openssl rand -hex 32 ON THE VM.  Values never appear in
  //      this script's stdout; all file ops run inside the helper.
  //      The phase is wrapped in phaseBlock so failures emit secrets:fail.
  if ((app.secrets ?? []).length > 0) {
    const secretsEnvUser = app.appUser ?? "root";
    const secretNames = app.secrets!;
    // All unique service unit template paths that must carry the secrets
    // EnvironmentFile line.  For legacy single-service apps this is just the
    // one primary unit; for multi-service apps every service unit is checked.
    const { services: svcs } = servicesOf(app);
    const uniqueUnits = [...new Set(svcs.map((s) => s.unit))];

    // --- secrets-preflight ---------------------------------------------------
    lines.push(
      `# --- secrets-preflight: verify unit templates have secrets EnvironmentFile ---`,
      marker("secrets-preflight", "start"),
      `_secrets_preflight_ok=1`,
    );
    for (const unitName of uniqueUnits) {
      const templatePath = `/etc/systemd/system/${unitName}@.service`;
      lines.push(
        `if ! grep -qF 'EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env' ${sq(templatePath)} 2>/dev/null; then`,
        `  echo "samohost: unit template ${templatePath} is missing EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env — re-run 'samohost env plan --host-prep' to install secrets support, then re-create this env" >&2`,
        `  _secrets_preflight_ok=0`,
        `fi`,
      );
    }
    lines.push(
      `if [[ "$_secrets_preflight_ok" == "1" ]]; then`,
      `  ${marker("secrets-preflight", "ok")}`,
      `else`,
      `  ${marker("secrets-preflight", "fail")}`,
      `  exit 1`,
      `fi`,
      ``,
    );

    // --- secrets (via helper, wrapped in phaseBlock) -------------------------
    // Values are generated ON THE VM inside the helper (openssl rand -hex 32).
    // The helper performs: mkdir, create-at-0600 if absent, reuse-or-generate
    // per name, chmod 600 — all under ONE root grant for /usr/local/sbin/samohost-secrets.
    lines.push(
      ...phaseBlock(
        "secrets",
        "generate per-env secrets via samohost-secrets helper (values on-VM only; never echoed)",
        [
          `if sudo /usr/local/sbin/samohost-secrets init ${sq(t.name)} ${sq(secretsEnvUser)} ${secretNames.map(sq).join(" ")}; `,
        ],
      ),
    );
  }

  // ----- migrate (optional) -----------------------------------------------
  // SAFETY GATE: only emit the migrate phase when the resolved DB backend is
  // `dblab` or `template` — i.e. when a per-env DB is guaranteed AND the
  // composed .env has been rewired to it. For `dbBackend: "none"` there is NO
  // per-env DB rewiring, so the composed .env still carries the operator
  // template's PROD DATABASE_URL. Emitting migrateCmd in that state would
  // apply unmerged branch migrations directly to the LIVE PROD DATABASE — a
  // catastrophic, irreversible action. The db-preflight failure hint (above)
  // already SUGGESTED `--db none` as a fallback; hardening it here closes the
  // path: an operator who follows that hint cannot accidentally migrate prod.
  //
  // When `migrateCmd` is absent, or when dbBackend is `none`, the generated
  // script is byte-identical to pre-feature output — the phase is absent.
  //
  // Environment sourcing: same principle as src/app/script.ts:141.
  //   no-appUser path: samo owns SAMOHOST_ENV_DIR/.env (0600); source it in a
  //     subshell before migrateCmd so DATABASE_URL (clone URL) is visible.
  //   appUser path: appUser owns the .env and reads it; wrap migrateCmd with
  //     sudo -u <appUser> (same pattern as install/build). The migration tool
  //     runs as appUser in SAMOHOST_ENV_DIR where .env is readable by appUser.
  //
  // Fail-closed: a non-zero exit from migrateCmd emits migrate:fail + exit 1,
  // same as every other phase. Idempotent runners no-op when already current.
  if (app.migrateCmd !== undefined && (t.dbBackend === "dblab" || t.dbBackend === "template")) {
    // Issue #163: SSH user IS appUser when appUser is set, so migrateCmd runs
    // directly as the dir owner — no sudo-u delegation needed.
    // Both paths source .env in a subshell so DATABASE_URL (rewritten to the
    // clone) is visible to the migration tool.
    // cd to SAMOHOST_ENV_DIR first: buildCmd may have done `cd apps/web` (or
    // similar) which changes the outer shell's CWD; the subshell inherits it.
    const migrateCmdExpr =
      `if (cd "$SAMOHOST_ENV_DIR" && set -a && . "$SAMOHOST_ENV_DIR/.env" && set +a && ${app.migrateCmd}); `;
    lines.push(
      ...phaseBlock(
        "migrate",
        "run migrateCmd in $SAMOHOST_ENV_DIR with composed env (branch schema applied before app boots)",
        [migrateCmdExpr],
      ),
    );
  }

  // ----- unit ------------------------------------------------------------------
  // Restart semantics: `enable --now` is a NO-OP on an already-active unit,
  // so a re-create/heal that rewrites .env never reloads the app's DB config.
  //
  // Strategy per service unit:
  //   - not yet active → `sudo /usr/bin/systemctl enable --now` (first-create)
  //   - already active → `disable --now` then `enable --now` (stop + restart)
  //
  // WHY disable--now+enable--now instead of bare restart: adopted VMs received
  // only enable --now / disable --now / reset-failed in their NOPASSWD sudoers
  // grant; a bare `restart` grant was NEVER added. Both `disable --now` and
  // `enable --now` are universally granted, so the two-call sequence works on
  // every host type without a new grant.
  //
  // `is-active` is UNPRIVILEGED — bare `systemctl is-active` (no sudo). The
  // hardened host's NOPASSWD block covers only enable/disable/reset-failed;
  // `sudo is-active` is DENIED (exit 1) → if-branch always false → only
  // `enable --now` would ever run. Consistent with PORT_CHECK_FN_LINES.
  //
  // Unit instances are baked as literals (not via a shell variable) so the
  // script is self-documenting and the pattern is testable without runtime
  // expansion.
  //
  // AGGREGATION (multi-service only): when there are 2+ services, we use a
  // `unit_all_ok` flag (mirroring `port_check_all_ok` and `health_ok`) so that
  // a failure on ANY service causes `unit:fail` + exit 1 — not just the last
  // service. Single-service (legacy) uses the unchanged `if { ... }` form via
  // phaseBlock so that the byte-identical gate still holds.
  {
    const unitInstances = services.map((svc) => `${svc.unit}@${t.name}.service`);
    const unitComment =
      "systemd template instances — disable--now+enable--now if already active, enable--now on first create (full-path sudo; grants in host-prep)";

    if (unitInstances.length === 1) {
      // LEGACY / single-service path: byte-identical to pre-aggregation output.
      const instance = unitInstances[0]!;
      const unitCommentBody: string[] = [
        "if { \\",
        `     # service unit: ${instance}`,
        `     if systemctl is-active ${sq(instance)} >/dev/null 2>&1; then \\`,
        `       sudo /usr/bin/systemctl disable --now ${sq(instance)} \\`,
        `         && sudo /usr/bin/systemctl enable --now ${sq(instance)}; \\`,
        "     else \\",
        `       sudo /usr/bin/systemctl enable --now ${sq(instance)}; \\`,
        "     fi \\",
        "   }; ",
      ];
      lines.push(...phaseBlock("unit", unitComment, unitCommentBody));
    } else {
      // MULTI-SERVICE path: aggregate all-service outcomes into unit_all_ok.
      // Mirrors the port_check_all_ok pattern: initialise ok=1, set to 0 on any
      // per-service failure, and emit unit:fail + exit 1 unless all succeeded.
      lines.push(
        `# --- unit: ${unitComment} ---`,
        marker("unit", "start"),
        "unit_all_ok=1",
      );
      for (const instance of unitInstances) {
        lines.push(
          `# service unit: ${instance}`,
          `if systemctl is-active ${sq(instance)} >/dev/null 2>&1; then`,
          `  sudo /usr/bin/systemctl disable --now ${sq(instance)} \\`,
          `    && sudo /usr/bin/systemctl enable --now ${sq(instance)} || unit_all_ok=0`,
          "else",
          `  sudo /usr/bin/systemctl enable --now ${sq(instance)} || unit_all_ok=0`,
          "fi",
        );
      }
      lines.push(
        'if [[ "$unit_all_ok" == "1" ]]; then',
        `  ${marker("unit", "ok")}`,
        "else",
        `  ${marker("unit", "fail")}`,
        "  exit 1",
        "fi",
        "",
      );
    }
  }

  // ----- vhost -----------------------------------------------------------------
  // The record is PROXIED (orange cloud), so CF edge fronts the origin. Caddy
  // uses `tls internal` (self-signed cert); CF Full mode accepts a self-signed
  // origin cert. No browser ever sees the self-signed cert — CF terminates the
  // real edge cert. Direct-to-origin is impossible on CF-locked VMs (firewall
  // allows :443 from CF IPs only), so the `tls internal` self-signed cert is
  // never exposed to clients. ACME is not used: it cannot complete behind a
  // CF-locked :443 and the host has no DNS-01 plugin.
  //
  // The vhost snippet is produced by renderVhost(planFromEnv(app, envRecord))
  // — the SAME renderer used for production main-host vhosts. For legacy
  // single-service apps (zero routes), renderVhost() emits a BARE
  // `reverse_proxy localhost:<port>` with NO `handle {}` wrapper, which is
  // Caddy-semantically identical to the previous printf form. For multi-service
  // apps the renderer adds named matchers and handle blocks.
  //
  // The `log { output file ... format json }` block is the idle-GC access-log
  // hook (writes one JSON line per request with `ts` and `request.host`). The
  // idle-GC pass reads max(ts) from this file to stamp EnvRecord.lastAccess,
  // enabling idle detection from real traffic rather than createdAt.
  // `/var/log/caddy/` is the standard Caddy log dir; host-prep sudoers already
  // grants write access. The idle-GC contract requires this block on every vhost.
  {
    // Build a minimal EnvRecord-like object for planFromEnv. planFromEnv reads
    // target.ports (multi-service) or target.port (legacy) and the vhost name.
    const envRecordForPlan: EnvRecord = {
      id: "tmp",
      vmId: "",
      appName: app.name,
      branch: t.branch,
      name: t.name,
      port: t.port,
      ...(t.ports !== undefined ? { ports: t.ports } : {}),
      vhost: t.vhost,
      dbBackend: t.dbBackend,
      createdAt: "",
    };
    const vhostContent = renderVhost(planFromEnv(app, envRecordForPlan));
    // Escape the vhost content for safe embedding in a printf argument. The
    // content is produced by our own renderer so it contains no secrets, but
    // backslashes and single-quotes still need escaping for the sq() wrapper.
    const vhostSq = sq(vhostContent);
    lines.push(
      ...phaseBlock(
        "vhost",
        "Caddy vhost snippet + reload via renderVhost (sites.d include applied in host-prep)",
        [
          `if printf %s ${vhostSq} \\`,
          '   | sudo /usr/bin/tee "$SAMOHOST_CADDY_SNIPPET" >/dev/null \\',
          "   && sudo /usr/bin/systemctl reload caddy; ",
        ],
      ),
    );
  }

  // ----- health ------------------------------------------------------------------
  // Poll every listener that declares a healthPath. All must return HTTP 200
  // for the env to be considered healthy. Listeners without healthPath are
  // not probed (internal/metrics listeners that should not be publicly reachable
  // are excluded from health gating).
  {
    const healthableListeners = allListeners.filter(
      ({ listener }) => listener.healthPath !== undefined,
    );

    lines.push(
      `# --- health: poll all listeners that declare a healthPath ---`,
      marker("health", "start"),
      "health_ok=1",
    );

    for (const { listener } of healthableListeners) {
      const allocatedPort = portMap.get(listener.name) ?? t.port;
      const healthUrl = `http://localhost:${allocatedPort}${listener.healthPath ?? "/"}`;
      lines.push(
        `# listener: ${listener.name} (${listener.portEnv}=${allocatedPort})`,
        `health_ok_${listener.name.replace(/-/g, "_")}=0`,
        `for attempt in $(seq 1 ${HEALTH_RETRIES}); do`,
        `  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${sq(healthUrl)} || echo 000)`,
        '  if [[ "$code" == "200" ]]; then',
        `    health_ok_${listener.name.replace(/-/g, "_")}=1`,
        "    break",
        "  fi",
        `  sleep ${HEALTH_SLEEP_SEC}`,
        "done",
        `if [[ "$health_ok_${listener.name.replace(/-/g, "_")}" != "1" ]]; then`,
        `  echo "env health check failed for listener ${listener.name} (${healthUrl}) — env left in place for inspection; destroy to clean up" >&2`,
        "  health_ok=0",
        "fi",
      );
    }

    lines.push(
      'if [[ "$health_ok" == "1" ]]; then',
      `  ${marker("health", "ok")}`,
      "else",
      `  ${marker("health", "fail")}`,
      "  exit 1",
      "fi",
      "",
      'echo "env ready: https://${SAMOHOST_VHOST} (port ${SAMOHOST_PORT})"',
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Build the env DESTROY script. Idempotent by design (every step tolerates
 * "already gone") so it doubles as the cleanup path for a failed create.
 *
 * When `app.kind === "static"` the unit-stop and db-drop phases are omitted
 * (there is no service and no DB for a static env). envOutcome in env/parse.ts
 * is lenient — it only fails on a `fail` marker and tolerates missing phases —
 * so omitting unit-stop/db-drop is safe.
 */
export function buildEnvDestroyScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
  const isStatic = app.kind === "static";
  const root = envsRoot(app);
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# samohost env-destroy script (generated; idempotent — safe after a failed create).",
    "set -uo pipefail",
    "",
    `SAMOHOST_ENV_NAME=${sq(t.name)}`,
    `SAMOHOST_ENV_DIR=${sq(`${root}/${t.name}`)}`,
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
  ];

  if (!isStatic) {
    // Node path: stop all service units in the topology.
    // Use servicesOf() so multi-service apps stop every service; legacy apps
    // produce a single-service view (same as the old SAMOHOST_UNIT_INSTANCE).
    // `disable --now ... || true` is absent-tolerant: destroying a legacy env
    // whose AppRecord later gained multi-service declarations is safe.
    const { services } = servicesOf(app);
    const unitInstances = services.map((svc) => `${svc.unit}@${t.name}.service`);
    lines.push(
      `# --- unit-stop ---`,
      marker("unit-stop", "start"),
    );
    for (const instance of unitInstances) {
      lines.push(
        `sudo /usr/bin/systemctl disable --now ${sq(instance)} 2>/dev/null || true`,
        `# Clear any residual 'failed' unit state (issue #11 finding 8; cosmetic).`,
        `sudo /usr/bin/systemctl reset-failed ${sq(instance)} 2>/dev/null || true`,
      );
    }
    lines.push(
      marker("unit-stop", "ok"),
      "",
    );
  }

  lines.push(
    `# --- vhost-remove ---`,
    marker("vhost-remove", "start"),
    'sudo /usr/bin/rm -f "$SAMOHOST_CADDY_SNIPPET"',
    "sudo /usr/bin/systemctl reload caddy || true",
    marker("vhost-remove", "ok"),
    "",
  );

  // Static envs have no DB — skip db-drop entirely (envOutcome is lenient;
  // missing phases are tolerated; only a `fail` marker fails the outcome).
  if (!isStatic) {
    if (t.dbBackend === "dblab") {
      const dbName = t.dbName ?? t.name;
      lines.push(
        `SAMOHOST_CLONE_ID=${sq(dbName)}`,
        ...DBLAB_BIN_RESOLVE_LINES,
        `# --- db-drop: delete the DBLab clone (issue #7: resolved CLI; a missing`,
        `# CLI must not abort teardown — idle clones auto-expire on the engine) ---`,
        marker("db-drop", "start"),
        'if [[ -n "$SAMOHOST_DBLAB_BIN" ]]; then',
        '  "$SAMOHOST_DBLAB_BIN" clone destroy "$SAMOHOST_CLONE_ID" 2>/dev/null || true',
        "else",
        '  echo "samohost: dblab CLI not found (PATH or ~/bin/dblab) — clone left for the engine to expire" >&2',
        "fi",
        marker("db-drop", "ok"),
        "",
      );
    } else if (t.dbBackend === "template") {
      const dbName = t.dbName ?? t.name.replace(/-/g, "_");
      lines.push(
        `SAMOHOST_DB_NAME=${sq(dbName)}`,
        `# --- db-drop: drop the per-env database and role ---`,
        marker("db-drop", "start"),
        'sudo -u postgres /usr/bin/dropdb --if-exists "$SAMOHOST_DB_NAME"',
        'printf \'DROP ROLE IF EXISTS "%s";\\n\' "$SAMOHOST_DB_NAME" | sudo -u postgres /usr/bin/psql --quiet --file=- >/dev/null || true',
        marker("db-drop", "ok"),
        "",
      );
    }
  }

  // ----- secrets-cleanup: remove per-env secrets dir -------------------------
  // When the app declares secrets[], remove /var/lib/samohost/envs/<name>/
  // to prevent stale secret values from being inherited if the env is later
  // recreated.  Runs via the samohost-secrets helper (same grant as env-create).
  // `|| true` keeps destroy idempotent when the dir is already gone or the
  // helper is absent (e.g. on a host that was prepped before PR-B shipped).
  if (!isStatic && (app.secrets ?? []).length > 0) {
    lines.push(
      `# --- secrets-cleanup: remove per-env secrets dir (prevents stale value inheritance) ---`,
      `sudo /usr/local/sbin/samohost-secrets clean ${sq(t.name)} 2>/dev/null || true`,
      ``,
    );
  }

  lines.push(
    `# --- dir-remove ---`,
    marker("dir-remove", "start"),
    'rm -rf "$SAMOHOST_ENV_DIR"',
    marker("dir-remove", "ok"),
    "",
    'echo "env destroyed: ${SAMOHOST_ENV_NAME}"',
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildSecretsRotateScript — regenerate ALL per-env secrets + restart units
// ---------------------------------------------------------------------------

/**
 * Build a bash script that regenerates ALL declared secrets for an env with
 * fresh random values (openssl rand -hex 32 on the VM) and restarts all
 * service units so the new values take effect.
 *
 * Unlike {@link buildEnvCreateScript}'s secrets phase, rotate does NOT reuse
 * existing values — it unconditionally overwrites the secrets file. This is
 * the ONLY intentional regeneration path; env-create always preserves existing
 * values to keep sessions valid across rebuilds.
 *
 * Privilege model: all secrets.env operations run as root via `sudo` (same as
 * env-create). Units are restarted using disable--now + enable--now (the
 * universally-granted pattern from buildHostPrepScript sudoers; no bare
 * `restart` grant is assumed on adopted hosts).
 *
 * Precondition: the caller has already verified that `app.secrets` is non-empty;
 * the sudoers grants emitted by {@link buildHostPrepScript} are in place.
 */
export function buildSecretsRotateScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
  assertOptionalLinuxAppUser(app.appUser);
  const envUser = app.appUser ?? "root";
  const secrets = app.secrets ?? [];
  const { services } = servicesOf(app);

  const lines: string[] = [
    "#!/usr/bin/env bash",
    `# samohost env secrets rotate for env ${sq(t.name)} (generated; pushed via ssh bash -s).`,
    "# Regenerates ALL declared secrets with fresh random values.",
    "# Only ACTIVE unit instances are restarted — stopped units are left stopped.",
    "set -euo pipefail",
    "",
    `# 1. Rotate all secrets via the samohost-secrets helper.`,
    `#    The helper rm-then-recreates the file, generates ALL names unconditionally`,
    `#    (no reuse on rotate), and sets mode 0600. Values are generated on-VM.`,
    `sudo /usr/local/sbin/samohost-secrets rotate ${sq(t.name)} ${sq(envUser)} ${secrets.map(sq).join(" ")}`,
    ``,
    `# 2. Restart ACTIVE unit instances so new secrets take effect.`,
    `#    disable--now + enable--now is the universally-granted restart pattern`,
    `#    (no bare restart grant on adopted hosts — issue #99 lesson).`,
    `#    Stopped units are intentionally NOT started: rotation only applies to`,
    `#    running envs; starting a stopped env is env-create's responsibility.`,
  ];

  for (const svc of services) {
    const instance = `${svc.unit}@${t.name}.service`;
    lines.push(
      `if systemctl is-active ${sq(instance)} >/dev/null 2>&1; then`,
      `  sudo /usr/bin/systemctl disable --now ${sq(instance)} \\`,
      `    && sudo /usr/bin/systemctl enable --now ${sq(instance)}`,
      `fi`,
    );
  }

  return lines.join("\n");
}

/**
 * Main-env vhost host validation (field-record-1#117 ITEM C). Local mirror of
 * commands/env.ts `isValidPreviewDomain` — importing it here would create an
 * import cycle (commands/env.ts imports this module). The host is embedded in
 * a ROOT-run script, so fail closed on anything that is not a dotted
 * lowercase DNS name (same posture as the invalid-preview-domain fix, #28).
 */
function isValidMainHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  return (
    new RegExp(`^${label}(?:\\.${label})*\\.[a-z]{2,63}$`).test(
      host.toLowerCase(),
    ) && host === host.toLowerCase()
  );
}

/**
 * Production app port for the main-env vhost, derived from
 * {@link AppRecord.healthUrl} (the only place the app record carries the
 * production listen port, e.g. http://localhost:3000/api/version → 3000).
 * Fails closed on an unparseable URL — never render a vhost pointing at a
 * guessed port.
 */
function mainEnvPort(app: AppRecord): number {
  let u: URL;
  try {
    u = new URL(app.healthUrl);
  } catch {
    throw new Error(
      `cannot derive the main-env vhost port for app '${app.name}': ` +
        `unparseable healthUrl ${JSON.stringify(app.healthUrl)} — fix the ` +
        `app record (or unset mainHost)`,
    );
  }
  if (u.port !== "") return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

/**
 * Generate the firewall section lines for the host-prep script.
 *
 * Returns an array of bash lines (no trailing newline / blank — the caller
 * appends an empty string to produce the separator blank line).
 *
 * Security posture:
 * - Never emit `ufw allow 443/tcp` or `ufw allow 80/tcp` (world-open forms).
 * - :443 rules are source-restricted to Cloudflare IP ranges, fetched at
 *   host-prep execution time from the canonical Cloudflare HTTPS endpoints.
 *   Fetching inside the generated bash (not at TS build time) means the list
 *   is current when the operator actually runs the script, and keeps this
 *   module side-effect-free (no network I/O in the builder).
 * - :80 rule (when controlPlaneIp is provided) is source-restricted to the
 *   single control-plane IP/CIDR.
 *
 * UFW syntax: the extended `from … to any port N` form requires proto to be
 * specified as a separate keyword BEFORE `from`, not as a `/proto` suffix on
 * the port number.  Ubuntu 24.04 ufw rejects `port 443/tcp` inside extended
 * rules — the rule errors out and is silently not added.  Correct form:
 *   ufw allow proto tcp from <src> to any port 443
 */
export function buildFirewallLines(
  isStatic: boolean,
  sshUser: string,
  opts?: HostPrepFirewallOpts,
): string[] {
  const allowCfHttps = opts?.allowCfHttps ?? true;
  const { controlPlaneIp } = opts ?? {};
  const stepNum = isStatic ? "4" : "5";

  const lines: string[] = [
    `# ${stepNum}. Firewall: source-restricted rules so the origin only answers`,
    `#    requests arriving from expected sources (Cloudflare edge / control-plane).`,
    `#    /usr/sbin/ufw is the canonical path on Ubuntu 22.04/24.04.`,
    `#    Run directly (this whole script is the ONE-TIME root host-prep), so NO`,
    `#    NOPASSWD sudoers grant for ufw is added above: the env create/destroy`,
    `#    scripts (run later as the non-root ${sshUser} user) never call ufw —`,
    `#    rules are opened once here, not per env.`,
  ];

  if (allowCfHttps) {
    lines.push(
      `#`,
      `#    :443 — Allow ONLY from Cloudflare IP ranges. Fetches the current`,
      `#    published ranges at host-prep time (https://www.cloudflare.com/ips-v4`,
      `#    and ips-v6 are the canonical sources; updated infrequently with advance`,
      `#    notice). Re-run host-prep after a CF range update to pick up new CIDRs.`,
      `#    Each range rule is idempotent (ufw deduplicates). If curl fails (no`,
      `#    internet at host-prep time), the loop body never runs and no :443 rules`,
      `#    are added — the host will reject CF edge connections until host-prep is`,
      `#    re-run with connectivity. '|| true' prevents script abort on curl failure.`,
      `for _cf4 in $(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4 2>/dev/null || true); do`,
      `  /usr/sbin/ufw allow proto tcp from "$_cf4" to any port 443`,
      `done`,
      `for _cf6 in $(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6 2>/dev/null || true); do`,
      `  /usr/sbin/ufw allow proto tcp from "$_cf6" to any port 443`,
      `done`,
    );
  }

  if (controlPlaneIp !== undefined) {
    lines.push(
      `#`,
      `#    :80 — Allow ONLY from the control-plane IP (CF→control-plane→VM:80`,
      `#    internal leg). World-open :80 is never emitted.`,
      `/usr/sbin/ufw allow proto tcp from '${controlPlaneIp}' to any port 80`,
    );
  }

  return lines;
}

/**
 * Firewall options for {@link buildHostPrepScript}.
 *
 * The fleet has two distinct serving shapes:
 *
 * 1. **CF-direct** (preview envs / static sites): CF edge → VM:443 directly.
 *    Use the default `allowCfHttps: true` — the generated script fetches the
 *    Cloudflare published IP ranges at host-prep time and emits one
 *    source-restricted allow rule per CIDR.  This avoids pinning a stale list
 *    in code and requires no build-time dependency.
 *
 * 2. **Control-plane-fronted** (prod app envs): CF → control-plane → VM:80.
 *    Pass `controlPlaneIp` to emit a source-restricted `:80` rule.  Set
 *    `allowCfHttps: false` when the VM never receives direct CF ingress on
 *    `:443` (e.g. the control-plane terminates TLS, and only forwards HTTP).
 */
export interface HostPrepFirewallOpts {
  /**
   * For the CF→control-plane→VM:80 serving shape: IP or CIDR of the control
   * plane whose requests must reach the VM on port 80 (plain HTTP, internal
   * leg).  When set, the generated script emits:
   *   /usr/sbin/ufw allow proto tcp from '<controlPlaneIp>' to any port 80
   * Absent: no :80 rule is emitted (VM:80 stays blocked — correct for
   * CF-direct VMs where CF terminates TLS at the VM itself).
   */
  controlPlaneIp?: string;

  /**
   * For the CF→VM:443 direct serving shape (preview envs / static sites).
   * When `true` (the default), the generated script fetches CF IP ranges at
   * runtime from https://www.cloudflare.com/ips-v4 and ips-v6 and emits a
   * source-restricted allow rule per CIDR:
   *   /usr/sbin/ufw allow proto tcp from '<cidr>' to any port 443
   * Set to `false` only for control-plane-fronted VMs that never receive
   * direct CF ingress on :443.
   *
   * @default true
   */
  allowCfHttps?: boolean;

  /**
   * When `true`, the generated host-prep script will overwrite a differing
   * live main vhost file rather than refusing.  A timestamped backup is
   * created before the overwrite; `caddy validate` is run and the backup is
   * restored on validate failure.
   *
   * Default `false`: the guard **refuses** to overwrite a live file that
   * differs from the staged content.  This protects hand-authored multi-service
   * vhosts (e.g. samograph) from being silently clobbered by a re-run
   * host-prep that only knows the single-service reverse_proxy form.
   *
   * @default false
   */
  forceMainVhost?: boolean;
}

/**
 * Render the ONE-TIME host preparation an operator with root must review and
 * apply before `env create` can run on a (vm, app): the Caddy sites.d include,
 * the durable main-env vhost (when {@link AppRecord.mainHost} is set), the
 * exact-path sudoers grants the env scripts rely on, and the firewall rules.
 *
 * Firewall posture (see {@link HostPrepFirewallOpts}):
 * - :443 rules are source-restricted to Cloudflare IP ranges (fetched at
 *   host-prep time) — NOT world-open.  The old `ufw allow 443/tcp` form is
 *   intentionally absent; every :443 allow carries an explicit `from <CIDR>`.
 * - :80 rules are emitted only when `controlPlaneIp` is provided, and are
 *   similarly source-restricted to that single IP/CIDR.
 *
 * When `app.kind === "static"` (issue #36): the systemd template unit, the
 * env-template-file step, and the DB sudoers grants are OMITTED (a static env
 * has no service, no DB, no env file). The Caddy/ufw/DNS steps are kept
 * unchanged — static HTTPS still needs them.
 *
 * This script is NOT meant to be piped to bash by samohost — it is printed
 * for human review (`samohost env plan --host-prep`).
 */
export function buildHostPrepScript(
  app: AppRecord,
  sshUser: string,
  firewallOpts?: HostPrepFirewallOpts,
): string {
  assertOptionalLinuxAppUser(app.appUser);
  const staticRoot = staticRootOf(app);
  const isStatic = app.kind === "static";
  const isStaticReleaseChannel = isStatic && app.releaseTagPattern !== undefined;
  const managesMainVhost = app.mainHost !== undefined && !isStaticReleaseChannel;
  const root = envsRoot(app);
  // Issue #97: the preview unit and the envs root must be owned by the app
  // user when appUser is registered. Fall back to sshUser for back-compat with
  // AppRecords that predate the appUser field.
  const envUser = app.appUser ?? sshUser;

  // Durable MAIN-env vhost (field-record-1#117 ITEM C, 7th drift class): the
  // production vhost must be provisioned state in sites.d, not a hand-applied
  // VM-local Caddy edit that the next Caddyfile churn de-references together
  // with every preview snippet (observed: Cloudflare 521 on *.samo.cat).
  //
  // Landmine guard: multi-service apps (e.g. samograph) hand-author this file
  // with path/ws routing that the single-service render does not know about.
  // A bare overwrite silently drops all custom routing → prod goes dark.
  // The emitted samohost_apply_main_vhost() guard refuses to overwrite a
  // differing live file unless --force-main-vhost was set for this invocation.
  const guardFnLines: string[] = [];
  const mainVhostLines: string[] = [];
  if (app.mainHost !== undefined && !isValidMainHost(app.mainHost)) {
    throw new Error(
      `invalid mainHost ${JSON.stringify(app.mainHost)} for app ` +
        `'${app.name}' — expected a dotted lowercase DNS name like ` +
        `"app.example.com" (embedded in a root-run script; ` +
        `failing closed)`,
    );
  }
  if (managesMainVhost) {
    // Narrowed by managesMainVhost, but keep a local constant so TypeScript and
    // the generated prose both reflect that this branch owns a concrete host.
    const mainHost = app.mainHost!;
    const port = mainEnvPort(app);
    const livePath = `/etc/caddy/sites.d/00-main-${app.name}.caddy`;
    const stagedPath = `/etc/caddy/sites.d/.staged-00-main-${app.name}.caddy`;
    const bakedForce = firewallOpts?.forceMainVhost === true ? "true" : "false";

    // Guard function definition — emitted early in the script (after set -euo
    // pipefail) so it is available when called later in the Caddy step.
    // All inner closing tokens use fi/done (not `}`), so the only `}` at
    // column 0 is the function's own closing brace — safe for extractFn().
    guardFnLines.push(
      "# Landmine guard: compare staged vs live main vhost; refuse if different",
      "# unless force=true.  Called from the Caddy step below.",
      "samohost_apply_main_vhost() {",
      "  local staged=\"$1\"",
      "  local live=\"$2\"",
      // Regular string so ${3:-false} is emitted verbatim (bash default, not TS).
      "  local force=\"${3:-false}\"",
      "  local backup=\"\"",
      "  if [[ -f \"$live\" ]]; then",
      "    if diff -q \"$staged\" \"$live\" >/dev/null 2>&1; then",
      "      rm -f \"$staged\"",
      "      return 0",
      "    fi",
      "    if [[ \"$force\" != \"true\" ]]; then",
      "      echo \"samohost host-prep: refusing to overwrite hand-authored/drifted main vhost:\" >&2",
      "      echo \"  $live\" >&2",
      "      diff -u \"$live\" \"$staged\" >&2 || true",
      "      echo \"\" >&2",
      "      echo \"  Re-run with --force-main-vhost to override.\" >&2",
      "      rm -f \"$staged\"",
      "      return 1",
      "    fi",
      // Regular strings so ${live} and ${...} expand as bash vars, not TS.
      "    backup=\"${live}.bak.$(date +%Y%m%dT%H%M%S)\"",
      "    cp \"$live\" \"$backup\"",
      "  fi",
      "  mv \"$staged\" \"$live\"",
      "  if ! caddy validate --config /etc/caddy/Caddyfile; then",
      "    echo \"samohost host-prep: caddy validate failed — restoring backup\" >&2",
      "    if [[ -n \"${backup}\" ]] && [[ -f \"${backup}\" ]]; then",
      "      cp \"${backup}\" \"$live\"",
      "    else",
      "      rm -f \"$live\"",
      "    fi",
      "    return 1",
      "  fi",
      "  systemctl reload caddy",
      "}",
      "",
    );

    const mainSiteAddress = isStatic && app.mainListen === "cp-http80"
      ? `http://${mainHost}`
      : mainHost;
    const mainSiteBody = isStatic
      ? [
          `${mainSiteAddress} {`,
          `\troot * "\${SAMOHOST_STATIC_DIR}"`,
          `\ttry_files {path} {path}/ =404`,
          `\tfile_server`,
          `\tencode gzip`,
          ...(app.mainListen === "cp-http80" ? [] : [`\ttls internal`]),
          `}`,
        ]
      : [
          `${mainHost} {`,
          `\treverse_proxy localhost:${port}`,
          `}`,
        ];

    mainVhostLines.push(
      "",
      `#    Landmine guard: render the intended single-service vhost to a staged`,
      `#    file, then call samohost_apply_main_vhost() to compare + conditionally`,
      `#    apply.  The guard refuses if the live file exists and differs — unless`,
      `#    force=true was baked in via --force-main-vhost at host-prep time.`,
      `#    The 00- prefix sorts the live file first in sites.d.`,
      ...(isStatic
        ? [
            `SAMOHOST_STATIC_ROOT=${sq(staticRoot ?? "")}`,
            `SAMOHOST_CHECKOUT_REAL=$(realpath -e ${sq(app.appDir)}) || { echo "static checkout is missing" >&2; exit 1; }`,
            `if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE=${sq(`${app.appDir}/`)}"$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE=${sq(app.appDir)}; fi`,
            'SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "staticRoot does not exist: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
            'case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "staticRoot escapes the checkout: $SAMOHOST_STATIC_ROOT" >&2; exit 1 ;; esac',
            '[[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "staticRoot must contain index.html: $SAMOHOST_STATIC_ROOT" >&2; exit 1; }',
            'samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"',
          ]
        : []),
      `cat > ${stagedPath} <<${isStatic ? "CADDY" : "'CADDY'"}`,
      ...mainSiteBody,
      "CADDY",
      ...(isStatic
        ? ['samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT"']
        : []),
      `samohost_apply_main_vhost \\`,
      `  ${stagedPath} \\`,
      `  ${livePath} \\`,
      `  ${bakedForce}`,
    );
  }

  // --- step 1: env template (node only) + step 2: systemd unit (node only) --
  const nodeOnlyLines: string[] = [];
  if (!isStatic) {
    const envDbVars = app.envDbVars ?? [...DEFAULT_ENV_DB_VARS];
    const defaultTemplateDb = `${app.name.replace(/-/g, "_")}_template`;
    nodeOnlyLines.push(
      `# 1. Env template file: base env vars (secrets) for every preview env.`,
      `#    Copy from the production env file (MINUS PORT) and adjust; chmod 600.`,
      `#    samohost env-create copies it on-host, appends PORT, and rewrites the`,
      `#    DATABASE NAME of each var in the app's envDbVars to the per-env db`,
      `#    (issue #11): this app's envDbVars = ${envDbVars.join(", ")}.`,
      `#    Each of those vars MUST be present in the template, pointing at the`,
      `#    production-shaped URL (scheme://user:pass@host[:port]/dbname[?params]).`,
      `#    Expected template database for --db template: ${defaultTemplateDb}`,
      `#    (override per env with --template-db).`,
      `install -m 600 -o ${sshUser} -g ${sshUser} /dev/null ${root}.template.env`,
      `echo 'EDIT ${root}.template.env: populate base env vars for previews' >&2`,
      "",
    );

    // Step 2: systemd template unit(s) — one template per unique service unit.
    // For single-service apps (legacy) only one template is written at the
    // app.serviceUnit path, preserving byte-identical output (no change in
    // behavior for apps that don't use multi-service declarations).
    // For multi-service apps, every distinct svc.unit gets its own template so
    // that env-create/rotate can start ALL service instances (BLOCKER 1a fix).
    const { services: hostPrepServices } = servicesOf(app);
    const uniqueHostPrepUnits = [...new Map(
      hostPrepServices.map((s) => [s.unit, s]),
    ).values()];

    if (uniqueHostPrepUnits.length === 1) {
      // SINGLE-SERVICE / LEGACY: exact original format for byte-identical output.
      const svc0 = uniqueHostPrepUnits[0]!;
      nodeOnlyLines.push(
        `# 2. systemd template unit: one instance per env (%i = env name).`,
        `#    User= is the app user (${envUser}) — the user that owns the env dir`,
        `#    and the cloned code (issue #97: was sshUser which cannot read the`,
        `#    appUser-owned checkout or the 600 .gh-token).`,
        `cat > /etc/systemd/system/${svc0.unit}@.service <<'UNIT'`,
        "[Unit]",
        `Description=${app.name} preview env %i`,
        "After=network.target",
        "",
        "[Service]",
        `User=${envUser}`,
        `WorkingDirectory=${root}/%i`,
        `EnvironmentFile=${root}/%i/.env`,
        // When the app declares secrets[], add a second EnvironmentFile that loads
        // the per-env 0600 secrets file.  The -/ prefix is NOT used: if secrets[]
        // is declared the file MUST exist (env-create writes it); a missing file
        // means the env-create script was not run, which is an operator error that
        // should surface as a unit-start failure rather than silently starting the
        // app without secrets. Legacy apps (secrets=[] or absent) produce
        // byte-identical output (this line is conditionally omitted).
        ...((app.secrets ?? []).length > 0
          ? [`EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env`]
          : []),
        "ExecStart=/usr/bin/npm start",
        "Restart=on-failure",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "UNIT",
        "systemctl daemon-reload",
        "",
      );
    } else {
      // MULTI-SERVICE: write a template for every unique service unit so that
      // ALL unit instances carry the EnvironmentFile for secrets (BLOCKER 1a).
      nodeOnlyLines.push(
        `# 2. systemd template units: one instance per env (%i = env name), per service.`,
        `#    User= is the app user (${envUser}).`,
      );
      for (const svc of uniqueHostPrepUnits) {
        const execStart = svc.execStart ?? "/usr/bin/npm start";
        nodeOnlyLines.push(
          `cat > /etc/systemd/system/${svc.unit}@.service <<'UNIT'`,
          "[Unit]",
          `Description=${app.name} ${svc.name} preview env %i`,
          "After=network.target",
          "",
          "[Service]",
          `User=${envUser}`,
          `WorkingDirectory=${root}/%i`,
          `EnvironmentFile=${root}/%i/.env`,
          ...((app.secrets ?? []).length > 0
            ? [`EnvironmentFile=/var/lib/samohost/envs/%i/secrets.env`]
            : []),
          `ExecStart=${execStart}`,
          "Restart=on-failure",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "UNIT",
        );
      }
      nodeOnlyLines.push("systemctl daemon-reload", "");
    }

    // Step 2b: install the samohost-secrets helper when the app declares secrets[]
    // OR when databaseUrlEnv is set (the clone-role password uses the same helper).
    // Installed here (before sudoers) so the helper binary exists when visudo
    // validates the NOPASSWD grant for it.  Single-quoted heredoc: no expansion
    // in the helper body during host-prep execution.
    const needsSecretsHelper = (app.secrets ?? []).length > 0 || app.databaseUrlEnv !== undefined;
    if (needsSecretsHelper) {
      nodeOnlyLines.push(
        `# 2b. samohost-secrets helper: validates env-name, performs all per-env`,
        `#     secrets file operations.  ONE exact-path sudoers grant covers all`,
        `#     env-create / rotate / destroy operations — no user-controlled glob.`,
        `cat > /usr/local/sbin/samohost-secrets <<'SAMOHOST_SECRETS_HELPER'`,
        ...SAMOHOST_SECRETS_HELPER_LINES,
        `SAMOHOST_SECRETS_HELPER`,
        `chmod 750 /usr/local/sbin/samohost-secrets`,
        ``,
      );
    }
  }

  // --- step 4 sudoers: node has systemd+postgres grants; static has caddy only -
  const sudoersLines: string[] = [
    `# ${isStatic ? "3" : "4"}. Exact-path sudoers grants (Defaults use_pty is in effect; the env`,
    `#    scripts always call these full paths — issue #99 lesson).`,
    `cat > /etc/sudoers.d/samohost-env-${app.name} <<SUDOERS`,
  ];
  if (!isStatic) {
    // Emit enable/disable/reset-failed grants for EVERY unique service unit,
    // not just the primary unit (samorev #141 finding 1). A second unit (e.g.
    // samograph-live@*) would be sudo-DENIED at enable without this fix.
    // For single-service apps, uniqueSudoUnits has exactly one entry (the
    // primary unit), so the output is byte-identical to the old single push.
    const { services: sudoServices } = servicesOf(app);
    const uniqueSudoUnits = [...new Set(sudoServices.map((s) => s.unit))];
    for (const sudoUnit of uniqueSudoUnits) {
      sudoersLines.push(
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now ${sudoUnit}@*.service`,
        // No restart grant: the unit phase's already-active branch uses
        // disable --now + enable --now (both universally granted on adopted and
        // provisioned VMs alike). A bare restart was never added to adopted hosts.
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl disable --now ${sudoUnit}@*.service`,
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed ${sudoUnit}@*.service`,
      );
    }
  }
  sudoersLines.push(
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy`,
    ...(isStaticReleaseChannel
      ? [
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/.samohost-next-Caddyfile`,
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/.samohost-next-Caddyfile /etc/caddy/Caddyfile`,
        `${sshUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/.samohost-next-Caddyfile`,
      ]
      : []),
  );
  if (!isStatic) {
    sudoersLines.push(
      `${sshUser} ALL=(postgres) NOPASSWD: /usr/bin/createdb, /usr/bin/dropdb, /usr/bin/psql`,
    );
  }
  // Issue #163: the env runner now SSHes AS appUser (when set), so 'sshUser'
  // never needs to delegate to 'appUser' via sudo for any app-dir operation.
  // The entire (appUser) sudoers block is removed:
  //   - git: SSH user IS appUser, runs as dir owner, no sudo-u needed.
  //   - npm (install/build): same.
  //   - install/tee/chmod (.env write): same — the .env is inside the
  //     appUser-owned envs dir, writable by the SSH session directly.
  // Removing these grants hardens the host: 'sshUser' (samo) can no longer
  // impersonate 'appUser' at all — the only granted impersonation target
  // remaining is postgres (db ops) and root (Caddy/systemctl).
  //
  // (Prior issues #97/#98/#101 added these grants when samo ran the env
  // scripts; #163 removes them by changing who runs the scripts instead.)
  // Grant ONE exact-path NOPASSWD for the samohost-secrets helper when:
  //   - the app declares secrets[] (init/get for app secrets), OR
  //   - databaseUrlEnv is set (init/get for the clone-role password).
  // The helper validates the env-name argument before touching any path.
  // (BLOCKER 2 fix + clone-role password extension.)
  if ((app.secrets ?? []).length > 0 || app.databaseUrlEnv !== undefined) {
    sudoersLines.push(
      `# Secrets: ONE exact-path grant for the samohost-secrets helper.`,
      `# The helper validates env-name (^[a-z0-9][a-z0-9-]*$) before touching any path.`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/local/sbin/samohost-secrets`,
    );
  }
  sudoersLines.push(
    "SUDOERS",
    `chmod 440 /etc/sudoers.d/samohost-env-${app.name}`,
    "visudo -cf /etc/sudoers.d/samohost-env-" + app.name,
  );

  return [
    "#!/usr/bin/env bash",
    `# samohost host-prep for app '${app.name}' — ONE-TIME, run by an operator with root.`,
    "# Review before applying. Nothing here is executed by samohost itself.",
    "set -euo pipefail",
    "",
    ...(isStatic && managesMainVhost ? [...staticTreeGuardFnLines(), ""] : []),
    // Guard function definition (only when mainHost is set); placed early so
    // it is in scope before the Caddy step that calls it.
    ...guardFnLines,
    ...nodeOnlyLines,
    `# ${isStatic ? "1" : "3"}. Caddy: include per-env vhost snippets${isStaticReleaseChannel ? "; production activates only in the tag release transaction" : " + the durable MAIN-env vhost"}`,
    ...(isStaticReleaseChannel
      ? [`#    Release-channel host-prep never creates or replaces the production vhost.`]
      : [`#    (field-record-1#117 ITEM C, 7th drift class).`]),
    "mkdir -p /etc/caddy/sites.d",
    `grep -Eq '^[[:space:]]*import[[:space:]]+(/etc/caddy/)?sites\\.d/\\*\\.caddy([[:space:]]*(#.*)?)?$' /etc/caddy/Caddyfile \\`,
    `  || printf '\\nimport sites.d/*.caddy\\n' >> /etc/caddy/Caddyfile`,
    ...mainVhostLines,
    // A managed main vhost reloads inside samohost_apply_main_vhost(). Every
    // other shape reloads only to activate the sites.d import; for static
    // release channels this preserves any existing versioned production route.
    ...(!managesMainVhost ? ["systemctl reload caddy"] : []),
    "",
    // The env-create script runs later as the non-root env user, so the envs
    // root must already exist and be writable by that user regardless of how
    // /opt/<app> was provisioned (e.g. root-owned when not via app bootstrap).
    // Issue #97: when appUser is registered the envs root is owned by appUser
    // so that `sudo -u appUser git clone` can create the env subdir inside it
    // (mode 755 + sshUser owner → appUser has no write permission → EACCES).
    `install -d -m 755 -o ${envUser} -g ${envUser} ${sq(root)}`,
    "",
    ...sudoersLines,
    "",
    ...buildFirewallLines(isStatic, sshUser, firewallOpts),
    "",
    `# ${isStatic ? "5" : "6"}. DNS (one-time, per-preview): samohost's DNS step (Gap #2) creates an`,
    `#    UNPROXIED A record for each per-preview hostname → this VM's IP.`,
    `#    Being UNPROXIED lets Caddy complete the ACME HTTP-01 challenge`,
    `#    directly and obtain a real Let's Encrypt cert (no browser warning).`,
    `#    The firewall rules above (step ${isStatic ? "4" : "5"}) must be in place for the TLS handshake to succeed.`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Custom-domain vhost scripts (domain add / domain rm)
// ---------------------------------------------------------------------------

/**
 * Build a bash script that writes a durable Caddy vhost snippet for a
 * client-owned FQDN on the **app VM** and reloads Caddy.  Pushed over SSH
 * by `domain add`.
 *
 * Snippet path: `/etc/caddy/sites.d/10-domain-<label>.caddy`
 * (`10-` sorts after the `00-main-*` main-env vhost; label = fqdn dots→dashes).
 *
 * Serving posture — HTTP only (`http://` scheme prefix):
 *   - node apps: `http://<fqdn> { reverse_proxy localhost:<port> }`
 *   - static apps: validate the last health-proven detached deployment and
 *     import its stable managed route; never derive from the bootstrap appDir
 *
 * The `http://` prefix (instead of bare `<fqdn> { tls internal }`) is critical:
 * the control-plane proxies custom-domain traffic to this app VM on **port 80**
 * (plain HTTP), so the vhost must match on :80 without a :443 redirect.  If
 * `tls internal` were used, Caddy would redirect the CP's :80 connection to
 * :443, breaking the routing chain.
 *
 * Relies on the same NOPASSWD sudoers grants that env-create scripts use
 * (already present after `env plan --host-prep` + `app bootstrap`).
 *
 * @throws if `fqdn` does not pass isValidMainHost (the FQDN is embedded in a
 *   root-run script — fail closed on injection risk).
 */
export function buildCustomDomainVhostScript(
  app: AppRecord,
  fqdn: string,
): string {
  if (!isValidMainHost(fqdn)) {
    throw new Error(
      `invalid fqdn ${JSON.stringify(fqdn)} for custom domain vhost — ` +
        `expected a dotted lowercase DNS name like "myapp.com" ` +
        `(embedded in a root-run script; failing closed)`,
    );
  }

  const label = fqdn.replace(/\./g, "-");
  const snippetPath = `/etc/caddy/sites.d/10-domain-${label}.caddy`;

  // http:// prefix → Caddy serves on :80 only, no TLS redirect.  The control
  // plane proxies custom-domain traffic over plain HTTP to this VM, so a :443
  // redirect here would break the routing chain.
  const isStatic = app.kind === "static";
  const staticReleaseTagFormat = app.releaseTagFormat ?? "";
  const staticRoot = staticRootOf(app);
  const releaseState = staticReleaseStatePaths(app.appDir);
  const cacheHeadersPrintf = staticCacheHeaderLines("\\t").join("\\n");
  const vhostBody = isStatic
    ? undefined
    : `http://${fqdn} {\n\treverse_proxy localhost:${mainEnvPort(app)}\n}`;

  return [
    "#!/usr/bin/env bash",
    `# samohost custom-domain vhost (app VM): ${fqdn} → ${app.name}`,
    "# Generated by 'samohost domain add'; pushed over SSH stdin to 'bash -s'.",
    "# http:// prefix: serves on :80 only (no TLS redirect — CP proxies via HTTP).",
    "set -euo pipefail",
    "",
    `SNIPPET=${sq(snippetPath)}`,
    "",
    ...(isStatic
      ? [
          'STAGED=""',
          'BACKUP=""',
          'ACTIVE_VALUES=""',
          'EXPECTED_ROUTE=""',
          `SAMOHOST_STATIC_ROOT=${sq(staticRoot ?? "")}`,
          `SAMOHOST_RELEASE_TAG_FORMAT=${sq(staticReleaseTagFormat)}`,
          `SAMOHOST_RELEASES_DIR=${sq(releaseState.releasesDir)}`,
          `SAMOHOST_ACTIVE_STATE=${sq(releaseState.activeState)}`,
          `SAMOHOST_ACTIVE_ROUTE=${sq(releaseState.activeRoute)}`,
          "",
          ...staticTreeGuardFnLines(),
          "",
          "samohost_cleanup_custom_domain() {",
          '  [[ -z "$STAGED" ]] || rm -f "$STAGED"',
          '  [[ -z "$BACKUP" ]] || rm -f "$BACKUP"',
          '  [[ -z "$ACTIVE_VALUES" ]] || rm -f "$ACTIVE_VALUES"',
          '  [[ -z "$EXPECTED_ROUTE" ]] || rm -f "$EXPECTED_ROUTE"',
          "}",
          "trap samohost_cleanup_custom_domain EXIT",
          "",

                '[[ -r "$SAMOHOST_ACTIVE_STATE" && -r "$SAMOHOST_ACTIVE_ROUTE" ]] || { echo "no authorized healthy static deployment is active; refusing custom-domain activation" >&2; exit 1; }',
                'ACTIVE_VALUES=$(mktemp)',
                `if ! python3 - "$SAMOHOST_ACTIVE_STATE" ${sq(app.name)} "$SAMOHOST_STATIC_ROOT" "$SAMOHOST_RELEASE_TAG_FORMAT" > "$ACTIVE_VALUES" <<'PY'`,
                "import datetime",
                "import json",
                "import re",
                "import sys",
                "",
                "path, expected_app, expected_root, expected_format_raw = sys.argv[1:]",
                "expected_format = expected_format_raw or None",
                "with open(path, encoding='utf-8') as source:",
                "    state = json.load(source)",
                "if state.get('schema') != 1 or state.get('appName') != expected_app or state.get('staticRoot') != expected_root or state.get('releaseTagFormat') != expected_format:",
                "    raise SystemExit('active static release state does not match this app')",
                "sha = state.get('sha')",
                "tag = state.get('tag')",
                "release_dir = state.get('releaseDir')",
                "if not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{7,40}', sha) is None:",
                "    raise SystemExit('active static release state has an invalid sha')",
                "if not isinstance(tag, str) or not tag or len(tag) > 255 or any(ord(ch) < 32 for ch in tag):",
                "    raise SystemExit('active static release state has an invalid tag')",
                "if expected_format == 'date':",
                "    match = re.fullmatch(r'v([0-9]{8})[.]([1-9][0-9]*)', tag)",
                "    if match is None:",
                "        raise SystemExit('active static release state has an invalid dated tag')",
                "    datetime.datetime.strptime(match.group(1), '%Y%m%d')",
                "if not isinstance(release_dir, str) or not release_dir.startswith('/') or any(ord(ch) < 32 for ch in release_dir):",
                "    raise SystemExit('active static release state has an invalid releaseDir')",
                "for value in (release_dir, sha, tag):",
                "    sys.stdout.buffer.write(value.encode('utf-8') + b'\\0')",
                "PY",
                "then",
                "  exit 1",
                "fi",
                'SAMOHOST_ACTIVE_VALUES=()',
                'mapfile -d "" -t SAMOHOST_ACTIVE_VALUES < "$ACTIVE_VALUES"',
                '[[ "${#SAMOHOST_ACTIVE_VALUES[@]}" == "3" ]] || { echo "active static release state is incomplete" >&2; exit 1; }',
                'SAMOHOST_ACTIVE_RELEASE_RAW="${SAMOHOST_ACTIVE_VALUES[0]}"',
                'SAMOHOST_ACTIVE_SHA="${SAMOHOST_ACTIVE_VALUES[1]}"',
                'SAMOHOST_ACTIVE_TAG="${SAMOHOST_ACTIVE_VALUES[2]}"',
                'SAMOHOST_RELEASES_REAL=$(realpath -e "$SAMOHOST_RELEASES_DIR") || { echo "static releases directory is missing" >&2; exit 1; }',
                '[[ ! -L "$SAMOHOST_ACTIVE_RELEASE_RAW" ]] || { echo "active static release path is a symlink" >&2; exit 1; }',
                'SAMOHOST_CHECKOUT_REAL=$(realpath -e "$SAMOHOST_ACTIVE_RELEASE_RAW") || { echo "active static release directory is missing" >&2; exit 1; }',
                '[[ "$SAMOHOST_ACTIVE_RELEASE_RAW" == "$SAMOHOST_CHECKOUT_REAL" ]] || { echo "active static release path is not canonical" >&2; exit 1; }',
                'case "$SAMOHOST_CHECKOUT_REAL" in "$SAMOHOST_RELEASES_REAL"/*) ;; *) echo "active static release escapes the releases directory" >&2; exit 1 ;; esac',
                '[[ "$(git -C "$SAMOHOST_CHECKOUT_REAL" -c safe.directory="$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD)" == "$SAMOHOST_ACTIVE_SHA" ]] || { echo "active static release checkout does not match its recorded sha" >&2; exit 1; }',
                'if [[ -n "$SAMOHOST_STATIC_ROOT" ]]; then SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL/$SAMOHOST_STATIC_ROOT"; else SAMOHOST_STATIC_CANDIDATE="$SAMOHOST_CHECKOUT_REAL"; fi',
                'SAMOHOST_STATIC_DIR=$(realpath -e "$SAMOHOST_STATIC_CANDIDATE") || { echo "active staticRoot does not exist" >&2; exit 1; }',
                'case "$SAMOHOST_STATIC_DIR" in "$SAMOHOST_CHECKOUT_REAL"|"$SAMOHOST_CHECKOUT_REAL"/*) ;; *) echo "active staticRoot escapes the release checkout" >&2; exit 1 ;; esac',
                '[[ -d "$SAMOHOST_STATIC_DIR" && -f "$SAMOHOST_STATIC_DIR/index.html" ]] || { echo "active staticRoot must contain index.html" >&2; exit 1; }',
                'python3 - "$SAMOHOST_STATIC_DIR/version.json" "$SAMOHOST_ACTIVE_SHA" "$SAMOHOST_ACTIVE_TAG" <<\'PY\'',
                "import json",
                "import sys",
                "with open(sys.argv[1], encoding='utf-8') as source:",
                "    identity = json.load(source)",
                "expected = {'version': sys.argv[3], 'tag': sys.argv[3], 'sha': sys.argv[2], 'environment': 'production'}",
                "if identity != expected:",
                "    raise SystemExit('active static release identity does not match state')",
                "PY",
                'EXPECTED_ROUTE=$(mktemp)',
                'printf \'root * "%s"\\ntry_files {path} {path}/ =404\\nfile_server\\nencode gzip\\n\' "$SAMOHOST_STATIC_DIR" > "$EXPECTED_ROUTE"',
                'cmp -s "$EXPECTED_ROUTE" "$SAMOHOST_ACTIVE_ROUTE" || { echo "active static route does not match structured release state" >&2; exit 1; }',
                'SAMOHOST_ACTIVE_FINGERPRINT=$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" | sha256sum | awk \'{print $1}\')',
          "samohost_assert_custom_domain_source() {",
          '  samohost_assert_static_tree_safe "$SAMOHOST_CHECKOUT_REAL" "$SAMOHOST_STATIC_DIR" "$SAMOHOST_STATIC_ROOT" || return 1',
          '  local current_fingerprint',
          '  current_fingerprint=$(sha256sum "$SAMOHOST_ACTIVE_STATE" "$SAMOHOST_ACTIVE_ROUTE" | sha256sum | awk \'{print $1}\') || return 1',
          '  [[ "$current_fingerprint" == "$SAMOHOST_ACTIVE_FINGERPRINT" ]] || { echo "active static release changed during custom-domain activation; retry" >&2; return 1; }',
          "}",
          "",
          'samohost_assert_custom_domain_source || exit 1',
          'STAGED=$(mktemp)',
          `printf 'http://${fqdn} {\\n${cacheHeadersPrintf}\\n\\timport "%s"\\n}\\n' "$SAMOHOST_ACTIVE_ROUTE" > "$STAGED"`,
          'samohost_assert_custom_domain_source || exit 1',
          "SAMOHOST_HAD_LIVE=0",
          'if [[ -f "$SNIPPET" ]]; then BACKUP=$(mktemp); cp -- "$SNIPPET" "$BACKUP"; SAMOHOST_HAD_LIVE=1; fi',
          'sudo /usr/bin/tee "$SNIPPET" >/dev/null < "$STAGED"',
          'if samohost_assert_custom_domain_source && sudo /usr/bin/systemctl reload caddy; then',
          "  :",
          "else",
          '  if [[ "$SAMOHOST_HAD_LIVE" == "1" ]]; then',
          '    sudo /usr/bin/tee "$SNIPPET" >/dev/null < "$BACKUP"',
          "  else",
          '    sudo /usr/bin/rm -f "$SNIPPET"',
          "  fi",
          "  exit 1",
          "fi",
        ]
      : [
          "# Write the Caddy snippet (overwrite — idempotent; same content each time).",
          `printf '%s\\n' ${sq(vhostBody!)} | sudo /usr/bin/tee "$SNIPPET" >/dev/null`,
          "",
          "# Reload Caddy (reload fails on bad config; no separate validate step needed).",
          `sudo /usr/bin/systemctl reload caddy`,
        ]),
    "",
    `echo "custom-domain vhost ready: ${fqdn}"`,
  ].join("\n");
}

/**
 * Build a bash script that removes the Caddy vhost snippet for a
 * client-owned FQDN from the app VM and reloads Caddy.  Pushed over SSH
 * by `domain rm`.
 */
export function buildCustomDomainVhostRemoveScript(fqdn: string): string {
  if (!isValidMainHost(fqdn)) {
    throw new Error(
      `invalid fqdn ${JSON.stringify(fqdn)} for custom domain vhost removal — ` +
        `expected a dotted lowercase DNS name (failing closed)`,
    );
  }

  const label = fqdn.replace(/\./g, "-");
  const snippetPath = `/etc/caddy/sites.d/10-domain-${label}.caddy`;

  return [
    "#!/usr/bin/env bash",
    `# samohost custom-domain vhost removal (app VM): ${fqdn}`,
    "# Generated by 'samohost domain rm'; pushed over SSH stdin to 'bash -s'.",
    "set -euo pipefail",
    "",
    `sudo /usr/bin/rm -f ${sq(snippetPath)}`,
    `sudo /usr/bin/systemctl reload caddy`,
    "",
    `echo "custom-domain vhost removed: ${fqdn}"`,
  ].join("\n");
}

/**
 * Build a bash script that writes the control-plane Caddy routing snippet for
 * a client-owned FQDN.  Run **locally** on the control plane by `domain add`
 * (no SSH — samohost runs on the control plane).
 *
 * Snippet path: `/etc/caddy/sites.d/10-domain-<label>.caddy`
 *
 * Routing chain this creates:
 *   CF edge → control plane :443 (tls internal, CF Full mode) →
 *   app VM <vmIp>:80 (plain HTTP, Host: <httpHost>) →
 *   app's Caddy vhost → localhost:<port>
 *
 * The script:
 *   1. Creates `/etc/caddy/sites.d/` if it doesn't exist.
 *   2. Appends `import sites.d/*.caddy` to the Caddyfile if not already present
 *      (idempotent one-time wiring; safe to repeat).
 *   3. Writes the per-domain snippet (overwrite — idempotent).
 *   4. Reloads Caddy via `systemctl reload caddy`.
 *
 * @param fqdn     Client custom domain (e.g. "myapp.com").
 * @param vmIp     App VM's public IP (e.g. "178.105.246.151").
 * @param httpHost Host header to send to the app VM on :80.  Use `app.mainHost`
 *                 when set (routes via the app VM's existing HTTP vhost for the
 *                 production app, no new vhost needed on the app VM); fall back
 *                 to `fqdn` itself (the app VM must have an HTTP vhost for it,
 *                 written by {@link buildCustomDomainVhostScript}).
 *
 * @throws if `fqdn` or `httpHost` fail basic domain validation (embedded in a
 *   locally-executed script — fail closed on injection risk).
 */
export function buildControlPlaneCustomDomainVhostScript(
  fqdn: string,
  vmIp: string,
  httpHost: string,
): string {
  if (!isValidMainHost(fqdn)) {
    throw new Error(
      `invalid fqdn ${JSON.stringify(fqdn)} for control-plane custom-domain vhost — ` +
        `expected a dotted lowercase DNS name (failing closed)`,
    );
  }
  // httpHost is embedded in a locally-run root script: validate it too.
  if (!isValidMainHost(httpHost)) {
    throw new Error(
      `invalid httpHost ${JSON.stringify(httpHost)} for control-plane custom-domain vhost — ` +
        `expected a dotted lowercase DNS name (failing closed)`,
    );
  }

  const label = fqdn.replace(/\./g, "-");
  const snippetPath = `/etc/caddy/sites.d/10-domain-${label}.caddy`;
  const caddyfile = "/etc/caddy/Caddyfile";

  // The vhost block mirrors production entries in the control-plane Caddyfile
  // (e.g. field-record-1.samo.team, game-changers.samo.team):
  //   tls internal   → CF Full mode accepts the self-signed origin cert
  //   reverse_proxy <vmIp>:80 → HTTP to the app VM (firewall allows CP IP only)
  //   header_up Host <httpHost> → app VM routes via its existing mainHost vhost
  //   header_up X-Real-IP {remote_host} → real client IP forwarded
  const vhostBlock = [
    `${fqdn} {`,
    `\ttls internal`,
    `\treverse_proxy ${vmIp}:80 {`,
    `\t\theader_up Host ${httpHost}`,
    `\t\theader_up X-Real-IP {remote_host}`,
    `\t}`,
    `\theader {`,
    `\t\tX-Content-Type-Options nosniff`,
    `\t}`,
    `}`,
  ].join("\n");

  return [
    "#!/usr/bin/env bash",
    `# samohost control-plane custom-domain vhost: ${fqdn} → ${vmIp}:80`,
    "# Generated by 'samohost domain add'; runs locally on the control plane.",
    "set -euo pipefail",
    "",
    `SNIPPET=${sq(snippetPath)}`,
    `CADDYFILE=${sq(caddyfile)}`,
    "",
    "# 1. Ensure sites.d/ exists on the control plane.",
    `sudo /usr/bin/mkdir -p /etc/caddy/sites.d`,
    "",
    "# 2. Add 'import sites.d/*.caddy' to the Caddyfile if not already present.",
    "#    Idempotent: grep -qF prevents duplicate lines on repeated runs.",
    `if ! grep -qF 'import sites.d/*.caddy' "$CADDYFILE"; then`,
    `  printf '\\nimport sites.d/*.caddy\\n' | sudo /usr/bin/tee -a "$CADDYFILE" >/dev/null`,
    `fi`,
    "",
    "# 3. Write the per-domain routing snippet (overwrite — idempotent).",
    `printf '%s\\n' ${sq(vhostBlock)} | sudo /usr/bin/tee "$SNIPPET" >/dev/null`,
    "",
    "# 4. Reload Caddy — reload fails on bad config (no separate validate needed).",
    "#    Primary: systemctl reload caddy (keeps systemd state authoritative).",
    "#    Fallback: caddy reload --config ... --force (admin API, zero-downtime) for",
    "#    the verified CP failure: PrivateTmp namespace stale after long uptime",
    "#    (systemd status=226/NAMESPACE). The || chain preserves fail-closed on",
    "#    genuinely invalid config because caddy reload validates before applying.",
    `sudo /usr/bin/systemctl reload caddy || sudo /usr/bin/caddy reload --config /etc/caddy/Caddyfile --force`,
    "",
    `echo "control-plane vhost ready: ${fqdn} → ${vmIp}:80 (Host: ${httpHost})"`,
  ].join("\n");
}

/**
 * Build a bash script that removes the control-plane Caddy routing snippet for
 * a client-owned FQDN.  Run **locally** on the control plane by `domain rm`.
 *
 * Only removes the per-domain snippet file from `sites.d/`; does NOT remove
 * the `import sites.d/*.caddy` line from the Caddyfile (that line is
 * persistent infrastructure shared by all custom-domain snippets).
 */
export function buildControlPlaneCustomDomainVhostRemoveScript(
  fqdn: string,
): string {
  if (!isValidMainHost(fqdn)) {
    throw new Error(
      `invalid fqdn ${JSON.stringify(fqdn)} for control-plane custom-domain vhost removal — ` +
        `expected a dotted lowercase DNS name (failing closed)`,
    );
  }

  const label = fqdn.replace(/\./g, "-");
  const snippetPath = `/etc/caddy/sites.d/10-domain-${label}.caddy`;

  return [
    "#!/usr/bin/env bash",
    `# samohost control-plane custom-domain vhost removal: ${fqdn}`,
    "# Generated by 'samohost domain rm'; runs locally on the control plane.",
    "set -euo pipefail",
    "",
    `sudo /usr/bin/rm -f ${sq(snippetPath)}`,
    `sudo /usr/bin/systemctl reload caddy || sudo /usr/bin/caddy reload --config /etc/caddy/Caddyfile --force`,
    "",
    `echo "control-plane vhost removed: ${fqdn}"`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Target derivation helper (shared by plan/create/destroy commands)
// ---------------------------------------------------------------------------

/** Build the script target from a persisted {@link EnvRecord}. */
export function targetFromRecord(env: EnvRecord): EnvScriptTarget {
  return {
    name: env.name,
    branch: env.branch,
    port: env.port,
    ...(env.ports !== undefined ? { ports: env.ports } : {}),
    vhost: env.vhost,
    dbBackend: env.dbBackend,
    ...(env.dbName !== undefined ? { dbName: env.dbName } : {}),
    ...(env.templateDb !== undefined ? { templateDb: env.templateDb } : {}),
  };
}
