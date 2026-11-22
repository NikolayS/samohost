/**
 * Database roles written by `buildHostBootstrapScript` for node apps.
 *
 * The bootstrap must create the app's own non-superuser login role (the role
 * named in APP_DATABASE_URL) with a password generated on the server, and
 * must never write a URL for a role that does not exist.
 *
 * Two kinds of tests:
 *   - rendered-text tests on the generated script;
 *   - executed tests that run only the database and env-file sections of the
 *     script with stub `sudo` and `openssl` commands on PATH. The stub `sudo`
 *     records its arguments and the SQL it receives on standard input, so the
 *     tests can check what would reach `psql` without root or PostgreSQL.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import type { AppRecord } from "../src/types.ts";
import { dbSection, makeSandbox, nodeApp, nodeOpts, readOr, runSection, type Sandbox } from "./bootstrap-db-harness.ts";

/** Lines of the script that are not comments. */
function codeLines(script: string): string[] {
  return script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
}

describe("bootstrap — app database role (rendered text)", () => {
  test("no placeholder password and no shared app_user role", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    // The old placeholder may appear only in the grep that detects it.
    for (const l of codeLines(script).filter((x) => x.includes("app_password"))) {
      expect(l).toMatch(/grep -q '\^APP_DATABASE_URL=postgresql:\/\/\[\^:@\/\]\*:app_password@'/);
    }
    expect(codeLines(script).join("\n")).not.toMatch(/postgresql:\/\/app_user:/);
  });

  test("default app role is per database: <dbName>_app", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script).toContain("APP_DB_ROLE='shop_app'");
  });

  test("role is created as a login role without elevated attributes", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script).toContain(
      "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(script).toMatch(/CREATE ROLE %I/);
  });

  test("role password comes from openssl on the server and reaches psql on stdin only", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script).toContain('APP_DB_PW="$(openssl rand -hex 24)"');
    // The password is a printf argument piped to psql, never a psql argument.
    const pwLines = codeLines(script).filter((l) => l.includes("APP_DB_PW") && l.includes("psql"));
    for (const l of pwLines) expect(l).not.toMatch(/psql[^|]*APP_DB_PW/);
  });

  test("the app's database is closed to PUBLIC and opened to the app role", () => {
    const script = buildHostBootstrapScript(nodeApp(), nodeOpts());
    expect(script).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC");
    expect(script).toContain("GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I");
  });

  test("invalid dbName is rejected (embedded in SQL and shell)", () => {
    expect(() => buildHostBootstrapScript(nodeApp(), nodeOpts({ dbName: "shop'; drop" }))).toThrow(/dbName/);
    expect(() => buildHostBootstrapScript(nodeApp(), nodeOpts({ dbName: "Shop-Prod" }))).toThrow(/dbName/);
  });

  test("invalid appDbRole is rejected", () => {
    expect(() => buildHostBootstrapScript(nodeApp(), nodeOpts({ appDbRole: "x y" }))).toThrow(/appDbRole/);
  });
});

describe("bootstrap — app database role (executed with stubs)", () => {
  function envFileApp(sb: Sandbox): AppRecord {
    return nodeApp({ envFile: join(sb.dir, "staging.env") });
  }

  test("first run creates the role and writes its real password into APP_DATABASE_URL", () => {
    const sb = makeSandbox();
    try {
      const script = buildHostBootstrapScript(envFileApp(sb), nodeOpts());
      const res = runSection(sb, dbSection(script));
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const env = readFileSync(join(sb.dir, "staging.env"), "utf8");
      const m = env.match(/^APP_DATABASE_URL=postgresql:\/\/shop_app:([0-9a-f]{48})@127\.0\.0\.1:5432\/shop$/m);
      expect(m, env).not.toBeNull();
      const pw = m![1]!;
      const sql = readOr(sb.sqlLog);
      expect(sql).toContain("CREATE ROLE %I");
      expect(sql).toContain(`PASSWORD $pgpw$${pw}$pgpw$`);
      // Never in argv, never on stdout/stderr.
      expect(readOr(sb.argvLog)).not.toContain(pw);
      expect(res.stdout).not.toContain(pw);
    } finally {
      sb.cleanup();
    }
  });

  test("re-run keeps the working password (no silent rotation)", () => {
    const sb = makeSandbox();
    try {
      const script = buildHostBootstrapScript(envFileApp(sb), nodeOpts());
      expect(runSection(sb, dbSection(script)).status).toBe(0);
      const first = readFileSync(join(sb.dir, "staging.env"), "utf8").match(/^APP_DATABASE_URL=.*$/m)![0];
      writeFileSync(sb.rolesFile, "shop_app\n");
      writeFileSync(sb.sqlLog, "");
      const res = runSection(sb, dbSection(script));
      expect(res.status).toBe(0);
      const second = readFileSync(join(sb.dir, "staging.env"), "utf8").match(/^APP_DATABASE_URL=.*$/m)![0];
      expect(second).toBe(first);
      const pw = first.match(/shop_app:([0-9a-f]+)@/)![1]!;
      // The role password is re-applied with the SAME value, never a new one.
      const sql = readOr(sb.sqlLog);
      const applied = [...sql.matchAll(/ALTER ROLE shop_app [^;]* PASSWORD \$pgpw\$([0-9a-f]+)\$pgpw\$/g)].map((x) => x[1]);
      expect(applied.length).toBe(1);
      for (const p of applied) expect(p).toBe(pw);
    } finally {
      sb.cleanup();
    }
  });

  test("an existing placeholder URL is replaced by a real role", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(
        join(sb.dir, "staging.env"),
        "DATABASE_URL=postgresql://postgres:abc@127.0.0.1:5432/shop\n" +
          "APP_DATABASE_URL=postgresql://app_user:app_password@127.0.0.1:5432/shop\n",
      );
      const script = buildHostBootstrapScript(envFileApp(sb), nodeOpts());
      const res = runSection(sb, dbSection(script));
      expect(res.status).toBe(0);
      const env = readFileSync(join(sb.dir, "staging.env"), "utf8");
      expect(env).not.toContain("app_password");
      expect(env).toMatch(/^APP_DATABASE_URL=postgresql:\/\/shop_app:[0-9a-f]{48}@/m);
    } finally {
      sb.cleanup();
    }
  });

  test("a working URL for another role is left unchanged and that role is not touched", () => {
    const sb = makeSandbox();
    try {
      const line = "APP_DATABASE_URL=postgresql://legacy_role:s3cret@127.0.0.1:5432/shop";
      writeFileSync(
        join(sb.dir, "staging.env"),
        `DATABASE_URL=postgresql://postgres:abc@127.0.0.1:5432/shop\n${line}\n`,
      );
      const script = buildHostBootstrapScript(envFileApp(sb), nodeOpts());
      const res = runSection(sb, dbSection(script));
      expect(res.status).toBe(0);
      const env = readFileSync(join(sb.dir, "staging.env"), "utf8");
      expect(env).toContain(line);
      // The role is not created or altered; it only keeps CONNECT on the database.
      expect(readOr(sb.sqlLog)).not.toMatch(/(CREATE|ALTER) ROLE[^\n]*legacy_role|rolname = 'legacy_role'\) THEN/);
      expect(readOr(sb.sqlLog)).toContain(
        "SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', 'shop', rolname) FROM pg_catalog.pg_roles WHERE rolname = 'legacy_role' \\gexec",
      );
      expect(readOr(sb.sqlLog)).not.toContain("shop_app");
    } finally {
      sb.cleanup();
    }
  });
});
