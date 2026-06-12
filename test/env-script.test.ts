import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvCreateScript,
  buildEnvDestroyScript,
  buildHostPrepScript,
  envsRoot,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import type { AppRecord } from "../src/types.ts";

function app(o: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1",
    vmId: "vm-1111",
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

/** Every generated script must at least be valid bash (`bash -n`). */
function bashSyntaxOk(script: string): boolean {
  const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (res.status !== 0) {
    // Surface the parse error in the test failure output.
    console.error(res.stderr);
  }
  return res.status === 0;
}

describe("envsRoot", () => {
  test("envs live beside the production checkout", () => {
    expect(envsRoot(app())).toBe("/opt/field-record/envs");
    expect(envsRoot(app({ appDir: "/opt/field-record/app/" }))).toBe(
      "/opt/field-record/envs",
    );
  });
});

describe("buildEnvCreateScript", () => {
  test("is valid bash for every db backend", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
  });

  test("deterministic: same inputs, byte-identical output", () => {
    expect(buildEnvCreateScript(app(), target())).toBe(
      buildEnvCreateScript(app(), target()),
    );
  });

  test("dblab backend is GATED on the LIVE engine API, not the retired unit (issue #7)", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    expect(s).toContain("<<<SAMOHOST_PHASE:db-preflight:start>>>");
    // Runtime-verified 2026-06-12: the engine runs as the dblab_server docker
    // container; the legacy dblab.service unit's ExecStart binary does not
    // exist. The gate is the engine's own healthz endpoint.
    expect(s).toContain("curl -fsS --max-time 5 http://127.0.0.1:2345/healthz");
    expect(s).not.toContain("systemctl is-active --quiet dblab.service");
    // CLI resolution: PATH first, then ~/bin/dblab (where the runbook installs
    // it; not on PATH in non-login shells) — bound to one var used everywhere.
    expect(s).toContain("command -v dblab");
    expect(s).toContain('$HOME/bin/dblab');
    expect(s).toContain("SAMOHOST_DBLAB_BIN");
    expect(s).toContain("samohost env preflight"); // pointer to the diagnosis cmd
    expect(s).toContain("docs/dblab-install-runbook.md"); // pointer to the install
    // The gate precedes any clone attempt.
    expect(s.indexOf("db-preflight:start")).toBeLessThan(s.indexOf("clone create"));
    // Non-dblab backends have no engine gate.
    for (const db of ["template", "none"] as const) {
      expect(buildEnvCreateScript(app(), target({ dbBackend: db }))).not.toContain("db-preflight");
    }
  });

  test("dblab backend: clone create + on-host password, no samohost-side secrets", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    // Every dblab CLI call goes through the resolved binary, never bare `dblab`.
    expect(s).toContain('"$SAMOHOST_DBLAB_BIN" clone create --id');
    expect(s).toContain("openssl rand -hex 16"); // generated ON HOST
    expect(s).toContain("<<<SAMOHOST_PHASE:db:start>>>");
    // The script must never echo the env file or the password.
    expect(s).not.toMatch(/cat .*\.env/);
    expect(s).not.toMatch(/echo .*PASSWORD/i);
  });

  test("template backend: exact-path sudo createdb from the template db", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "template", dbName: "fr_feat_x" }));
    expect(s).toContain("sudo -u postgres /usr/bin/createdb --template=");
    expect(s).toContain("field_record_1_template");
  });

  test("none backend: no db phase, no DATABASE_URL append", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "none" }));
    expect(s).not.toContain("SAMOHOST_PHASE:db:");
    expect(s).not.toContain("DATABASE_URL");
  });

  test("env file composed on-host from the operator template", () => {
    const s = buildEnvCreateScript(app(), target());
    expect(s).toContain("/opt/field-record/envs.template.env");
    expect(s).toContain('chmod 600 "$SAMOHOST_ENV_DIR/.env"');
    expect(s).toContain("<<<SAMOHOST_PHASE:envfile:start>>>");
  });

  test("systemd instance + caddy vhost use full-path sudo only", () => {
    const s = buildEnvCreateScript(app(), target());
    expect(s).toContain("field-record@field-record-1-feat-x.service");
    expect(s).toContain('sudo /usr/bin/systemctl enable --now');
    expect(s).toContain("sudo /usr/bin/tee");
    expect(s).toContain("sudo /usr/bin/systemctl reload caddy");
    // Never a bare `sudo systemctl` (issue #99 exact-path grants).
    expect(s).not.toMatch(/sudo systemctl/);
  });

  test("vhost and port flow into caddy snippet and health probe", () => {
    const s = buildEnvCreateScript(app(), target({ port: 3142 }));
    expect(s).toContain("SAMOHOST_PORT='3142'");
    expect(s).toContain("field-record-1-feat-x.samo.cat");
    expect(s).toContain("http://localhost:${SAMOHOST_PORT}/");
  });

  test("phase markers cover the full create sequence", () => {
    const s = buildEnvCreateScript(app(), target());
    for (const p of ["clone", "install", "build", "db", "envfile", "unit", "vhost", "health"]) {
      expect(s).toContain(`<<<SAMOHOST_PHASE:${p}:start>>>`);
    }
  });
});

describe("buildEnvDestroyScript", () => {
  test("is valid bash and idempotent-by-construction (no set -e)", () => {
    const s = buildEnvDestroyScript(app(), target());
    expect(bashSyntaxOk(s)).toBe(true);
    expect(s).toContain("set -uo pipefail");
    expect(s).not.toContain("set -euo");
  });

  test("dblab destroy deletes the clone via the resolved CLI (issue #7)", () => {
    const s = buildEnvDestroyScript(app(), target({ dbBackend: "dblab" }));
    expect(s).toContain('"$SAMOHOST_DBLAB_BIN" clone destroy');
    // Same two-path CLI resolution as create (PATH, then ~/bin/dblab).
    expect(s).toContain("command -v dblab");
    expect(s).toContain("$HOME/bin/dblab");
    // Idempotent: a missing CLI must not abort the rest of the teardown.
    expect(s).toMatch(/clone destroy[^\n]*\|\| true/);
  });

  test("template destroy drops db and role via exact-path sudo", () => {
    const s = buildEnvDestroyScript(app(), target({ dbBackend: "template", dbName: "fr_feat_x" }));
    expect(s).toContain("sudo -u postgres /usr/bin/dropdb --if-exists");
    expect(s).toContain("DROP ROLE IF EXISTS");
  });

  test("stops the unit, removes the vhost, removes the dir", () => {
    const s = buildEnvDestroyScript(app(), target());
    expect(s).toContain('sudo /usr/bin/systemctl disable --now');
    expect(s).toContain("/etc/caddy/sites.d/");
    expect(s).toContain('rm -rf "$SAMOHOST_ENV_DIR"');
  });
});

describe("buildHostPrepScript", () => {
  test("is valid bash", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app(), "agent"))).toBe(true);
  });

  test("documents template unit, caddy include, sudoers grants, wildcard DNS", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("/etc/systemd/system/field-record@.service");
    expect(s).toContain("import sites.d/*.caddy");
    expect(s).toContain("/etc/sudoers.d/samohost-env-field-record-1");
    expect(s).toContain("visudo -cf");
    expect(s).toContain("wildcard A record");
    // Exact-path grants only.
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });
});

// ---------------------------------------------------------------------------
// Issue #11 — preview-env write-path fix cluster
// ---------------------------------------------------------------------------

/**
 * Extract a bash function definition (named `name`, closing brace at column 0)
 * from a generated script so tests can EXECUTE it against prod-shaped
 * fixtures. Shapes below mirror the executed sandbox proof
 * (/tmp/samohost-sandbox/evidence-env/SUMMARY.txt): field-record's
 * staging.env carries a superuser DATABASE_URL and an app_user
 * APP_DATABASE_URL, both pointing at the production db `field_record`.
 */
function extractFn(script: string, name: string): string {
  const re = new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`);
  const m = script.match(re);
  if (m === null) throw new Error(`bash function ${name}() not found in script`);
  return m[1]!;
}

// Prod-shaped values (same field names/forms as the sandbox staging.env).
const PROD_ADMIN_URL = "postgresql://postgres:s3kr3t-admin@localhost:5432/field_record";
const PROD_APP_URL = "postgresql://app_user:app-pw-9@localhost:5432/field_record?sslmode=disable";

interface RewireRun {
  code: number;
  stdout: string;
  stderr: string;
  env: string;
}

/** Execute the generated samohost_rewire_db_vars against a real temp .env. */
function runRewire(envContent: string, vars: string[], dbName: string): RewireRun {
  const dir = mkdtempSync(join(tmpdir(), "samohost-rewire-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, envContent, { mode: 0o600 });
    const script = buildEnvCreateScript(
      app({ envDbVars: vars }),
      target({ dbBackend: "template", dbName }),
    );
    const fn = extractFn(script, "samohost_rewire_db_vars");
    const prog = [
      "set -uo pipefail",
      `SAMOHOST_DB_NAME='${dbName}'`,
      `SAMOHOST_ENV_DB_VARS=(${vars.map((v) => `'${v}'`).join(" ")})`,
      fn,
      `samohost_rewire_db_vars '${envPath}'`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      env: readFileSync(envPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("issue #11 findings 1+2+3: per-env DB var mapping (template backend)", () => {
  const appWithVars = () =>
    app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] });
  const tpl = () =>
    target({ dbBackend: "template", dbName: "field_record_1_feat_x" });

  test("create script declares the mapped vars and rewires them on-host", () => {
    const s = buildEnvCreateScript(appWithVars(), tpl());
    expect(s).toContain("SAMOHOST_ENV_DB_VARS=('DATABASE_URL' 'APP_DATABASE_URL')");
    expect(s).toContain("samohost_rewire_db_vars() {");
    expect(s).toContain('samohost_rewire_db_vars "$SAMOHOST_ENV_DIR/.env"');
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("envDbVars defaults to DATABASE_URL when the app declares none", () => {
    const s = buildEnvCreateScript(app(), tpl());
    expect(s).toContain("SAMOHOST_ENV_DB_VARS=('DATABASE_URL')");
  });

  test("per-env role creation and password generation are DROPPED (template backend)", () => {
    const s = buildEnvCreateScript(appWithVars(), tpl());
    // Same roles as prod: template-copy grants + RLS policies apply unchanged.
    expect(s).not.toContain("CREATE ROLE");
    expect(s).not.toContain("GRANT ALL ON DATABASE");
    expect(s).not.toContain("openssl rand");
  });

  test("executed: rewrites ONLY the db-name path component of each mapped var", () => {
    const r = runRewire(
      [
        `DATABASE_URL=${PROD_ADMIN_URL}`,
        `APP_DATABASE_URL=${PROD_APP_URL}`,
        "NODE_ENV=production",
        "",
      ].join("\n"),
      ["DATABASE_URL", "APP_DATABASE_URL"],
      "field_record_1_feat_x",
    );
    expect(r.code).toBe(0);
    // Scheme/user/password/host/port/query preserved; ONLY dbname rewritten.
    expect(r.env).toContain(
      "DATABASE_URL=postgresql://postgres:s3kr3t-admin@localhost:5432/field_record_1_feat_x",
    );
    expect(r.env).toContain(
      "APP_DATABASE_URL=postgresql://app_user:app-pw-9@localhost:5432/field_record_1_feat_x?sslmode=disable",
    );
    // The PRODUCTION db name must be gone: systemd EnvironmentFile is
    // LAST-wins, but stripping the originals is required (dotenv loaders are
    // app-dependent — append-only composition is not safe).
    expect(r.env.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    expect(r.env.match(/^APP_DATABASE_URL=/gm)).toHaveLength(1);
    expect(r.env).not.toMatch(/\/field_record(\?|"|$)/m);
    // Unmapped vars pass through untouched.
    expect(r.env).toContain("NODE_ENV=production");
    // Secret values are NEVER echoed.
    expect(r.stdout + r.stderr).not.toContain("s3kr3t-admin");
    expect(r.stdout + r.stderr).not.toContain("app-pw-9");
  });

  test("executed: handles URLs with no port and no query params", () => {
    const r = runRewire(
      "DATABASE_URL=postgresql://u:pw@dbhost/prod_db\n",
      ["DATABASE_URL"],
      "envdb",
    );
    expect(r.code).toBe(0);
    expect(r.env).toContain("DATABASE_URL=postgresql://u:pw@dbhost/envdb");
  });

  test("executed: a MISSING mapped var fails the phase loudly (no silent prod inheritance)", () => {
    const r = runRewire(
      `DATABASE_URL=${PROD_ADMIN_URL}\n`,
      ["DATABASE_URL", "APP_DATABASE_URL"],
      "envdb",
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("APP_DATABASE_URL");
    expect(r.stderr).not.toContain("s3kr3t-admin");
  });

  test("executed: a non-URL value fails with a clear message naming the var", () => {
    const r = runRewire("DATABASE_URL=not-a-url\n", ["DATABASE_URL"], "envdb");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
  });
});

describe("issue #11 finding 4: template db phase is re-run idempotent", () => {
  test("db phase is dropdb --if-exists + createdb --template (recreate semantics)", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "template", dbName: "fr_x" }));
    expect(s).toContain('sudo -u postgres /usr/bin/dropdb --if-exists "$SAMOHOST_DB_NAME"');
    expect(s).toContain(
      'sudo -u postgres /usr/bin/createdb --template="$SAMOHOST_TEMPLATE_DB" "$SAMOHOST_DB_NAME"',
    );
    expect(s.indexOf('dropdb --if-exists "$SAMOHOST_DB_NAME"')).toBeLessThan(
      s.indexOf('createdb --template='),
    );
  });
});

describe("issue #11 finding 5: clone fallback when the appDir checkout is shallow", () => {
  test("script defines a two-strategy clone with explicit failure messages", () => {
    const s = buildEnvCreateScript(app(), target());
    expect(s).toContain("samohost_clone_env_dir() {");
    expect(s).toContain("falling back to a plain clone");
  });

  interface CloneFixture {
    dir: string;
    origin: string;
  }

  function gitFixture(): CloneFixture {
    const dir = mkdtempSync(join(tmpdir(), "samohost-clone-"));
    const origin = join(dir, "origin");
    const git = (args: string[], cwd: string) => {
      const r = spawnSync(
        "git",
        ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
        { cwd, encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    spawnSync("mkdir", ["-p", origin]);
    git(["init", "-b", "main"], origin);
    writeFileSync(join(origin, "f.txt"), "v1\n");
    git(["add", "f.txt"], origin);
    git(["commit", "-m", "c1"], origin);
    git(["branch", "sbx/docs-readme"], origin);
    return { dir, origin };
  }

  function runClone(appDir: string, envDir: string, branch: string) {
    const fn = extractFn(buildEnvCreateScript(app(), target()), "samohost_clone_env_dir");
    const prog = [
      "set -uo pipefail",
      `SAMOHOST_APP_DIR='${appDir}'`,
      `SAMOHOST_ENV_DIR='${envDir}'`,
      `SAMOHOST_BRANCH='${branch}'`,
      fn,
      "samohost_clone_env_dir",
    ].join("\n");
    return spawnSync("bash", ["-c", prog], { encoding: "utf8" });
  }

  test("executed: SHALLOW appDir → reference clone fails → plain clone succeeds, message names the failed strategy", () => {
    const fx = gitFixture();
    try {
      const appDir = join(fx.dir, "appdir");
      const sc = spawnSync(
        "git",
        ["clone", "--depth", "1", `file://${fx.origin}`, appDir],
        { encoding: "utf8" },
      );
      expect(sc.status).toBe(0);
      const envDir = join(fx.dir, "envs", "e1");
      const r = runClone(appDir, envDir, "sbx/docs-readme");
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("--reference");
      expect(r.stderr).toContain("falling back to a plain clone");
      const head = spawnSync("git", ["-C", envDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      });
      expect(head.stdout.trim()).toBe("sbx/docs-readme");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("executed: FULL appDir → reference clone path, no fallback message", () => {
    const fx = gitFixture();
    try {
      const appDir = join(fx.dir, "appdir");
      const sc = spawnSync("git", ["clone", `file://${fx.origin}`, appDir], {
        encoding: "utf8",
      });
      expect(sc.status).toBe(0);
      const envDir = join(fx.dir, "envs", "e1");
      const r = runClone(appDir, envDir, "sbx/docs-readme");
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("falling back");
      const head = spawnSync("git", ["-C", envDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      });
      expect(head.stdout.trim()).toBe("sbx/docs-readme");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

describe("issue #11 finding 6: --template-db override", () => {
  test("templateDb on the target overrides the convention name", () => {
    const s = buildEnvCreateScript(
      app(),
      target({ dbBackend: "template", dbName: "fr_x", templateDb: "custom_tpl" }),
    );
    expect(s).toContain("SAMOHOST_TEMPLATE_DB='custom_tpl'");
    expect(s).not.toContain("field_record_1_template");
  });

  test("host-prep prints the expected template DB name (operator must not guess)", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("field_record_1_template");
  });
});

describe("issue #11 finding 8: destroy resets the failed unit; host-prep grants cover it", () => {
  test("destroy reset-failed after disable, tolerant of absence", () => {
    const s = buildEnvDestroyScript(app(), target());
    expect(s).toContain(
      'sudo /usr/bin/systemctl reset-failed "$SAMOHOST_UNIT_INSTANCE" 2>/dev/null || true',
    );
    expect(s.indexOf("disable --now")).toBeLessThan(s.indexOf("reset-failed"));
  });

  test("host-prep sudoers include the reset-failed grant", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain(
      "NOPASSWD: /usr/bin/systemctl reset-failed field-record@*.service",
    );
  });

  test("host-prep documents the envDbVars template contract", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("envDbVars");
  });
});

// ---------------------------------------------------------------------------
// Issue #7 — dblab backend contract fixes (runtime-verified 2026-06-12 against
// DBLab v4.1.3 live on samo-we-field-record)
// ---------------------------------------------------------------------------

/**
 * REAL clone-status JSON captured from the live engine (dblab clone status,
 * v4.1.3, 2026-06-12) — the port is a STRING nested at `.db.port`, NOT a
 * top-level number. Stored verbatim (password field is empty in the real
 * output) so the parsing tests run against the prod shape, not a hand-rolled
 * mock.
 */
const CLONE_STATUS_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "dblab-clone-status.json",
);

/** Run the generated samohost_clone_port fn against a stub dblab CLI that
 * replays the captured prod JSON. `breakPython` forces the sed fallback. */
function runClonePort(opts: { breakPython?: boolean; json?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "samohost-cloneport-"));
  try {
    const jsonPath = join(dir, "status.json");
    writeFileSync(
      jsonPath,
      opts.json ?? readFileSync(CLONE_STATUS_FIXTURE, "utf8"),
    );
    const stub = join(dir, "dblab-stub");
    writeFileSync(stub, `#!/usr/bin/env bash\ncat '${jsonPath}'\n`, {
      mode: 0o755,
    });
    const fn = extractFn(
      buildEnvCreateScript(app(), target({ dbBackend: "dblab" })),
      "samohost_clone_port",
    );
    const prog = [
      "set -uo pipefail",
      // Optionally hide python3 from the function to exercise the sed path.
      ...(opts.breakPython
        ? [
            "command() {",
            '  if [[ "${2:-}" == python3 ]]; then return 1; fi',
            '  builtin command "$@"',
            "}",
          ]
        : []),
      `SAMOHOST_DBLAB_BIN='${stub}'`,
      "SAMOHOST_CLONE_ID='smoke-shape-1'",
      fn,
      "samohost_clone_port",
    ].join("\n");
    return spawnSync("bash", ["-c", prog], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("issue #7: clone port parsed from the NESTED .db.port string", () => {
  test("script no longer greps a top-level \"port\" (the old sed matched the wrong/no field)", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    expect(s).not.toContain('"port"[^0-9]');
    expect(s).toContain("samohost_clone_port() {");
    // Extraction result is validated as numeric inside the db phase.
    expect(s).toMatch(/SAMOHOST_DB_PORT.*=~ \^\[0-9\]\+\$/);
    // No hard jq dependency (jq presence on hosts is not guaranteed).
    expect(s).not.toMatch(/\bjq\b/);
  });

  test("executed (python3 path): real v4.1.3 status JSON → 6000", () => {
    const r = runClonePort();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("6000");
  });

  test("executed (sed fallback, python3 absent): real v4.1.3 status JSON → 6000", () => {
    const r = runClonePort({ breakPython: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("6000");
  });

  test("executed: compact (non-pretty) JSON parses identically", () => {
    const compact = JSON.stringify(
      JSON.parse(readFileSync(CLONE_STATUS_FIXTURE, "utf8")),
    );
    expect(runClonePort({ json: compact }).stdout.trim()).toBe("6000");
    expect(
      runClonePort({ json: compact, breakPython: true }).stdout.trim(),
    ).toBe("6000");
  });
});

/** Execute the generated samohost_rewire_db_hostport against a temp .env. */
function runRewireHostport(
  envContent: string,
  vars: string[],
  port: string,
): RewireRun {
  const dir = mkdtempSync(join(tmpdir(), "samohost-rewirehp-"));
  try {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, envContent, { mode: 0o600 });
    const script = buildEnvCreateScript(
      app({ envDbVars: vars }),
      target({ dbBackend: "dblab" }),
    );
    const fn = extractFn(script, "samohost_rewire_db_hostport");
    const prog = [
      "set -uo pipefail",
      `SAMOHOST_DB_PORT='${port}'`,
      `SAMOHOST_ENV_DB_VARS=(${vars.map((v) => `'${v}'`).join(" ")})`,
      fn,
      `samohost_rewire_db_hostport '${envPath}'`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      env: readFileSync(envPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("issue #7 (closing the PR #12 TODO): dblab envDbVars host:port mapping", () => {
  test("dblab create script declares the mapped vars and rewires them on-host", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    expect(s).toContain("SAMOHOST_ENV_DB_VARS=('DATABASE_URL' 'APP_DATABASE_URL')");
    expect(s).toContain("samohost_rewire_db_hostport() {");
    expect(s).toContain('samohost_rewire_db_hostport "$SAMOHOST_ENV_DIR/.env"');
    // The old append-only DATABASE_URL shape is GONE: the clone is a physical
    // copy carrying prod's roles, so the template's credentials stay and only
    // host:port is repointed at the clone.
    expect(s).not.toContain("SAMOHOST_DATABASE_URL");
    expect(s).not.toMatch(/printf 'DATABASE_URL=/);
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("dblab envDbVars defaults to DATABASE_URL when the app declares none", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    expect(s).toContain("SAMOHOST_ENV_DB_VARS=('DATABASE_URL')");
  });

  test("executed: rewrites ONLY host:port to 127.0.0.1:<clone-port>; creds/dbname/query kept", () => {
    const r = runRewireHostport(
      [
        `DATABASE_URL=${PROD_ADMIN_URL}`,
        `APP_DATABASE_URL=${PROD_APP_URL}`,
        "NODE_ENV=production",
        "",
      ].join("\n"),
      ["DATABASE_URL", "APP_DATABASE_URL"],
      "6000",
    );
    expect(r.code).toBe(0);
    // Same-roles philosophy as #12: the clone is a physical copy, prod roles
    // and passwords exist in it — user/password/dbname/query carry over.
    expect(r.env).toContain(
      "DATABASE_URL=postgresql://postgres:s3kr3t-admin@127.0.0.1:6000/field_record",
    );
    expect(r.env).toContain(
      "APP_DATABASE_URL=postgresql://app_user:app-pw-9@127.0.0.1:6000/field_record?sslmode=disable",
    );
    // Originals stripped, exactly one line per var, prod host:port gone.
    expect(r.env.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    expect(r.env.match(/^APP_DATABASE_URL=/gm)).toHaveLength(1);
    expect(r.env).not.toContain("@localhost:5432");
    // Unmapped vars pass through untouched.
    expect(r.env).toContain("NODE_ENV=production");
    // Secret values are NEVER echoed.
    expect(r.stdout + r.stderr).not.toContain("s3kr3t-admin");
    expect(r.stdout + r.stderr).not.toContain("app-pw-9");
  });

  test("executed: URL without explicit port still gains the clone port", () => {
    const r = runRewireHostport(
      "DATABASE_URL=postgresql://u:pw@dbhost/prod_db?sslmode=disable\n",
      ["DATABASE_URL"],
      "6042",
    );
    expect(r.code).toBe(0);
    expect(r.env).toContain(
      "DATABASE_URL=postgresql://u:pw@127.0.0.1:6042/prod_db?sslmode=disable",
    );
  });

  test("executed: a MISSING mapped var fails loudly (no silent prod inheritance)", () => {
    const r = runRewireHostport(
      `DATABASE_URL=${PROD_ADMIN_URL}\n`,
      ["DATABASE_URL", "APP_DATABASE_URL"],
      "6000",
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("APP_DATABASE_URL");
    expect(r.stderr).not.toContain("s3kr3t-admin");
  });

  test("executed: a non-URL value fails with a clear message naming the var", () => {
    const r = runRewireHostport("DATABASE_URL=not-a-url\n", ["DATABASE_URL"], "6000");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
  });
});

describe("issue #7: clone globals sync (logical retrieval drops cluster roles/grants/policies)", () => {
  // Live-verified 2026-06-12 on samo-we-field-record: the engine's retrieval
  // mode is LOGICAL (pg_dump/pg_restore of the database only) — the restored
  // clone had NO prod roles, NO grants, and ZERO of prod's 14 RLS policies
  // (they were silently dropped at restore time because the roles they
  // reference did not exist in the clone's cluster). Rewiring host:port at a
  // clone in that state hands the app a database where its own credentials
  // and RLS contract are broken. The db phase therefore replays the globals
  // from the prod catalogs ON-HOST and verifies parity before the env file
  // is composed.

  const dblabScript = () => buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));

  test("db phase replays roles (with password hashes), ownership, grants, and policies from prod catalogs", () => {
    const s = dblabScript();
    expect(s).toContain("samohost_sync_clone_globals() {");
    // Roles with their scram hashes come from pg_authid via the exact-path
    // sudo psql grant (host-prep) — superuser-only catalog, host-side only.
    expect(s).toContain("sudo -u postgres /usr/bin/psql");
    expect(s).toContain("pg_authid");
    expect(s).toContain("rolpassword");
    expect(s).toContain("BYPASSRLS");
    // Ownership + grants + policies are regenerated from prod's catalogs.
    expect(s).toContain("OWNER TO");
    expect(s).toContain("table_privileges");
    expect(s).toContain("pg_policies");
    expect(s).toContain("CREATE POLICY");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("sync runs INSIDE the db phase, after port extraction, before envfile", () => {
    const s = dblabScript();
    const dbStart = s.indexOf("<<<SAMOHOST_PHASE:db:start>>>");
    const sync = s.indexOf("samohost_sync_clone_globals\n");
    const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    expect(sync).toBeGreaterThan(dbStart);
    expect(sync).toBeLessThan(envfileStart);
    // The phase condition includes the sync (a failed sync fails the phase).
    expect(s).toMatch(/&& samohost_sync_clone_globals/);
  });

  test("verifies parity: clone policy count must reach prod's before the phase passes", () => {
    const s = dblabScript();
    expect(s).toContain("FROM pg_policies");
    // A parity comparison gates success (prod count vs clone count).
    expect(s).toMatch(/-ge "\$\{?prod_policies\}?"|-ge "\$prod_policies"/);
    expect(s).toContain("policy");
  });

  test("password hashes never reach stdout/stderr: apply output is suppressed", () => {
    const s = dblabScript();
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // Every psql APPLY into the clone silences both streams (error text can
    // quote failing statements, which may contain role password hashes).
    for (const line of fn.split("\n")) {
      if (line.includes("PGPASSWORD") && line.includes("psql")) {
        expect(line).toContain(">/dev/null 2>&1");
      }
    }
    // And nothing echoes generated DDL.
    expect(fn).not.toMatch(/echo .*rolpassword/i);
  });

  test("non-dblab backends carry NO globals sync", () => {
    for (const db of ["template", "none"] as const) {
      expect(buildEnvCreateScript(app(), target({ dbBackend: db }))).not.toContain(
        "samohost_sync_clone_globals",
      );
    }
  });
});
