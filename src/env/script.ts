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
 * full Postgres instance on its own port holding a PHYSICAL COPY of prod —
 * prod's roles, passwords, and database name all exist inside it. So ONLY
 * host:port is rewritten (to 127.0.0.1:$SAMOHOST_DB_PORT, the engine's
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
 * Build the env CREATE script: fresh shallow clone of the branch, install +
 * build, per-env database (dblab clone / template createdb / none), env file
 * composed on-host, systemd template instance start, Caddy vhost write +
 * reload, localhost health probe. Failure exits non-zero; partial state is
 * cleaned by the destroy script (idempotent), not by rollback here.
 */
export function buildEnvCreateScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
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
      "# Per-clone credentials are generated ON THE HOST and never echoed.",
      "# (They create an ADDITIONAL role on the clone; the app keeps using the",
      "# template's prod credentials, which exist in the physical copy.)",
      'SAMOHOST_DB_PASSWORD="$(openssl rand -hex 16)"',
      ...CLONE_PORT_FN_LINES,
      ...phaseBlock(
        "db",
        "DBLab thin clone + nested .db.port extraction (v4.1.3 contract, issue #7)",
        [
          'if "$SAMOHOST_DBLAB_BIN" clone create --id "$SAMOHOST_CLONE_ID" \\',
          '     --username samohost_env --password "$SAMOHOST_DB_PASSWORD" \\',
          "     >/dev/null \\",
          '   && SAMOHOST_DB_PORT="$(samohost_clone_port)" \\',
          '   && [[ "$SAMOHOST_DB_PORT" =~ ^[0-9]+$ ]]; ',
        ],
        [
          '  echo "samohost: dblab clone create/status failed, or no numeric port at .db.port in the clone status JSON" >&2',
          "  exit 1",
        ],
      ),
      "# Env vars whose URLs are repointed at the clone (AppRecord.envDbVars).",
      `SAMOHOST_ENV_DB_VARS=(${envDbVars.map(sq).join(" ")})`,
      "",
      ...REWIRE_DB_HOSTPORT_FN_LINES,
      "",
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
  lines.push(
    ...phaseBlock(
      "vhost",
      "Caddy vhost snippet + reload (sites.d include applied in host-prep)",
      [
        "if printf '%s {\\n\\treverse_proxy localhost:%s\\n}\\n' \\",
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
 */
export function buildEnvDestroyScript(
  app: AppRecord,
  t: EnvScriptTarget,
): string {
  const root = envsRoot(app);
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# samohost env-destroy script (generated; idempotent — safe after a failed create).",
    "set -uo pipefail",
    "",
    `SAMOHOST_ENV_NAME=${sq(t.name)}`,
    `SAMOHOST_ENV_DIR=${sq(`${root}/${t.name}`)}`,
    `SAMOHOST_UNIT_INSTANCE=${sq(`${app.serviceUnit}@${t.name}.service`)}`,
    `SAMOHOST_CADDY_SNIPPET=${sq(`/etc/caddy/sites.d/${t.name}.caddy`)}`,
    "",
    `# --- unit-stop ---`,
    marker("unit-stop", "start"),
    'sudo /usr/bin/systemctl disable --now "$SAMOHOST_UNIT_INSTANCE" 2>/dev/null || true',
    "# Clear any residual 'failed' unit state (issue #11 finding 8; cosmetic).",
    'sudo /usr/bin/systemctl reset-failed "$SAMOHOST_UNIT_INSTANCE" 2>/dev/null || true',
    marker("unit-stop", "ok"),
    "",
    `# --- vhost-remove ---`,
    marker("vhost-remove", "start"),
    'sudo /usr/bin/rm -f "$SAMOHOST_CADDY_SNIPPET"',
    "sudo /usr/bin/systemctl reload caddy || true",
    marker("vhost-remove", "ok"),
    "",
  ];

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
 * Render the ONE-TIME host preparation an operator with root must review and
 * apply before `env create` can run on a (vm, app): the systemd template unit,
 * the Caddy sites.d include, the env template file, and the exact-path sudoers
 * grants the env scripts rely on. This script is NOT meant to be piped to bash
 * by samohost — it is printed for human review (`samohost env plan --host-prep`).
 */
export function buildHostPrepScript(app: AppRecord, sshUser: string): string {
  const root = envsRoot(app);
  const unit = app.serviceUnit;
  const envDbVars = app.envDbVars ?? [...DEFAULT_ENV_DB_VARS];
  const defaultTemplateDb = `${app.name.replace(/-/g, "_")}_template`;
  return [
    "#!/usr/bin/env bash",
    `# samohost host-prep for app '${app.name}' — ONE-TIME, run by an operator with root.`,
    "# Review before applying. Nothing here is executed by samohost itself.",
    "set -euo pipefail",
    "",
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
    `# 3. Caddy: include per-env vhost snippets.`,
    "mkdir -p /etc/caddy/sites.d",
    `grep -q 'import sites.d/\\*.caddy' /etc/caddy/Caddyfile \\`,
    `  || printf '\\nimport sites.d/*.caddy\\n' >> /etc/caddy/Caddyfile`,
    "systemctl reload caddy",
    "",
    `# 4. Exact-path sudoers grants (Defaults use_pty is in effect; the env`,
    `#    scripts always call these full paths — issue #99 lesson).`,
    `cat > /etc/sudoers.d/samohost-env-${app.name} <<SUDOERS`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl enable --now ${unit}@*.service`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl disable --now ${unit}@*.service`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed ${unit}@*.service`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy`,
    `${sshUser} ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy`,
    `${sshUser} ALL=(postgres) NOPASSWD: /usr/bin/createdb, /usr/bin/dropdb, /usr/bin/psql`,
    "SUDOERS",
    `chmod 440 /etc/sudoers.d/samohost-env-${app.name}`,
    "visudo -cf /etc/sudoers.d/samohost-env-" + app.name,
    "",
    `# 5. DNS (one-time, manual): wildcard A record for the preview domain`,
    `#    (*.samo.cat -> VM IP) at the registrar. With a wildcard A record no`,
    `#    per-env DNS API calls are needed; Caddy obtains per-vhost certs via`,
    `#    HTTP-01 as envs appear.`,
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
