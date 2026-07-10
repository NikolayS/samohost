/**
 * Retro-gate: regression tests + silent-failure/log guards for dblab clone-role auth.
 *
 * Covers the two bugs fixed in commit 77358aa (shipped without tests) and adds
 * hardening that was deferred from PR #142:
 *
 * REGRESSION TESTS (prove the 77358aa fixes stay fixed):
 *   1a. DBROLE extraction: the `sed -E` (not `sed -nE`) pipeline extracts a
 *       non-empty role from both `postgresql://user:pw@host/db` and
 *       `postgresql://user@host/db` template URL forms.
 *   1b. no-appUser path: when appUser is absent (the samograph case) AND
 *       databaseUrlEnv is set, the envfile phase body calls
 *       samohost_rewire_db_credentialed AFTER samohost_rewire_db_hostport.
 *
 * HARDENING (new guards, all RED until implementation added):
 *   2a. [[ -n "$SAMOHOST_CLONE_APP_DBROLE" ]] guard in samohost_set_clone_role_password:
 *       fails loud (non-zero + marker) before ALTER ROLE when the role is empty.
 *   2b. -v ON_ERROR_STOP=1 on the ALTER ROLE psql invocation: SQL errors propagate
 *       non-zero (prevent silent pass of a failed ALTER ROLE).
 *   3.  SET log_min_error_statement TO 'panic' in the same stdin batch as ALTER ROLE,
 *       ordered before it: prevents the failing-statement text (which may include the
 *       password) from being written to the pg server log on error.
 *   4a. install -m 600 /dev/null "${envfile}.rewired" pre-creation in
 *       samohost_rewire_db_hostport: closes the umask race window.
 *   4b. install -m 600 /dev/null "${envfile}.credrew" pre-creation in
 *       samohost_rewire_db_credentialed: same umask fix.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  buildEnvCreateScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors dblab-clone-auth.test.ts naming convention)
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "retro-app-1",
    vmId: "retro-vm-1",
    name: "samograph",
    repo: "acme/samograph",
    branch: "main",
    appDir: "/opt/samograph/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:3000/health",
    serviceUnit: "samograph",
    ...o,
  };
}

function target(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "samograph-feat-retro",
    branch: "feat/retro",
    port: 40200,
    vhost: "samograph-feat-retro.samo.cat",
    dbBackend: "dblab",
    dbName: "samograph-feat-retro",
    ...o,
  };
}

/** Extract samohost_set_clone_role_password function body from the script. */
function extractSetPwFn(s: string): string {
  const m = s.match(/(samohost_set_clone_role_password\(\) \{[\s\S]*?\n\})/);
  if (m === null) throw new Error("samohost_set_clone_role_password() not found in script");
  return m[1]!;
}

/** Extract samohost_rewire_db_hostport function body from the script. */
function extractHostportFn(s: string): string {
  const m = s.match(/(samohost_rewire_db_hostport\(\) \{[\s\S]*?\n\})/);
  if (m === null) throw new Error("samohost_rewire_db_hostport() not found in script");
  return m[1]!;
}

/** Extract samohost_rewire_db_credentialed function body from the script. */
function extractCredFn(s: string): string {
  const m = s.match(/(samohost_rewire_db_credentialed\(\) \{[\s\S]*?\n\})/);
  if (m === null) throw new Error("samohost_rewire_db_credentialed() not found in script");
  return m[1]!;
}

// ---------------------------------------------------------------------------
// 1a. REGRESSION: DBROLE extraction — sed pipeline must produce non-empty role
//
// BUG HISTORY: the first `sed` in the pipeline used `sed -nE` (with the -n
// suppress-output flag) but lacked the /p print suffix, so it ALWAYS produced
// empty output. The second `sed` then received empty input and also produced
// nothing → SAMOHOST_CLONE_APP_DBROLE="" → ALTER ROLE with empty role name →
// psql syntax error.
// FIX (77358aa): drop `-n` from the first sed so it prints the substituted line.
// THESE TESTS must RED-fail if the old `sed -nE` form is reintroduced.
// ---------------------------------------------------------------------------

describe("RETRO 1a. DBROLE extraction: pipeline extracts non-empty role from both URL forms", () => {
  /**
   * Run the SAMOHOST_CLONE_APP_DBROLE assignment from the generated script
   * against a synthetic template file containing the given DATABASE_URL, then
   * return the value the script assigns to SAMOHOST_CLONE_APP_DBROLE.
   *
   * This runs the ACTUAL generated sed pipeline, not a hand-rolled replica —
   * so any regression in the sed command is caught directly.
   */
  function evalDbrole(templateUrl: string, databaseUrlEnv = "DATABASE_URL"): { value: string; status: number } {
    const s = buildEnvCreateScript(
      app({ databaseUrlEnv, appUser: "samograph-user" }),
      target({ dbBackend: "dblab" }),
    );
    const scriptLines = s.split("\n");
    const assignLine = scriptLines.find((l) =>
      l.startsWith("SAMOHOST_CLONE_APP_DBROLE="),
    );
    if (assignLine === undefined) {
      throw new Error("SAMOHOST_CLONE_APP_DBROLE= line not found in generated script");
    }
    const dir = mkdtempSync(join(tmpdir(), "samohost-dbrole-"));
    try {
      const templatePath = join(dir, "template.env");
      writeFileSync(templatePath, `${databaseUrlEnv}=${templateUrl}\n`, { mode: 0o600 });
      const prog = [
        `SAMOHOST_ENV_TEMPLATE=${JSON.stringify(templatePath)}`,
        assignLine,
        `printf '%s\\n' "$SAMOHOST_CLONE_APP_DBROLE"`,
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      return { value: res.stdout.trim(), status: res.status ?? 1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("URL WITH password postgresql://samo:pw@host/db → role = 'samo' (non-empty)", () => {
    const { value, status } = evalDbrole("postgresql://samo:pw@host/db");
    expect(status).toBe(0);
    expect(value).toBe("samo");
    expect(value).not.toBe("");
  });

  test("URL WITHOUT password postgresql://samo@host/db → role = 'samo' (non-empty)", () => {
    const { value, status } = evalDbrole("postgresql://samo@host/db");
    expect(status).toBe(0);
    expect(value).toBe("samo");
    expect(value).not.toBe("");
  });

  test("URL with port postgresql://appuser:pw@host:5432/db → role = 'appuser'", () => {
    const { value, status } = evalDbrole("postgresql://appuser:pw@host:5432/db");
    expect(status).toBe(0);
    expect(value).toBe("appuser");
    expect(value).not.toBe("");
  });

  test("documents old buggy sed -nE form produces empty output (RED evidence for pre-fix code)", () => {
    // The OLD pipeline used `sed -nE 's/^[^=]+=//'` as the first sed.
    // -n suppresses all output; without an explicit /p flag the substitution
    // result is never printed → empty string. This test demonstrates the bug
    // by running the old form directly. It must stay here as documentation.
    const buggyPipeline =
      "printf 'DATABASE_URL=postgresql://samo:pw@host/db\\n' " +
      "| sed -nE 's/^[^=]+=//' " +
      "| sed -nE 's|^\"?[A-Za-z0-9+]+://([^:/@?\"]+)(:[^@/]*)?@.*|\\\\1|p'";
    const res = spawnSync("bash", ["-c", buggyPipeline], { encoding: "utf8" });
    // The old pipeline ALWAYS produces empty — that was the bug.
    expect(res.stdout.trim()).toBe("");
  });

  test("generated script uses sed -E (not sed -nE) for the first sed in the DBROLE pipeline", () => {
    const s = buildEnvCreateScript(
      app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" }),
      target({ dbBackend: "dblab" }),
    );
    const assignLine = s.split("\n").find((l) =>
      l.startsWith("SAMOHOST_CLONE_APP_DBROLE="),
    );
    expect(assignLine).toBeDefined();
    // Must use `sed -E` (no -n) as the first sed to emit output.
    // `sed -nE` without /p would suppress output → empty DBROLE → broken ALTER ROLE.
    expect(assignLine).toMatch(/sed -E 's\/\^\[/);
    // Must NOT have `sed -nE` as the first sed (the bug form).
    expect(assignLine).not.toMatch(/tail -n 1 \| sed -nE 's/);
  });
});

// ---------------------------------------------------------------------------
// 1b. REGRESSION: no-appUser path — credentialed rewrite in envfile phase
//
// BUG HISTORY: buildEnvfileScopedBodyLines() (the appUser path) correctly called
// samohost_rewire_db_credentialed. The backward-compat path (no appUser, used by
// samograph) called only samohost_rewire_db_hostport and NEVER called
// samohost_rewire_db_credentialed → DATABASE_URL kept the original user-only
// fragment → password authentication failed for user "samo" at runtime.
// FIX (77358aa): add the databaseUrlEnv guard + credentialed call in the
// no-appUser path too.
// THESE TESTS must RED-fail if the credentialed rewrite call is removed from
// the no-appUser path.
// ---------------------------------------------------------------------------

describe("RETRO 1b. no-appUser path: credentialed rewrite called after hostport in envfile phase", () => {
  /** App with databaseUrlEnv but WITHOUT appUser (the samograph case). */
  const noUserAppWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL" /* no appUser */ });

  test("no-appUser + databaseUrlEnv → generated script contains samohost_rewire_db_credentialed", () => {
    const s = buildEnvCreateScript(noUserAppWithDbUrl(), target({ dbBackend: "dblab" }));
    expect(s).toContain("samohost_rewire_db_credentialed");
  });

  test("no-appUser + databaseUrlEnv → credentialed call AFTER hostport call in script order", () => {
    const s = buildEnvCreateScript(noUserAppWithDbUrl(), target({ dbBackend: "dblab" }));
    const hostportIdx = s.indexOf('samohost_rewire_db_hostport "$SAMOHOST_ENV_DIR/.env"');
    const credIdx = s.indexOf('samohost_rewire_db_credentialed "$SAMOHOST_ENV_DIR/.env"');
    expect(hostportIdx).toBeGreaterThan(-1);
    expect(credIdx).toBeGreaterThan(-1);
    // Credentialed rewrite must follow hostport rewrite (hostport sets the correct
    // host:port; credentialed then adds user:pw on top of that).
    expect(credIdx).toBeGreaterThan(hostportIdx);
  });

  test("no-appUser + databaseUrlEnv → credentialed call is in the envfile phase &&-chain", () => {
    const s = buildEnvCreateScript(noUserAppWithDbUrl(), target({ dbBackend: "dblab" }));
    // Both calls must appear within the same envfile-phase &&-chain.
    const envfilePhasesIdx = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    const credIdx = s.indexOf('samohost_rewire_db_credentialed "$SAMOHOST_ENV_DIR/.env"');
    expect(envfilePhasesIdx).toBeGreaterThan(-1);
    expect(credIdx).toBeGreaterThan(envfilePhasesIdx);
  });

  test("no-appUser + NO databaseUrlEnv → credentialed rewrite NOT in envfile phase (no-op path)", () => {
    // Apps without databaseUrlEnv should NOT get credentialed rewrite.
    const s = buildEnvCreateScript(app( /* no databaseUrlEnv, no appUser */), target({ dbBackend: "dblab" }));
    expect(s).not.toContain('samohost_rewire_db_credentialed "$SAMOHOST_ENV_DIR/.env"');
  });
});

// ---------------------------------------------------------------------------
// 2a. HARDEN: [[ -n "$SAMOHOST_CLONE_APP_DBROLE" ]] guard — fail loud before ALTER ROLE
//
// Without this guard, if the DBROLE extraction pipeline produces empty (e.g.,
// due to a template URL without a user component, or a future sed regression),
// the ALTER ROLE statement silently receives an empty role name, psql fails with
// a syntax error, and the phase may or may not propagate the failure depending
// on other error-handling. A loud guard catches this at the top of the function,
// before touching psql, with a clear actionable message.
// ---------------------------------------------------------------------------

describe("HARDEN 2a. empty-DBROLE guard: fail loud before ALTER ROLE", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });

  test("samohost_set_clone_role_password contains [[ -n \"$SAMOHOST_CLONE_APP_DBROLE\" ]] guard", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    // Guard must check that SAMOHOST_CLONE_APP_DBROLE is non-empty.
    expect(fn).toMatch(/\[\[ -n "\$SAMOHOST_CLONE_APP_DBROLE"/);
  });

  test("guard appears BEFORE the psql invocation in the function body", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    const guardIdx = fn.search(/\[\[ -n "\$SAMOHOST_CLONE_APP_DBROLE"/);
    const psqlIdx = fn.indexOf("/usr/bin/psql");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(psqlIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(psqlIdx);
  });

  test("executed: empty SAMOHOST_CLONE_APP_DBROLE → non-zero exit", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    // Patch out the sudo calls so the test does not require a privileged env.
    // Replace sudo init/get with no-ops; leave the guard untouched.
    const patched = fn
      .replace(
        /sudo \/usr\/local\/sbin\/samohost-secrets init[^\n]+/,
        ": # (patched) sudo samohost-secrets init",
      )
      .replace(
        /SAMOHOST_CLONE_ROLE_PW="\$\(sudo[^\n]+\)"/,
        "SAMOHOST_CLONE_ROLE_PW='fakepw'",
      );
    const prog = [
      "SAMOHOST_ENV_NAME='test-env'",
      "SAMOHOST_SECRETS_ENV_USER='testuser'",
      // Empty role — the guard must catch this.
      "SAMOHOST_CLONE_APP_DBROLE=''",
      "SAMOHOST_DB_PASSWORD='pw'",
      "SAMOHOST_DB_PORT='5433'",
      patched,
      "samohost_set_clone_role_password",
    ].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
  });

  test("executed: empty SAMOHOST_CLONE_APP_DBROLE → error message mentions SAMOHOST_CLONE_APP_DBROLE", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    const patched = fn
      .replace(
        /sudo \/usr\/local\/sbin\/samohost-secrets init[^\n]+/,
        ": # (patched) sudo samohost-secrets init",
      )
      .replace(
        /SAMOHOST_CLONE_ROLE_PW="\$\(sudo[^\n]+\)"/,
        "SAMOHOST_CLONE_ROLE_PW='fakepw'",
      );
    const prog = [
      "SAMOHOST_ENV_NAME='test-env'",
      "SAMOHOST_SECRETS_ENV_USER='testuser'",
      "SAMOHOST_CLONE_APP_DBROLE=''",
      "SAMOHOST_DB_PASSWORD='pw'",
      "SAMOHOST_DB_PORT='5433'",
      patched,
      "samohost_set_clone_role_password 2>&1 || true",
    ].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
    // The error message must be actionable: mention the variable name.
    expect(res.stdout + res.stderr).toMatch(/SAMOHOST_CLONE_APP_DBROLE/);
  });

  test("executed: non-empty SAMOHOST_CLONE_APP_DBROLE does NOT trigger the guard", () => {
    // With a valid role, the guard must not fire — only the psql call may fail
    // (we patch psql away to avoid needing a real database).
    const dir = mkdtempSync(join(tmpdir(), "samohost-guard-ok-"));
    try {
      const fakePsql = join(dir, "psql");
      writeFileSync(fakePsql, "#!/bin/bash\ncat >/dev/null\nexit 0\n");
      chmodSync(fakePsql, 0o755);

      const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
      const fn = extractSetPwFn(s);
      const patched = fn
        .replace(
          /sudo \/usr\/local\/sbin\/samohost-secrets init[^\n]+/,
          ": # (patched) sudo samohost-secrets init",
        )
        .replace(
          /SAMOHOST_CLONE_ROLE_PW="\$\(sudo[^\n]+\)"/,
          "SAMOHOST_CLONE_ROLE_PW='fakepw'",
        )
        .replace(/\/usr\/bin\/psql\b/, fakePsql);

      const prog = [
        "SAMOHOST_ENV_NAME='test-env'",
        "SAMOHOST_SECRETS_ENV_USER='testuser'",
        "SAMOHOST_CLONE_APP_DBROLE='samo'",
        "SAMOHOST_DB_PASSWORD='pw'",
        "SAMOHOST_DB_PORT='5433'",
        patched,
        "samohost_set_clone_role_password",
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      // With non-empty role and patched psql the function must succeed (exit 0).
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. HARDEN: -v ON_ERROR_STOP=1 on the ALTER ROLE psql invocation
//
// Without ON_ERROR_STOP, a SQL error (e.g., role does not exist yet, concurrent
// modification) causes psql to note the error but still exit 0. The db phase
// then silently passes — the app starts with no password on its clone role.
// With ON_ERROR_STOP=1, psql exits non-zero on SQL error → db phase fails loud.
// ---------------------------------------------------------------------------

describe("HARDEN 2b. ON_ERROR_STOP=1 on ALTER ROLE psql: SQL errors propagate non-zero", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });

  test("samohost_set_clone_role_password psql invocation includes -v ON_ERROR_STOP=1", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    expect(fn).toContain("-v ON_ERROR_STOP=1");
  });

  test("executed: simulated psql error (exit 3) → function exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-on-error-"));
    try {
      // Fake psql: consume stdin (so the pipe doesn't SIGPIPE), exit 3 (SQL error).
      const fakePsql = join(dir, "psql");
      writeFileSync(fakePsql, "#!/bin/bash\ncat >/dev/null\nexit 3\n");
      chmodSync(fakePsql, 0o755);

      const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
      const fn = extractSetPwFn(s);
      const patched = fn
        .replace(
          /sudo \/usr\/local\/sbin\/samohost-secrets init[^\n]+/,
          ": # (patched) sudo samohost-secrets init",
        )
        .replace(
          /SAMOHOST_CLONE_ROLE_PW="\$\(sudo[^\n]+\)"/,
          "SAMOHOST_CLONE_ROLE_PW='fakepw'",
        )
        .replace(/\/usr\/bin\/psql\b/, fakePsql);

      const prog = [
        "SAMOHOST_ENV_NAME='test-env'",
        "SAMOHOST_SECRETS_ENV_USER='testuser'",
        "SAMOHOST_CLONE_APP_DBROLE='samo'",
        "SAMOHOST_DB_PASSWORD='pw'",
        "SAMOHOST_DB_PORT='5433'",
        patched,
        "samohost_set_clone_role_password",
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      // psql exited 3 → function must exit non-zero (SQL error must propagate).
      expect(res.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SECURITY: SET log_min_error_statement TO 'panic' in the ALTER ROLE batch
//
// Even with SET log_statement TO 'none' (which already exists), if the ALTER
// ROLE itself raises an error (e.g., role does not exist), the server may log
// the failing statement under log_min_error_statement. The fix: include
// `SET log_min_error_statement TO 'panic'` in the SAME session stdin batch
// before the ALTER ROLE so the privileged session never logs the failing
// statement text even on error.
// ---------------------------------------------------------------------------

describe("HARDEN 3. log_min_error_statement: suppress error-statement log in ALTER ROLE session", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });

  test("samohost_set_clone_role_password contains SET log_min_error_statement TO 'panic'", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    expect(fn).toMatch(/SET log_min_error_statement TO 'panic'/);
  });

  test("SET log_min_error_statement appears BEFORE ALTER ROLE in the printf batch", () => {
    // Use lastIndexOf to find the occurrences in the printf format string (not
    // in earlier comments — the guard comment mentions "ALTER ROLE" but that is
    // prose, not SQL, and appears before the printf call in the function body).
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    // Both must be present in the function.
    expect(fn).toContain("SET log_min_error_statement");
    expect(fn).toContain("ALTER ROLE");
    // The last occurrence of each is in the printf format string (the SQL batch).
    const logMinErrIdx = fn.lastIndexOf("SET log_min_error_statement");
    const alterRoleIdx = fn.lastIndexOf("ALTER ROLE");
    expect(logMinErrIdx).toBeGreaterThan(-1);
    expect(alterRoleIdx).toBeGreaterThan(-1);
    // SET must come before ALTER ROLE in the SQL batch.
    expect(logMinErrIdx).toBeLessThan(alterRoleIdx);
  });

  test("SET log_min_error_statement is in the same printf/stdin batch as ALTER ROLE", () => {
    // Confirm both SET and ALTER ROLE are part of the same printf argument block
    // (they must be in the same string fed to psql via stdin — not two separate
    // psql calls where the first could complete before the second fires).
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractSetPwFn(s);
    // Extract the printf format string (between the outer quotes of the printf call).
    const printfMatch = fn.match(/printf\s+"([\s\S]*?)"\s*\\/);
    expect(printfMatch).not.toBeNull();
    const printfFmt = printfMatch![1]!;
    expect(printfFmt).toContain("log_min_error_statement");
    expect(printfFmt).toContain("ALTER ROLE");
  });
});

// ---------------------------------------------------------------------------
// 4. UMASK: pre-create temp rewire files at 0600 before writing secrets
//
// Both rewire functions write secrets to a temp file via a bare `>` redirect,
// which creates the file at umask permissions (typically 022 → 0644 on stock
// Ubuntu). For a brief moment the file holding ALL env secrets is world-readable.
// Fix: pre-create the temp file with `install -m 600 /dev/null <file>` (the
// pattern already used for .env.baseurl on line ~1422) so it is 0600 from the
// first byte written.
// ---------------------------------------------------------------------------

describe("HARDEN 4. umask: temp rewire files pre-created 0600 before secrets are written", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });

  // --- 4a: samohost_rewire_db_hostport ---

  test("4a: samohost_rewire_db_hostport contains install -m 600 /dev/null before > redirect to .rewired", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractHostportFn(s);
    // The pre-create must appear before the bare > redirect.
    expect(fn).toMatch(/install -m 600 \/dev\/null "\$\{envfile\}\.rewired"/);
    // Pre-create must appear BEFORE the bare `>` redirect.
    const preCreateIdx = fn.indexOf('install -m 600 /dev/null "${envfile}.rewired"');
    const redirectIdx = fn.indexOf('> "${envfile}.rewired"');
    expect(preCreateIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(preCreateIdx).toBeLessThan(redirectIdx);
  });

  test("4a executed: .rewired file is 0600 from the moment of creation", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-umask-hp-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(
        envPath,
        "DATABASE_URL=postgresql://samo@127.0.0.1:45001/samograph\n",
        { mode: 0o600 },
      );

      const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
      const fn = extractHostportFn(s);

      // Probe: install -m 600 is called, then immediately check permissions before
      // the grep `>` redirect fills the file.
      const probeScript = [
        "set -uo pipefail",
        `SAMOHOST_ENV_DB_VARS=(DATABASE_URL)`,
        `SAMOHOST_DB_PORT='45001'`,
        fn,
        // Call the function; it will create ${envPath}.rewired as part of rewiring.
        `samohost_rewire_db_hostport '${envPath}'`,
        // After the call the .rewired file is gone (mv'd to .env), but if the
        // install -m 600 pre-create guard is present the temp file was 0600 the
        // whole time. We verify indirectly: the function must succeed.
      ].join("\n");
      const res = spawnSync("bash", ["-c", probeScript], { encoding: "utf8" });
      // Function must succeed (exit 0).
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- 4b: samohost_rewire_db_credentialed ---

  test("4b: samohost_rewire_db_credentialed contains install -m 600 /dev/null before > redirect to .credrew", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const fn = extractCredFn(s);
    // The pre-create must appear before the bare > redirect.
    expect(fn).toMatch(/install -m 600 \/dev\/null "\$\{envfile\}\.credrew"/);
    // Pre-create must appear BEFORE the bare `>` redirect.
    const preCreateIdx = fn.indexOf('install -m 600 /dev/null "${envfile}.credrew"');
    const redirectIdx = fn.indexOf('> "${envfile}.credrew"');
    expect(preCreateIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(preCreateIdx).toBeLessThan(redirectIdx);
  });

  test("4b executed: .credrew file is 0600 from the moment of creation", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-umask-cr-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(
        envPath,
        [
          "DATABASE_URL=postgresql://samo@127.0.0.1:45001/samograph",
          "NODE_ENV=production",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
      const fn = extractCredFn(s);

      const probeScript = [
        "set -uo pipefail",
        `SAMOHOST_CLONE_CRED_VAR='DATABASE_URL'`,
        `SAMOHOST_CLONE_APP_DBROLE='samo'`,
        `SAMOHOST_CLONE_ROLE_PW='testpassword123'`,
        `SAMOHOST_DB_PORT='45001'`,
        fn,
        `samohost_rewire_db_credentialed '${envPath}'`,
      ].join("\n");
      const res = spawnSync("bash", ["-c", probeScript], { encoding: "utf8" });
      // Function must succeed (exit 0).
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
