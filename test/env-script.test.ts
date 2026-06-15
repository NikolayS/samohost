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

  test("documents template unit, caddy include, sudoers grants, per-preview DNS posture", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("/etc/systemd/system/field-record@.service");
    expect(s).toContain("import sites.d/*.caddy");
    expect(s).toContain("/etc/sudoers.d/samohost-env-field-record-1");
    expect(s).toContain("visudo -cf");
    // DNS comment must describe the correct posture: per-preview UNPROXIED A
    // record (not the old misleading wildcard claim).
    expect(s).toContain("UNPROXIED");
    expect(s).toContain("per-preview");
    // Old misleading claim must be gone.
    expect(s).not.toContain("no per-env DNS API calls are needed");
    // Exact-path grants only.
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });

  // -------------------------------------------------------------------------
  // Durable MAIN-env vhost (field-record-1#117 ITEM C — 7th drift class).
  //
  // The production vhost (field-record-1.samo.team → localhost:3000) existed
  // only as a hand-applied VM-local Caddy edit. Any churn that rewrites
  // /etc/caddy/Caddyfile de-references it together with every sites.d preview
  // snippet (observed as Cloudflare 521 on *.samo.cat). host-prep must emit
  // the main vhost as durable, provisioned state in /etc/caddy/sites.d/,
  // consistent with how env-create writes per-env snippets.
  // -------------------------------------------------------------------------
  const MAIN_HOST = "field-record-1.samo.team";

  test("writes the durable main-env vhost snippet into sites.d (#117 ITEM C)", () => {
    const s = buildHostPrepScript(app({ mainHost: MAIN_HOST }), "agent");
    expect(bashSyntaxOk(s)).toBe(true);
    // Stable filename that sorts FIRST in sites.d (00- prefix).
    expect(s).toContain("/etc/caddy/sites.d/00-main-field-record-1.caddy");
    // Host-matched block proxying to the production port (from healthUrl).
    expect(s).toContain("field-record-1.samo.team");
    expect(s).toContain("reverse_proxy localhost:3000");
    // The sites.d include is still applied, and the snippet write precedes
    // the caddy reload so one host-prep run leaves the main vhost live.
    expect(s).toContain("import sites.d/*.caddy");
    expect(s.indexOf("00-main-field-record-1.caddy")).toBeLessThan(
      s.indexOf("systemctl reload caddy"),
    );
  });

  test("main-env vhost write is idempotent (deterministic overwrite, no append-drift)", () => {
    const s = buildHostPrepScript(app({ mainHost: MAIN_HOST }), "agent");
    // Re-render is byte-identical → re-running host-prep rewrites the same
    // deterministic snippet in place.
    expect(s).toBe(buildHostPrepScript(app({ mainHost: MAIN_HOST }), "agent"));
    // The snippet write is a whole-file overwrite (>), never an append (>>).
    const line = s
      .split("\n")
      .find((l) => l.includes("00-main-field-record-1.caddy"));
    expect(line).toBeDefined();
    expect(line).toContain("> /etc/caddy/sites.d/00-main-field-record-1.caddy");
    expect(line).not.toContain(">>");
  });

  test("derives the main vhost port from healthUrl (explicit port and scheme default)", () => {
    expect(
      buildHostPrepScript(
        app({ mainHost: MAIN_HOST, healthUrl: "http://localhost:8080/health" }),
        "agent",
      ),
    ).toContain("reverse_proxy localhost:8080");
    expect(
      buildHostPrepScript(
        app({ mainHost: MAIN_HOST, healthUrl: "http://localhost/health" }),
        "agent",
      ),
    ).toContain("reverse_proxy localhost:80");
    expect(
      buildHostPrepScript(
        app({ mainHost: MAIN_HOST, healthUrl: "https://localhost/health" }),
        "agent",
      ),
    ).toContain("reverse_proxy localhost:443");
  });

  test("fails closed on an unparseable healthUrl when mainHost is set", () => {
    // Same fail-closed posture as the invalid-preview-domain fix (#117 → 525):
    // never render a vhost pointing at a guessed port.
    expect(() =>
      buildHostPrepScript(
        app({ mainHost: MAIN_HOST, healthUrl: "not a url" }),
        "agent",
      ),
    ).toThrow(/healthUrl/);
  });

  test("fails closed on an invalid mainHost (it is embedded in a root-run script)", () => {
    expect(() =>
      buildHostPrepScript(app({ mainHost: "bad host!" }), "agent"),
    ).toThrow(/main.?host/i);
  });

  test("no mainHost → no main vhost snippet (back-compat), include still applied", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).not.toContain("00-main-");
    expect(s).toContain("import sites.d/*.caddy");
  });

  // -------------------------------------------------------------------------
  // Issue #38 — open ufw 443 in host-prep; correct preview DNS comment
  // -------------------------------------------------------------------------

  test("opens ufw 443/tcp so the origin answers HTTPS (avoids 522)", () => {
    // host-prep is run with root; /usr/sbin/ufw is the canonical path on
    // Ubuntu 22.04/24.04 and ufw allow is naturally idempotent.
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("/usr/sbin/ufw allow 443/tcp");
  });

  test("ufw 443 is opened in host-prep only — NOT granted in the per-env NOPASSWD sudoers, and never called by the env scripts (privilege surface)", () => {
    const hp = buildHostPrepScript(app(), "agent");
    // 443 is opened once, here, by the root operator running host-prep.
    expect(hp).toContain("/usr/sbin/ufw allow 443/tcp");
    // It must NOT be added to the per-(vm,app) sudoers block: the env scripts
    // run later as the non-root sshUser and have no reason to touch ufw, so a
    // ufw NOPASSWD grant would needlessly widen that user's privileges.
    expect(hp).not.toMatch(/NOPASSWD:.*ufw/);
    // And the env create/destroy scripts never invoke ufw at all.
    expect(buildEnvCreateScript(app(), target())).not.toContain("ufw");
    expect(buildEnvDestroyScript(app(), target())).not.toContain("ufw");
  });

  test("DNS comment describes per-preview UNPROXIED A record + ufw 443 (not misleading wildcard claim)", () => {
    const s = buildHostPrepScript(app(), "agent");
    // New wording must reference the correct posture (unproxied, per-preview).
    expect(s).toContain("UNPROXIED");
    expect(s).toContain("per-preview");
    // Must mention that ufw 443 is required for HTTP-01 / HTTPS to work.
    expect(s).toMatch(/ufw.*443|443.*ufw/i);
    // Old misleading claim — "no per-env DNS API calls are needed" — must be gone.
    expect(s).not.toContain("no per-env DNS API calls are needed");
  });

  test("regression: vhost blocks emitted by buildEnvCreateScript carry NO tls directive", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      // Caddy vhost blocks must remain bare (ACME mode); tls internal would
      // force a self-signed cert → browser warning on direct-to-origin previews.
      expect(s).not.toMatch(/^\s*tls\s/m);
    }
  });

  test("regression: vhost blocks emitted by buildEnvCreateScript are valid bash", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
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
    // A parity comparison gates success (prod count vs clone count) — now via
    // the fail-closed helper (PR #22 review finding 1) instead of the old
    // inline `clone -ge $prod_policies` that degraded to `-ge 0` on an empty
    // prod capture.
    const fn = extractFn(s, "samohost_sync_clone_globals");
    expect(fn).toContain('samohost_parity_check "RLS policies"');
    const parity = extractFn(s, "samohost_parity_check");
    expect(parity).toMatch(/-lt "\$prod"/);
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

// ---------------------------------------------------------------------------
// PR #22 independent review findings — the role/policy replay is the #11-class
// safety mechanism, so its gates must fail CLOSED and its role copy must be
// scoped to the app's roles with cluster superpowers stripped.
// ---------------------------------------------------------------------------

/** Like extractFn but returns null when the function is not (yet) generated. */
function extractFnOptional(script: string, name: string): string | null {
  const re = new RegExp(`(${name}\\(\\) \\{[\\s\\S]*?\\n\\})`);
  const m = script.match(re);
  return m === null ? null : m[1]!;
}

/**
 * REAL pg_authid row shape, dry-run-verified against prod (samo-we-field-record,
 * 2026-06-12): `psql -At -c "SELECT rolname, rolcanlogin, rolpassword FROM
 * pg_authid ..."` emits `rolname|t|SCRAM-SHA-256$4096:<salt>$<stored>:<server>`
 * (NULL password -> empty third field). Names mirror prod's actual split:
 * app roles (field_record = envDbVars[0]/table owner, app_user = RLS subject)
 * vs ops roles (ci_user, ci_app_user, dblab_dump — BYPASSRLS/CI roles the app
 * never uses). Hashes are FAKE (shape-true base64), never prod values.
 */
const AUTHID_ROWS_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "dblab-pg-authid-rows.txt",
);
const FAKE_SCRAM_FIELD_RECORD =
  "SCRAM-SHA-256$4096:RnJTYWx0$RnJTdG9yZWRLZXk=:RnJTZXJ2ZXJLZXk=";
const FAKE_SCRAM_APP_USER =
  "SCRAM-SHA-256$4096:QXBwU2FsdA==$QXBwU3RvcmVkS2V5:QXBwU2VydmVyS2V5";
const FAKE_SCRAM_DBLAB_DUMP =
  "SCRAM-SHA-256$4096:RGJsYWJTYWx0$RGJsYWJTdG9yZWQ=:RGJsYWJTZXJ2ZXI=";

/** Prod-shaped operator template (same var/URL shapes as /opt/field-record/
 * envs.template.env; role components verified on-host 2026-06-12). */
const SYNC_TEMPLATE_DEFAULT = [
  "DATABASE_URL=postgresql://field_record:admin-pw-X@localhost:5432/field_record",
  "APP_DATABASE_URL=postgresql://app_user:app-pw-9@localhost:5432/field_record?sslmode=disable",
  "NODE_ENV=production",
  "",
].join("\n");

/**
 * What prod psql emits TODAY for the legacy DDL-building pg_authid query
 * (CASE rolsuper/rolcreatedb/rolcreaterole/rolbypassrls/rolcanlogin order,
 * shape verified live in the original PR #22 work). Lets the harness stay
 * prod-shape-faithful for whichever query generation the script embeds.
 */
const AUTHID_DDL_LEGACY = [
  `CREATE ROLE field_record SUPERUSER CREATEDB CREATEROLE BYPASSRLS LOGIN PASSWORD '${FAKE_SCRAM_FIELD_RECORD}';`,
  `CREATE ROLE app_user LOGIN PASSWORD '${FAKE_SCRAM_APP_USER}';`,
  "CREATE ROLE ci_user BYPASSRLS LOGIN PASSWORD 'SCRAM-SHA-256$4096:Q2lTYWx0$Q2lTdG9yZWRLZXk=:Q2lTZXJ2ZXJLZXk=';",
  "CREATE ROLE ci_app_user LOGIN PASSWORD 'SCRAM-SHA-256$4096:Q2lBcHBTYWx0$Q2lBcHBTdG9yZWQ=:Q2lBcHBTZXJ2ZXI=';",
  `CREATE ROLE dblab_dump BYPASSRLS LOGIN PASSWORD '${FAKE_SCRAM_DBLAB_DUMP}';`,
  "CREATE ROLE analytics_group;",
  "",
].join("\n");

/**
 * Stub `sudo` (prod-side psql): keyed on recognizable SQL fragments, each
 * branch replays what PROD psql returns for that query (fragments + output
 * shapes dry-run against the live prod db, read-only, 2026-06-12).
 *
 * The schema-grants branch (ON SCHEMA) is dispatched before the generic
 * table-grants branch (GRANT) so the two don't collide.
 */
const SUDO_STUB = [
  "sudo() {",
  '  local sql="${!#}"',
  '  if [[ "$sql" == *"count(*)"* ]]; then',
  '    if [[ "$sql" == *"pg_policies"* ]]; then cat "$FIX/prod_policies"',
  '    elif [[ "$sql" == *"table_privileges"* ]]; then cat "$FIX/prod_grants"',
  '    elif [[ "$sql" == *"pg_tables"* ]]; then cat "$FIX/prod_ownership"',
  "    fi",
  '    [[ -s "$FIX/prod_counts_fail" ]] && return 1',
  "    return 0",
  "  fi",
  '  if [[ "$sql" == *"pg_authid"* ]]; then',
  '    if [[ "$sql" == *"CREATE ROLE"* ]]; then cat "$FIX/prod_authid_ddl"',
  '    else cat "$FIX/prod_authid_rows"; fi',
  "    return 0",
  "  fi",
  '  if [[ "$sql" == *"CREATE POLICY"* ]]; then cat "$FIX/prod_policy_ddl"; return 0; fi',
  '  if [[ "$sql" == *"unnest(roles)"* ]]; then cat "$FIX/prod_scoped_roles"; return 0; fi',
  '  if [[ "$sql" == *"OWNER TO"* ]]; then cat "$FIX/prod_owner_ddl"; return 0; fi',
  // Schema grants branch: one call per scoped role (WHERE r.rolname = '<role>').
  // The fixture models what prod returns for that specific role — in the real test
  // each call returns grants for one role; the harness returns the full fixture
  // which is correct because the default fixture only has scoped-role grants.
  '  if [[ "$sql" == *"ON SCHEMA"* ]]; then cat "$FIX/prod_schema_grant_ddl"; return 0; fi',
  '  if [[ "$sql" == *"GRANT "* ]]; then cat "$FIX/prod_grant_ddl"; return 0; fi',
  "  return 0",
  "}",
].join("\n");

/**
 * Stub `psql` (clone-side): `-f -` applies append their stdin batch to
 * applied.sql (the harness's side channel) and fail when the batch contains
 * $CLONE_APPLY_FAIL_ON (simulating a real in-clone DDL failure); `-c` count
 * reads replay the clone fixtures.
 */
const PSQL_STUB = [
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
  '  if [[ "$sql" == *"pg_policies"* ]]; then cat "$FIX/clone_policies"',
  '  elif [[ "$sql" == *"table_privileges"* ]]; then cat "$FIX/clone_grants"',
  '  elif [[ "$sql" == *"pg_tables"* ]]; then cat "$FIX/clone_ownership"',
  "  fi",
  "  return 0",
  "}",
].join("\n");

interface SyncGlobalsOpts {
  template?: string;
  prodAuthidRows?: string;
  prodScopedRoles?: string;
  prodPolicies?: string;
  prodGrants?: string;
  prodOwnership?: string;
  prodCountsFail?: boolean;
  clonePolicies?: string;
  cloneGrants?: string;
  cloneOwnership?: string;
  cloneApplyFailOn?: string;
  /** DDL the prod-side sudo stub returns for schema-grant queries (ON SCHEMA). */
  prodSchemaGrantDdl?: string;
}

interface SyncGlobalsRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Every DDL batch the clone-side psql received (harness side channel). */
  applied: string;
}

/** Execute the generated globals-sync path against prod-shaped fixtures. */
function runSyncGlobals(opts: SyncGlobalsOpts = {}): SyncGlobalsRun {
  const dir = mkdtempSync(join(tmpdir(), "samohost-syncglobals-"));
  try {
    const fix = (name: string, content: string) =>
      writeFileSync(join(dir, name), content);
    fix("template.env", opts.template ?? SYNC_TEMPLATE_DEFAULT);
    fix(
      "prod_authid_rows",
      opts.prodAuthidRows ?? readFileSync(AUTHID_ROWS_FIXTURE, "utf8"),
    );
    fix("prod_authid_ddl", AUTHID_DDL_LEGACY);
    // Live union-query result (policies roles + grantees + owners) on prod:
    // app_user, field_record, public.
    fix("prod_scoped_roles", opts.prodScopedRoles ?? "app_user\nfield_record\npublic\n");
    fix("prod_policies", opts.prodPolicies ?? "14");
    fix("prod_grants", opts.prodGrants ?? "315");
    fix("prod_ownership", opts.prodOwnership ?? "29");
    fix("prod_counts_fail", opts.prodCountsFail ? "1" : "");
    fix("clone_policies", opts.clonePolicies ?? "14");
    fix("clone_grants", opts.cloneGrants ?? "315");
    fix("clone_ownership", opts.cloneOwnership ?? "29");
    fix("prod_owner_ddl", "ALTER TABLE public.app_users OWNER TO field_record;\n");
    fix("prod_grant_ddl", "GRANT SELECT ON public.app_users TO app_user;\n");
    // Prod-verified: field_record is the DB owner so it gets CREATE on public
    // via pg_database_owner=UC — replayed explicitly because the clone's DB
    // owner is postgres. Dry-run shape: GRANT CREATE ON SCHEMA public TO ...;
    fix(
      "prod_schema_grant_ddl",
      opts.prodSchemaGrantDdl ??
        "GRANT USAGE ON SCHEMA public TO field_record;\nGRANT CREATE ON SCHEMA public TO field_record;\nGRANT USAGE ON SCHEMA public TO app_user;\n",
    );
    fix(
      "prod_policy_ddl",
      "CREATE POLICY p ON public.app_users AS PERMISSIVE FOR SELECT TO app_user USING (true);\n",
    );
    fix("applied.sql", "");
    const script = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const fns = [
      "samohost_app_url_roles",
      "samohost_emit_scoped_role_sql",
      "samohost_parity_check",
      "samohost_sync_clone_globals",
    ]
      .map((n) => extractFnOptional(script, n))
      .filter((f): f is string => f !== null);
    const prog = [
      "set -uo pipefail",
      `FIX='${dir}'`,
      `CLONE_APPLY_FAIL_ON='${opts.cloneApplyFailOn ?? ""}'`,
      `SAMOHOST_ENV_TEMPLATE='${join(dir, "template.env")}'`,
      "SAMOHOST_ENV_DB_VARS=('DATABASE_URL' 'APP_DATABASE_URL')",
      "SAMOHOST_DB_PASSWORD='harness-stub-pw'",
      "SAMOHOST_DB_PORT='6000'",
      SUDO_STUB,
      PSQL_STUB,
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

describe("PR #22 review finding 1 (MAJOR): parity gate fails CLOSED", () => {
  test("executed: EMPTY prod policy count must FAIL the phase, not pass it", () => {
    // The exact fail-open bug: an empty prod count made `clone -ge ""` evaluate
    // as `-ge 0` and serve a clone with missing RLS (the #11 bypass class).
    const r = runSyncGlobals({ prodPolicies: "", clonePolicies: "0" });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("parity");
  });

  test("executed: a FAILING prod count capture (non-zero exit, empty output) must FAIL", () => {
    const r = runSyncGlobals({ prodPolicies: "", prodCountsFail: true });
    expect(r.code).not.toBe(0);
  });

  test("executed: a non-numeric prod policy count must FAIL the phase", () => {
    const r = runSyncGlobals({
      prodPolicies: "ERROR:  permission denied",
      clonePolicies: "0",
    });
    expect(r.code).not.toBe(0);
    // The unvalidated capture must never be echoed back verbatim either way;
    // the gate message reports the gate, not raw query output.
    expect(r.stdout).toBe("");
  });

  test("executed: an empty CLONE count stays a failure (closed side stays closed)", () => {
    const r = runSyncGlobals({ clonePolicies: "" });
    expect(r.code).not.toBe(0);
  });

  test("executed: prod>0 with clone=0 fails; healthy parity passes", () => {
    expect(runSyncGlobals({ clonePolicies: "0" }).code).not.toBe(0);
    expect(runSyncGlobals().code).toBe(0);
  });

  test("script text: a parity helper validates BOTH prod and clone counts numerically", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_parity_check");
    // Two independent numeric validations: prod side AND clone side.
    expect(fn.match(/=~ \^\[0-9\]\+\$/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The clone-side count read keeps stderr suppressed (error text from a
    // psql failure can quote SQL); only the captured count is used.
    expect(fn).toContain("2>/dev/null");
  });
});

describe("PR #22 review finding 2 (MAJOR): role replay scoped to app roles, superpowers stripped", () => {
  test("executed: ONLY app-referenced roles are replayed — ops/superuser roles ABSENT", () => {
    const r = runSyncGlobals();
    expect(r.code).toBe(0);
    // The app's roles (envDbVars URL roles + grant/policy grantees + owner).
    expect(r.applied).toContain('"app_user"');
    expect(r.applied).toContain('"field_record"');
    // Prod's unrelated ops roles must never reach the preview clone.
    expect(r.applied).not.toContain("ci_user");
    expect(r.applied).not.toContain("ci_app_user");
    expect(r.applied).not.toContain("dblab_dump");
    expect(r.applied).not.toContain("analytics_group");
  });

  test("executed: replayed roles are stripped of every cluster superpower", () => {
    const r = runSyncGlobals();
    expect(r.applied).toMatch(
      /ALTER ROLE "field_record" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD/,
    );
    expect(r.applied).toMatch(
      /ALTER ROLE "app_user" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD/,
    );
    // \b…\b does not match the NO- forms, so any bare grant of a superpower fails here.
    expect(r.applied).not.toMatch(/(?<!NO)\bSUPERUSER\b/);
    expect(r.applied).not.toMatch(/(?<!NO)\bBYPASSRLS\b/);
    expect(r.applied).not.toMatch(/(?<!NO)\bCREATEROLE\b/);
    expect(r.applied).not.toMatch(/(?<!NO)\bCREATEDB\b/);
    expect(r.applied).not.toMatch(/(?<!NO)\bREPLICATION\b/);
  });

  test("executed: password hashes carry over for the scoped roles (sign-in works), never on stdout/stderr", () => {
    const r = runSyncGlobals();
    expect(r.applied).toContain(FAKE_SCRAM_FIELD_RECORD);
    expect(r.applied).toContain(FAKE_SCRAM_APP_USER);
    expect(r.applied).not.toContain(FAKE_SCRAM_DBLAB_DUMP);
    expect(r.stdout + r.stderr).not.toContain("SCRAM-SHA-256");
  });

  test("executed helper: samohost_emit_scoped_role_sql emits only scoped roles from prod-shaped pg_authid rows", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_emit_scoped_role_sql");
    const dir = mkdtempSync(join(tmpdir(), "samohost-emitrole-"));
    try {
      const scoped = join(dir, "scoped");
      writeFileSync(scoped, "app_user\nanalytics_group\n");
      const prog = [fn, `samohost_emit_scoped_role_sql '${scoped}'`].join("\n");
      const r = spawnSync("bash", ["-c", prog], {
        input: readFileSync(AUTHID_ROWS_FIXTURE, "utf8"),
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('CREATE ROLE "app_user";');
      expect(r.stdout).toContain(
        `ALTER ROLE "app_user" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION LOGIN PASSWORD '${FAKE_SCRAM_APP_USER}';`,
      );
      // NOLOGIN group role without a hash: no PASSWORD clause, NOLOGIN kept.
      expect(r.stdout).toContain(
        'ALTER ROLE "analytics_group" NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOLOGIN;',
      );
      // Unscoped rows (incl. superuser ops roles) are dropped entirely.
      expect(r.stdout).not.toContain("field_record");
      expect(r.stdout).not.toContain("dblab_dump");
      expect(r.stderr).not.toContain("SCRAM-SHA-256");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed helper: a hash with quoting metacharacters is skipped, not interpolated, not echoed", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_emit_scoped_role_sql");
    const dir = mkdtempSync(join(tmpdir(), "samohost-emitrole-"));
    try {
      const scoped = join(dir, "scoped");
      writeFileSync(scoped, "weird_role\n");
      const prog = [fn, `samohost_emit_scoped_role_sql '${scoped}'`].join("\n");
      const r = spawnSync("bash", ["-c", prog], {
        input: "weird_role|t|SCRAM-SHA-256$4096:a'b$c:d\n",
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("PASSWORD");
      expect(r.stdout).not.toContain("a'b");
      expect(r.stderr).not.toContain("a'b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed helper: samohost_app_url_roles extracts the role component of each mapped var, leaking no values", () => {
    const s = buildEnvCreateScript(
      app({ envDbVars: ["DATABASE_URL", "APP_DATABASE_URL"] }),
      target({ dbBackend: "dblab" }),
    );
    const fn = extractFn(s, "samohost_app_url_roles");
    const dir = mkdtempSync(join(tmpdir(), "samohost-urlroles-"));
    try {
      const tpl = join(dir, "template.env");
      writeFileSync(tpl, SYNC_TEMPLATE_DEFAULT);
      const prog = [
        "set -uo pipefail",
        `SAMOHOST_ENV_TEMPLATE='${tpl}'`,
        "SAMOHOST_ENV_DB_VARS=('DATABASE_URL' 'APP_DATABASE_URL')",
        fn,
        "samohost_app_url_roles",
      ].join("\n");
      const r = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split("\n").sort();
      expect(lines).toEqual(["app_user", "field_record"]);
      expect(r.stdout + r.stderr).not.toContain("admin-pw-X");
      expect(r.stdout + r.stderr).not.toContain("app-pw-9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("script text: the unscoped pg_authid attribute passthrough is GONE", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The old query copied prod's rolsuper/rolbypassrls/rolcreaterole bits
    // verbatim into the clone for EVERY non-builtin role.
    expect(fn).not.toContain("WHEN rolsuper");
    expect(fn).not.toContain("WHEN rolbypassrls");
    expect(s).toContain("NOSUPERUSER");
    expect(s).toContain("NOBYPASSRLS");
  });
});

describe("PR #22 review finding 3 (MINOR): partial grant/ownership replay must be visible", () => {
  test("executed: a FAILING ownership apply fails the phase (counted via exit codes, output suppressed)", () => {
    const r = runSyncGlobals({ cloneApplyFailOn: "OWNER TO" });
    expect(r.code).not.toBe(0);
    // Failures are COUNTED, never echoed: psql error text can quote DDL.
    expect(r.stdout + r.stderr).not.toContain("SCRAM-SHA-256");
    expect(r.stdout + r.stderr).not.toContain("OWNER TO public.app_users");
  });

  test("executed: a FAILING grants apply fails the phase", () => {
    const r = runSyncGlobals({ cloneApplyFailOn: "GRANT SELECT" });
    expect(r.code).not.toBe(0);
  });

  test("executed: clone grant count below prod fails parity", () => {
    const r = runSyncGlobals({ cloneGrants: "0" });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("grant");
  });

  test("script text: ownership/grant applies run under ON_ERROR_STOP with streams suppressed", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    expect(fn).toContain("ON_ERROR_STOP");
    for (const line of fn.split("\n")) {
      if (line.includes("ON_ERROR_STOP") && !line.trim().startsWith("#")) {
        expect(line).toContain(">/dev/null 2>&1");
        expect(line).not.toContain("|| true");
      }
    }
  });
});

describe("PR #22 review finding 4 (MINOR): prod_db derivation is validated", () => {
  test("executed: a mapped var with NO database path component fails the phase, names the var, leaks nothing", () => {
    const r = runSyncGlobals({
      template: [
        "DATABASE_URL=postgresql://field_record:admin-pw-X@localhost:5432",
        "APP_DATABASE_URL=postgresql://app_user:app-pw-9@localhost:5432/field_record",
        "",
      ].join("\n"),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
    // A mis-parse can capture the WHOLE line (credentials included) — the
    // failure message must never echo the derived value.
    expect(r.stdout + r.stderr).not.toContain("admin-pw-X");
  });

  test("executed: a garbage (non-URL) first mapped var fails the phase", () => {
    const r = runSyncGlobals({
      template: "DATABASE_URL=not-a-url\nAPP_DATABASE_URL=also-not\n",
    });
    expect(r.code).not.toBe(0);
  });

  test("executed: a MISSING first mapped var fails the phase", () => {
    const r = runSyncGlobals({ template: "NODE_ENV=production\n" });
    expect(r.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema-grant replay (live-validation finding, 2026-06-12): the globals sync
// was missing schema-level GRANT USAGE/CREATE ON SCHEMA statements. When prod's
// database owner role (e.g. field_record) is NOT the clone's DB owner (postgres
// is), the role loses CREATE on the public schema — causing migration failures
// with "permission denied for schema public" at app startup.
// ---------------------------------------------------------------------------
describe("schema-grant replay (live-validation finding 2026-06-12)", () => {
  test("executed: schema grants from prod are applied to the clone", () => {
    const r = runSyncGlobals();
    expect(r.code).toBe(0);
    // field_record must receive GRANT CREATE ON SCHEMA public (prod-sourced).
    expect(r.applied).toContain("GRANT CREATE ON SCHEMA public TO field_record");
    expect(r.applied).toContain("GRANT USAGE ON SCHEMA public TO field_record");
    expect(r.applied).toContain("GRANT USAGE ON SCHEMA public TO app_user");
  });

  test("executed: schema-grant apply failure is counted and fails the phase", () => {
    const r = runSyncGlobals({ cloneApplyFailOn: "GRANT CREATE ON SCHEMA" });
    expect(r.code).not.toBe(0);
  });

  test("script text: schema-grant SQL uses per-role WHERE clause (scoping by construction)", () => {
    // The implementation uses WHERE r.rolname = '$_sr_role' in a while-read loop
    // over scoped_roles. Since scoped_roles only contains app-referenced roles,
    // the SQL never queries for ops/CI roles — scoping is by construction, not
    // post-filter. Verify the generated script has this WHERE clause.
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The while loop reads from scoped_roles and uses $_sr_role in the SQL.
    expect(fn).toContain("while IFS= read -r _sr_role");
    expect(fn).toContain("r.rolname = '$_sr_role'");
    expect(fn).toContain('done < "$scoped_roles"');
  });

  test("script text: schema-grant step is present in samohost_sync_clone_globals", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    const fn = extractFn(s, "samohost_sync_clone_globals");
    // The schema-grant replay step must query schema privileges and emit grants.
    expect(fn).toContain("ON SCHEMA");
    expect(fn).toContain("GRANT");
    expect(fn).toContain("has_schema_privilege");
    // Must be applied to the clone under ON_ERROR_STOP with streams suppressed
    // (idempotent, but failures — e.g. role doesn't exist yet — are real errors).
    // The apply line follows the schema-grant query pipe; check that the
    // ON_ERROR_STOP apply is present in the schema-grant vicinity.
    const lines = fn.split("\n");
    const schemaGrantQueryIdx = lines.findIndex((l) => l.includes("has_schema_privilege"));
    expect(schemaGrantQueryIdx).toBeGreaterThan(-1);
    // Within the next few lines, ON_ERROR_STOP and >/dev/null 2>&1 must appear.
    const nearby = lines.slice(schemaGrantQueryIdx, schemaGrantQueryIdx + 5).join("\n");
    expect(nearby).toContain("ON_ERROR_STOP");
    expect(nearby).toContain(">/dev/null 2>&1");
  });
});

// ---------------------------------------------------------------------------
// Issue #36 — static-site preview backend (Caddy file_server)
// ---------------------------------------------------------------------------

describe("static env-create path (kind='static')", () => {
  // buildEnvCreateScript with kind:'static' must emit a file_server vhost.
  // It must NOT emit npm ci, npm start, systemd unit, or DB/envfile phases.
  // It must NOT emit reverse_proxy localhost: (nothing listens there).

  test("static create script is valid bash", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("static create script contains file_server and try_files", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("file_server");
    expect(s).toContain("try_files {path} /index.html");
  });

  test("static create script does NOT contain npm ci, npm start, or reverse_proxy localhost:", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).not.toContain("npm ci");
    expect(s).not.toContain("npm start");
    expect(s).not.toContain("reverse_proxy localhost:");
  });

  test("static create script contains the clone phase (reuses CLONE_FN_LINES)", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("<<<SAMOHOST_PHASE:clone:start>>>");
    expect(s).toContain("samohost_clone_env_dir() {");
  });

  test("static create script does NOT emit install/build/db/envfile/unit phases", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    for (const phase of ["install", "build", "db", "envfile", "unit"]) {
      expect(s).not.toContain(`<<<SAMOHOST_PHASE:${phase}:start>>>`);
    }
  });

  test("static create script health probe uses Host-header curl against local Caddy (not localhost:PORT)", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    // Must use the HTTPS + Host header approach.
    expect(s).toContain('-H "Host: $SAMOHOST_VHOST"');
    expect(s).toContain("https://127.0.0.1/");
    // Must NOT poll the app port (nothing listens there for static sites).
    expect(s).not.toContain("http://localhost:${SAMOHOST_PORT}/");
  });

  test("static create script health probe checks for 200 in the retry loop", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    // Same retry loop shape as the node path.
    expect(s).toContain(`<<<SAMOHOST_PHASE:health:start>>>`);
    expect(s).toContain('"200"');
  });

  test("static create script emits the vhost phase with tee + caddy reload", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("<<<SAMOHOST_PHASE:vhost:start>>>");
    expect(s).toContain("sudo /usr/bin/tee");
    expect(s).toContain("sudo /usr/bin/systemctl reload caddy");
  });

  test("static vhost block has no tls directive (bare = ACME mode)", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).not.toMatch(/^\s*tls\s/m);
  });

  test("static create script contains encode gzip", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("encode gzip");
  });

  test("node path still works when kind is absent", () => {
    const s = buildEnvCreateScript(app(), target());
    expect(s).toContain("npm ci");
    expect(s).toContain("reverse_proxy localhost:");
    expect(s).not.toContain("file_server");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("node path still works when kind is explicitly 'node'", () => {
    const s = buildEnvCreateScript(app({ kind: "node" }), target());
    expect(s).toContain("npm ci");
    expect(s).toContain("reverse_proxy localhost:");
    expect(s).not.toContain("file_server");
    expect(bashSyntaxOk(s)).toBe(true);
  });
});

describe("static env-destroy path (kind='static')", () => {
  test("static destroy is valid bash", () => {
    const s = buildEnvDestroyScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("static destroy does NOT emit unit-stop start marker", () => {
    const s = buildEnvDestroyScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).not.toContain("<<<SAMOHOST_PHASE:unit-stop:start>>>");
  });

  test("static destroy does NOT emit db-drop", () => {
    const s = buildEnvDestroyScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).not.toContain("<<<SAMOHOST_PHASE:db-drop");
    expect(s).not.toContain("db-drop");
  });

  test("static destroy DOES emit vhost-remove", () => {
    const s = buildEnvDestroyScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("<<<SAMOHOST_PHASE:vhost-remove:start>>>");
    expect(s).toContain('sudo /usr/bin/rm -f "$SAMOHOST_CADDY_SNIPPET"');
    expect(s).toContain("sudo /usr/bin/systemctl reload caddy");
  });

  test("static destroy DOES emit dir-remove", () => {
    const s = buildEnvDestroyScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    expect(s).toContain("<<<SAMOHOST_PHASE:dir-remove:start>>>");
    expect(s).toContain('rm -rf "$SAMOHOST_ENV_DIR"');
  });
});

describe("static host-prep path (kind='static')", () => {
  test("static host-prep is valid bash", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app({ kind: "static" }), "agent"))).toBe(true);
  });

  test("static host-prep contains caddy reload grant", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl reload caddy");
  });

  test("static host-prep contains tee and rm grants for caddy snippets", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).toContain("NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy");
    expect(s).toContain("NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy");
  });

  test("static host-prep does NOT contain systemctl enable/disable/reset-failed unit@ grants", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    // Systemd template instance grants are NOT needed for static sites.
    expect(s).not.toContain(`systemctl enable --now ${app({ kind: "static" }).serviceUnit}@`);
    expect(s).not.toContain(`systemctl disable --now ${app({ kind: "static" }).serviceUnit}@`);
    expect(s).not.toContain(`systemctl reset-failed ${app({ kind: "static" }).serviceUnit}@`);
  });

  test("static host-prep does NOT contain createdb/dropdb/psql postgres grant", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).not.toContain("(postgres) NOPASSWD: /usr/bin/createdb");
    expect(s).not.toContain("/usr/bin/dropdb");
    // postgres-user psql grant not needed for static
    expect(s).not.toContain("(postgres) NOPASSWD:");
  });

  test("static host-prep does NOT contain the systemd @.service template unit", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    // No systemd template unit for static sites.
    expect(s).not.toContain(`/etc/systemd/system/${app({ kind: "static" }).serviceUnit}@.service`);
  });

  test("static host-prep includes the caddy sites.d include", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).toContain("import sites.d/*.caddy");
    expect(s).toContain("mkdir -p /etc/caddy/sites.d");
  });

  test("static host-prep includes the ufw 443/tcp line", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).toContain("/usr/sbin/ufw allow 443/tcp");
  });

  test("static host-prep includes the DNS comment with UNPROXIED", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "agent");
    expect(s).toContain("UNPROXIED");
  });

  test("node host-prep is unchanged (still has systemd unit and postgres grants)", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("/etc/systemd/system/field-record@.service");
    expect(s).toContain("(postgres) NOPASSWD: /usr/bin/createdb");
    expect(bashSyntaxOk(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #43 — host-prep must create + own the envs root dir
//
// buildEnvCreateScript's clone phase does `mkdir -p "$SAMOHOST_ENVS_ROOT"` as
// the NON-ROOT env user. When /opt/<app> is root-owned (any client not
// onboarded via `samohost app bootstrap`), mkdir fails with Permission denied.
// buildHostPrepScript is the root-run one-time prep: it must guarantee the
// envs root exists AND is owned by the env user before env create ever runs.
// ---------------------------------------------------------------------------

describe("issue #43: host-prep creates + owns the envs root dir", () => {
  // For the test app: appDir = '/opt/field-record/app' → envsRoot = '/opt/field-record/envs'
  // sq('/opt/field-record/envs') = "'/opt/field-record/envs'"

  test("node app host-prep emits idempotent install -d for the envs root (node path)", () => {
    const s = buildHostPrepScript(app(), "agent");
    // install -d -m 755 -o <sshUser> -g <sshUser> <sq(envsRoot)>
    expect(s).toContain(
      "install -d -m 755 -o agent -g agent '/opt/field-record/envs'",
    );
  });

  test("static app host-prep emits idempotent install -d for the envs root (static path)", () => {
    const s = buildHostPrepScript(app({ kind: "static" }), "samo");
    expect(s).toContain(
      "install -d -m 755 -o samo -g samo '/opt/field-record/envs'",
    );
  });

  test("node host-prep bash syntax still valid after the addition", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app(), "agent"))).toBe(true);
  });

  test("static host-prep bash syntax still valid after the addition", () => {
    expect(bashSyntaxOk(buildHostPrepScript(app({ kind: "static" }), "samo"))).toBe(true);
  });
});
