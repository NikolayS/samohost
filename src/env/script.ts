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

/** Same marker prefix as deploy scripts — one parser convention everywhere. */
export const ENV_PHASE_PREFIX = "<<<SAMOHOST_PHASE:";

/** Env-create phases, in order. Destroy uses the destroy phases. */
export type EnvPhaseName =
  | "clone"
  | "install"
  | "build"
  | "db-preflight"
  | "db"
  | "envfile"
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
 * Bash function: two-strategy branch checkout (issue #11 finding 5). A
 * `git clone --reference` off the production checkout is cheap, but git
 * rejects SHALLOW (or otherwise unusable) reference repos; the old
 * `A && clone || fetch && checkout` chain then ran the fetch against the
 * nonexistent env dir, masking the real error. Now: explicit fallback to a
 * plain clone of the same origin URL, with a message NAMING which strategy
 * failed and why. (Closing brace at column 0 — tests extract and execute it.)
 */
const CLONE_FN_LINES: string[] = [
  "samohost_clone_env_dir() {",
  "  local origin_url",
  '  origin_url="$(git -C "$SAMOHOST_APP_DIR" remote get-url origin)" || {',
  '    echo "samohost: cannot read the origin URL from $SAMOHOST_APP_DIR" >&2',
  "    return 1",
  "  }",
  '  if [[ -d "$SAMOHOST_ENV_DIR/.git" ]]; then',
  '    git -C "$SAMOHOST_ENV_DIR" fetch origin "$SAMOHOST_BRANCH" \\',
  '      && git -C "$SAMOHOST_ENV_DIR" checkout -B "$SAMOHOST_BRANCH" "origin/$SAMOHOST_BRANCH"',
  "    return",
  "  fi",
  '  if git clone --reference "$SAMOHOST_APP_DIR" --dissociate \\',
  '       --branch "$SAMOHOST_BRANCH" --single-branch \\',
  '       "$origin_url" "$SAMOHOST_ENV_DIR"; then',
  "    return 0",
  "  fi",
  '  echo "samohost: strategy 1 (git clone --reference $SAMOHOST_APP_DIR) failed — the production checkout is unusable as a clone reference (e.g. a shallow checkout); falling back to a plain clone of $origin_url" >&2',
  '  rm -rf "$SAMOHOST_ENV_DIR"',
  '  if git clone --branch "$SAMOHOST_BRANCH" --single-branch \\',
  '       "$origin_url" "$SAMOHOST_ENV_DIR"; then',
  "    return 0",
  "  fi",
  '  echo "samohost: strategy 2 (plain git clone of $origin_url, branch $SAMOHOST_BRANCH) ALSO failed — clone phase cannot proceed" >&2',
  "  return 1",
  "}",
];

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
  /** Allocated app port (env/ports.ts). */
  port: number;
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

  // ----- clone (reuse CLONE_FN_LINES unchanged) ----------------------------
  lines.push(...CLONE_FN_LINES, "");
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      "if samohost_clone_env_dir; ",
    ]),
  );

  lines.push('cd "$SAMOHOST_ENV_DIR"', "");

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
        "if printf '%s {\\n\\ttls internal\\n\\troot * %s\\n\\ttry_files {path} /index.html\\n\\tfile_server\\n\\tencode gzip\\n}\\n' \\",
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
    `SAMOHOST_UNIT_INSTANCE=${sq(`${app.serviceUnit}@${t.name}.service`)}`,
    `SAMOHOST_ENV_TEMPLATE=${sq(`${root}.template.env`)}`,
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
  ];

  // ----- clone: reference clone from the production checkout (cheap) with an
  // explicit plain-clone fallback for shallow/unusable references (issue #11
  // finding 5); existing env dirs take the fetch+checkout path.
  lines.push(...CLONE_FN_LINES, "");
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      "if samohost_clone_env_dir; ",
    ]),
  );

  lines.push('cd "$SAMOHOST_ENV_DIR"', "");

  lines.push(
    ...phaseBlock("install", "npm ci (clean, reproducible install)", [
      "if npm ci; ",
    ]),
  );

  lines.push(
    ...phaseBlock("build", "build", [`if ${app.buildCmd}; `]),
  );

  // ----- db ------------------------------------------------------------------
  if (t.dbBackend === "dblab") {
    const dbName = t.dbName ?? t.name;
    const envDbVars = app.envDbVars ?? [...DEFAULT_ENV_DB_VARS];
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
      ...phaseBlock(
        "db",
        "DBLab thin clone + .db.port extraction + prod globals sync (issue #7)",
        [
          'if "$SAMOHOST_DBLAB_BIN" clone create --id "$SAMOHOST_CLONE_ID" \\',
          '     --username samohost_env --password "$SAMOHOST_DB_PASSWORD" \\',
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
  const envfileBody = [
    "if cp \"$SAMOHOST_ENV_TEMPLATE\" \"$SAMOHOST_ENV_DIR/.env\" \\",
    "   && chmod 600 \"$SAMOHOST_ENV_DIR/.env\" \\",
    '   && printf \'\\nPORT=%s\\n\' "$SAMOHOST_PORT" >> "$SAMOHOST_ENV_DIR/.env" \\',
  ];
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
  envfileBody.push("   && true; ");
  lines.push(
    ...phaseBlock(
      "envfile",
      "compose .env ON-HOST from the operator template (samohost never sees values)",
      envfileBody,
    ),
  );

  // ----- unit ------------------------------------------------------------------
  lines.push(
    ...phaseBlock(
      "unit",
      "systemd template instance (full-path sudo; grants in host-prep)",
      ['if sudo /usr/bin/systemctl enable --now "$SAMOHOST_UNIT_INSTANCE"; '],
    ),
  );

  // ----- vhost -----------------------------------------------------------------
  // The record is PROXIED (orange cloud), so CF edge fronts the origin. Caddy
  // uses `tls internal` (self-signed cert); CF Full mode accepts a self-signed
  // origin cert. No browser ever sees the self-signed cert — CF terminates the
  // real edge cert. Direct-to-origin is impossible on CF-locked VMs (firewall
  // allows :443 from CF IPs only), so the `tls internal` self-signed cert is
  // never exposed to clients. ACME is not used: it cannot complete behind a
  // CF-locked :443 and the host has no DNS-01 plugin.
  lines.push(
    ...phaseBlock(
      "vhost",
      "Caddy vhost snippet + reload (sites.d include applied in host-prep)",
      [
        "if printf '%s {\\n\\ttls internal\\n\\treverse_proxy localhost:%s\\n}\\n' \\",
        '     "$SAMOHOST_VHOST" "$SAMOHOST_PORT" \\',
        '   | sudo /usr/bin/tee "$SAMOHOST_CADDY_SNIPPET" >/dev/null \\',
        "   && sudo /usr/bin/systemctl reload caddy; ",
      ],
    ),
  );

  // ----- health ------------------------------------------------------------------
  lines.push(
    `# --- health: poll the app on its localhost port ---`,
    marker("health", "start"),
    "health_ok=0",
    `for attempt in $(seq 1 ${HEALTH_RETRIES}); do`,
    '  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:${SAMOHOST_PORT}/" || echo 000)',
    '  if [[ "$code" == "200" ]]; then health_ok=1; break; fi',
    `  sleep ${HEALTH_SLEEP_SEC}`,
    "done",
    'if [[ "$health_ok" == "1" ]]; then',
    `  ${marker("health", "ok")}`,
    "else",
    `  ${marker("health", "fail")}`,
    '  echo "env health check failed — env left in place for inspection; destroy to clean up" >&2',
    "  exit 1",
    "fi",
    "",
    'echo "env ready: https://${SAMOHOST_VHOST} (port ${SAMOHOST_PORT})"',
    "",
  );

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
  ];

  if (!isStatic) {
    // Node path: stop the systemd template instance.
    lines.push(
      `SAMOHOST_UNIT_INSTANCE=${sq(`${app.serviceUnit}@${t.name}.service`)}`,
    );
  }

  lines.push(
    "",
  );

  if (!isStatic) {
    // Node path: emit unit-stop phase.
    lines.push(
      `# --- unit-stop ---`,
      marker("unit-stop", "start"),
      'sudo /usr/bin/systemctl disable --now "$SAMOHOST_UNIT_INSTANCE" 2>/dev/null || true',
      "# Clear any residual 'failed' unit state (issue #11 finding 8; cosmetic).",
      'sudo /usr/bin/systemctl reset-failed "$SAMOHOST_UNIT_INSTANCE" 2>/dev/null || true',
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
 * Render the ONE-TIME host preparation an operator with root must review and
 * apply before `env create` can run on a (vm, app): the Caddy sites.d include,
 * the durable main-env vhost (when {@link AppRecord.mainHost} is set), the
 * exact-path sudoers grants the env scripts rely on, and the ufw 443 rule.
 *
 * When `app.kind === "static"` (issue #36): the systemd template unit, the
 * env-template-file step, and the DB sudoers grants are OMITTED (a static env
 * has no service, no DB, no env file). The Caddy/ufw/DNS steps are kept
 * unchanged — static HTTPS still needs them.
 *
 * This script is NOT meant to be piped to bash by samohost — it is printed
 * for human review (`samohost env plan --host-prep`).
 */
export function buildHostPrepScript(app: AppRecord, sshUser: string): string {
  const isStatic = app.kind === "static";
  const root = envsRoot(app);
  const unit = app.serviceUnit;

  // Durable MAIN-env vhost (field-record-1#117 ITEM C, 7th drift class): the
  // production vhost must be provisioned state in sites.d, not a hand-applied
  // VM-local Caddy edit that the next Caddyfile churn de-references together
  // with every preview snippet (observed: Cloudflare 521 on *.samo.cat).
  const mainVhostLines: string[] = [];
  if (app.mainHost !== undefined) {
    if (!isValidMainHost(app.mainHost)) {
      throw new Error(
        `invalid mainHost ${JSON.stringify(app.mainHost)} for app ` +
          `'${app.name}' — expected a dotted lowercase DNS name like ` +
          `"field-record-1.samo.team" (embedded in a root-run script; ` +
          `failing closed)`,
      );
    }
    const port = mainEnvPort(app);
    mainVhostLines.push(
      "",
      `#    Durable MAIN-env vhost: deterministic content, so the plain '>'`,
      `#    overwrite is idempotent (re-running host-prep rewrites the same`,
      `#    bytes in place — no append-drift). The 00- prefix sorts it first.`,
      `#    Host and port are strictly validated above (root-run script).`,
      `cat > /etc/caddy/sites.d/00-main-${app.name}.caddy <<'CADDY'`,
      `${app.mainHost} {`,
      `\treverse_proxy localhost:${port}`,
      `}`,
      "CADDY",
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
      `cat > /etc/systemd/system/${unit}@.service <<'UNIT'`,
      "[Unit]",
      `Description=${app.name} preview env %i`,
      "After=network.target",
      "",
      "[Service]",
      `User=${sshUser}`,
      `WorkingDirectory=${root}/%i`,
      `EnvironmentFile=${root}/%i/.env`,
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
    ...nodeOnlyLines,
    `# ${isStatic ? "1" : "3"}. Caddy: include per-env vhost snippets + the durable MAIN-env vhost`,
    `#    (field-record-1#117 ITEM C, 7th drift class).`,
    "mkdir -p /etc/caddy/sites.d",
    `grep -q 'import sites.d/\\*.caddy' /etc/caddy/Caddyfile \\`,
    `  || printf '\\nimport sites.d/*.caddy\\n' >> /etc/caddy/Caddyfile`,
    ...mainVhostLines,
    "systemctl reload caddy",
    "",
    // The env-create script runs later as the non-root env user, so the envs
    // root must already exist and be writable by that user regardless of how
    // /opt/<app> was provisioned (e.g. root-owned when not via app bootstrap).
    `install -d -m 755 -o ${sshUser} -g ${sshUser} ${sq(root)}`,
    "",
    ...sudoersLines,
    "",
    `# ${isStatic ? "4" : "5"}. Firewall: allow 443/tcp so the origin answers HTTPS.`,
    `#    Without this the browser (or Cloudflare edge) gets a TCP-refused`,
    `#    connection → Cloudflare 522. /usr/sbin/ufw is the canonical path on`,
    `#    Ubuntu 22.04/24.04; ufw allow is naturally idempotent.`,
    `#    Run directly (this whole script is the ONE-TIME root host-prep), so NO`,
    `#    NOPASSWD sudoers grant for ufw is added above: the env create/destroy`,
    `#    scripts (run later as the non-root ${sshUser} user) never call ufw —`,
    `#    443 is opened once here, not per env. Adding a /usr/sbin/ufw NOPASSWD`,
    `#    grant would needlessly widen the env user's privilege surface.`,
    `/usr/sbin/ufw allow 443/tcp`,
    "",
    `# ${isStatic ? "5" : "6"}. DNS (one-time, per-preview): samohost's DNS step (Gap #2) creates an`,
    `#    UNPROXIED A record for each per-preview hostname → this VM's IP.`,
    `#    Being UNPROXIED lets Caddy complete the ACME HTTP-01 challenge`,
    `#    directly and obtain a real Let's Encrypt cert (no browser warning).`,
    `#    ufw 443 above is required for the TLS handshake to succeed.`,
    "",
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
    vhost: env.vhost,
    dbBackend: env.dbBackend,
    ...(env.dbName !== undefined ? { dbName: env.dbName } : {}),
    ...(env.templateDb !== undefined ? { templateDb: env.templateDb } : {}),
  };
}
