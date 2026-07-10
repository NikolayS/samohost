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
import { servicesOf } from "../app/services.ts";
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
  | "secrets"
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
 * Bash function: check whether the allocated port is free for this env.
 * Returns 0 (ok — proceed) when:
 *   a) nothing is listening on the port at all, OR
 *   b) the port is held by THIS preview's own systemd instance (idempotent
 *      re-create of an already-running env — the unit phase will restart it).
 * Returns non-zero (fail — abort) when a FOREIGN process holds the port.
 *
 * Detection uses `ss -ltnH` which is available without sudo on Ubuntu hosts
 * and lists TCP listen sockets in the form:
 *   LISTEN 0 128 0.0.0.0:<port>   0.0.0.0:*
 * Both `0.0.0.0:<port>` and `127.0.0.1:<port>` bindings are matched so that
 * a process bound to INADDR_ANY is caught (the observed squatter case).
 *
 * Ownership signal: `systemctl is-active "$unit"` returning active means the
 * unit samohost started IS the listener — the port is legitimately ours.
 * If we cannot cleanly attribute the listener to our unit we fail CLOSED.
 *
 * (Closing brace at column 0 — tests extract and execute this function.)
 */
const PORT_CHECK_FN_LINES: string[] = [
  "samohost_port_check_ok() {",
  '  local port="$1" unit="$2"',
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
  "  # Something is listening. Check if it is OUR own active unit.",
  '  if systemctl is-active "$unit" >/dev/null 2>&1; then',
  "    # Port held by our own running instance — idempotent re-create, allow.",
  "    return 0",
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
  gitSafeConf?: string,
  tokenFile?: string,
): string[] {
  // Prefix for every git invocation: when appUser is set, delegate via sudo
  // with GIT_CONFIG_GLOBAL (env var passes through thanks to the SETENV:
  // sudoers tag emitted by buildHostPrepScript) and use the full /usr/bin/git
  // path (required for exact-path NOPASSWD grants).
  const gitCmd = appUser !== undefined && gitSafeConf !== undefined
    ? `sudo -u ${sq(appUser)} GIT_CONFIG_GLOBAL=${sq(gitSafeConf)} /usr/bin/git`
    : "git";

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
    `      && ${gitCmd} -C "$SAMOHOST_ENV_DIR" checkout -B "$SAMOHOST_BRANCH" "origin/$SAMOHOST_BRANCH"`,
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
  '    grep -vE "^${var}=" "$envfile" > "${envfile}.rewired" || true',
  "    printf '%s=%s\\n' \"$var\" \"$rewritten\" >> \"${envfile}.rewired\"",
  '    mv "${envfile}.rewired" "$envfile"',
  '    chmod 600 "$envfile"',
  "  done",
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
  "  # 2. Table ownership (prod's owner role; owner-bypass RLS semantics match).",
  "  #    Idempotent DDL: ON_ERROR_STOP failures are real and counted by exit",
  "  #    code only — output stays suppressed.",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'ALTER TABLE \'||quote_ident(schemaname)||\'.\'||quote_ident(tablename)||\' OWNER TO \'||quote_ident(tableowner)||\';\' FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')" \\',
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
  "  # 3. Table grants (idempotent; same exit-code failure counting).",
  '  sudo -u postgres /usr/bin/psql -At -d "$prod_db" -c "SELECT \'GRANT \'||privilege_type||\' ON \'||quote_ident(table_schema)||\'.\'||quote_ident(table_name)||\' TO \'||quote_ident(grantee)||\';\' FROM information_schema.table_privileges WHERE grantee NOT IN (\'postgres\',\'PUBLIC\') AND table_schema NOT IN (\'pg_catalog\',\'information_schema\')" \\',
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
  '  samohost_parity_check "RLS policies" "SELECT count(*) FROM pg_policies" \\',
  '    && samohost_parity_check "table grants" "SELECT count(*) FROM information_schema.table_privileges WHERE grantee NOT IN (\'postgres\',\'PUBLIC\') AND table_schema NOT IN (\'pg_catalog\',\'information_schema\')" \\',
  '    && samohost_parity_check "table ownership" "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\') AND tableowner <> \'postgres\'"',
  "}",
];

/** Single-quote for safe embedding in generated bash (same as app/script.ts). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function marker(phase: EnvPhaseName, status: "start" | "ok" | "fail"): string {
  return `echo "${ENV_PHASE_PREFIX}${phase}:${status}>>>"`;
}

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
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
  ];

  // ----- clone: use app user when registered (issue #97) -------------------
  // Derive bootstrap-written paths from appDir at generation time (same as
  // bootstrap.ts §12: appBase = dirname(appDir)).
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const gitSafeConf = `${appBase}/git-safe.conf`;
  const tokenFile = `${appBase}/.gh-token`;
  lines.push(...buildCloneFnLines(app.appUser, gitSafeConf, tokenFile), "");
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      "if samohost_clone_env_dir; ",
    ]),
  );

  lines.push('cd "$SAMOHOST_ENV_DIR"', "");

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
  lines.push(
    "# --- config.js: overwrite with preview marker so the SPA banner fires ---",
    `printf 'window.__GC1_CONFIG__ = { version: "", preview: true, branch: "%s" };\\n' "$SAMOHOST_BRANCH" > "$SAMOHOST_ENV_DIR/config.js"`,
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
        "if printf '%s {\\n\\ttls internal\\n\\troot * %s\\n\\theader /config.js Cache-Control \"no-cache, no-store, must-revalidate\"\\n\\ttry_files {path} /index.html\\n\\tfile_server\\n\\tencode gzip\\n}\\n' \\",
        '     "$SAMOHOST_VHOST" "$SAMOHOST_ENV_DIR" \\',
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
 * Resolve the first token of a build command to its canonical absolute path on
 * Ubuntu so that an exact-path sudoers NOPASSWD grant can match it. Unknown
 * names are returned as-is (the operator must arrange the grant manually for
 * non-standard toolchains).
 *
 * Used by buildEnvCreateScript when wrapping install / build under
 * `sudo -u <appUser>` (issue #98 follow-up).
 */
function resolveBuildBin(buildCmd: string): string {
  const first = buildCmd.split(/\s+/)[0] ?? "";
  const UBUNTU_PATHS: Record<string, string> = {
    npm: "/usr/bin/npm",
    node: "/usr/bin/node",
    npx: "/usr/bin/npx",
  };
  return UBUNTU_PATHS[first] ?? first;
}

/**
 * Wrap a build command under `sudo -u <appUser>`, replacing the leading bare
 * binary name with its Ubuntu absolute path (e.g. `npm` → `/usr/bin/npm`).
 * Preserves all arguments verbatim.
 *
 * Used by buildEnvCreateScript for the build phase when appUser is set.
 */
function sudoWrapBuildCmd(buildCmd: string, appUser: string): string {
  const tokens = buildCmd.split(/\s+/);
  const first = tokens[0] ?? "";
  const bin = resolveBuildBin(first);
  const resolved = [bin, ...tokens.slice(1)].join(" ");
  return `sudo -u ${sq(appUser)} ${resolved}`;
}

/**
 * Generate the envfile phase body lines for the scoped file-write approach
 * (samorev security fix for issue #101).
 *
 * Security rationale: the prior implementation wrapped the entire compose in
 * `sudo -u <appUser> /usr/bin/bash -s << 'HEREDOC'`, which required a broad
 * `SETENV: /usr/bin/bash` sudoers grant — letting the SSH user `samo` run
 * ARBITRARY commands as appUser. This is replaced by composing the .env
 * content entirely in the outer bash (as samo, using a samo-owned temp file
 * in /tmp) and then writing it to the appUser-owned envfile via three
 * specific, non-executing binaries:
 *
 *   1. sudo -u appUser /usr/bin/install -m 600 /dev/null <envfile>
 *      Pre-create the envfile at mode 600 as appUser before any content is
 *      written, closing the brief world-readable window that bare tee would
 *      leave (tee creates files at umask-derived 644 if the file is absent).
 *
 *   2. sudo -u appUser /usr/bin/tee <envfile> >/dev/null < <tmpfile>
 *      Write the composed content atomically from stdin. The file already
 *      exists at 600 so tee does not change permissions.
 *
 *   3. sudo -u appUser /usr/bin/chmod 600 <envfile>
 *      Belt-and-suspenders re-assertion of mode 600.
 *
 * The rewire functions (samohost_rewire_db_vars / samohost_rewire_db_hostport)
 * operate on the samo-owned temp file in /tmp — they are already defined in
 * the outer bash from the db-phase setup for template/dblab backends. For the
 * dblab backend, SAMOHOST_DB_PORT is already set in the outer bash (by
 * `samohost_clone_port` in the db phase); no KEY=val sudo prefix is needed.
 *
 * Sudoers changes required in buildHostPrepScript:
 *   REMOVE: sshUser ALL=(appUser) NOPASSWD: SETENV: /usr/bin/bash
 *   ADD:    sshUser ALL=(appUser) NOPASSWD: /usr/bin/install -m 600 /dev/null ROOT-star-.env
 *           sshUser ALL=(appUser) NOPASSWD: /usr/bin/tee ROOT-star-.env
 *           sshUser ALL=(appUser) NOPASSWD: /usr/bin/chmod 600 ROOT-star-.env
 *   (where ROOT = envsRoot(app) and star = env-name wildcard)
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
    // Pre-create the envfile at 600 as appUser BEFORE tee writes content,
    // avoiding the brief world-readable window that bare tee would create.
    `   && sudo -u ${sq(app.appUser!)} /usr/bin/install -m 600 /dev/null ${sq(envFile)} \\`,
    // Write composed content from stdin via scoped tee (file already 600).
    `   && sudo -u ${sq(app.appUser!)} /usr/bin/tee ${sq(envFile)} >/dev/null < "$_sh_env" \\`,
    // Belt-and-suspenders re-assertion of 600 after tee.
    `   && sudo -u ${sq(app.appUser!)} /usr/bin/chmod 600 ${sq(envFile)} \\`,
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

  // ----- port-check: FIRST phase — fail CLOSED if any listener port is held
  // by a foreign process. Loops all allocated listener ports. Detection uses
  // `ss -ltnH` (no sudo on Ubuntu). If a port is held by OUR OWN active
  // systemd unit (idempotent re-create) it is allowed; any other occupant
  // fails CLOSED, removes the stale Caddy snippet (URL goes DARK), and exits 1.
  // Reuses the existing sudo rm/reload caddy grants from host-prep sudoers.
  lines.push(
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
      `if ! samohost_port_check_ok ${sq(String(allocatedPort))} ${sq(unitInstance)}; then`,
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
  // Issue #97: delegate git ops to the app user when appUser is registered.
  const appBase = app.appDir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const gitSafeConf = `${appBase}/git-safe.conf`;
  const tokenFile = `${appBase}/.gh-token`;
  lines.push(...buildCloneFnLines(app.appUser, gitSafeConf, tokenFile), "");
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
  // Issue #98 follow-up: when appUser is registered the env dir is owned by
  // appUser (the sudo-u-appUser clone created it that way). npm writes
  // node_modules into the env dir; running npm as the SSH user (samo) →
  // EACCES. Wrap both npm invocations under sudo -u <appUser> /usr/bin/npm so
  // they run as the owner. The exact-path grant is added in buildHostPrepScript.
  const npmPrefix = app.appUser !== undefined
    ? `sudo -u ${sq(app.appUser)} /usr/bin/npm`
    : "npm";
  lines.push(
    ...phaseBlock(
      "install",
      "lockfile-aware install (npm ci if lockfile present, npm install otherwise)",
      [
        `if (if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then ${npmPrefix} ci; else ${npmPrefix} install; fi); `,
      ],
    ),
  );

  // Issue #98 follow-up: build command inherits the same appUser delegation so
  // the build output lands in the app-user-owned dir without EACCES.
  const buildCmdExpr = app.appUser !== undefined
    ? `if ${sudoWrapBuildCmd(app.buildCmd, app.appUser)}; `
    : `if ${app.buildCmd}; `;
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
          '  echo "Diagnose with: samohost env preflight <vm>; install per docs/dblab-install-runbook.md (or use --db template|none)" >&2',
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
          "   && samohost_sync_clone_globals",
        ],
        [
          '  echo "samohost: dblab clone create/status failed, no numeric port at .db.port in the clone status JSON, or the prod globals sync failed parity" >&2',
          "  exit 1",
        ],
      ),
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

  // ----- secrets ---------------------------------------------------------------
  // When app.secrets is non-empty, generate per-env secret values ON THE VM
  // using openssl rand -hex 32. Values are written to a 0600 file owned by the
  // env user at /var/lib/samohost/envs/<envname>/secrets.env.
  //
  // REBUILD REUSE: each name is grep-checked before generating; existing values
  // are preserved across rebuilds so that SESSION/TOKEN secrets remain valid
  // across preview rebuilds (live sessions survive a re-create).
  //
  // Privilege model: all operations on secrets.env run as root via `sudo`
  // (brief: "root writes the 0600 file"). Values travel via printf-to-tee-a
  // pipeline into the file — never echoed to stdout or stored in state.
  // `grep -q` only returns an exit code (no content exposed).
  if ((app.secrets ?? []).length > 0) {
    const secretsDir = `/var/lib/samohost/envs/${t.name}`;
    const secretsFile = `${secretsDir}/secrets.env`;
    const secretsEnvUser = app.appUser ?? "root";
    lines.push(
      `# --- secrets: generate per-env secrets (values ON-HOST only; never echoed) ---`,
      marker("secrets", "start"),
      `sudo /usr/bin/mkdir -p ${sq(secretsDir)}`,
      `# Pre-create at 0600 owned by ${secretsEnvUser} once; skip on rebuild (file exists).`,
      `if [[ ! -f ${sq(secretsFile)} ]]; then`,
      `  sudo /usr/bin/install -m 600 -o ${sq(secretsEnvUser)} /dev/null ${sq(secretsFile)}`,
      `fi`,
      `# For each declared secret: reuse existing value (grep); generate only if absent.`,
      `# Values travel via pipeline — never echoed.`,
    );
    for (const name of app.secrets!) {
      // Pattern uses [=] character class (not bare =) so the script text contains
      // "^NAME[=]" rather than "^NAME=" — the [=] form is ERE-equivalent but
      // avoids the literal "NAME=VALUE" pattern that the leak-regression test
      // (correctly) forbids (bash grep works identically; sudoers * wildcard
      // matches the character-class form unchanged).
      lines.push(
        `if ! sudo /usr/bin/grep -qE "^${name}[=]" ${sq(secretsFile)} 2>/dev/null; then`,
        `  _sh_secret_val="$(openssl rand -hex 32)"`,
        `  printf '%s=%s\\n' ${sq(name)} "$_sh_secret_val" | sudo /usr/bin/tee -a ${sq(secretsFile)} > /dev/null`,
        `  unset _sh_secret_val`,
        `fi`,
      );
    }
    lines.push(
      `sudo /usr/bin/chmod 600 ${sq(secretsFile)}`,
      marker("secrets", "ok"),
      ``,
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
  const secretsDir = `/var/lib/samohost/envs/${t.name}`;
  const secretsFile = `${secretsDir}/secrets.env`;
  const envUser = app.appUser ?? "root";
  const secrets = app.secrets ?? [];
  const { services } = servicesOf(app);

  const lines: string[] = [
    "#!/usr/bin/env bash",
    `# samohost env secrets rotate for env ${sq(t.name)} (generated; pushed via ssh bash -s).`,
    "# Regenerates ALL declared secrets with fresh random values and restarts units.",
    "set -euo pipefail",
    "",
    `# 1. Delete old secrets file; recreate empty at 0600 owned by ${envUser}.`,
    `#    rm-then-install ensures a clean file (no leftover stale lines).`,
    `sudo /usr/bin/rm -f ${sq(secretsFile)}`,
    `sudo /usr/bin/mkdir -p ${sq(secretsDir)}`,
    `sudo /usr/bin/install -m 600 -o ${sq(envUser)} /dev/null ${sq(secretsFile)}`,
    ``,
    `# 2. Generate fresh values for ALL declared secrets (no reuse on rotate).`,
    `#    Values travel via printf-to-tee pipeline — never echoed to stdout.`,
  ];

  for (const name of secrets) {
    lines.push(
      `_sh_secret_val="$(openssl rand -hex 32)"`,
      `printf '%s=%s\\n' ${sq(name)} "$_sh_secret_val" | sudo /usr/bin/tee -a ${sq(secretsFile)} > /dev/null`,
      `unset _sh_secret_val`,
    );
  }

  lines.push(
    `sudo /usr/bin/chmod 600 ${sq(secretsFile)}`,
    ``,
    `# 3. Restart all env unit instances so new secrets are loaded.`,
    `#    disable--now + enable--now is the universally-granted pattern`,
    `#    (no bare restart grant on adopted hosts — issue #99 lesson).`,
  );

  for (const svc of services) {
    const instance = `${svc.unit}@${t.name}.service`;
    lines.push(
      `if systemctl is-active ${sq(instance)} >/dev/null 2>&1; then`,
      `  sudo /usr/bin/systemctl disable --now ${sq(instance)}`,
      `fi`,
      `sudo /usr/bin/systemctl enable --now ${sq(instance)}`,
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
  const isStatic = app.kind === "static";
  const root = envsRoot(app);
  const unit = app.serviceUnit;
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
  if (app.mainHost !== undefined) {
    if (!isValidMainHost(app.mainHost)) {
      throw new Error(
        `invalid mainHost ${JSON.stringify(app.mainHost)} for app ` +
          `'${app.name}' — expected a dotted lowercase DNS name like ` +
          `"app.example.com" (embedded in a root-run script; ` +
          `failing closed)`,
      );
    }
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

    mainVhostLines.push(
      "",
      `#    Landmine guard: render the intended single-service vhost to a staged`,
      `#    file, then call samohost_apply_main_vhost() to compare + conditionally`,
      `#    apply.  The guard refuses if the live file exists and differs — unless`,
      `#    force=true was baked in via --force-main-vhost at host-prep time.`,
      `#    The 00- prefix sorts the live file first in sites.d.`,
      `cat > ${stagedPath} <<'CADDY'`,
      `${app.mainHost} {`,
      `\treverse_proxy localhost:${port}`,
      `}`,
      "CADDY",
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
      `# 2. systemd template unit: one instance per env (%i = env name).`,
      `#    User= is the app user (${envUser}) — the user that owns the env dir`,
      `#    and the cloned code (issue #97: was sshUser which cannot read the`,
      `#    appUser-owned checkout or the 600 .gh-token).`,
      `cat > /etc/systemd/system/${unit}@.service <<'UNIT'`,
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
  }

  // --- step 4 sudoers: node has systemd+postgres grants; static has caddy only -
  const sudoersLines: string[] = [
    `# ${isStatic ? "3" : "4"}. Exact-path sudoers grants (Defaults use_pty is in effect; the env`,
    `#    scripts always call these full paths — issue #99 lesson).`,
    `cat > /etc/sudoers.d/samohost-env-${app.name} <<SUDOERS`,
  ];
  if (!isStatic) {
    sudoersLines.push(
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now ${unit}@*.service`,
      // No restart grant: the unit phase's already-active branch uses
      // disable --now + enable --now (both universally granted on adopted and
      // provisioned VMs alike). A bare restart was never added to adopted hosts.
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl disable --now ${unit}@*.service`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed ${unit}@*.service`,
    );
  }
  sudoersLines.push(
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy`,
  );
  if (!isStatic) {
    sudoersLines.push(
      `${sshUser} ALL=(postgres) NOPASSWD: /usr/bin/createdb, /usr/bin/dropdb, /usr/bin/psql`,
    );
  }
  // Issue #97: when appUser is registered, grant sshUser the right to run
  // /usr/bin/git as appUser with SETENV so that GIT_CONFIG_GLOBAL passes
  // through to the git subprocess. Without SETENV, sudo strips the variable
  // and git loses the safe.directory override.
  //
  // Issue #98 follow-up: also grant /usr/bin/npm so that the install phase
  // (npm ci / npm install) and build phase (npm run build) can run as appUser.
  // A single /usr/bin/npm entry covers all three. The npm grant does NOT need
  // SETENV (no environment variable is forwarded to npm); a separate plain
  // NOPASSWD line is cleaner and avoids unnecessarily widening SETENV scope.
  //
  // samorev security fix (#101): the prior broad `SETENV: /usr/bin/bash` grant
  // let samo run ARBITRARY commands as appUser. It is replaced by three scoped
  // file-write-only grants tied to the envs-root path pattern:
  //   /usr/bin/install -m 600 /dev/null <root>/*/.env — pre-create at 600
  //   /usr/bin/tee <root>/*/.env                      — write content
  //   /usr/bin/chmod 600 <root>/*/.env                — re-assert mode
  // None of these binaries execute arbitrary code. The compose logic runs as
  // samo in a mktemp temp file; only the final write touches the appUser dir.
  if (app.appUser !== undefined) {
    // Resolve the build-command binary so a non-npm build tool also gets a
    // grant (e.g. `node ./build.js` → /usr/bin/node). When buildCmd is already
    // npm-based the resolved binary equals /usr/bin/npm and we omit the
    // duplicate; the single /usr/bin/npm line covers install + build.
    const buildBin = resolveBuildBin(app.buildCmd);
    sudoersLines.push(
      `${sshUser} ALL=(${app.appUser}) NOPASSWD: SETENV: /usr/bin/git`,
      `${sshUser} ALL=(${app.appUser}) NOPASSWD: /usr/bin/npm`,
      ...(buildBin !== "/usr/bin/npm"
        ? [`${sshUser} ALL=(${app.appUser}) NOPASSWD: ${buildBin}`]
        : []),
      // Scoped envfile write grants (samorev security fix — replaces the broad
      // /usr/bin/bash SETENV grant). Path pattern uses the envs root so the
      // sudoers glob covers any env name without allowing writes elsewhere.
      `${sshUser} ALL=(${app.appUser}) NOPASSWD: /usr/bin/install -m 600 /dev/null ${root}/*/.env`,
      `${sshUser} ALL=(${app.appUser}) NOPASSWD: /usr/bin/tee ${root}/*/.env`,
      `${sshUser} ALL=(${app.appUser}) NOPASSWD: /usr/bin/chmod 600 ${root}/*/.env`,
    );
  }
  // When the app declares secrets[], add scoped root grants for
  // /var/lib/samohost/envs/*/secrets.env (PR-B).  All operations run as root
  // (brief: "root writes the 0600 file").  grep -qE only returns an exit code —
  // no content is exposed.  tee -a appends a single printf line; > /dev/null
  // prevents value from appearing in stdout.  rm -f is needed by env secrets
  // rotate (delete + recreate ensures a clean overwrite).
  if ((app.secrets ?? []).length > 0) {
    sudoersLines.push(
      `# Secrets (PR-B): per-env 0600 file at /var/lib/samohost/envs/<name>/secrets.env.`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/mkdir -p /var/lib/samohost/envs`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/install -m 600 -o ${envUser} /dev/null /var/lib/samohost/envs/*/secrets.env`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/grep -qE * /var/lib/samohost/envs/*/secrets.env`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/tee -a /var/lib/samohost/envs/*/secrets.env`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/chmod 600 /var/lib/samohost/envs/*/secrets.env`,
      `${sshUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /var/lib/samohost/envs/*/secrets.env`,
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
    // Guard function definition (only when mainHost is set); placed early so
    // it is in scope before the Caddy step that calls it.
    ...guardFnLines,
    ...nodeOnlyLines,
    `# ${isStatic ? "1" : "3"}. Caddy: include per-env vhost snippets + the durable MAIN-env vhost`,
    `#    (field-record-1#117 ITEM C, 7th drift class).`,
    "mkdir -p /etc/caddy/sites.d",
    `grep -q 'import sites.d/\\*.caddy' /etc/caddy/Caddyfile \\`,
    `  || printf '\\nimport sites.d/*.caddy\\n' >> /etc/caddy/Caddyfile`,
    ...mainVhostLines,
    // When mainHost is set, samohost_apply_main_vhost() handles validate +
    // reload internally.  When mainHost is absent, emit the top-level reload
    // to activate the 'import sites.d/*.caddy' addition.
    ...(app.mainHost === undefined ? ["systemctl reload caddy"] : []),
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
 *   - static apps: `http://<fqdn> { root * <appDir>; file_server }`
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
  let vhostBody: string;
  if (app.kind === "static") {
    vhostBody = `http://${fqdn} {\n\troot * ${app.appDir}\n\tfile_server\n}`;
  } else {
    const port = mainEnvPort(app);
    vhostBody = `http://${fqdn} {\n\treverse_proxy localhost:${port}\n}`;
  }

  return [
    "#!/usr/bin/env bash",
    `# samohost custom-domain vhost (app VM): ${fqdn} → ${app.name}`,
    "# Generated by 'samohost domain add'; pushed over SSH stdin to 'bash -s'.",
    "# http:// prefix: serves on :80 only (no TLS redirect — CP proxies via HTTP).",
    "set -euo pipefail",
    "",
    `SNIPPET=${sq(snippetPath)}`,
    "",
    "# Write the Caddy snippet (overwrite — idempotent; same content each time).",
    `printf '%s\\n' ${sq(vhostBody)} | sudo /usr/bin/tee "$SNIPPET" >/dev/null`,
    "",
    "# Reload Caddy (reload fails on bad config; no separate validate step needed).",
    `sudo /usr/bin/systemctl reload caddy`,
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
    `\t\tCache-Control "no-cache, no-store, must-revalidate"`,
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
    "#    systemctl reload caddy is always available on the control plane.",
    `sudo /usr/bin/systemctl reload caddy`,
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
    `sudo /usr/bin/systemctl reload caddy`,
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
