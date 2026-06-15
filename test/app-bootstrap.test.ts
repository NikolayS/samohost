/**
 * Tests for `buildHostBootstrapScript` — the pure OS-level bootstrap generator
 * (PR-A1: OS prep, user/layout, sudoers, MAIN systemd unit, sshd drop-in,
 * Caddy base config, self-check table).
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
    ...overrides,
  };
}

function demoOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return {
    appUser: "deployer",
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
  test("script does NOT contain --token, --gh-token, or password=", () => {
    const script = buildHostBootstrapScript(fieldRecord(), defaultOpts());
    expect(script).not.toMatch(/--token/);
    expect(script).not.toMatch(/--gh-token/);
    expect(script).not.toMatch(/password=/i);
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
    const scriptLower = script;
    expect(scriptLower).toContain("caddy validate");
    // validate must appear before reload
    const validateIdx = scriptLower.indexOf("caddy validate");
    const reloadIdx = scriptLower.indexOf("caddy reload") !== -1
      ? scriptLower.indexOf("caddy reload")
      : scriptLower.indexOf("systemctl reload caddy");
    expect(validateIdx).toBeLessThan(reloadIdx);
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
