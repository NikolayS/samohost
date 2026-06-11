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
 * operator-managed template (`/opt/<app>/envs.template.env`), then appends the
 * per-env PORT and — for db-backed envs — a DATABASE_URL whose password is
 * generated on the host (`openssl rand`). Nothing secret transits samohost's
 * stdout parsing: the script never echoes the env file or the password.
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

  // ----- clone: reference clone from the production checkout (cheap), then
  // fetch + checkout the branch.
  lines.push(
    ...phaseBlock("clone", "branch checkout into the env dir", [
      'mkdir -p "$SAMOHOST_ENVS_ROOT"',
      'if [[ ! -d "$SAMOHOST_ENV_DIR/.git" ]] \\',
      '   && git clone --reference "$SAMOHOST_APP_DIR" --dissociate \\',
      '        --branch "$SAMOHOST_BRANCH" --single-branch \\',
      '        "$(git -C "$SAMOHOST_APP_DIR" remote get-url origin)" "$SAMOHOST_ENV_DIR" \\',
      '   || git -C "$SAMOHOST_ENV_DIR" fetch origin "$SAMOHOST_BRANCH" \\',
      '   && git -C "$SAMOHOST_ENV_DIR" checkout -B "$SAMOHOST_BRANCH" "origin/$SAMOHOST_BRANCH"; ',
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
    lines.push(
      `SAMOHOST_CLONE_ID=${sq(dbName)}`,
      "# Per-clone credentials are generated ON THE HOST and never echoed.",
      'SAMOHOST_DB_PASSWORD="$(openssl rand -hex 16)"',
      ...phaseBlock(
        "db",
        "DBLab thin clone (PLAN HOOK: flags to be confirmed against the live DBLab Engine CLI)",
        [
          'if dblab clone create --id "$SAMOHOST_CLONE_ID" \\',
          '     --username samohost_env --password "$SAMOHOST_DB_PASSWORD" \\',
          "     >/dev/null; ",
        ],
      ),
      "# The clone's host port comes from clone status JSON, composed on-host.",
      `SAMOHOST_DB_PORT="$(dblab clone status "$SAMOHOST_CLONE_ID" 2>/dev/null | sed -n 's/.*"port"[^0-9]*\\([0-9]*\\).*/\\1/p' | head -1)"`,
      'SAMOHOST_DATABASE_URL="postgresql://samohost_env:${SAMOHOST_DB_PASSWORD}@localhost:${SAMOHOST_DB_PORT}/postgres"',
      "",
    );
  } else if (t.dbBackend === "template") {
    const dbName = t.dbName ?? t.name.replace(/-/g, "_");
    const tpl = t.templateDb ?? `${app.name.replace(/-/g, "_")}_template`;
    lines.push(
      `SAMOHOST_DB_NAME=${sq(dbName)}`,
      `SAMOHOST_TEMPLATE_DB=${sq(tpl)}`,
      "# Per-env role password generated ON THE HOST, never echoed.",
      'SAMOHOST_DB_PASSWORD="$(openssl rand -hex 16)"',
      ...phaseBlock(
        "db",
        "template-database copy (fallback until DBLab Engine is confirmed)",
        [
          // Exact-path sudo: grants are listed in the host-prep script.
          'if sudo -u postgres /usr/bin/createdb --template="$SAMOHOST_TEMPLATE_DB" "$SAMOHOST_DB_NAME" \\',
          '   && printf \'CREATE ROLE "%s" LOGIN PASSWORD \'"\'"\'%s\'"\'"\';\\nGRANT ALL ON DATABASE "%s" TO "%s";\\n\' \\',
          '        "$SAMOHOST_DB_NAME" "$SAMOHOST_DB_PASSWORD" "$SAMOHOST_DB_NAME" "$SAMOHOST_DB_NAME" \\',
          "      | sudo -u postgres /usr/bin/psql --quiet --file=- >/dev/null; ",
        ],
      ),
      'SAMOHOST_DATABASE_URL="postgresql://${SAMOHOST_DB_NAME}:${SAMOHOST_DB_PASSWORD}@localhost:5432/${SAMOHOST_DB_NAME}"',
      "",
    );
  }

  // ----- envfile ---------------------------------------------------------------
  const envfileBody = [
    "if cp \"$SAMOHOST_ENV_TEMPLATE\" \"$SAMOHOST_ENV_DIR/.env\" \\",
    "   && chmod 600 \"$SAMOHOST_ENV_DIR/.env\" \\",
    '   && printf \'\\nPORT=%s\\n\' "$SAMOHOST_PORT" >> "$SAMOHOST_ENV_DIR/.env" \\',
  ];
  if (t.dbBackend !== "none") {
    envfileBody.push(
      '   && printf \'DATABASE_URL=%s\\n\' "$SAMOHOST_DATABASE_URL" >> "$SAMOHOST_ENV_DIR/.env" \\',
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
      `# --- db-drop: delete the DBLab clone ---`,
      marker("db-drop", "start"),
      'dblab clone destroy "$SAMOHOST_CLONE_ID" 2>/dev/null || true',
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
  return [
    "#!/usr/bin/env bash",
    `# samohost host-prep for app '${app.name}' — ONE-TIME, run by an operator with root.`,
    "# Review before applying. Nothing here is executed by samohost itself.",
    "set -euo pipefail",
    "",
    `# 1. Env template file: base env vars (secrets) for every preview env.`,
    `#    Copy from the production env file and adjust; chmod 600.`,
    `#    samohost env-create copies it on-host and appends PORT/DATABASE_URL.`,
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
  };
}
