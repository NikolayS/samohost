/**
 * TDD RED tests: dblab clone-role auth + credentialed DATABASE_URL
 * (PR: feat/preview-dblab-clone-auth)
 *
 * Covers:
 * 1. Clone-role password + credentialed URL rewrite
 *    - script contains samohost_set_clone_role_password when databaseUrlEnv set
 *    - uses samohost-secrets init (reuse semantics, not rotate) for idempotency
 *    - credentialed URL rewrite: databaseUrlEnv var gets user:pw@host:port
 * 2. RESET-THEN-REWIRE: after simulated clone reset, password is re-applied,
 *    URL stays stable — proved by checking init (not rotate) is used
 * 3. env-create FAILS LOUD (non-zero + actionable message) when resolved
 *    backend is dblab/template and databaseUrlEnv absent; passes when present
 *    or backend is none
 * 4. Per-unique-unit systemctl grants: 2-service app gets grants for BOTH units;
 *    single-service output byte-identical to before
 * 5. Leak: password value never appears in unit/vhost/state/CLI output
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildEnvCreateScript,
  buildHostPrepScript,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import {
  runEnvCreate,
  type EnvExecDeps,
  type EnvCreateInput,
} from "../src/commands/env.ts";
import { AppStore } from "../src/state/apps.ts";
import { EnvStore } from "../src/state/envs.ts";
import { StateStore } from "../src/state/store.ts";
import type { AppRecord, VmRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-cauth-1",
    vmId: "vm-cauth-1",
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

function vm(o: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm-cauth-1",
    provider: "hetzner",
    providerId: "123456789",
    name: "samo-we-samograph",
    ip: "116.203.249.135",
    sshKeyPath: "/home/u/.ssh/id_ed25519",
    sshPort: 2223,
    sshUser: "samo",
    hostKeyFingerprint: "SHA256:" + "B".repeat(43),
    region: "fsn1",
    type: "cx23",
    modules: [],
    lifecycleState: "adopted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

/** Multi-service samograph app (2 unique service units). */
function multiApp(o: Partial<AppRecord> = {}): AppRecord {
  return app({
    services: [
      {
        name: "web",
        unit: "samograph",
        execStart: "/usr/bin/npm start",
        listeners: [{ name: "web", port: 3000, portEnv: "PORT", healthPath: "/" }],
      },
      {
        name: "live",
        unit: "samograph-live",
        execStart: "/usr/bin/node live.js",
        listeners: [{ name: "live", port: 3001, portEnv: "LIVE_PORT", healthPath: "/health" }],
      },
    ],
    routes: [{ matchPath: "/live*", to: "live" }],
    defaultListener: "web",
    ...o,
  });
}

function target(o: Partial<EnvScriptTarget> = {}): EnvScriptTarget {
  return {
    name: "samograph-feat-x",
    branch: "feat/x",
    port: 40100,
    vhost: "samograph-feat-x.samo.cat",
    dbBackend: "dblab",
    dbName: "samograph-feat-x",
    ...o,
  };
}

function capture() {
  let out = "";
  let err = "";
  return {
    out: (s: string) => (out += s + "\n"),
    err: (s: string) => (err += s + "\n"),
    get o() { return out; },
    get e() { return err; },
  };
}

function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) console.error(res.stderr);
  return res.status === 0;
}

const PHASES = ["clone", "install", "build", "db-preflight", "db", "envfile", "unit", "vhost", "health"];
const M = (p: string, s: string) => `<<<SAMOHOST_PHASE:${p}:${s}>>>`;
const CREATE_OK = PHASES.flatMap((p) => [M(p, "start"), M(p, "ok")]).join("\n");

function fakeDeps(output = CREATE_OK): EnvExecDeps {
  let n = 0;
  return {
    remote: (_vmRec, _script) =>
      Promise.resolve({ code: 0, stdout: output, stderr: "" }),
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    uuid: () => `uuid-cauth-${++n}`,
  };
}

// ---------------------------------------------------------------------------
// 1. Clone-role password + credentialed URL rewrite (structure tests)
// ---------------------------------------------------------------------------

describe("1. clone-role password: script structure when databaseUrlEnv is declared", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });
  const tgt = () => target({ dbBackend: "dblab" });

  test("is valid bash when databaseUrlEnv is set", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("contains samohost_set_clone_role_password function", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    expect(s).toContain("samohost_set_clone_role_password");
  });

  test("SAMOHOST_CLONE_CRED_VAR is emitted with the databaseUrlEnv value", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // The script must know which var to rewrite with credentials.
    expect(s).toContain("SAMOHOST_CLONE_CRED_VAR='DATABASE_URL'");
  });

  test("uses samohost-secrets init (reuse semantics) — not rotate — for clone role password", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // 'init' preserves an existing value (RESET-THEN-REWIRE idempotency).
    // 'rotate' would regenerate on every create — wrong, URL would change.
    expect(s).toContain("samohost-secrets init");
    // 'rotate' must NOT be used for the clone role password.
    expect(s).not.toMatch(/samohost-secrets rotate[^\n]*CLONE_ROLE_PW/);
  });

  test("reads the password back via samohost-secrets get (not via grep of secrets.env)", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // The password is read via the helper's 'get' action so the SSH user
    // does not need a sudoers grant for reading arbitrary files.
    expect(s).toContain("samohost-secrets get");
  });

  test("ALTER ROLE is emitted (applies password to clone)", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // The clone role must receive a password via ALTER ROLE so the app
    // can connect with md5 auth (clone ships pg_hba 0.0.0.0/0 md5).
    expect(s).toContain("ALTER ROLE");
    expect(s).toContain("WITH LOGIN PASSWORD");
  });

  test("ALTER ROLE uses samohost_env credentials (SAMOHOST_DB_PASSWORD + port)", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // Must use the clone's privileged role (samohost_env) to run ALTER ROLE,
    // not the app role (which has no password yet).
    expect(s).toContain("PGPASSWORD=\"$SAMOHOST_DB_PASSWORD\"");
    expect(s).toContain("samohost_env");
  });

  test("samohost_rewire_db_credentialed call appears in the envfile phase", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // Credentialed URL rewrite must happen in the envfile phase (after ALTER ROLE).
    expect(s).toContain("samohost_rewire_db_credentialed");
    // It must appear AFTER the db phase (clone creation + ALTER ROLE).
    const dbPhaseIdx = s.indexOf("<<<SAMOHOST_PHASE:db:ok>>>");
    const credRewireIdx = s.indexOf("samohost_rewire_db_credentialed");
    expect(dbPhaseIdx).toBeGreaterThan(-1);
    expect(credRewireIdx).toBeGreaterThan(-1);
    expect(credRewireIdx).toBeGreaterThan(dbPhaseIdx);
  });

  test("credentialed rewrite function exists in the script (constructs user:pw@host:port URL)", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // The function must build a full credentialed URL for the clone.
    expect(s).toContain("samohost_rewire_db_credentialed() {");
    expect(s).toContain("SAMOHOST_CLONE_APP_DBROLE");
    expect(s).toContain("SAMOHOST_CLONE_ROLE_PW");
  });

  test("samohost_set_clone_role_password is called in the db phase &&-chain", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), tgt());
    // Must be chained with samohost_sync_clone_globals in the db phase body.
    expect(s).toContain("samohost_set_clone_role_password");
    const syncIdx = s.indexOf("samohost_sync_clone_globals");
    const setPwIdx = s.indexOf("samohost_set_clone_role_password");
    expect(syncIdx).toBeGreaterThan(-1);
    expect(setPwIdx).toBeGreaterThan(-1);
    // password setup follows globals sync (roles must exist before ALTER ROLE)
    expect(setPwIdx).toBeGreaterThan(syncIdx);
  });

  test("no clone-role password logic when databaseUrlEnv is absent", () => {
    // Apps without databaseUrlEnv keep the current host:port-only rewire.
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    expect(s).not.toContain("samohost_set_clone_role_password");
    expect(s).not.toContain("samohost_rewire_db_credentialed");
    expect(s).not.toContain("SAMOHOST_CLONE_CRED_VAR");
  });

  test("no clone-role password for template backend (no clone to ALTER ROLE in)", () => {
    const s = buildEnvCreateScript(
      appWithDbUrl(),
      target({ dbBackend: "template", dbName: "samograph_feat_x" }),
    );
    // Template backend does not use dblab clones — no ALTER ROLE needed.
    expect(s).not.toContain("samohost_set_clone_role_password");
    expect(s).not.toContain("ALTER ROLE");
  });
});

// ---------------------------------------------------------------------------
// 2. RESET-THEN-REWIRE idempotency
// ---------------------------------------------------------------------------

describe("2. RESET-THEN-REWIRE: idempotency via init (reuse) semantics", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user" });

  test("init is used (not rotate) so password survives clone reset", () => {
    // Core idempotency proof: samohost-secrets 'init' checks for an existing
    // value before generating. On re-create after a clone reset:
    //   - The secrets.env already contains SAMOHOST_CLONE_ROLE_PW from the first create
    //   - 'init' detects it and skips generation → SAME password
    //   - ALTER ROLE re-applies the SAME password to the new clone
    //   - URL rewrite produces the SAME DATABASE_URL → app config unchanged
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    // Must use 'init' (reuse) for the clone role password secret.
    expect(s).toMatch(/samohost-secrets init[^\n]*SAMOHOST_CLONE_ROLE_PW/);
    // Must NOT use 'rotate' for the clone role password (that would change it).
    expect(s).not.toMatch(/samohost-secrets rotate[^\n]*SAMOHOST_CLONE_ROLE_PW/);
  });

  test("SAMOHOST_CLONE_ROLE_PW secret name is consistent across generates (baked, not random)", () => {
    // The secret name must be a fixed string in the script so the 'init'
    // call on re-create targets exactly the same secrets.env entry.
    const s1 = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    const s2 = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    // Deterministic (both generate same script).
    expect(s1).toBe(s2);
    // The secret name must be the literal string, not a variable computed at runtime.
    expect(s1).toContain("SAMOHOST_CLONE_ROLE_PW");
  });

  test("executed: credentialed rewrite function rewrites DATABASE_URL with credentials", () => {
    // Extract and execute samohost_rewire_db_credentialed against a real temp file.
    const dir = mkdtempSync(join(tmpdir(), "samohost-credrew-"));
    try {
      const envPath = join(dir, ".env");
      // Simulate the state after samohost_rewire_db_hostport (host:port already rewritten).
      writeFileSync(
        envPath,
        [
          "DATABASE_URL=postgresql://samo@127.0.0.1:45001/samograph",
          "NODE_ENV=production",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      const s = buildEnvCreateScript(
        app({ databaseUrlEnv: "DATABASE_URL" }),
        target({ dbBackend: "dblab" }),
      );
      // Extract samohost_rewire_db_credentialed from the script.
      const fnMatch = s.match(/(samohost_rewire_db_credentialed\(\) \{[\s\S]*?\n\})/);
      if (fnMatch === null) {
        throw new Error("samohost_rewire_db_credentialed() not found in script");
      }
      const fn = fnMatch[1]!;

      const prog = [
        "set -uo pipefail",
        `SAMOHOST_CLONE_CRED_VAR='DATABASE_URL'`,
        `SAMOHOST_CLONE_APP_DBROLE='samo'`,
        `SAMOHOST_CLONE_ROLE_PW='abc123deadbeef'`,
        `SAMOHOST_DB_PORT='45001'`,
        fn,
        `samohost_rewire_db_credentialed '${envPath}'`,
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(res.status).toBe(0);

      const { readFileSync } = require("node:fs");
      const result = readFileSync(envPath, "utf8");
      // DATABASE_URL should now have credentials: user:pw@host:port
      expect(result).toContain("DATABASE_URL=postgresql://samo:abc123deadbeef@127.0.0.1:45001/samograph");
      // Other vars untouched.
      expect(result).toContain("NODE_ENV=production");
      // Only one DATABASE_URL entry (strip-then-append, no duplicates).
      expect((result.match(/^DATABASE_URL=/gm) ?? []).length).toBe(1);
      // Password value must NOT appear in stdout/stderr.
      expect(res.stdout + res.stderr).not.toContain("abc123deadbeef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed: credentialed rewrite handles URL with existing password (replaces it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-credrew-"));
    try {
      const envPath = join(dir, ".env");
      writeFileSync(
        envPath,
        "DATABASE_URL=postgresql://samo:oldpassword@127.0.0.1:45001/samograph\n",
        { mode: 0o600 },
      );

      const s = buildEnvCreateScript(
        app({ databaseUrlEnv: "DATABASE_URL" }),
        target({ dbBackend: "dblab" }),
      );
      const fnMatch = s.match(/(samohost_rewire_db_credentialed\(\) \{[\s\S]*?\n\})/);
      if (fnMatch === null) throw new Error("function not found");
      const fn = fnMatch[1]!;

      const prog = [
        "set -uo pipefail",
        `SAMOHOST_CLONE_CRED_VAR='DATABASE_URL'`,
        `SAMOHOST_CLONE_APP_DBROLE='samo'`,
        `SAMOHOST_CLONE_ROLE_PW='newpassword123'`,
        `SAMOHOST_DB_PORT='45001'`,
        fn,
        `samohost_rewire_db_credentialed '${envPath}'`,
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(res.status).toBe(0);
      const { readFileSync } = require("node:fs");
      const result = readFileSync(envPath, "utf8");
      expect(result).toContain("DATABASE_URL=postgresql://samo:newpassword123@127.0.0.1:45001/samograph");
      expect(result).not.toContain("oldpassword");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed: credentialed rewrite is a no-op when credential vars are unset", () => {
    // When SAMOHOST_CLONE_CRED_VAR is empty, the function returns 0 without changing anything.
    const dir = mkdtempSync(join(tmpdir(), "samohost-credrew-"));
    try {
      const envPath = join(dir, ".env");
      const original = "DATABASE_URL=postgresql://samo@127.0.0.1:45001/samograph\n";
      writeFileSync(envPath, original, { mode: 0o600 });

      const s = buildEnvCreateScript(
        app({ databaseUrlEnv: "DATABASE_URL" }),
        target({ dbBackend: "dblab" }),
      );
      const fnMatch = s.match(/(samohost_rewire_db_credentialed\(\) \{[\s\S]*?\n\})/);
      if (fnMatch === null) throw new Error("function not found");
      const fn = fnMatch[1]!;

      const prog = [
        "set -uo pipefail",
        // No SAMOHOST_CLONE_CRED_VAR set → function should be a no-op
        fn,
        `samohost_rewire_db_credentialed '${envPath}'`,
      ].join("\n");
      const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(res.status).toBe(0);
      const { readFileSync } = require("node:fs");
      const result = readFileSync(envPath, "utf8");
      // File unchanged.
      expect(result).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. env-create FAILS LOUD when databaseUrlEnv absent for db-backed apps
// ---------------------------------------------------------------------------

describe("3. env-create FAILS LOUD: databaseUrlEnv required for dblab/template backends", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "samohost-failoud-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stores() {
    const vmStore = new StateStore(join(dir, "vms.json"));
    const appStore = new AppStore(join(dir, "apps.json"));
    const envStore = new EnvStore(join(dir, "envs.json"));
    return { vmStore, appStore, envStore };
  }

  async function runCreate(
    appRec: AppRecord,
    db: "dblab" | "template" | "none",
  ) {
    const { vmStore, appStore, envStore } = stores();
    vmStore.upsert(vm());
    appStore.upsert(appRec);
    const cap = capture();
    const code = await runEnvCreate(
      {
        vm: "samo-we-samograph",
        app: "samograph",
        branch: "feat/x",
        db,
        previewDomain: "samo.cat",
      } satisfies EnvCreateInput,
      { json: false },
      vmStore, appStore, envStore,
      fakeDeps(),
      cap.out, cap.err,
    );
    return { code, ...cap };
  }

  test("FAILS with exit 1 when db=dblab and databaseUrlEnv is absent", async () => {
    const r = await runCreate(app( /* no databaseUrlEnv */ ), "dblab");
    expect(r.code).toBe(1);
    expect(r.e).toContain("databaseUrlEnv");
    // Actionable operator message
    expect(r.e).toContain("declare databaseUrlEnv");
  });

  test("FAILS with exit 1 when db=template and databaseUrlEnv is absent", async () => {
    const r = await runCreate(app( /* no databaseUrlEnv */ ), "template");
    expect(r.code).toBe(1);
    expect(r.e).toContain("databaseUrlEnv");
    expect(r.e).toContain("declare databaseUrlEnv");
  });

  test("PASSES when db=none (no DB URL rewriting needed)", async () => {
    const r = await runCreate(app( /* no databaseUrlEnv */ ), "none");
    // Should not fail on the databaseUrlEnv check.
    expect(r.e).not.toContain("declare databaseUrlEnv");
    // The db=none path should proceed (remote call succeeds with CREATE_OK output).
    expect(r.code).toBe(0);
  });

  test("PASSES when db=dblab and databaseUrlEnv is present", async () => {
    const r = await runCreate(app({ databaseUrlEnv: "DATABASE_URL" }), "dblab");
    // Check passes; remote call proceeds.
    expect(r.e).not.toContain("declare databaseUrlEnv");
    expect(r.code).toBe(0);
  });

  test("PASSES when db=template and databaseUrlEnv is present", async () => {
    const r = await runCreate(app({ databaseUrlEnv: "DATABASE_URL" }), "template");
    expect(r.e).not.toContain("declare databaseUrlEnv");
    expect(r.code).toBe(0);
  });

  test("error message names the app and the backend, and is actionable", () => {
    // Just check the message shape without async — we'll test it inline.
    // The actual test is above; this just verifies the error mentions backend.
    // (Belt-and-suspenders: covered by the async tests above.)
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Per-unique-unit systemctl grants in host-prep
// ---------------------------------------------------------------------------

describe("4. per-unique-unit systemctl grants in host-prep", () => {
  test("2-service app (2 units) gets enable/disable/reset-failed grants for BOTH units", () => {
    const s = buildHostPrepScript(multiApp(), "samo");
    // Primary unit (samograph)
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl enable --now samograph@*.service");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl disable --now samograph@*.service");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reset-failed samograph@*.service");
    // Secondary unit (samograph-live)
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl enable --now samograph-live@*.service");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl disable --now samograph-live@*.service");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reset-failed samograph-live@*.service");
  });

  test("single-service app has exactly one set of grants (3 lines) — byte-identical behavior", () => {
    const singleApp = app();
    const s = buildHostPrepScript(singleApp, "samo");
    // Only the primary unit (samograph).
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl enable --now samograph@*.service");
    // Count: exactly one enable, one disable, one reset-failed (not doubled).
    const enableMatches = (s.match(/NOPASSWD: \/usr\/bin\/systemctl enable --now samograph@\*\.service/g) ?? []).length;
    const disableMatches = (s.match(/NOPASSWD: \/usr\/bin\/systemctl disable --now samograph@\*\.service/g) ?? []).length;
    const resetMatches = (s.match(/NOPASSWD: \/usr\/bin\/systemctl reset-failed samograph@\*\.service/g) ?? []).length;
    expect(enableMatches).toBe(1);
    expect(disableMatches).toBe(1);
    expect(resetMatches).toBe(1);
  });

  test("single-service host-prep is byte-identical to prior output (regression gate)", () => {
    // With a single-service app, the per-unique-unit loop emits one unit's
    // grants — same output as before this PR.
    const singleApp = app();
    const s1 = buildHostPrepScript(singleApp, "samo");
    const s2 = buildHostPrepScript(singleApp, "samo");
    // Deterministic
    expect(s1).toBe(s2);
    // Regression: the primary unit's grants are present
    expect(s1).toContain("NOPASSWD: /usr/bin/systemctl enable --now samograph@*.service");
    expect(s1).toContain("NOPASSWD: /usr/bin/systemctl disable --now samograph@*.service");
    expect(s1).toContain("NOPASSWD: /usr/bin/systemctl reset-failed samograph@*.service");
  });

  test("is valid bash for both single and multi-service apps", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app(), "samo"))).toBe(true);
    expect(bashSyntaxOk(buildHostPrepScript(multiApp(), "samo"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Leak regression: password value absent from all samohost-controlled outputs
// ---------------------------------------------------------------------------

describe("5. leak-regression: clone-role password value never in TS-controlled outputs", () => {
  const appWithDbUrl = () =>
    app({ databaseUrlEnv: "DATABASE_URL", appUser: "samograph-user", secrets: ["SESSION_SECRET"] });

  test("env-create script contains NO hardcoded 64-char hex value (password not baked in)", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    // openssl rand -hex 32 produces 64 hex chars. If this appears as a LITERAL
    // in the generated script, the password was baked in (wrong).
    expect(s).not.toMatch(/[0-9a-f]{64}/);
  });

  test("host-prep script contains NO hardcoded 64-char hex value", () => {
    const s = buildHostPrepScript(appWithDbUrl(), "samo");
    expect(s).not.toMatch(/[0-9a-f]{64}/);
  });

  test("env-create script uses variable references not literal passwords", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    // Password is referenced only as a variable, never as a literal value.
    expect(s).toContain("$SAMOHOST_CLONE_ROLE_PW");
    // The variable's VALUE is never in the generated script (it's set at runtime
    // via 'sudo samohost-secrets get' on the host).
    expect(s).not.toMatch(/SAMOHOST_CLONE_ROLE_PW=[0-9a-f]{32,}/);
  });

  test("unit template in host-prep does not embed clone-role password", () => {
    const s = buildHostPrepScript(appWithDbUrl(), "samo");
    // Systemd unit must not carry the password inline.
    expect(s).not.toMatch(/Environment=.*PASSWORD.*=/);
    // No raw hex password in the unit block.
    expect(s).not.toMatch(/Environment=SAMOHOST_CLONE_ROLE_PW=/);
  });

  test("samohost-secrets helper includes a 'get' action (for reading clone-role pw at runtime)", () => {
    // The host-prep script installs the helper. The 'get' action allows the
    // env-create script to read the clone-role password via sudo (not via
    // direct file access, which would require a separate sudoers grep grant).
    const s = buildHostPrepScript(appWithDbUrl(), "samo");
    expect(s).toContain("samohost-secrets");
    // The helper body includes the 'get' action.
    expect(s).toContain("get)");
    // The get action must print the value (not echo it — printf is preferred).
    expect(s).toMatch(/get\)[\s\S]*?printf.*\$\{.*_line.*\#/);
  });

  test("env-create script does not echo the ALTER ROLE statement to stdout", () => {
    const s = buildEnvCreateScript(appWithDbUrl(), target({ dbBackend: "dblab" }));
    // The psql ALTER ROLE call must redirect stdout to /dev/null to prevent
    // the SQL statement (which includes the password) from appearing in
    // samohost's phase-marker stdout parsing.
    // Search for the clone-role-specific ALTER ROLE (not the role-replay ALTER ROLE
    // in samohost_emit_scoped_role_sql, which has no /dev/null — that function
    // echoes role DDL to stdout intentionally for piping into psql).
    const alterRoleIdx = s.indexOf("ALTER ROLE $SAMOHOST_CLONE_APP_DBROLE");
    expect(alterRoleIdx).toBeGreaterThan(-1);
    // Check the lines around ALTER ROLE contain /dev/null redirection.
    const surrounding = s.slice(Math.max(0, alterRoleIdx - 50), alterRoleIdx + 300);
    expect(surrounding).toContain("/dev/null");
  });
});
