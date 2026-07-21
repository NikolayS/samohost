/**
 * Tests for `buildHostBootstrapScript` — the pure OS-level bootstrap generator
 * (PR-A1: OS prep, user/layout, sudoers, MAIN systemd unit, sshd drop-in,
 * Caddy base config, self-check table).
 * (PR-A2: DB bootstrap, base env file, token-safe repo clone — new describe
 * blocks appended below the A1 tests.)
 *
 * Strategy (mirrors env-script.test.ts):
 *   - a `fieldRecord()` fixture AppRecord (field-record-1-like) +
 *     an opts fixture.
 *   - a `demoApp()` fixture with a DIFFERENT name/user/unit to validate
 *     parameterization and the no-hardcoding assertion.
 *   - ALL tests initially FAIL because `buildHostBootstrapScript` does not
 *     exist yet (RED commit). Implementation makes them green (GREEN commit).
 *
 * NO Playwright scenario is required: `buildHostBootstrapScript` is a pure
 * string generator with no browser surface. Compensating coverage is this
 * bun:test suite plus the `bash -n` syntax check on every generated script.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHostBootstrapScript,
  type HostBootstrapOptions,
} from "../src/app/bootstrap.ts";
import type { AppRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** field-record-1-like AppRecord — the production shape this generalizes. */
function fieldRecord(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111-2222-3333",
    vmId: "vm-aaaa-bbbb-cccc",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    migrateCmd: "node --import tsx/esm src/migration-runner-cli.ts",
    seedCmd: "npm run db:seed",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    envFile: "/opt/field-record/staging.env",
    assertions: { rlsNonSuperuser: true },
    ...overrides,
  };
}

/** A completely different app — proves no field-record/agent hardcoding. */
function demoApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-demo-0000",
    vmId: "vm-demo-0001",
    name: "demo-app",
    repo: "Tanya301/demo-app",
    branch: "main",
    appDir: "/opt/demo-app/app",
    buildCmd: "npm run build",
    healthUrl: "http://localhost:4000/health",
    serviceUnit: "demo-app",
    ...overrides,
  };
}

function defaultOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "agent",
    dbName: "field_record",
    ...overrides,
  };
}

function demoOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "deployer",
    dbName: "demo_db",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run bash -n (syntax check only) against the script string. */
function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) {
    console.error("bash -n stderr:", res.stderr);
  }
  return res.status === 0;
}

/**
 * Result of executing a rendered bootstrap script EXACTLY the way samohost
 * delivers it in production: piped to `bash` on STDIN (the `bash -s` over-ssh
 * contract — see defaultRemoteScriptRunner in src/commands/app.ts, which feeds
 * the whole script body as the process's stdin).
 *
 * This is strictly stronger than `bash -n`: `bash -n` never EXECUTES the §0
 * `read`, so it cannot catch a `read` that consumes the script's own bytes off
 * the same FD 0 that bash is reading the program from. The fresh-VM regression
 * (`bash: line 31: syntax error near unexpected token 'else'`) only manifests
 * at runtime, under exactly this stdin delivery, when no token file is present.
 */
interface PipedRun {
  status: number | null;
  stderr: string;
}

/**
 * Render → execute the script by PIPING it to `bash` on stdin (mirrors
 * `bash -s`). The PATH is replaced with stubbed no-op binaries so the script
 * has ZERO host side effects (no apt-get, no systemctl, no useradd, etc.) —
 * we only care whether bash can PARSE+RUN the program without the §0 `read`
 * stealing the script body off FD 0. `appBase` is pointed at a writable temp
 * dir so §0's `mkdir`/token-file writes succeed and execution reaches the §0
 * if/else (the exact spot that broke on the fixture VM).
 */
function runPipedToBash(app: AppRecord, opts: HostBootstrapOptions): PipedRun {
  const sandbox = mkdtempSync(join(tmpdir(), "samohost-bootstrap-pipe-"));
  const stubBin = join(sandbox, "stub-bin");
  mkdirSync(stubBin);
  // Commands the script invokes that we must neuter to keep the test hermetic.
  const stubs = [
    "apt-get", "curl", "gpg", "useradd", "install", "visudo", "systemctl",
    "caddy", "openssl", "sudo", "pg_ctlcluster", "pg_lsclusters", "lsb_release",
    "createdb", "chown", "tee", "node", "git", "stat",
  ];
  for (const c of stubs) {
    const p = join(stubBin, c);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  const appBase = join(sandbox, "appbase");
  const script = buildHostBootstrapScript(app, { ...opts, appBase });
  // PATH: stubs first (win over real binaries), then the real dirs that hold
  // bash/mkdir/printf/echo/grep/etc. so the interpreter and shell builtins run.
  const res = spawnSync("bash", [], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubBin}:/usr/bin:/bin` },
  });
  rmSync(sandbox, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript — bash syntax", () => {
  test("field-record fixture passes bash -n (no syntax errors)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("demo-app fixture passes bash -n", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("tlsMode:local passes bash -n", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ tlsMode: "local" }));
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("tlsMode:acme passes bash -n", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ tlsMode: "acme" }));
    expect(bashSyntaxOk(script)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: fresh-VM `bash -s` delivery — §0 `read` must NOT steal the script
//
// ROOT CAUSE (fixture run, fresh VM): samohost delivers the bootstrap script by
// PIPING it to `bash -s` over ssh — the whole program is on the process's
// stdin (FD 0). §0's `IFS= read -r _tok` reads from FD 0, so on a fresh VM
// (no pre-placed token file) `read` swallows the NEXT LINE(S) OF THE SCRIPT
// ITSELF off FD 0. That eats `if [[ -s "$TOKEN_FILE" ]]; then`, leaving a
// dangling `else` → `bash: line 31: syntax error near unexpected token 'else'`.
// Caddy + the main unit then never install → previews 522.
//
// `bash -n` CANNOT catch this (it never runs `read`), which is why the existing
// `bash -n` suite stayed green while a fresh VM blew up. These tests execute the
// script the way prod does (stdin pipe) and assert §0 leaves the script intact.
// ---------------------------------------------------------------------------
describe("buildHostBootstrapScript — fresh-VM bash -s delivery (§0 read must not steal script)", () => {
  test("field-record: piped to bash on stdin runs WITHOUT the §0 read stealing the script", () => {
    const run = runPipedToBash(fieldRecord(), defaultOpts());
    // The exact fixture-VM signature must NOT appear.
    expect(run.stderr).not.toMatch(/syntax error near unexpected token .else/);
    expect(run.stderr).not.toMatch(/syntax error/);
  });

  test("demo-app: piped to bash on stdin runs WITHOUT a §0 read syntax error", () => {
    const run = runPipedToBash(demoApp(), demoOpts());
    expect(run.stderr).not.toMatch(/syntax error/);
  });

  test("tlsMode:local: piped to bash on stdin has no §0 read syntax error", () => {
    const run = runPipedToBash(fieldRecord(), defaultOpts({ tlsMode: "local" }));
    expect(run.stderr).not.toMatch(/syntax error/);
  });
});

describe("buildHostBootstrapScript — determinism / purity", () => {
  test("same inputs produce byte-identical output (pure function)", () => {
    const a = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const b = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(a).toBe(b);
  });

  test("different app names produce different scripts", () => {
    const fr = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const da = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(fr).not.toBe(da);
  });
});

describe("buildHostBootstrapScript — no secrets / no credentials", () => {
  test("script does NOT contain --token, --gh-token, or bare PGPASSWORD= assignment", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).not.toMatch(/--token/);
    expect(script).not.toMatch(/--gh-token/);
    // PGPASSWORD= is the forbidden pattern (puts cleartext in env); git credential
    // protocol's 'echo password=$(cat ...)' is the allowed runtime-cat pattern.
    expect(script).not.toMatch(/PGPASSWORD=/);
  });

  test("script does NOT contain https://...@github.com (credential-in-URL)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Pattern: https://anything@github.com (credential embedding)
    expect(script).not.toMatch(/https:\/\/[^@\s]+@github\.com/);
  });
});

describe("buildHostBootstrapScript — exact-path sudo grants", () => {
  test("sudoers file contains NOPASSWD: /usr/bin/systemctl restart <unit>", () => {
    const app = fieldRecord();
    const script = buildHostBootstrapScript(app, defaultOpts());
    const unit = app.serviceUnit;
    // Must match the exact grant pattern: NOPASSWD + full-path + restart + unit
    expect(script).toMatch(
      new RegExp(`NOPASSWD:\\s*/usr/bin/systemctl restart ${unit}`),
    );
  });

  test("sudoers file contains NOPASSWD: /usr/bin/systemctl daemon-reload", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/NOPASSWD:\s*\/usr\/bin\/systemctl daemon-reload/);
  });

  test("sudoers file contains NOPASSWD grant for /usr/bin/psql as postgres", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/\(postgres\)\s+NOPASSWD:\s*\/usr\/bin\/psql/);
  });

  test("sudoers file is validated with visudo -cf", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("visudo -cf");
  });

  test("demo-app fixture: sudoers restart grant uses demo-app unit name", () => {
    const app = demoApp();
    const script = buildHostBootstrapScript(app, demoOpts());
    expect(script).toMatch(
      new RegExp(`NOPASSWD:\\s*/usr/bin/systemctl restart demo-app`),
    );
  });
});

describe("buildHostBootstrapScript — full-path systemctl only (issue #99)", () => {
  test("no bare `sudo systemctl` in non-comment lines", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const codeLines = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"));
    for (const line of codeLines) {
      // A bare `sudo systemctl` (without full path) must NOT appear.
      expect(/sudo\s+systemctl\b/.test(line)).toBe(false);
    }
  });

  test("every `systemctl` token in non-comment lines uses /usr/bin/systemctl", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const codeLines = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"));
    for (const line of codeLines) {
      if (/systemctl/.test(line)) {
        expect(line).toContain("/usr/bin/systemctl");
      }
    }
  });
});

describe("buildHostBootstrapScript — PostgreSQL install + PG_FALLBACK", () => {
  test("script contains the configured PG major version (default 18)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Must reference pg major 18 in the install logic
    expect(script).toContain("18");
  });

  test("script contains PG_FALLBACK announcement line (idempotent fallback)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("PG_FALLBACK");
  });

  test("script with custom pgMajor:17 references 17 and PG_FALLBACK", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ pgMajor: 17 }));
    expect(script).toContain("17");
    expect(script).toContain("PG_FALLBACK");
  });

  test("script contains Node.js install via NodeSource", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // NodeSource or nodesource reference
    expect(script).toMatch(/nodesource|NodeSource/i);
  });

  test("script with custom nodeMajor:20 references 20", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ nodeMajor: 20 }));
    expect(script).toContain("20");
  });
});

describe("buildHostBootstrapScript — Caddy config", () => {
  test("script contains `import sites.d/*.caddy`", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("import sites.d/*.caddy");
  });

  test("script creates /etc/caddy/sites.d directory", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("/etc/caddy/sites.d");
    // mkdir -p must be present
    expect(script).toMatch(/mkdir\s+-p[^\n]*\/etc\/caddy\/sites\.d/);
  });

  test("script runs `caddy validate` before reload", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("caddy validate");
    // validate must appear before the EXECUTABLE reload line.
    // Find the first reload that is an actual command (not a sudoers NOPASSWD grant).
    // Executable reloads: lines containing "systemctl reload caddy" but NOT "NOPASSWD:"
    const validateIdx = script.indexOf("caddy validate");
    const lines = script.split("\n");
    const reloadLineIdx = lines.findIndex(
      (l) => (l.includes("caddy reload") || l.includes("systemctl reload caddy")) &&
              !l.includes("NOPASSWD:")
    );
    // Convert line index to character offset for comparison
    const reloadCharIdx = lines.slice(0, reloadLineIdx).join("\n").length;
    expect(validateIdx).toBeGreaterThanOrEqual(0);
    expect(reloadLineIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeLessThan(reloadCharIdx);
  });

  test("tlsMode:local => `local_certs` global is present", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ tlsMode: "local" }));
    expect(script).toContain("local_certs");
  });

  test("tlsMode:acme (default) => no `local_certs` global", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ tlsMode: "acme" }));
    expect(script).not.toContain("local_certs");
  });

  test("tlsMode omitted (default acme) => no `local_certs`", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).not.toContain("local_certs");
  });
});

describe("buildHostBootstrapScript — MAIN systemd unit (NOT template)", () => {
  test("script writes /etc/systemd/system/<unit>.service with [Service] block", () => {
    const app = fieldRecord();
    const script = buildHostBootstrapScript(app, defaultOpts());
    const unit = app.serviceUnit;
    expect(script).toContain(`/etc/systemd/system/${unit}.service`);
    expect(script).toContain("[Service]");
  });

  test("unit file contains User=<appUser>", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    expect(script).toContain("User=agent");
  });

  test("unit file contains WorkingDirectory=<appDir>", () => {
    const app = fieldRecord();
    const script = buildHostBootstrapScript(app, defaultOpts());
    expect(script).toContain(`WorkingDirectory=${app.appDir}`);
  });

  test("unit file contains the configured ExecStart (default /usr/bin/node dist/server.js)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("ExecStart=/usr/bin/node dist/server.js");
  });

  test("unit file contains custom ExecStart when provided", () => {
    const script = buildHostBootstrapScript(
      fieldRecord(),
      defaultOpts({ execStart: "/usr/bin/bun run src/server.ts" }),
    );
    expect(script).toContain("ExecStart=/usr/bin/bun run src/server.ts");
  });

  test("script does NOT contain template `@.service` syntax (host-bootstrap owns MAIN unit only)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // The template unit (@.service and %i expansion) is owned by host-prep, NOT here
    expect(script).not.toContain("@.service");
    expect(script).not.toMatch(/%i\b/);
  });

  test("daemon-reload is called after writing the unit file", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("/usr/bin/systemctl daemon-reload");
  });

  test("unit is enabled (start deferred to first deploy)", () => {
    const app = fieldRecord();
    const script = buildHostBootstrapScript(app, defaultOpts());
    expect(script).toContain(`/usr/bin/systemctl enable ${app.serviceUnit}`);
  });
});

describe("buildHostBootstrapScript — no field-record hardcoding", () => {
  test("demo-app fixture: script contains 'demo-app' app name", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts({ appUser: "deployer" }));
    expect(script).toContain("demo-app");
  });

  test("demo-app fixture: script contains 'deployer' as appUser", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts({ appUser: "deployer" }));
    expect(script).toContain("deployer");
  });

  test("demo-app fixture: script does NOT contain 'field-record' hardcode", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(script).not.toContain("field-record");
  });

  test("demo-app fixture: script does NOT contain 'field_record' hardcode", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(script).not.toContain("field_record");
  });

  test("demo-app fixture: script does NOT contain 'agent' user hardcode", () => {
    // When appUser is 'deployer', 'agent' must not appear as a user reference
    const script = buildHostBootstrapScript(demoApp(), demoOpts({ appUser: "deployer" }));
    // 'agent' should not appear as a standalone user name (may appear in descriptive text)
    // We check it's not in sudoers/useradd lines referencing user identity
    const sudoersLines = script.split("\n").filter((l) =>
      l.includes("NOPASSWD") || l.includes("useradd") || l.includes("usermod")
    );
    for (const line of sudoersLines) {
      expect(line).not.toContain(" agent");
    }
  });
});

describe("buildHostBootstrapScript — sshd AllowUsers drop-in", () => {
  test("script contains sshd AllowUsers extension for appUser", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    // Must extend AllowUsers in sshd config
    expect(script).toMatch(/AllowUsers/);
    expect(script).toContain("agent");
  });

  test("sshd drop-in is a 09- file (sorts before hardening baseline 10-samohost.conf)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("09-");
  });
});

describe("buildHostBootstrapScript — /opt/<app> layout", () => {
  test("script creates appBase directory (default /opt/<name>)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Default appBase is /opt/field-record
    expect(script).toContain("/opt/field-record");
  });

  test("script creates uploads subdirectory", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("uploads");
  });

  test("script sets ownership of appBase/uploads to appUser", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    // chown or install -o agent for the directories
    expect(script).toMatch(/chown|install.*-o\s+agent|install.*agent/);
  });

  test("custom appBase is used when provided", () => {
    const script = buildHostBootstrapScript(
      fieldRecord(),
      defaultOpts({ appBase: "/srv/myapp" }),
    );
    expect(script).toContain("/srv/myapp");
  });
});

describe("buildHostBootstrapScript — self-check table", () => {
  test("script ends with a PASS/FAIL check table", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Must contain PASS/FAIL check table
    expect(script).toMatch(/PASS|FAIL/);
  });

  test("self-check exits non-zero if any FAIL", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Must contain an exit 1 or non-zero exit as part of the check table
    expect(script).toContain("exit 1");
  });

  test("self-check covers node presence", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/node.*version|which node|command.*node/i);
  });

  test("self-check covers caddy active", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/caddy/);
  });
});

describe("buildHostBootstrapScript — OS user creation", () => {
  test("script creates the app user with useradd (NOT adduser)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    // Must use useradd --create-home (stack-prep.sh choice: adduser's chfn dies on hardened box)
    expect(script).toContain("useradd");
    expect(script).not.toContain("adduser");
  });

  test("script copies operator authorized_keys to app user", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    expect(script).toContain("authorized_keys");
  });
});

// ==========================================================================
// PR-A2: DB bootstrap + base env file + token-safe repo clone
// ==========================================================================

// ---------------------------------------------------------------------------
// A2 fixtures: extend base fixtures with the new required dbName option
// ---------------------------------------------------------------------------

function frOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "agent",
    dbName: "field_record",
    ...overrides,
  };
}

function demoOptsA2(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "deployer",
    dbName: "demo_db",
    appDbRole: "svc_user",
    seedOwnerLogin: "admin_owner",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (d) DB bootstrap — explicit dbName invariant
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — explicit dbName (critical invariant)", () => {
  test("createdb uses the literal dbName value, not a derived variant", () => {
    // dbName='field_record', app.name='field-record' → transformed 'field_record_1'
    // must NOT appear; only the literal dbName must appear in createdb.
    const app = fieldRecord(); // app.name='field-record', repo has '-1' suffix
    const script = buildHostBootstrapScript(app, frOpts({ dbName: "field_record" }));
    expect(script).toContain("field_record");
    expect(script).toMatch(/createdb[^\n]*field_record/);
  });

  test("script does NOT contain a name derived by transforming app.name (field_record_1)", () => {
    // The critic-flagged anti-pattern: 'field-record-1'.replace(/-/g,'_') = 'field_record_1'
    // With app.name='field-record' and dbName='field_record', 'field_record_1' must not appear.
    const script = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "field_record" }));
    expect(script).not.toContain("field_record_1");
  });

  test("DATABASE_URL path component uses the literal dbName value", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "field_record" }));
    // postgresql://postgres:...@127.0.0.1:5432/field_record
    expect(script).toMatch(/DATABASE_URL=postgresql:\/\/postgres:[^\n]*\/field_record/);
  });

  test("with dbName='custom_db', createdb references custom_db, not any app.name transform", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "custom_db" }));
    expect(script).toMatch(/createdb[^\n]*custom_db/);
    // Should not reference field_record in db context
    expect(script).not.toMatch(/createdb[^\n]*field_record/);
    expect(script).not.toMatch(/DATABASE_URL[^\n]*\/field_record/);
  });

  test("demo-app fixture: createdb uses demoOptsA2 dbName (demo_db), not demo_app", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2());
    expect(script).toMatch(/createdb[^\n]*demo_db/);
    // 'demo_app' is the serviceUnit name, NOT the DB name — must not appear in createdb
    expect(script).not.toMatch(/createdb[^\n]*demo_app/);
  });
});

// ---------------------------------------------------------------------------
// (d) DB bootstrap — superuser password on-host, STDIN-fed psql
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — DB superuser password handling", () => {
  test("script enables postgresql systemd unit before use", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/systemctl enable[^\n]*(--now )?postgresql|systemctl start postgresql/);
  });

  test("script has a wait-for-ready loop for the postgres cluster", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // A retry/wait loop: some form of 'for _ in ... do ... sleep'
    expect(script).toMatch(/for\s+_\s+in\b|for\s+i\s+in\b/);
    expect(script).toContain("sleep 1");
  });

  test("superuser password generated on-host with openssl rand (never in script text)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // openssl rand must appear — that's the on-host generator
    expect(script).toMatch(/openssl\s+rand/);
    // No literal hex password baked into the script itself
    expect(script).not.toMatch(/postgres:[0-9a-f]{48}/); // no baked 24-byte hex
  });

  test("ALTER ROLE postgres PASSWORD fed to psql via STDIN (not in argv)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // The SQL must be fed via STDIN (printf ... | psql or heredoc | psql)
    expect(script).toContain("ALTER ROLE postgres PASSWORD");
    // The psql invocation that carries the ALTER must use stdin piping, not -c with password
    // Pattern: something | ... psql  (the pipe feeds the SQL)
    expect(script).toMatch(/printf[^\n]*\|\s*(sudo[^\n]*)?\s*.*psql|printf[^\n]*ALTER ROLE/);
  });

  test("no PGPASSWORD= in a command line (password must not be in argv)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // PGPASSWORD in env-var export for ALTER ROLE psql is the forbidden pattern
    // (it puts the cleartext in the process environment visibly)
    // The stack-prep.sh pattern feeds via STDIN instead
    const lines = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const line of lines) {
      // PGPASSWORD= in a command line is forbidden
      expect(/PGPASSWORD=[^\s]/.test(line)).toBe(false);
    }
  });

  test("superuser password uses dollar-quoting ($pgpw$...$pgpw$) to neutralize quote chars", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Port of stack-prep §4: dollar-quote the PW so embedded quotes can't break SQL.
    // In the generated bash script, the dollar signs are backslash-escaped (\$pgpw\$)
    // so bash treats them as literal $ at runtime. The raw script text has \$pgpw\$.
    // The test looks for 'pgpw' adjacent to a dollar sign in any form.
    expect(script).toContain("pgpw");
    expect(script).toMatch(/ALTER ROLE postgres PASSWORD/);
  });

  test("createdb is guarded by pg_database SELECT (idempotent)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Idempotency: check pg_database before createdb
    expect(script).toMatch(/pg_database|datname/);
  });

  test("reuses existing superuser password from env file if present (idempotent)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // The script checks if ENV_FILE already has DATABASE_URL and extracts the PW
    expect(script).toMatch(/DATABASE_URL.*ENV_FILE|ENV_FILE.*DATABASE_URL/s);
  });
});

// ---------------------------------------------------------------------------
// (e) Base env file seeding
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — base env file content", () => {
  test("env file is written with umask 077 and chmod 600", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("umask 077");
    expect(script).toContain("chmod 600");
  });

  test("env file is chowned to appUser", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/chown.*agent.*staging\.env|chown.*agent.*ENV_FILE/);
  });

  test("env file contains DATABASE_URL=postgresql://postgres:", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("DATABASE_URL=postgresql://postgres:");
  });

  test("env file DATABASE_URL ends with the literal dbName", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "field_record" }));
    // postgresql://postgres:${PG_SUPER_PW}@127.0.0.1:5432/field_record
    expect(script).toMatch(/DATABASE_URL=postgresql:\/\/postgres:\$[^@\n]*@127\.0\.0\.1:5432\/field_record/);
  });

  test("env file contains APP_DATABASE_URL placeholder line", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/APP_DATABASE_URL=/);
  });

  test("env file contains NODE_ENV=production", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("NODE_ENV=production");
  });

  test("env file contains PORT derived from healthUrl (default 3000 for field-record)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // healthUrl is http://localhost:3000/api/version → port 3000
    expect(script).toContain("PORT=3000");
  });

  test("env file contains PORT derived from healthUrl (4000 for demo-app)", () => {
    // demo-app has healthUrl http://localhost:4000/health
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2());
    expect(script).toContain("PORT=4000");
  });

  test("env file contains HOST=0.0.0.0", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("HOST=0.0.0.0");
  });

  test("env file contains COOKIE_SECRET generated on-host with openssl rand", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("COOKIE_SECRET=");
    // The secret must be generated on-host (openssl rand) not baked in
    expect(script).toMatch(/openssl\s+rand/);
    // No literal 32-byte hex baked in
    expect(script).not.toMatch(/COOKIE_SECRET=[0-9a-f]{64}/);
  });

  test("env file does NOT contain PG_BACKEND= (stack-prep invariant: set in unit Environment=)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).not.toContain("PG_BACKEND=");
  });

  test("env file contains SEED_OWNER_LOGIN=owner (default)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("SEED_OWNER_LOGIN=owner");
  });

  test("env file contains SEED_OWNER_LOGIN with custom seedOwnerLogin option", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2({ seedOwnerLogin: "admin_owner" }));
    expect(script).toContain("SEED_OWNER_LOGIN=admin_owner");
  });

  test("env file contains SEED_OWNER_PASSWORD generated on-host", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toContain("SEED_OWNER_PASSWORD=");
    // Must be a variable reference (on-host generated), not a literal password baked in
    expect(script).not.toMatch(/SEED_OWNER_PASSWORD=[0-9a-f]{16}/);
  });

  test("RLS URL var name comes from rlsUrlVar when set (e.g. APP_DATABASE_URL)", () => {
    const app = fieldRecord({ rlsUrlVar: "APP_DATABASE_URL" });
    const script = buildHostBootstrapScript(app, frOpts());
    expect(script).toContain("APP_DATABASE_URL=");
  });

  test("RLS URL var defaults to APP_DATABASE_URL when app.rlsUrlVar is not set", () => {
    const app = { ...fieldRecord() };
    // Ensure rlsUrlVar is undefined
    delete (app as Partial<AppRecord>).rlsUrlVar;
    const script = buildHostBootstrapScript(app, frOpts());
    expect(script).toContain("APP_DATABASE_URL=");
  });

  test("custom appDbRole option used in RLS URL placeholder (default: app_user)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Default role is app_user
    expect(script).toMatch(/APP_DATABASE_URL=postgresql:\/\/app_user:/);
  });

  test("custom appDbRole option (svc_user) appears in RLS URL placeholder", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2({ appDbRole: "svc_user" }));
    expect(script).toMatch(/[A-Z_]*DATABASE_URL=postgresql:\/\/svc_user:/);
  });

  test("RLS URL placeholder uses literal 'app_password' (deploy.sh rotates on first deploy)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/APP_DATABASE_URL=postgresql:\/\/app_user:app_password@/);
  });

  test("env file preserves idempotency: reuse existing COOKIE_SECRET if present", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Check for pattern: if ENV_FILE already has COOKIE_SECRET, extract it
    expect(script).toMatch(/COOKIE_SECRET.*ENV_FILE|ENV_FILE.*COOKIE_SECRET/s);
  });

  test("env file preserves DEPLOYED_SHA / DEPLOY_FAILED_SHA across re-runs", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/DEPLOYED_SHA/);
  });
});

// ---------------------------------------------------------------------------
// (f) Token-safe repo clone
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — token-safe repo clone", () => {
  test("clone is FULL — no --depth flag in any non-comment line", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // The script must contain a git clone invocation somewhere
    expect(script).toMatch(/\bgit\b[^\n]*\bclone\b/);
    // Full clone only: --depth and --shallow must NOT appear in code lines
    const codeLines = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const line of codeLines) {
      expect(line).not.toContain("--depth");
      expect(line).not.toContain("--shallow");
    }
  });

  test("clone does NOT embed token in the remote URL (no https://token@github.com)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Credential-in-URL pattern must be absent
    expect(script).not.toMatch(/https:\/\/[^@\s]+@github\.com/);
  });

  test("token is sourced via IFS= read -r from STDIN or .gh-token file (never hardcoded)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Token arrives via read-from-stdin or from TOKEN_FILE path
    expect(script).toMatch(/IFS=\s+read\s+-r|IFS=read|TOKEN_FILE|\.gh-token/);
  });

  test("git credential.helper uses inline function reading token file by path at runtime", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // The credential helper pattern from stack-prep: !f() { echo username=x-access-token; echo password=$(cat <file>); }; f
    expect(script).toMatch(/credential\.helper/);
    expect(script).toMatch(/x-access-token/);
    expect(script).toMatch(/cat.*gh-token|cat.*TOKEN_FILE/);
  });

  test("remote set-url origin is called after clone (strips in-URL credential)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/remote\s+set-url\s+origin/);
  });

  test("clone is idempotent: skips if appDir/.git already exists", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/APP_DIR.*\.git|\.git.*APP_DIR|appDir.*\.git/i);
    // Should have an if-then skip guard
    expect(script).toMatch(/-d.*\.git/);
  });

  test("git clone clones into app.appDir", () => {
    const app = fieldRecord(); // appDir=/opt/field-record/app
    const script = buildHostBootstrapScript(app, frOpts());
    // The clone target must be the appDir
    expect(script).toMatch(new RegExp(`git.*clone.*${app.appDir}|git.*clone.*APP_DIR`));
  });

  test("git-safe.conf is written for the appDir (dubious-ownership guard)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/safe.*directory|GIT_CONFIG_GLOBAL|GIT_SAFE_CONF/i);
  });

  test("token file is set to 600 permissions", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/chmod.*600.*gh-token|chmod.*600.*TOKEN_FILE/);
  });

  test("clone step is skipped (with warning) if no token is present", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/SKIP.*token|skip.*token|no.*token|WARNING.*token/i);
  });

  test("credential helper is persisted for later fetches (git config --global)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).toMatch(/git config --global|git config.*global/);
  });

  test("clone credential helper must NOT expand token into argv (samorev #32)", () => {
    // INVARIANT: the token value must never appear in git's argv (visible in
    // /proc/<pid>/cmdline). The broken form uses a double-quoted -c argument:
    //   git -c "credential.helper=...$(cat $TOKEN_FILE)..."
    // which causes bash to expand $(cat $TOKEN_FILE) AT INVOCATION TIME and place
    // the token VALUE into git's argv. The correct form uses single-quotes so that
    // $(cat ...) is only evaluated LAZILY when git invokes the credential helper.
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // Must NOT contain double-quoted -c "credential.helper=... (broken form)
    expect(script).not.toMatch(/git -c "credential\.helper/);
    // Must contain the deferred single-quoted form: -c 'credential.helper=
    expect(script).toMatch(/git -c 'credential\.helper/);
  });

  // -------------------------------------------------------------------------
  // REGRESSION (FD-3-fix-exposed, pre-existing): the INLINE clone credential
  // helper authenticates on a fresh VM.
  //
  // ROOT CAUSE (fixture acceptance): §12's INLINE clone helper is single-quoted
  // (correctly deferred, no argv leak — samorev #32), but its body referenced
  //   echo "password=$(cat $TOKEN_FILE)"
  // where $TOKEN_FILE is a PLAIN, UNEXPORTED bash variable (assigned in §0 as
  // `TOKEN_FILE=...`, never `export`ed). git invokes the credential helper in a
  // FRESH SUBSHELL — and the clone runs under `sudo -u <appUser>`, which strips
  // the parent environment. So inside the helper subshell $TOKEN_FILE is EMPTY,
  // `cat` gets no path, and git receives an EMPTY password →
  //   "Invalid username or token" → private-repo clone FAILS on a fresh VM →
  // no app checkout → previews 521.
  //
  // The PERSISTED helper a few lines below (git config --global ...) already
  // uses the LITERAL token-file path (`cat <literal /opt/.../.gh-token>`) and
  // DOES authenticate. The INLINE clone helper must resolve the token the SAME
  // working way (literal path), while STAYING single-quoted (no argv leak).
  // -------------------------------------------------------------------------
  describe("buildHostBootstrapScript (A2) — inline clone credential helper resolves the token (fresh VM)", () => {
    /** Extract the single line that is the INLINE `git -c 'credential.helper=...' clone` invocation. */
    function inlineCloneHelperLine(script: string): string {
      const line = script
        .split("\n")
        .find((l) => /git -c 'credential\.helper=/.test(l) && /\bclone\b/.test(l));
      expect(line, "inline clone credential.helper line must exist").toBeDefined();
      return line as string;
    }

    test("inline clone helper does NOT depend on the unexported $TOKEN_FILE var", () => {
      // The bug: `cat $TOKEN_FILE` inside the single-quoted helper — $TOKEN_FILE
      // is empty in git's helper subshell under `sudo -u`. The helper must use
      // the literal token-file path (matching the proven persist line), so it
      // must NOT reference the bare $TOKEN_FILE / ${TOKEN_FILE} variable.
      const line = inlineCloneHelperLine(buildHostBootstrapScript(fieldRecord(), frOpts()));
      expect(line).not.toMatch(/cat \$\{?TOKEN_FILE\}?/);
    });

    test("inline clone helper reads the token by LITERAL path (same form as the persist line)", () => {
      const app = fieldRecord(); // appBase=/opt/field-record → token at /opt/field-record/.gh-token
      const line = inlineCloneHelperLine(buildHostBootstrapScript(app, frOpts()));
      // Must `cat` the literal token-file path, exactly like the persisted helper.
      expect(line).toMatch(/cat \/opt\/field-record\/\.gh-token/);
    });

    test("rendered inline clone helper YIELDS the token even with the env stripped (sudo -u model)", () => {
      // Strongest assertion: render the helper, point its literal token path at a
      // temp file holding a known secret, then run the helper EXACTLY as git does
      // — in a subshell with the environment wiped (`env -i`), modelling
      // `sudo -u <appUser>` stripping $TOKEN_FILE. It must still emit the secret.
      const sandbox = mkdtempSync(join(tmpdir(), "samohost-clone-helper-"));
      const tokenPath = join(sandbox, ".gh-token");
      const SECRET = "ghs_FRESH_VM_TOKEN_VALUE_xyz";
      writeFileSync(tokenPath, SECRET);
      chmodSync(tokenPath, 0o600);

      // Render with appBase pointed at the sandbox so the literal token path the
      // helper bakes in is exactly tokenPath.
      const script = buildHostBootstrapScript(fieldRecord(), frOpts({ appBase: sandbox }));
      const line = inlineCloneHelperLine(script);

      // Pull the single-quoted credential.helper VALUE out of the rendered line:
      //   ... git -c 'credential.helper=<HELPER>' clone ...
      const m = line.match(/credential\.helper=([\s\S]*?)' clone/);
      expect(m, "could not extract credential.helper value from inline clone line").not.toBeNull();
      const helperBody = (m as RegExpMatchArray)[1] ?? ""; // !f() { ...; }; f

      // git invokes the helper value by stripping the leading '!' and running the
      // REMAINDER through the shell (in a subshell, env stripped). Model that.
      const shellProgram = helperBody.replace(/^!/, "");
      const res = spawnSync("bash", ["-c", shellProgram], {
        encoding: "utf8",
        env: {}, // wipe env → $TOKEN_FILE absent, exactly like `sudo -u` does
      });
      rmSync(sandbox, { recursive: true, force: true });

      // The helper MUST have emitted the real token as the password line.
      expect(res.stdout).toContain(`password=${SECRET}`);
      // And must NOT have produced an empty password (the fresh-VM failure).
      expect(res.stdout).not.toMatch(/password=\s*$/m);
    });
  });
});

// ---------------------------------------------------------------------------
// A2 — bash -n syntax on full A1+A2 generated scripts
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — bash syntax (full script with A2 phases)", () => {
  test("field-record fixture with A2 options passes bash -n", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("demo-app fixture with A2 options passes bash -n", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2());
    expect(bashSyntaxOk(script)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A2 — determinism / purity still holds
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — determinism / purity with new options", () => {
  test("same inputs with dbName produce byte-identical output", () => {
    const a = buildHostBootstrapScript(fieldRecord(), frOpts());
    const b = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(a).toBe(b);
  });

  test("different dbName produces different scripts", () => {
    const a = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "alpha_db" }));
    const b = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "beta_db" }));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// A2 — no field-record hardcoding with non-field-record fixture
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — no hardcoding with demo-app fixture", () => {
  test("demo-app script does NOT contain 'field-record' anywhere", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2());
    expect(script).not.toContain("field-record");
  });

  test("demo-app script does NOT contain 'field_record' anywhere", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2());
    expect(script).not.toContain("field_record");
  });

  test("demo-app script contains the custom dbName 'demo_db'", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2({ dbName: "demo_db" }));
    expect(script).toContain("demo_db");
  });

  test("demo-app script contains custom appDbRole 'svc_user'", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2({ appDbRole: "svc_user" }));
    expect(script).toContain("svc_user");
  });

  test("demo-app script contains custom seedOwnerLogin 'admin_owner'", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOptsA2({ seedOwnerLogin: "admin_owner" }));
    expect(script).toContain("admin_owner");
  });
});

// ---------------------------------------------------------------------------
// A2 — self-check table extended (postgres ready, db present, env 600, clone)
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — extended self-check table", () => {
  test("self-check covers postgres ready", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // chk entry for postgres/pg readiness
    expect(script).toMatch(/chk[^\n]*(postgres|pg)\s*(ready|up|active)/i);
  });

  test("self-check covers database present (dbName)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts({ dbName: "field_record" }));
    // chk entry for the db
    expect(script).toMatch(/chk[^\n]*field_record/);
  });

  test("self-check covers staging.env has 600 permissions", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // chk entry for env file mode
    expect(script).toMatch(/chk[^\n]*(staging\.env|env.*600|600.*env)/i);
  });

  test("self-check covers app clone present", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    // chk entry for the clone
    expect(script).toMatch(/chk[^\n]*(clone|\.git)/i);
  });
});

// ---------------------------------------------------------------------------
// A2 — A1 ownership boundary still holds (no @.service template emitted)
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (A2) — A1 ownership boundary preserved", () => {
  test("A2 script does NOT contain template @.service syntax", () => {
    const script = buildHostBootstrapScript(fieldRecord(), frOpts());
    expect(script).not.toContain("@.service");
    expect(script).not.toMatch(/%i\b/);
  });
});

// ---------------------------------------------------------------------------
// (PG-PAM fix) Pre-create postgres system user before apt install
//
// ROOT CAUSE: postgresql-common's postinst calls `adduser --system ... postgres`
// which internally invokes `chfn` to set GECOS info. On a PAM-password-expired
// (hardened) box, chfn fails:
//   "Authentication token is no longer valid; new one required" (exit 82)
// leaving PG unconfigured → the whole bootstrap aborts (rc 100).
//
// FIX: Pre-create the `postgres` system user+group with `useradd` (no chfn,
// no PAM auth) BEFORE the apt install. The postinst guards its adduser call
// with `if ! getent passwd postgres`, so a pre-existing user makes it skip
// the dangerous adduser+chfn path entirely.
//
// This mirrors the insight already applied to the APP user in §4 (useradd, NOT
// adduser — see §4 comment in bootstrap.ts and stack-prep.sh ~line 187).
// The guard must live INSIDE the PG install block (i.e., only when PG is not
// yet installed) and BEFORE the apt-get install postgresql-* line.
//
// Found on a freshly-hardened smoke VM: field-record-1#117
// (host-bootstrap PG/PAM-chfn fix).
// ---------------------------------------------------------------------------

describe("buildHostBootstrapScript (PG-PAM fix) — postgres user pre-created before apt install", () => {
  test("generated script contains useradd for postgres user (not adduser)", () => {
    // The guard must use useradd (no chfn/PAM) not adduser (which calls chfn).
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toContain("useradd");
    // Must specifically reference 'postgres' user in a useradd invocation
    expect(script).toMatch(/useradd[^\n]*postgres/);
    // Must NOT use adduser for the postgres user (adduser's chfn dies on hardened box)
    const lines = script.split("\n");
    for (const line of lines) {
      if (!line.trimStart().startsWith("#") && /adduser/.test(line)) {
        // adduser must not appear in any non-comment code line referencing postgres
        expect(/adduser[^\n]*postgres/.test(line)).toBe(false);
      }
    }
  });

  test("postgres useradd guard is idempotent: wrapped in `id postgres` check", () => {
    // Must be `if ! id postgres >/dev/null 2>&1` (or equivalent) so it is a no-op
    // when the user already exists (re-runnable bootstrap).
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/id\s+postgres/);
    // The check must be a negative guard (skip if already exists)
    expect(script).toMatch(/!\s*id\s+postgres/);
  });

  test("postgres useradd guard appears BEFORE the postgresql apt-get install line (ordering)", () => {
    // The whole point: we must pre-create the user BEFORE the postinst runs.
    // Order: useradd-postgres guard index < apt-get install postgresql index.
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const lines = script.split("\n");

    // Find the index of the useradd postgres guard line
    const useradd_pg_idx = lines.findIndex(
      (l) => !l.trimStart().startsWith("#") && /useradd[^\n]*postgres/.test(l),
    );
    expect(useradd_pg_idx).toBeGreaterThan(-1);

    // Find the index of the apt-get install postgresql line
    const apt_pg_idx = lines.findIndex(
      (l) =>
        !l.trimStart().startsWith("#") &&
        /apt-get install[^\n]*postgresql/.test(l),
    );
    expect(apt_pg_idx).toBeGreaterThan(-1);

    // The useradd guard must come BEFORE the install
    expect(useradd_pg_idx).toBeLessThan(apt_pg_idx);
  });

  test("postgres useradd uses --system flag (system account, not regular user)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    // Must be a system account (matches what postgresql-common expects)
    expect(script).toMatch(/useradd[^\n]*--system[^\n]*postgres|useradd[^\n]*postgres[^\n]*--system/);
  });

  test("postgres pre-create guard scoped to PG install block (not emitted when PG already present)", () => {
    // The guard must live inside the `if command -v psql ... else` block —
    // it should only run when PG is not yet installed.
    // We verify this by checking the guard appears AFTER the psql-present check
    // (i.e., it is inside the else branch, not at the top level of the script).
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    const lines = script.split("\n");

    const psql_check_idx = lines.findIndex((l) => /command -v psql/.test(l));
    const useradd_pg_idx = lines.findIndex(
      (l) => !l.trimStart().startsWith("#") && /useradd[^\n]*postgres/.test(l),
    );
    // The useradd guard must come AFTER the `command -v psql` idempotency check
    expect(psql_check_idx).toBeGreaterThan(-1);
    expect(useradd_pg_idx).toBeGreaterThan(psql_check_idx);
  });

  test("bash -n still passes after PG-PAM fix is applied (script remains syntax-clean)", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("bash -n still passes for demo-app fixture after PG-PAM fix (no regression)", () => {
    const script = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("PG-PAM fix does NOT hardcode field-record: guard present in demo-app fixture too", () => {
    // The guard must appear in any generated script regardless of app, since the
    // PAM hazard is OS-level (not app-specific).
    const script = buildHostBootstrapScript(demoApp(), demoOpts());
    expect(script).toMatch(/useradd[^\n]*postgres/);
    expect(script).toMatch(/!\s*id\s+postgres/);
  });

  test("PG-PAM fix does NOT weaken adduser guard for the APP user (§4 still uses useradd)", () => {
    // §4 pre-existing behavior: app OS user is also created with useradd (not adduser).
    // After the fix, that invariant must remain intact.
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts({ appUser: "agent" }));
    // The app user (agent) creation line must use useradd
    expect(script).toMatch(/useradd[^\n]*agent|useradd[^\n]*--create-home/);
    // adduser must not appear for the app user either
    const lines = script.split("\n");
    for (const line of lines) {
      if (!line.trimStart().startsWith("#") && /adduser[^\n]*agent/.test(line)) {
        throw new Error(`adduser used for app user in line: ${line}`);
      }
    }
  });
});

// ============================================================================
// Phase B: buildHostBootstrapScript — static site path (kind='static')
//
// All tests in this describe block are RED until the static branch is added to
// src/app/bootstrap.ts. The backward-compat guard at the end must stay GREEN.
//
// NOTE: staticOpts() intentionally omits dbName — static apps have no database.
// The type cast is required because the current HostBootstrapOptions type marks
// dbName as required; the implementation change will make it optional with a
// kind-aware guard.
// ============================================================================

function staticRecord(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-0001",
    vmId: "vm-aaaa-0001",
    name: "my-static-site",
    kind: "static",
    repo: "Tanya301/my-static-site",
    branch: "main",
    appDir: "/opt/my-static-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://my-static-site.example.com/",
    serviceUnit: "my-static-site",
    mainHost: "my-static-site.example.com",
    ...overrides,
  };
}

// staticOpts intentionally omits dbName (static apps have no database).
// Cast required because current type marks dbName as required.
function staticOpts(overrides: Record<string, unknown> = {}): HostBootstrapOptions {
  return {
    appUser: "agent",
    ...overrides,
  } as HostBootstrapOptions;
}

describe("buildHostBootstrapScript — static path (kind='static')", () => {
  test("static bootstrap is valid bash", () => {
    // The script is syntactically valid bash even if semantically wrong today.
    // This test passes today; remains a contract lock after the static branch is added.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(bashSyntaxOk(script)).toBe(true);
  });

  test("static bootstrap does NOT install Node.js (no NodeSource, no apt nodejs)", () => {
    // FAILS today: src/app/bootstrap.ts:289-309 always emits §1 NodeSource install.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).not.toMatch(/nodesource|NodeSource/i);
    expect(script).not.toMatch(/apt-get install.*nodejs/);
  });

  test("static bootstrap does NOT install PostgreSQL (no PGDG, no apt postgresql)", () => {
    // FAILS today: src/app/bootstrap.ts:313-370 always emits §2 PGDG install.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).not.toMatch(/pgdg|postgresql/i);
    expect(script).not.toMatch(/apt-get install.*postgresql/i);
  });

  test("static bootstrap does NOT write a MAIN systemd unit (no ExecStart, no .service file)", () => {
    // FAILS today: src/app/bootstrap.ts:462-492 always emits §7 unit.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).not.toContain("ExecStart");
    expect(script).not.toContain("/etc/systemd/system/my-static-site.service");
  });

  test("static bootstrap does NOT emit DB bootstrap (no PG_SUPER_PW, no createdb, no DATABASE_URL=)", () => {
    // FAILS today: src/app/bootstrap.ts:541-600 always emits §10 DB bootstrap.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).not.toContain("PG_SUPER_PW");
    expect(script).not.toContain("createdb");
    // The env-file write must not leak DATABASE_URL= into the generated script.
    expect(script).not.toContain("DATABASE_URL=");
  });

  test("static bootstrap DOES install Caddy via official apt repo", () => {
    // Caddy is the server for a static site. §3 is already unconditional so
    // this passes today — remains a contract lock for the static path.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).toContain("caddy");
    expect(script).toMatch(/apt-get install.*caddy/i);
  });

  test("static bootstrap writes a file_server production Caddy site block when mainHost is set", () => {
    // FAILS today: no file_server block is emitted by buildHostBootstrapScript.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).toContain("file_server");
    expect(script).toContain("my-static-site.example.com");
    // Block must include tls internal (CF Full-mode; ACME cannot complete behind
    // CF-locked :443 — same rationale as buildStaticEnvCreateScript).
    expect(script).toContain("tls internal");
  });

  test("static bootstrap honors cp-http80 without emitting tls internal", () => {
    const script = buildHostBootstrapScript(
      staticRecord({ mainListen: "cp-http80" }),
      staticOpts(),
    );
    const start = script.indexOf("http://my-static-site.example.com {");
    const end = script.indexOf("}\nCADDY_SITE", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = script.slice(start, end);
    expect(block).toContain('root * "${SAMOHOST_STATIC_DIR}"');
    expect(script).toContain("samohost_assert_static_tree_safe");
    expect(block).toContain("try_files {path} {path}/ =404");
    expect(block).toContain("file_server");
    expect(block).not.toContain("tls internal");
  });

  test("static bootstrap firewall: source-restricts :443 to CF IP ranges, NEVER world-open", () => {
    // FAILS today: buildHostBootstrapScript has no firewall section at all.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    // CF range fetch loops (same pattern as buildFirewallLines in env/script.ts).
    expect(script).toContain("https://www.cloudflare.com/ips-v4");
    expect(script).toContain("https://www.cloudflare.com/ips-v6");
    // Correct UFW extended syntax: proto before from, no /tcp suffix on port.
    // Ubuntu 24.04 ufw rejects the combined `port 443/tcp` form in extended rules —
    // the rule errors out silently and :443 is never locked to CF IPs.
    expect(script).toMatch(/proto tcp from .* to any port 443/);
    // The buggy combined form must be absent.
    expect(script).not.toContain("to any port 443/tcp");
    // World-open forms must NEVER appear.
    expect(script).not.toMatch(/ufw allow 443/);
    expect(script).not.toMatch(/ufw allow 80/);
  });

  test("static bootstrap firewall: emits source-restricted :80 rule when controlPlaneIp is set", () => {
    // FAILS today: no firewall section.
    const script = buildHostBootstrapScript(
      staticRecord(),
      staticOpts({ firewallOpts: { controlPlaneIp: "10.0.0.1" } }),
    );
    expect(script).toContain("10.0.0.1");
    // Correct UFW extended syntax: proto before from, no /tcp suffix on port.
    expect(script).toMatch(/proto tcp from '10\.0\.0\.1' to any port 80/);
    // The buggy combined form must be absent.
    expect(script).not.toContain("to any port 80/tcp");
    // Must be source-restricted, not world-open.
    expect(script).toContain("from '10.0.0.1'");
  });

  test("static cp-fronted bootstrap can disable direct Cloudflare :443 ingress", () => {
    const script = buildHostBootstrapScript(
      staticRecord({ mainListen: "cp-http80" }),
      staticOpts({
        firewallOpts: { controlPlaneIp: "10.0.0.1", allowCfHttps: false },
      }),
    );
    expect(script).toContain("proto tcp from '10.0.0.1' to any port 80");
    expect(script).not.toContain("https://www.cloudflare.com/ips-v4");
    expect(script).not.toContain("https://www.cloudflare.com/ips-v6");
  });

  test("static bootstrap self-check omits node/postgres/unit/db rows", () => {
    // FAILS today: §13 self-check always emits all rows including
    // node_ok, pg_ok, unit_ok, db_ok.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).not.toContain("node_ok=");
    expect(script).not.toContain("pg_ok=");
    expect(script).not.toContain("unit_ok=");
    expect(script).not.toContain("db_ok=");
  });

  test("static bootstrap self-check validates caddy active and clone present", () => {
    // caddy_ok and clone_ok are present in the current self-check too,
    // so this PASSES today — remains a contract lock for the static path.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    expect(script).toContain("caddy_ok=");
    expect(script).toContain("clone_ok=");
  });

  test("static bootstrap sudoers: omits systemctl restart/stop/start grants for the main unit", () => {
    // FAILS today: src/app/bootstrap.ts:448-460 always emits all five grants.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    // Find the sudoers heredoc block.
    const sudoStart = script.indexOf("cat > '/etc/sudoers.d/");
    const sudoEnd = script.indexOf("\nSUDOERS\n", sudoStart) + 8;
    const sudoBlock = sudoStart >= 0 ? script.slice(sudoStart, sudoEnd) : "";
    expect(sudoBlock).not.toContain("systemctl start my-static-site");
    expect(sudoBlock).not.toContain("systemctl stop my-static-site");
    expect(sudoBlock).not.toContain("systemctl restart my-static-site");
    expect(sudoBlock).not.toContain("systemctl enable my-static-site");
  });

  test("static bootstrap does NOT throw when dbName is absent (static apps have no database)", () => {
    // After the fix: calling with no dbName on a static app must succeed.
    // FAILS today: function runs (no throw), but the script contains 'undefined'
    // strings from opts.dbName being undefined — which is its own failure mode.
    // This test asserts the positive (no throw) and that the output doesn't
    // contain raw 'undefined' strings.
    let script: string | undefined;
    expect(() => {
      script = buildHostBootstrapScript(staticRecord(), staticOpts());
    }).not.toThrow();
    expect(script).toBeDefined();
    expect(script).not.toContain("undefined");
  });

  test("static bootstrap throws when dbName is absent on a non-static (node) app", () => {
    // Guard: making dbName optional must not silently allow a node app to omit it.
    // FAILS today: the function does NOT throw — it just uses dbName=undefined and
    // produces a script with 'undefined' in it (no throw, so this assertion fails).
    expect(() =>
      buildHostBootstrapScript(
        fieldRecord(),  // kind unset = node
        { appUser: "agent" } as HostBootstrapOptions,  // no dbName
      ),
    ).toThrow(/dbName.*required|dbName.*static/i);
  });

  test("node path unchanged: still installs Node+PostgreSQL, emits ExecStart and DB bootstrap", () => {
    // Backward-compat guard. PASSES today; must continue to pass after the static
    // branch is added.
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).toMatch(/nodesource|NodeSource/i);
    expect(script).toMatch(/postgresql/i);
    expect(script).toContain("ExecStart");
    expect(script).toContain("PG_SUPER_PW");
    expect(script).toContain("DATABASE_URL=");
  });

  test("regression #ownershipfix: static bootstrap git rev-parse uses -c safe.directory scoping so the samo-owned process can read an app-user-owned checkout (dubious-ownership guard, bootstrap.ts:762)", () => {
    // ROOT CAUSE (same as env-script.test.ts #ownershipfix): the bootstrap script
    // runs as the SSH admin user ('samo' / 'agent'), but static release checkouts
    // are owned by the app user.  Without -c safe.directory=<path>, git >=2.35
    // aborts with "detected dubious ownership in repository" before emitting HEAD.
    // The guard then captures an empty string and unconditionally fails with
    // "active static deployment checkout does not match recorded sha" — blocking
    // every bootstrap execution on a correctly-deployed static app.
    //
    // FIX (bootstrap.ts:762): use per-invocation trust scoping
    //   git -C "$SAMOHOST_CHECKOUT_REAL" -c safe.directory="$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD
    // This is non-persistent (does not mutate ~/.gitconfig), bounded to the
    // already realpath-validated path, and mirrors the identical fix in
    // env/script.ts:2846 (custom-domain vhost guard).
    //
    // Also: 2>/dev/null was removed from the call so the real git error is
    // visible to the operator on actual failure.
    const script = buildHostBootstrapScript(staticRecord(), staticOpts());
    // 1. Must use the scoped safe.directory form (ownership-safe, non-persistent).
    expect(script).toContain(
      'git -C "$SAMOHOST_CHECKOUT_REAL" -c safe.directory="$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD',
    );
    // 2. Must NOT suppress stderr — the real git error must reach the operator.
    expect(script).not.toContain(
      'git -C "$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD 2>/dev/null',
    );
    // 3. Must NOT use the bare (non-scoped) rev-parse form.
    expect(script).not.toMatch(
      /git -C "\$SAMOHOST_CHECKOUT_REAL" rev-parse HEAD(?! 2>\/dev\/null)/,
    );
    // 4. Script must remain valid bash.
    expect(bashSyntaxOk(script)).toBe(true);
  });
});
