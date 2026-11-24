import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvCreateScript } from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";
import { SQL } from "bun";

// Seven initial policies; four later migrations create four more tables/policies.
const oldTables = ["tenants", "calls", "audit_log", "transcripts", "tokens", "workers", "webhook_events"];
const lateTables = ["deleted_calls", "settings", "calendar_events", "calendar_event_exclusions"];
const protections = oldTables.map(table => ({ schema: "public", table, enabled: true, forced: true,
  policies: [{ name: `${table}_tenant_isolation`, permissive: "PERMISSIVE", command: "ALL",
    roles: ["fixture_app"], using: "tenant_id = current_setting('app.tenant_id')::uuid",
    check: "tenant_id = current_setting('app.tenant_id')::uuid" }] }));

function generatedScript() {
  const app: AppRecord = { id: "app", vmId: "vm", name: "fixture", repo: "example/app", branch: "main",
    appDir: "/opt/fixture/app", buildCmd: "true", healthUrl: "http://localhost:3000/", serviceUnit: "fixture" };
  return buildEnvCreateScript(app, { name: "fixture-feature", branch: "feature", port: 3100,
    vhost: "fixture-feature.samo.cat", dbBackend: "dblab", dbName: "fixture-feature" });
}

function run(options: { newerProdTables?: boolean; mutate?: (rows: typeof protections) => void; failRead?: "prod" | "clone" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-rls-lag-"));
  try {
    const clone = structuredClone(protections); options.mutate?.(clone);
    writeFileSync(join(dir, "prod.json"), JSON.stringify(protections));
    writeFileSync(join(dir, "clone.json"), JSON.stringify(clone));
    writeFileSync(join(dir, "template.env"), "DATABASE_URL=postgresql://fixture@localhost:5432/fixture_db\n");
    writeFileSync(join(dir, "applied.sql"), "");
    const script = generatedScript();
    const names = ["samohost_app_url_roles", "samohost_emit_scoped_role_sql", "samohost_parity_check", "samohost_sync_clone_globals"];
    const functions = names.map(name => script.match(new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`))![1]);
    const scope = oldTables.map(table => `'public.${table}'`).join(",");
    const program = ["set -uo pipefail", `FIX='${dir}'`, `SCOPE="${scope}"`,
      `FAIL_READ='${options.failRead ?? ""}'`, `PROD_COUNT=${options.newerProdTables ? 11 : 7}`, `SAMOHOST_ENV_TEMPLATE='${dir}/template.env'`,
      "SAMOHOST_ENV_DB_VARS=('DATABASE_URL')", "SAMOHOST_DB_PORT=6000", "SAMOHOST_DB_PASSWORD=fake",
      // Catalog doubles exercise the real generated shell, including SQL scoping.
      `sudo() {
        local sql="\${!#}"
        if [[ "$sql" == *jsonb_build_object* ]]; then
          [[ "$FAIL_READ" == prod ]] && return 1
          cat "$FIX/prod.json"; return 0
        fi
        if [[ "$sql" == *'count(*)'* ]]; then
          if [[ "$sql" == *pg_policies* ]]; then
            if [[ "$sql" == *"IN ($SCOPE)"* ]]; then echo 7; else echo "$PROD_COUNT"; fi
          else echo 7; fi
          return 0
        fi
        if [[ "$sql" == *'CREATE POLICY'* ]]; then
          printf 'CREATE POLICY p ON public.calls USING (true);\\n'
          [[ "$sql" == *"IN ($SCOPE)"* ]] || printf 'CREATE POLICY p ON public.calendar_events USING (true);\\n'
          return 0
        fi
        [[ "$sql" == *'pg_has_role'* ]] && { echo f; return 0; }
        [[ "$sql" == *'rolsuper'* ]] && { echo 'f|f'; return 0; }
        [[ "$sql" == *'pg_authid'* ]] && { echo 'fixture|t|'; return 0; }
        [[ "$sql" == *'unnest(roles)'* ]] && { echo fixture; echo fixture_app; return 0; }
        return 0
      }`,
      `psql() {
        local sql='' prev='' file=0 arg
        for arg in "$@"; do
          [[ "$prev" == -c ]] && sql="$arg"
          [[ "$arg" == -f ]] && file=1
          prev="$arg"
        done
        if [[ "$file" == 1 ]]; then cat >> "$FIX/applied.sql"; return 0; fi
        if [[ "$sql" == *jsonb_build_object* ]]; then
          [[ "$FAIL_READ" == clone ]] && return 1
          cat "$FIX/clone.json"; return 0
        fi
        [[ "$sql" == *information_schema.tables* ]] && { echo "$SCOPE"; return 0; }
        [[ "$sql" == *pg_policies* || "$sql" == *table_privileges* || "$sql" == *pg_tables* ]] && { echo 7; return 0; }
        echo 0
      }`, ...functions, "samohost_sync_clone_globals"].join("\n");
    const result = spawnSync("bash", ["-c", program], { encoding: "utf8" });
    return { code: result.status, stderr: result.stderr, stdout: result.stdout, applied: readFileSync(join(dir, "applied.sql"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("RLS protection on an older DBLab snapshot", () => {
  test("seven protected snapshot tables pass with four newer prod tables absent", () => {
    const result = run({ newerProdTables: true });
    expect(result.code).toBe(0);
    for (const table of lateTables) expect(result.applied).not.toContain(`public.${table}`);
  });
  test.each(["missing policy", "changed USING", "changed CHECK", "changed roles", "changed command", "changed permissiveness", "extra permissive policy", "RLS disabled", "FORCE RLS disabled"])("fails closed: %s on an existing table", kind => {
    const result = run({ mutate: rows => {
      const row = rows[0]!, policy = row.policies[0]!;
      if (kind === "missing policy") row.policies = [];
      if (kind === "changed USING") policy.using = "true";
      if (kind === "changed CHECK") policy.check = "true";
      if (kind === "changed roles") policy.roles = ["public"];
      if (kind === "changed command") policy.command = "SELECT";
      if (kind === "changed permissiveness") policy.permissive = "RESTRICTIVE";
      if (kind === "extra permissive policy") row.policies.push({ ...policy, name: "allow_all", using: "true" });
      if (kind === "RLS disabled") row.enabled = false;
      if (kind === "FORCE RLS disabled") row.forced = false;
    } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("RLS protection");
    expect(result.stdout).toBe("");
  });
  test.each(["prod", "clone"] as const)("fails closed if %s protection metadata cannot be read", failRead => {
    const result = run({ failRead });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("RLS protection");
  });
  test.skipIf(!process.env.SAMOHOST_TEST_DATABASE_URL)("generated catalog SQL detects real PostgreSQL protection changes and excludes later tables", async () => {
    // Explicit opt-in local fixture; no connection is constructed in a skipped suite.
    const sql = new SQL(process.env.SAMOHOST_TEST_DATABASE_URL!);
    const schema = `rls_lag_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await sql.begin(async tx => {
        await tx.unsafe(`CREATE SCHEMA ${schema}`);
        for (const table of oldTables) {
          await tx.unsafe(`CREATE TABLE ${schema}.${table}(tenant_id uuid); ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON ${schema}.${table} FOR ALL TO PUBLIC USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`);
        }
        const scope = oldTables.map(table => `'${schema}.${table}'`).join(",");
        const query = generatedScript().match(/  _rls_sql="([^\n]+)"/)![1]!.replaceAll("$_clone_tab_in", scope);
        const metadata = async () => String(Object.values((await tx.unsafe(query))[0]!)[0]);
        const baseline = await metadata();
        const parsed = JSON.parse(baseline);
        expect(parsed).toHaveLength(7);
        expect(parsed.every((row: { enabled: boolean; forced: boolean }) => row.enabled && row.forced)).toBe(true);
        expect(parsed[0].policies[0].roles).toEqual(["public"]);
        for (const table of lateTables) {
          await tx.unsafe(`CREATE TABLE ${schema}.${table}(tenant_id uuid); CREATE POLICY late_policy ON ${schema}.${table} USING (true)`);
        }
        const count = await tx`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ${schema}`;
        expect(count[0].n).toBe(11);
        expect(await metadata()).toBe(baseline);
        await tx.unsafe(`ALTER POLICY tenant_isolation ON ${schema}.tenants USING (true)`);
        expect(await metadata()).not.toBe(baseline);
        await tx.unsafe(`ALTER POLICY tenant_isolation ON ${schema}.tenants USING (tenant_id = current_setting('app.tenant_id')::uuid); ALTER TABLE ${schema}.tenants NO FORCE ROW LEVEL SECURITY`);
        expect(await metadata()).not.toBe(baseline);
        await tx.unsafe(`ALTER TABLE ${schema}.tenants FORCE ROW LEVEL SECURITY; ALTER TABLE ${schema}.tenants DISABLE ROW LEVEL SECURITY`);
        expect(await metadata()).not.toBe(baseline);
        await tx.unsafe(`ALTER TABLE ${schema}.tenants ENABLE ROW LEVEL SECURITY; CREATE POLICY allow_all ON ${schema}.tenants USING (true)`);
        expect(await metadata()).not.toBe(baseline);
        await tx.unsafe(`DROP POLICY allow_all ON ${schema}.tenants; DROP POLICY tenant_isolation ON ${schema}.tenants`);
        expect(await metadata()).not.toBe(baseline);
        await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      });
    } finally { await sql.close(); }
  });
});
