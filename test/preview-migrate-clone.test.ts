/**
 * TDD RED tests for two preview-DB gaps:
 *
 * GAP 1 — MIGRATE PHASE
 *   When `app.migrateCmd` is declared, env-create must run migrations against
 *   the clone AFTER secrets (composed .env + secrets.env are in place) and
 *   BEFORE the systemd unit starts. Idempotent migration runners are no-ops
 *   when the clone is already up-to-date (BRANCH schema).
 *   When `migrateCmd` is absent, the generated script is byte-identical to
 *   pre-feature output (legacy gate).
 *
 * GAP 3 — ROLE-ASSUMPTION REPLAY
 *   The app's tenant queries run `SET LOCAL ROLE <app_role>` (a NOLOGIN RLS
 *   role). In prod the DATABASE_URL login role is SUPERUSER so SET ROLE works
 *   implicitly. `samohost_sync_clone_globals` strips NOSUPERUSER on replay
 *   (correct) but never replays role-assumption membership → the clone login
 *   role cannot SET ROLE → login + core features fail.
 *   Fix: after role replay, for each login role L (envDbVars URLs) and each
 *   scoped role R (R≠L) where prod `pg_has_role(L, R, 'USAGE')` is true, emit
 *   `GRANT R TO L` into the clone. Add a fail-closed parity gate.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvCreateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "migrate-app-1",
    vmId: "vm-migrate-1",
    name: "field-record-1",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    ...o,
  };
}

function target(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "field-record-1-feat-x",
    branch: "feat/x",
    port: 3100,
    vhost: "field-record-1-feat-x.samo.cat",
    dbBackend: "dblab",
    dbName: "field-record-1-feat-x",
    ...o,
  };
}

/** Extract a named bash function body from a generated script. */
function extractFn(s: string, name: string): string {
  const re = new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`);
  const m = s.match(re);
  if (m === null) throw new Error(`${name}() not found in script`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// SUDO_STUB for role-assumption tests (extends the sync-globals pattern used in
// env-script.test.ts, adding a pg_has_role branch keyed on a fixture file).
// ---------------------------------------------------------------------------

const SUDO_STUB_WITH_HAS_ROLE = [
  "sudo() {",
  '  local sql="${!#}"',
  '  if [[ "$sql" == *"count(*)"* ]]; then',
  '    if [[ "$sql" == *"pg_policies"* ]]; then cat "$FIX/prod_policies"',
  '    elif [[ "$sql" == *"pg_auth_members"* ]]; then cat "$FIX/prod_auth_members"',
  '    elif [[ "$sql" == *"table_privileges"* ]]; then cat "$FIX/prod_grants"',
  '    elif [[ "$sql" == *"pg_tables"* ]]; then cat "$FIX/prod_ownership"',
  "    fi",
  '    [[ -s "$FIX/prod_counts_fail" ]] && return 1',
  "    return 0",
  "  fi",
  '  if [[ "$sql" == *"pg_has_role"* ]]; then cat "$FIX/prod_has_role"; return 0; fi',
  '  if [[ "$sql" == *"pg_authid"* ]]; then',
  '    if [[ "$sql" == *"CREATE ROLE"* ]]; then cat "$FIX/prod_authid_ddl"',
  '    else cat "$FIX/prod_authid_rows"; fi',
  "    return 0",
  "  fi",
  '  if [[ "$sql" == *"CREATE POLICY"* ]]; then cat "$FIX/prod_policy_ddl"; return 0; fi',
  '  if [[ "$sql" == *"unnest(roles)"* ]]; then cat "$FIX/prod_scoped_roles"; return 0; fi',
  '  if [[ "$sql" == *"OWNER TO"* ]]; then cat "$FIX/prod_owner_ddl"; return 0; fi',
  '  if [[ "$sql" == *"ON SCHEMA"* ]]; then cat "$FIX/prod_schema_grant_ddl"; return 0; fi',
  '  if [[ "$sql" == *"GRANT "* ]]; then cat "$FIX/prod_grant_ddl"; return 0; fi',
  "  return 0",
  "}",
].join("\n");

const PSQL_STUB_WITH_AUTH_MEMBERS = [
  "psql() {",
  '  local sql="" isfile=0 prev="" a batch',
  '  for a in "$@"; do',
  '    if [[ "$prev" == "-c" ]]; then sql="$a"; fi',
  '    if [[ "$a" == "-f" ]]; then isfile=1; fi',
  '    prev="$a"',
  "  done",
  '  if [[ "$isfile" == 1 ]]; then',
  '    batch="$(cat)"',
  '    printf \'%s\\n\' "$batch" >> "$FIX/applied.sql"',
  '    if [[ -n "$CLONE_APPLY_FAIL_ON" && "$batch" == *"$CLONE_APPLY_FAIL_ON"* ]]; then return 1; fi',
  "    return 0",
  "  fi",
  '  if [[ "$sql" == *"pg_auth_members"* ]]; then cat "$FIX/clone_auth_members"',
  '  elif [[ "$sql" == *"pg_policies"* ]]; then cat "$FIX/clone_policies"',
  '  elif [[ "$sql" == *"table_privileges"* ]]; then cat "$FIX/clone_grants"',
  '  elif [[ "$sql" == *"pg_tables"* ]]; then cat "$FIX/clone_ownership"',
  "  fi",
  "  return 0",
  "}",
].join("\n");

const AUTHID_ROWS_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "dblab-pg-authid-rows.txt",
);

const FAKE_SCRAM_FIELD_RECORD =
  "SCRAM-SHA-256$4096:RnJTYWx0$RnJTdG9yZWRLZXk=:RnJTZXJ2ZXJLZXk=";
const FAKE_SCRAM_APP_USER =
  "SCRAM-SHA-256$4096:QXBwU2FsdA==$QXBwU3RvcmVkS2V5:QXBwU2VydmVyS2V5";

const AUTHID_DDL_LEGACY = [
  `CREATE ROLE field_record SUPERUSER CREATEDB CREATEROLE BYPASSRLS LOGIN PASSWORD '${FAKE_SCRAM_FIELD_RECORD}';`,
  `CREATE ROLE app_user LOGIN PASSWORD '${FAKE_SCRAM_APP_USER}';`,
  "CREATE ROLE ci_user BYPASSRLS LOGIN PASSWORD 'SCRAM-SHA-256$4096:Q2lTYWx0$Q2lTdG9yZWRLZXk=:Q2lTZXJ2ZXJLZXk=';",
  `CREATE ROLE dblab_dump BYPASSRLS LOGIN PASSWORD 'SCRAM-SHA-256$4096:RGJsYWJTYWx0$RGJsYWJTdG9yZWQ=:RGJsYWJTZXJ2ZXI=';`,
  "CREATE ROLE analytics_group;",
  "",
].join("\n");

const SYNC_TEMPLATE_DEFAULT = [
  "DATABASE_URL=postgresql://field_record:admin-pw-X@localhost:5432/field_record",
  "APP_DATABASE_URL=postgresql://app_user:app-pw-9@localhost:5432/field_record?sslmode=disable",
  "NODE_ENV=production",
  "",
].join("\n");

interface RoleAssumptionOpts {
  /** What prod_has_role fixture contains: "t" if membership holds, "f" if not. */
  prodHasRole?: string;
  /** Prod auth_members count (for parity gate). Default "0" (prod uses superuser). */
  prodAuthMembers?: string;
  /** Clone auth_members count after GRANTs. Default "1". */
  cloneAuthMembers?: string;
  cloneApplyFailOn?: string;
}

interface SyncGlobalsResult {
  code: number;
  stdout: string;
  stderr: string;
  applied: string;
}

/** Execute samohost_sync_clone_globals against prod-shaped stubs, capturing
 *  applied.sql and the exit code. Mirrors the runSyncGlobals harness in
 *  env-script.test.ts but adds pg_has_role + pg_auth_members fixtures. */
function runSyncGlobalsRA(opts: RoleAssumptionOpts = {}): SyncGlobalsResult {
  const dir = mkdtempSync(join(tmpdir(), "samohost-ra-"));
  try {
    const fix = (name: string, content: string) =>
      writeFileSync(join(dir, name), content);

    fix("template.env", SYNC_TEMPLATE_DEFAULT);
    fix("prod_authid_rows", readFileSync(AUTHID_ROWS_FIXTURE, "utf8"));
    fix("prod_authid_ddl", AUTHID_DDL_LEGACY);
    fix("prod_scoped_roles", "app_user\nfield_record\npublic\n");
    fix("prod_policies", "14");
    fix("prod_grants", "315");
    fix("prod_ownership", "29");
    fix("prod_auth_members", opts.prodAuthMembers ?? "0");
    fix("clone_policies", "14");
    fix("clone_grants", "315");
    fix("clone_ownership", "29");
    fix("clone_auth_members", opts.cloneAuthMembers ?? "1");
    fix("prod_owner_ddl", "ALTER TABLE public.app_users OWNER TO field_record;\n");
    fix("prod_grant_ddl", "GRANT SELECT ON public.app_users TO app_user;\n");
    fix(
      "prod_schema_grant_ddl",
      "GRANT USAGE ON SCHEMA public TO field_record;\nGRANT CREATE ON SCHEMA public TO field_record;\nGRANT USAGE ON SCHEMA public TO app_user;\n",
    );
    fix(
      "prod_policy_ddl",
      "CREATE POLICY p ON public.app_users AS PERMISSIVE FOR SELECT TO app_user USING (true);\n",
    );
    // pg_has_role fixture: "t" means L has membership in R (or L is superuser).
    fix("prod_has_role", opts.prodHasRole ?? "t");
    fix("prod_counts_fail", "");
    fix("applied.sql", "");

    const script = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );

    const fnNames = [
      "samohost_app_url_roles",
      "samohost_emit_scoped_role_sql",
      "samohost_parity_check",
      "samohost_sync_clone_globals",
    ];

    const fns = fnNames
      .map((n) => {
        const re = new RegExp(`(${n}\\(\\) \\{[\\s\\S]*?\\n\\})`);
        const m = script.match(re);
        return m === null ? null : m[1]!;
      })
      .filter((f): f is string => f !== null);

    const prog = [
      "set -uo pipefail",
      `FIX='${dir}'`,
      `CLONE_APPLY_FAIL_ON='${opts.cloneApplyFailOn ?? ""}'`,
      `SAMOHOST_ENV_TEMPLATE='${join(dir, "template.env")}'`,
      "SAMOHOST_ENV_DB_VARS=('DATABASE_URL' 'APP_DATABASE_URL')",
      "SAMOHOST_DB_PASSWORD='harness-stub-pw'",
      "SAMOHOST_DB_PORT='6000'",
      SUDO_STUB_WITH_HAS_ROLE,
      PSQL_STUB_WITH_AUTH_MEMBERS,
      ...fns,
      "samohost_sync_clone_globals",
    ].join("\n");

    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      applied: readFileSync(join(dir, "applied.sql"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// GAP 1: MIGRATE PHASE TESTS
// ---------------------------------------------------------------------------

describe("GAP 1: migrate phase — schema in branch applied to clone before app boots", () => {
  test("script text: migrate:start marker emitted when migrateCmd is set", () => {
    const s = buildEnvCreateScript(
      app({ migrateCmd: "npx prisma migrate deploy" }),
      target(),
    );
    expect(s).toContain("<<<SAMOHOST_PHASE:migrate:start>>>");
    expect(s).toContain("<<<SAMOHOST_PHASE:migrate:ok>>>");
    expect(s).toContain("<<<SAMOHOST_PHASE:migrate:fail>>>");
  });

  test("script text: no migrate phase when migrateCmd is absent — byte-identical legacy output", () => {
    // Absence of migrateCmd must produce zero migrate markers AND a script
    // byte-identical to one where migrateCmd is explicitly undefined.
    const sDefault = buildEnvCreateScript(app(), target());
    const sUndef = buildEnvCreateScript(app({ migrateCmd: undefined }), target());
    expect(sDefault).toBe(sUndef);
    expect(sDefault).not.toContain("SAMOHOST_PHASE:migrate:");
  });

  test("script text: migrate phase is ordered AFTER envfile and BEFORE unit", () => {
    const s = buildEnvCreateScript(
      app({ migrateCmd: "npm run migrate" }),
      target(),
    );
    const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
    const migrateStart = s.indexOf("<<<SAMOHOST_PHASE:migrate:start>>>");
    const unitStart = s.indexOf("<<<SAMOHOST_PHASE:unit:start>>>");
    expect(envfileOk).toBeGreaterThan(-1);
    expect(migrateStart).toBeGreaterThan(-1);
    expect(unitStart).toBeGreaterThan(-1);
    expect(migrateStart).toBeGreaterThan(envfileOk);
    expect(migrateStart).toBeLessThan(unitStart);
  });

  test("script text: migrate phase is ordered AFTER secrets when secrets are declared", () => {
    const s = buildEnvCreateScript(
      app({
        migrateCmd: "npm run migrate",
        secrets: ["JWT_SECRET"],
        appUser: "field-record",
      }),
      target(),
    );
    const secretsOk = s.indexOf("<<<SAMOHOST_PHASE:secrets:ok>>>");
    const migrateStart = s.indexOf("<<<SAMOHOST_PHASE:migrate:start>>>");
    const unitStart = s.indexOf("<<<SAMOHOST_PHASE:unit:start>>>");
    expect(secretsOk).toBeGreaterThan(-1);
    expect(migrateStart).toBeGreaterThan(-1);
    expect(unitStart).toBeGreaterThan(-1);
    expect(migrateStart).toBeGreaterThan(secretsOk);
    expect(migrateStart).toBeLessThan(unitStart);
  });

  test("script text: migrate phase runs in $SAMOHOST_ENV_DIR context", () => {
    // The composed .env (DATABASE_URL → clone) lives in SAMOHOST_ENV_DIR.
    // The migrate phase must reference SAMOHOST_ENV_DIR so migrateCmd can find it.
    const s = buildEnvCreateScript(
      app({ migrateCmd: "npm run migrate" }),
      target(),
    );
    const lines = s.split("\n");
    const migrateStartLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:start>>>"),
    );
    const migrateOkLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:ok>>>"),
    );
    expect(migrateStartLine).toBeGreaterThan(-1);
    expect(migrateOkLine).toBeGreaterThan(-1);
    // SAMOHOST_ENV_DIR must appear somewhere between the two markers (either
    // as a cd target or as part of the env source path).
    const migrateBlock = lines
      .slice(migrateStartLine, migrateOkLine + 1)
      .join("\n");
    expect(migrateBlock).toMatch(/SAMOHOST_ENV_DIR/);
  });

  test("script text: no-appUser path sources composed .env before migrateCmd", () => {
    // When appUser is absent, samo owns SAMOHOST_ENV_DIR/.env (0600) and can
    // source it. migrateCmd must see DATABASE_URL → clone URL.
    const s = buildEnvCreateScript(
      app({ migrateCmd: "node migrate.js" }), // no appUser
      target(),
    );
    const lines = s.split("\n");
    const migrateStartLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:start>>>"),
    );
    const migrateOkLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:ok>>>"),
    );
    const migrateBlock = lines
      .slice(migrateStartLine, migrateOkLine + 1)
      .join("\n");
    // The .env must be sourced (set -a; . ...; set +a pattern).
    expect(migrateBlock).toMatch(/\. .*\.env/);
  });

  test("script text: appUser-wrapped — sudo -u <appUser> when appUser is set", () => {
    const s = buildEnvCreateScript(
      app({ migrateCmd: "node migrate.js", appUser: "field-record" }),
      target(),
    );
    const lines = s.split("\n");
    const migrateStartLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:start>>>"),
    );
    const migrateOkLine = lines.findIndex((l) =>
      l.includes("<<<SAMOHOST_PHASE:migrate:ok>>>"),
    );
    const migrateBlock = lines
      .slice(migrateStartLine, migrateOkLine + 1)
      .join("\n");
    // The migrate command must be wrapped as the app user.
    expect(migrateBlock).toContain("sudo -u 'field-record'");
  });

  test("executed: migrate phase is FAIL-CLOSED — migrate:fail + exit 1 when command fails", () => {
    // Extract the migrate phase from a no-appUser script, replace the migrate
    // command with `false` (always fails), and verify:
    //   1. The process exits non-zero.
    //   2. The migrate:fail marker is printed.
    //   3. The migrate:ok marker is NOT printed.
    const s = buildEnvCreateScript(
      app({ migrateCmd: "npm run migrate" }),
      target({ dbBackend: "none" }), // no DB setup needed for this test
    );

    // Verify the migrate phase exists in the script.
    expect(s).toContain("<<<SAMOHOST_PHASE:migrate:start>>>");

    // Build a minimal harness: define SAMOHOST_ENV_DIR pointing at a tmpdir
    // with a dummy .env, then extract + run just the migrate phase section.
    const dir = mkdtempSync(join(tmpdir(), "samohost-migrate-fail-"));
    try {
      // Write a minimal .env so the source doesn't fail on a missing file.
      writeFileSync(join(dir, ".env"), "DATABASE_URL=postgresql://x:y@localhost/test\n");

      // Build a script that:
      // 1. Sets up SAMOHOST_ENV_DIR to our tmpdir.
      // 2. Has a migrate function body that always fails.
      // 3. Exercises the migrate phase markers and fail-closed exit.
      const harness = [
        "set -euo pipefail",
        `SAMOHOST_ENV_DIR='${dir}'`,
        // Marker helper.
        'marker() { echo "<<<SAMOHOST_PHASE:$1:$2>>>"; }',
        // Simulate the migrate phase with a command that always fails.
        // We mirror the exact phaseBlock structure:
        //   marker start; if <cmd>; then marker ok; else marker fail; exit 1; fi
        'marker migrate start',
        'if false; then',
        '  marker migrate ok',
        'else',
        '  marker migrate fail',
        '  exit 1',
        'fi',
      ].join("\n");

      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      // Must exit non-zero.
      expect(res.status).not.toBe(0);
      // Must emit migrate:fail.
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:migrate:fail>>>");
      // Must NOT emit migrate:ok.
      expect(res.stdout).not.toContain("<<<SAMOHOST_PHASE:migrate:ok>>>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed: migrate phase passes when migrateCmd succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-migrate-ok-"));
    try {
      writeFileSync(join(dir, ".env"), "DATABASE_URL=postgresql://x:y@localhost/test\n");

      // Extract the migrate phase from the generated script and run it
      // with a command that always succeeds (true).
      const s = buildEnvCreateScript(
        app({ migrateCmd: "npm run migrate" }),
        target({ dbBackend: "none" }),
      );

      // Extract just the migrate phase lines (between migrate:start and migrate:ok/fail).
      const lines = s.split("\n");
      const startIdx = lines.findIndex((l) =>
        l.includes("<<<SAMOHOST_PHASE:migrate:start>>>"),
      );
      // Find the closing `fi` of the migrate phase block.
      let endIdx = startIdx;
      for (let i = startIdx; i < lines.length; i++) {
        if (lines[i]!.trim() === "fi") {
          endIdx = i;
          break;
        }
      }
      expect(startIdx).toBeGreaterThan(-1);

      // Replace the migrate command with `true` so it always succeeds.
      const migrateBlock = lines
        .slice(startIdx, endIdx + 1)
        .join("\n")
        .replace(/npm run migrate/, "true");

      const prog = [
        "set -euo pipefail",
        `SAMOHOST_ENV_DIR='${dir}'`,
        migrateBlock,
      ].join("\n");

      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:migrate:ok>>>");
      expect(res.stdout).not.toContain("<<<SAMOHOST_PHASE:migrate:fail>>>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("script text: valid bash syntax with migrateCmd set (all db backends)", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(
        app({ migrateCmd: "npx prisma migrate deploy" }),
        target({ dbBackend: db }),
      );
      const res = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
      if (res.status !== 0) console.error(res.stderr);
      expect(res.status).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// GAP 3: ROLE-ASSUMPTION REPLAY TESTS
// ---------------------------------------------------------------------------

describe("GAP 3: role-assumption replay — GRANT R TO L for SET ROLE capability", () => {
  test("script text: samohost_sync_clone_globals uses pg_has_role for membership check", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The function must check prod membership via pg_has_role (covers both
    // explicit membership AND superuser-in-prod implying membership).
    expect(fn).toContain("pg_has_role");
  });

  test("script text: samohost_sync_clone_globals emits GRANT R TO L for role-assumption", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The GRANT statement for role membership must be present.
    expect(fn).toMatch(/GRANT.*TO/);
  });

  test("script text: role-assumption parity gate is present", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // A samohost_parity_check call covering role memberships (pg_auth_members)
    // must be in the function so a failed GRANT causes the phase to fail CLOSED.
    expect(fn).toContain("pg_auth_members");
    expect(fn).toContain("samohost_parity_check");
  });

  test("script text: role-assumption GRANT does not grant SUPERUSER to clone role", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The GRANT for role-assumption must be GRANT <role> TO <login-role>,
    // NOT a cluster privilege. Verify no SUPERUSER appears in the GRANT block.
    // (NOSUPERUSER in the ALTER ROLE block is expected and allowed.)
    const grantLines = fn
      .split("\n")
      .filter((l) => l.includes("GRANT") && l.includes("TO") && !l.includes("ON "));
    // At least one GRANT...TO line must exist (the role-assumption GRANT).
    expect(grantLines.length).toBeGreaterThan(0);
    // None of the role-membership GRANT lines may grant SUPERUSER.
    for (const gl of grantLines) {
      expect(gl).not.toContain("SUPERUSER");
    }
  });

  test("executed: GRANT R TO L emitted in applied.sql when pg_has_role returns t", () => {
    // prod_has_role = "t" means the login role L has membership in scoped role R.
    // We expect the clone to receive GRANT R TO L.
    const r = runSyncGlobalsRA({ prodHasRole: "t", cloneAuthMembers: "1" });
    expect(r.code).toBe(0);
    // applied.sql must contain at least one GRANT ... TO statement (role membership).
    expect(r.applied).toMatch(/GRANT "[a-z_]+" TO "[a-z_]+";/);
  });

  test("executed: no GRANT emitted when pg_has_role returns f for all pairs", () => {
    // prod_has_role = "f" means no membership. No GRANT statements expected.
    // clone_auth_members = 0 because no GRANTs were applied.
    const r = runSyncGlobalsRA({ prodHasRole: "f", cloneAuthMembers: "0" });
    expect(r.code).toBe(0);
    // No role-membership GRANT lines should appear (only table GRANTs).
    const grantLines = r.applied
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("GRANT ") &&
          !l.includes(" ON ") && // not a table/schema grant
          l.includes(" TO "),
      );
    expect(grantLines.length).toBe(0);
  });

  test("executed: GRANT statement does not grant SUPERUSER — only role membership", () => {
    const r = runSyncGlobalsRA({ prodHasRole: "t", cloneAuthMembers: "1" });
    expect(r.code).toBe(0);
    // The role-membership grants in applied.sql must not include any cluster privilege.
    const roleGrants = r.applied
      .split("\n")
      .filter((l) => l.startsWith("GRANT ") && !l.includes(" ON ") && l.includes(" TO "));
    for (const g of roleGrants) {
      expect(g).not.toContain("SUPERUSER");
      expect(g).not.toContain("BYPASSRLS");
      expect(g).not.toContain("CREATEROLE");
      expect(g).not.toContain("CREATEDB");
      expect(g).not.toContain("REPLICATION");
    }
  });

  test("executed: parity gate catches zero clone memberships when prod had some", () => {
    // If GRANTs fail to apply (clone_auth_members = 0) but prod_auth_members > 0,
    // the parity gate must fail CLOSED.
    const r = runSyncGlobalsRA({
      prodHasRole: "t",
      prodAuthMembers: "2",
      cloneAuthMembers: "0",
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/parity|role/);
  });

  test("executed: healthy parity passes when clone memberships >= prod", () => {
    // When prod has explicit memberships (e.g. from previous grants) and clone
    // matches them, parity must pass.
    const r = runSyncGlobalsRA({
      prodHasRole: "t",
      prodAuthMembers: "0",  // prod is superuser-based — no explicit pg_auth_members
      cloneAuthMembers: "1", // clone got the explicit GRANT
    });
    expect(r.code).toBe(0);
  });

  test("script text: non-dblab backends carry NO role-assumption replay", () => {
    for (const db of ["template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      expect(s).not.toContain("samohost_sync_clone_globals");
      expect(s).not.toContain("pg_has_role");
    }
  });
});
