/**
 * TDD RED tests: RLS-bypass capability replay to clone login roles.
 *
 * ROOT CAUSE (GOLD proof 2026-07-10): the app's auth path runs a query BEFORE
 * it SETs the tenant GUC, relying on the login role bypassing FORCE ROW LEVEL
 * SECURITY. On PROD the login role (e.g. `samo`) is SUPERUSER, which
 * implicitly bypasses RLS. samohost's clone role-init correctly STRIPS
 * superuser (security) and (as of #144) replays role MEMBERSHIP — but it does
 * NOT replay the RLS-bypass, so the clone login role hits the RLS policy
 * during auth and login fails. The GOLD proof only completed after a MANUAL
 * `ALTER ROLE samo BYPASSRLS` on the clone.
 *
 * FIX: in samohost_sync_clone_globals (alongside the #144 role-assumption
 * replay, same section), for each env login role L (from envDbVars URL roles):
 *   - query PROD: SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=L
 *   - if PROD L effectively bypasses RLS (rolsuper=t OR rolbypassrls=t),
 *     emit ALTER ROLE "L" BYPASSRLS on the CLONE (FAITHFUL: only BYPASSRLS,
 *     never SUPERUSER)
 *   - parity gate: verify L has rolbypassrls=true on the clone (scoped to
 *     emitted roles only, not cluster-wide)
 *
 * SECURITY: prod side is SELECT-only; clone is ephemeral+localhost; no
 * SUPERUSER granted; only BYPASSRLS; only when prod L already has it.
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
    id: "rls-bypass-app-1",
    vmId: "vm-rls-bypass-1",
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
  "",
].join("\n");

const SYNC_TEMPLATE_DEFAULT = [
  "DATABASE_URL=postgresql://field_record:admin-pw-X@localhost:5432/field_record",
  "APP_DATABASE_URL=postgresql://app_user:app-pw-9@localhost:5432/field_record?sslmode=disable",
  "NODE_ENV=production",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Extended stubs for RLS-bypass tests
//
// Extended from the SUDO_STUB_WITH_HAS_ROLE pattern (preview-migrate-clone
// tests), adding:
//   - pg_roles query for rolsuper/rolbypassrls → prod_rls_bypass fixture
//   - clone-side rolbypassrls count → handled in PSQL stub
// ---------------------------------------------------------------------------

const SUDO_STUB_WITH_RLS_BYPASS = [
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
  // pg_roles query for rolsuper + rolbypassrls (RLS-bypass check — prod side)
  '  if [[ "$sql" == *"rolsuper"* && "$sql" == *"rolbypassrls"* && "$sql" == *"pg_roles"* ]]; then cat "$FIX/prod_rls_bypass"; return 0; fi',
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

const PSQL_STUB_WITH_RLS_BYPASS = [
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
  '  if [[ "$sql" == *"rolbypassrls"* ]]; then cat "$FIX/clone_bypass_count"',
  '  elif [[ "$sql" == *"pg_auth_members"* ]]; then cat "$FIX/clone_auth_members"',
  '  elif [[ "$sql" == *"pg_policies"* ]]; then cat "$FIX/clone_policies"',
  '  elif [[ "$sql" == *"table_privileges"* ]]; then cat "$FIX/clone_grants"',
  '  elif [[ "$sql" == *"pg_tables"* ]]; then cat "$FIX/clone_ownership"',
  "  fi",
  "  return 0",
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface RlsBypassOpts {
  /**
   * Fixture for `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=L`
   * on prod. Format: "rolsuper|rolbypassrls" (e.g. "t|f", "f|t", "f|f").
   * The same value is returned for every login role queried.
   */
  prodRlsBypass?: string;
  /** Prod auth_members count (for role-assumption parity gate). Default "0". */
  prodAuthMembers?: string;
  /** Clone auth_members count (role-assumption parity). Default "0". */
  cloneAuthMembers?: string;
  /**
   * Clone bypass count returned by the parity gate query
   * `SELECT count(*) FROM pg_roles WHERE rolbypassrls AND rolname IN (...)`.
   * Default "0".
   */
  cloneBypassCount?: string;
  /** If set, psql -f - fails when the batch contains this string. */
  cloneApplyFailOn?: string;
}

interface SyncGlobalsResult {
  code: number;
  stdout: string;
  stderr: string;
  applied: string;
}

function runSyncGlobalsRLS(opts: RlsBypassOpts = {}): SyncGlobalsResult {
  const dir = mkdtempSync(join(tmpdir(), "samohost-rls-"));
  try {
    const fix = (name: string, content: string) =>
      writeFileSync(join(dir, name), content);

    fix("template.env", SYNC_TEMPLATE_DEFAULT);
    fix("prod_authid_rows", readFileSync(AUTHID_ROWS_FIXTURE, "utf8"));
    fix("prod_authid_ddl", AUTHID_DDL_LEGACY);
    fix("prod_scoped_roles", "app_user\nfield_record\n");
    fix("prod_policies", "14");
    fix("prod_grants", "315");
    fix("prod_ownership", "29");
    fix("prod_auth_members", opts.prodAuthMembers ?? "0");
    fix("clone_policies", "14");
    fix("clone_grants", "315");
    fix("clone_ownership", "29");
    fix("clone_auth_members", opts.cloneAuthMembers ?? "0");
    fix("prod_owner_ddl", "ALTER TABLE public.app_users OWNER TO field_record;\n");
    fix("prod_grant_ddl", "GRANT SELECT ON public.app_users TO app_user;\n");
    fix(
      "prod_schema_grant_ddl",
      "GRANT USAGE ON SCHEMA public TO field_record;\nGRANT USAGE ON SCHEMA public TO app_user;\n",
    );
    fix(
      "prod_policy_ddl",
      "CREATE POLICY p ON public.app_users AS PERMISSIVE FOR SELECT TO app_user USING (true);\n",
    );
    // pg_has_role: "f" by default so role-assumption emits 0 grants → auth_members=0 is fine.
    fix("prod_has_role", "f");
    // prod_rls_bypass: "rolsuper|rolbypassrls" for each queried login role.
    fix("prod_rls_bypass", opts.prodRlsBypass ?? "f|f");
    // clone_bypass_count: how many clone roles have rolbypassrls after our ALTERs.
    fix("clone_bypass_count", opts.cloneBypassCount ?? "0");
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
      SUDO_STUB_WITH_RLS_BYPASS,
      PSQL_STUB_WITH_RLS_BYPASS,
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
// Script-text tests (static — verify the generated bash contains the right
// constructs before any execution)
// ---------------------------------------------------------------------------

describe("rls-bypass-replay: script-text", () => {
  test("samohost_sync_clone_globals queries pg_roles for rolsuper and rolbypassrls (prod side)", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const re = /samohost_sync_clone_globals\(\) \{[\s\S]*?\n\}/;
    const fn = s.match(re)?.[0] ?? "";
    expect(fn).toContain("rolsuper");
    expect(fn).toContain("rolbypassrls");
    expect(fn).toContain("pg_roles");
  });

  test("samohost_sync_clone_globals emits ALTER ROLE BYPASSRLS for login roles", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const re = /samohost_sync_clone_globals\(\) \{[\s\S]*?\n\}/;
    const fn = s.match(re)?.[0] ?? "";
    // Must contain the ALTER ROLE … BYPASSRLS emit pattern.
    expect(fn).toMatch(/ALTER ROLE.*BYPASSRLS/);
  });

  test("RLS-bypass parity gate present in samohost_sync_clone_globals", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const re = /samohost_sync_clone_globals\(\) \{[\s\S]*?\n\}/;
    const fn = s.match(re)?.[0] ?? "";
    // The parity gate must query the clone for rolbypassrls count, scoped to
    // the emitted login roles (IN clause), and compare against emitted count.
    expect(fn).toContain("emitted_bypass");
    // The gate must fail CLOSED when the count doesn't match.
    expect(fn).toMatch(/RLS-bypass parity/i);
  });

  test("no SUPERUSER granted in the RLS-bypass emit block", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const re = /samohost_sync_clone_globals\(\) \{[\s\S]*?\n\}/;
    const fn = s.match(re)?.[0] ?? "";
    // The BYPASSRLS ALTER must not also include SUPERUSER.
    // We check: every line that contains BYPASSRLS in a printf/ALTER ROLE context
    // must not also contain SUPERUSER as a privilege to grant.
    const bypassLines = fn
      .split("\n")
      .filter(
        (l) =>
          l.includes("BYPASSRLS") &&
          (l.includes("ALTER ROLE") || l.includes("printf")),
      );
    expect(bypassLines.length).toBeGreaterThan(0);
    for (const l of bypassLines) {
      // The line may reference NOSUPERUSER (in existing role replay); it must
      // NOT grant SUPERUSER as a new attribute.
      // We check that SUPERUSER does not appear without the NO prefix on the
      // same BYPASSRLS line (i.e. not granting superuser alongside bypassrls).
      expect(l).not.toMatch(/(?<!NO)SUPERUSER/);
    }
  });
});

// ---------------------------------------------------------------------------
// Executed tests — run samohost_sync_clone_globals with stubs and inspect
// applied.sql + exit code
// ---------------------------------------------------------------------------

describe("rls-bypass-replay: executed — emit behavior", () => {
  test("emits ALTER ROLE BYPASSRLS when prod login role is SUPERUSER (rolsuper=t, rolbypassrls=f)", () => {
    // Prod login role is superuser → implicitly bypasses RLS → must grant BYPASSRLS on clone.
    // 2 login roles (field_record, app_user); both get "t|f" → 2 emitted → clone returns 2.
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "t|f",
      cloneBypassCount: "2",
    });
    expect(r.code).toBe(0);
    // applied.sql must contain at least one ALTER ROLE ... BYPASSRLS statement.
    expect(r.applied).toMatch(/ALTER ROLE "[a-z_]+" BYPASSRLS;/);
  });

  test("emits ALTER ROLE BYPASSRLS when prod login role has rolbypassrls directly (non-super)", () => {
    // Prod login role has explicit BYPASSRLS (not superuser) → must be replayed.
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "f|t",
      cloneBypassCount: "2",
    });
    expect(r.code).toBe(0);
    expect(r.applied).toMatch(/ALTER ROLE "[a-z_]+" BYPASSRLS;/);
  });

  test("does NOT emit ALTER ROLE BYPASSRLS when prod login role is plain (rolsuper=f, rolbypassrls=f)", () => {
    // Plain prod role — no RLS-bypass capability → no BYPASSRLS ALTER emitted.
    // Note: the existing role replay emits NOBYPASSRLS (stripping superpowers);
    // we check that no standalone ALTER ROLE ... BYPASSRLS; (bypass grant) appears.
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "f|f",
      cloneBypassCount: "0",
    });
    expect(r.code).toBe(0);
    // The standalone BYPASSRLS-grant pattern: `ALTER ROLE "X" BYPASSRLS;`
    // (not preceded by NO, not part of a multi-attribute ALTER).
    const rlsGrantLines = r.applied
      .split("\n")
      .filter((l) => /ALTER ROLE "[a-z_]+" BYPASSRLS;/.test(l));
    expect(rlsGrantLines.length).toBe(0);
  });

  test("no SUPERUSER granted in applied.sql — only BYPASSRLS attribute emitted", () => {
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "t|f",
      cloneBypassCount: "2",
    });
    expect(r.code).toBe(0);
    // The RLS-bypass ALTER must be `ALTER ROLE "X" BYPASSRLS;` — the sole
    // attribute. It must NOT include SUPERUSER or any other cluster privilege.
    // (The existing role replay emits NOSUPERUSER/NOBYPASSRLS/... on a separate
    // ALTER line — those are fine and expected. We check the NEW bypass lines.)
    const bypassGrantLines = r.applied
      .split("\n")
      .filter((l) => /ALTER ROLE "[a-z_]+" BYPASSRLS;/.test(l));
    expect(bypassGrantLines.length).toBeGreaterThan(0);
    for (const l of bypassGrantLines) {
      // The bypass ALTER must be the minimal form — no extra privileges.
      expect(l).not.toContain("SUPERUSER");
      expect(l).not.toContain("CREATEROLE");
      expect(l).not.toContain("CREATEDB");
      expect(l).not.toContain("REPLICATION");
      expect(l).not.toContain("LOGIN");
      expect(l).not.toContain("PASSWORD");
    }
  });
});

describe("rls-bypass-replay: executed — parity gate", () => {
  test("parity gate fails CLOSED when emitted BYPASSRLS did not land on clone", () => {
    // 2 login roles → both get "t|f" → 2 emitted; but clone_bypass_count=0
    // → the parity gate must fail (emitted=2, clone=0).
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "t|f",
      cloneBypassCount: "0", // GRANTs did not land
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/rls[-\s]bypass parity|bypassrls/i);
  });

  test("parity gate passes when clone has correct bypass count", () => {
    // 2 login roles → both "t|f" → 2 emitted → clone returns 2 → PASS.
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "t|f",
      cloneBypassCount: "2",
    });
    expect(r.code).toBe(0);
  });

  test("parity gate passes when no roles bypass RLS (emitted=0 → gate skipped)", () => {
    // Plain roles → emitted=0 → the gate must be skipped (no fail).
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "f|f",
      cloneBypassCount: "0",
    });
    expect(r.code).toBe(0);
  });
});

describe("rls-bypass-replay: non-dblab backends carry no RLS-bypass logic", () => {
  test("template + none backends do not contain samohost_sync_clone_globals", () => {
    for (const db of ["template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      expect(s).not.toContain("samohost_sync_clone_globals");
      expect(s).not.toContain("rolbypassrls");
    }
  });
});

describe("rls-bypass-replay: legacy byte-identical when no bypass roles", () => {
  test("script text is valid bash with the new code", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const res = spawnSync("bash", ["-n"], { input: s, encoding: "utf8" });
    if (res.status !== 0) console.error(res.stderr);
    expect(res.status).toBe(0);
  });

  test("when no login role bypasses RLS (f|f), applied.sql has no BYPASSRLS grant statements", () => {
    // When prod roles are plain (no super, no bypassrls), the new code must
    // emit ZERO standalone `ALTER ROLE "X" BYPASSRLS;` grant statements.
    // The existing role replay may still emit NOBYPASSRLS (stripping superpowers)
    // — that is correct and not altered by this feature.
    const r = runSyncGlobalsRLS({
      prodRlsBypass: "f|f",
      cloneBypassCount: "0",
    });
    expect(r.code).toBe(0);
    // Only the new standalone BYPASSRLS-grant form must be absent.
    const bypassGrantLines = r.applied
      .split("\n")
      .filter((l) => /ALTER ROLE "[a-z_]+" BYPASSRLS;/.test(l));
    expect(bypassGrantLines.length).toBe(0);
  });
});
