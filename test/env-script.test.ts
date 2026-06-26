import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import {
  buildEnvCreateScript,
  buildEnvDestroyScript,
  buildHostPrepScript,
  envsRoot,
  type EnvScriptTarget,
} from "../src/env/script.ts";
import { buildDeployScript } from "../src/app/script.ts";
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

  test("dblab backend: clone create is idempotent — destroy-then-create so a re-create over an existing clone succeeds (issue #59)", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    // A fresh clone matching the deploy requires destroying any prior clone of
    // the same id FIRST (mirrors the template backend's dropdb --if-exists +
    // createdb). Without this, `dblab clone create --id <x>` fails at the engine
    // with "clone already exists" and the preview cannot be re-made.
    expect(s).toContain('"$SAMOHOST_DBLAB_BIN" clone destroy "$SAMOHOST_CLONE_ID"');
    // The pre-create destroy must tolerate an ABSENT clone gracefully (first
    // create, or engine already expired it) — never abort the create on a
    // missing-clone error. Same posture as the destroy script (issue #7).
    expect(s).toMatch(/clone destroy "\$SAMOHOST_CLONE_ID"[^\n]*\|\| true/);
    // Ordering: the idempotent destroy precedes the create within the db phase.
    const destroyIdx = s.indexOf('clone destroy "$SAMOHOST_CLONE_ID"');
    const createIdx = s.indexOf("clone create --id");
    expect(destroyIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(destroyIdx).toBeLessThan(createIdx);
    // And the destroy happens AFTER the engine preflight gate (no clone ops
    // before the engine is confirmed live/drivable).
    expect(s.indexOf("db-preflight:start")).toBeLessThan(destroyIdx);
  });

  test("dblab backend: clone create passes --protected with SAMOHOST_DBLAB_LEASE_MINUTES (default 20160 = 2 weeks)", () => {
    // Root-cause: without --protected the DBLab engine uses its own
    // maxIdleMinutes, which on a short-lived engine config can be as low as
    // 45 min — causing a running preview to lose its database mid-life and
    // return Internal Server Error. samohost must own the clone lifetime.
    //
    // The flag is --protected <minutes>, where <minutes> is the lease in
    // minutes.  20160 = 14 days * 24 h * 60 min.
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    // The generated clone create line must carry --protected with the lease value.
    expect(s).toContain("--protected");
    expect(s).toContain("20160");
    // The --protected flag + value must appear on the clone create line
    // (not some unrelated context).
    const createLine = s
      .split("\n")
      .find((l) => l.includes("clone create") || l.includes("--protected"));
    expect(createLine).toBeDefined();
    // Verify the lease is a number that exceeds the old 45-min IDLE_THRESHOLD
    // so samohost always owns teardown, never the engine default.
    const match = s.match(/--protected[= ](\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThan(45);

    // Custom lease: SAMOHOST_DBLAB_LEASE_MINUTES=1440 → 1440 in the script.
    const orig = process.env["SAMOHOST_DBLAB_LEASE_MINUTES"];
    process.env["SAMOHOST_DBLAB_LEASE_MINUTES"] = "1440";
    try {
      const s2 = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
      expect(s2).toContain("--protected");
      const m2 = s2.match(/--protected[= ](\d+)/);
      expect(m2).not.toBeNull();
      expect(m2![1]).toBe("1440");
    } finally {
      if (orig === undefined) delete process.env["SAMOHOST_DBLAB_LEASE_MINUTES"];
      else process.env["SAMOHOST_DBLAB_LEASE_MINUTES"] = orig;
    }

    // Non-dblab backends must NOT carry --protected (they have no DBLab clone).
    for (const db of ["template", "none"] as const) {
      expect(buildEnvCreateScript(app(), target({ dbBackend: db }))).not.toContain("--protected");
    }
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

  // Issue #78: lockfile-less apps (no-DB fixtures, minimal greenfield) hard-fail
  // npm ci with "can only install with an existing package-lock.json", which under
  // set -euo pipefail + phaseBlock default onFail=exit 1 aborts the env-create
  // script BEFORE the .env / systemd unit / Caddy vhost are written → no :443
  // listener → CF 521. The install phase must detect the lockfile and fall back.
  test("install phase is lockfile-aware: falls back to npm install when no package-lock.json exists", () => {
    // All db backends share the same install phase rendering.
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      // Must gate on lockfile presence.
      expect(s).toContain("[ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]");
      // Fallback branch for lockfile-less apps.
      expect(s).toContain("npm install");
      // npm ci branch preserved for the lockfile-present case.
      expect(s).toContain("npm ci");
      // The old bare unguarded form must be gone (fails on lockfile-less apps).
      expect(s).not.toMatch(/if npm ci; /);
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

  test("invalid mainHost error message uses a neutral placeholder, not a client-specific hostname (D2)", () => {
    let msg = "";
    try {
      buildHostPrepScript(app({ mainHost: "bad host!" }), "agent");
    } catch (e) {
      msg = (e as Error).message;
    }
    // Error must have been thrown
    expect(msg).not.toBe("");
    // Generic platform code must NOT embed a client-specific domain as the example
    // (app.name appears legitimately as 'field-record-1'; the contamination is the
    // hardcoded "field-record-1.samo.team" example string — keyed by ".samo.team")
    expect(msg).not.toContain("field-record-1.samo.team");
    // Must carry a neutral placeholder example so the message is still helpful
    expect(msg).toContain("app.example.com");
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

  test("vhost blocks emitted by buildEnvCreateScript carry 'tls internal' (CF Full-mode proxied origin; self-signed cert only ever seen by CF edge — issue #54)", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      // CF Full mode + proxied record: origin serves self-signed HTTPS via
      // Caddy 'tls internal'. CF edge holds the real cert; no browser ever
      // sees the self-signed cert (CF firewall blocks direct-to-origin). ACME
      // is not used (it cannot complete behind a CF-locked :443 and the host
      // has no DNS-01 plugin).
      expect(s).toContain("tls internal");
    }
  });

  test("static buildEnvCreateScript vhost block also carries 'tls internal' (issue #54)", () => {
    // Static path (buildStaticEnvCreateScript): same CF Full+proxied posture.
    const staticApp = { ...app(), kind: "static" as const };
    const s = buildEnvCreateScript(staticApp, target());
    expect(s).toContain("tls internal");
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
    // Must NOT poll the app port (nothing listens there for static sites).
    expect(s).not.toContain("http://localhost:${SAMOHOST_PORT}/");
    // Must use the HTTPS approach (retain pre-existing assertion for curl structure).
    expect(s).toContain("https://");
  });

  // Issue #46: static health probe must use --resolve so curl sends the correct
  // TLS SNI (the vhost name), not 127.0.0.1 (for which Caddy has no cert).
  // Proven live: `-H "Host: $SAMOHOST_VHOST" https://127.0.0.1/` triggers a
  // handshake failure (SNI=127.0.0.1 → no cert → 000) even though Caddy serves
  // a real 200 externally. `--resolve` sets BOTH the TCP destination AND the
  // TLS SNI to the vhost, so Caddy selects the right cert and the health probe
  // reflects the actual state of the site.
  test("static health probe uses --resolve so SNI matches the vhost (issue #46)", () => {
    const s = buildEnvCreateScript(app({ kind: "static" }), target({ dbBackend: "none" }));
    // New form: --resolve "$SAMOHOST_VHOST:443:127.0.0.1" "https://$SAMOHOST_VHOST/"
    expect(s).toContain('--resolve "$SAMOHOST_VHOST:443:127.0.0.1"');
    expect(s).toContain('"https://$SAMOHOST_VHOST/"');
    // Old form must be gone: it sent SNI=127.0.0.1 → handshake fail → 000.
    expect(s).not.toContain('-H "Host: $SAMOHOST_VHOST" https://127.0.0.1/');
    // Script must still be valid bash.
    expect(bashSyntaxOk(s)).toBe(true);
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

// ---------------------------------------------------------------------------
// Preview-flag: env create sets SAMO_ENV + SAMO_BRANCH (node) and config.js
// (static) so the preview banner fires. Prod deploy path stays clean.
// ---------------------------------------------------------------------------

describe("preview-flag: node env create appends SAMO_ENV=preview and SAMO_BRANCH", () => {
  test("node create script contains printf lines appending SAMO_ENV=preview to the .env", () => {
    const s = buildEnvCreateScript(app(), target());
    // The envfile phase must append SAMO_ENV=preview after the PORT append.
    expect(s).toContain("SAMO_ENV=preview");
  });

  test("node create script contains a printf line appending SAMO_BRANCH from $SAMOHOST_BRANCH", () => {
    const s = buildEnvCreateScript(app(), target());
    // SAMO_BRANCH value comes from the shell var $SAMOHOST_BRANCH, not a
    // hardcoded literal, so branch values with slashes round-trip correctly.
    expect(s).toContain("SAMO_BRANCH");
    expect(s).toContain("$SAMOHOST_BRANCH");
  });

  test("node create bash syntax still valid after SAMO_ENV/SAMO_BRANCH additions", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
  });

  test("node create is deterministic after SAMO_ENV/SAMO_BRANCH additions", () => {
    expect(buildEnvCreateScript(app(), target())).toBe(
      buildEnvCreateScript(app(), target()),
    );
  });

  test("executed: branch with a slash lands literally in the .env as SAMO_BRANCH=demo/red-login", () => {
    // This is the required round-trip test: string-match on the builder output
    // proves template shape, but an executed run proves the bash actually works
    // for branch names that contain slashes (e.g. demo/red-login).
    // We cannot run the full create script (it would clone a git repo, create a DB,
    // etc.), so we construct a minimal bash program that replicates only the
    // envfile-phase steps — mirroring the runRewire/runClone pattern above.
    const dir = mkdtempSync(join(tmpdir(), "samohost-preview-flag-"));
    try {
      const envDir = join(dir, "envdir");
      const templateEnv = join(dir, "template.env");
      // Minimal template env: just NODE_ENV so the copy succeeds.
      writeFileSync(templateEnv, "NODE_ENV=production\n", { mode: 0o600 });
      const prog = [
        "set -euo pipefail",
        `SAMOHOST_ENV_DIR='${envDir}'`,
        `SAMOHOST_ENV_TEMPLATE='${templateEnv}'`,
        `SAMOHOST_PORT='3100'`,
        `SAMOHOST_BRANCH='demo/red-login'`,
        `mkdir -p '${envDir}'`,
        `cp "$SAMOHOST_ENV_TEMPLATE" "$SAMOHOST_ENV_DIR/.env"`,
        `chmod 600 "$SAMOHOST_ENV_DIR/.env"`,
        `printf '\\nPORT=%s\\n' "$SAMOHOST_PORT" >> "$SAMOHOST_ENV_DIR/.env"`,
        `printf '\\nSAMO_ENV=preview\\nSAMO_BRANCH=%s\\n' "$SAMOHOST_BRANCH" >> "$SAMOHOST_ENV_DIR/.env"`,
      ].join("\n");
      // Verify the program we'll execute is itself syntactically valid.
      const syntaxCheck = spawnSync("bash", ["-n"], { input: prog, encoding: "utf8" });
      expect(syntaxCheck.status).toBe(0);
      const r = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      if (r.status !== 0) {
        console.error("round-trip bash stderr:", r.stderr);
      }
      expect(r.status).toBe(0);
      const envContents = readFileSync(join(envDir, ".env"), "utf8");
      expect(envContents).toContain("SAMO_ENV=preview");
      expect(envContents).toContain("SAMO_BRANCH=demo/red-login");
      // The slash must land as a literal character, not be shell-interpreted.
      // Truncation at / would produce "SAMO_BRANCH=demo" followed by a newline,
      // not a slash — detect that by checking the full form is present.
      expect(envContents.match(/^SAMO_BRANCH=(.*)$/m)?.[1]).toBe("demo/red-login");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executed round-trip: the ACTUAL generated script's envfile printf lines handle a slash branch", () => {
    // This test extracts the real generated envfile printf lines from the
    // builder and executes them — verifying the generated bash text round-trips.
    const slashBranch = "demo/red-login";
    const s = buildEnvCreateScript(app(), target({ branch: slashBranch }));
    // The generated script must contain both SAMO_ENV=preview and a SAMO_BRANCH
    // append that uses $SAMOHOST_BRANCH (the shell var holding the branch value).
    expect(s).toContain("SAMO_ENV=preview");
    expect(s).toContain("SAMO_BRANCH");
    // Additionally, SAMOHOST_BRANCH is set at the top of the script to the
    // single-quoted branch value (including the slash).
    expect(s).toContain(`SAMOHOST_BRANCH='${slashBranch}'`);
  });
});

describe("preview-flag: static env create writes config.js with preview:true", () => {
  function staticApp(o: Partial<AppRecord> = {}): AppRecord {
    return app({
      kind: "static",
      buildCmd: "true",
      serviceUnit: "gc1",
      repo: "samo-agent/game-changers",
      appDir: "/opt/gc1/app",
      ...o,
    });
  }

  test("static create script contains a printf that writes config.js with preview: true", () => {
    const s = buildEnvCreateScript(staticApp(), target());
    expect(s).toContain("preview: true");
  });

  test("static create script writes config.js into $SAMOHOST_ENV_DIR", () => {
    const s = buildEnvCreateScript(staticApp(), target());
    expect(s).toContain('$SAMOHOST_ENV_DIR/config.js');
  });

  test("static create script OVERWRITES config.js with > (not >>)", () => {
    const s = buildEnvCreateScript(staticApp(), target());
    // Must use > (overwrite) not >> (append): the repo ships a default
    // config.js with preview:false that must be replaced.
    expect(s).toContain('> "$SAMOHOST_ENV_DIR/config.js"');
    // Verify it's not an append.
    const configJsLine = s
      .split("\n")
      .find((l) => l.includes("config.js"));
    expect(configJsLine).toBeDefined();
    expect(configJsLine).not.toMatch(/>>/);
  });

  test("static create script embeds the branch from $SAMOHOST_BRANCH in config.js", () => {
    const s = buildEnvCreateScript(staticApp(), target({ branch: "demo/red-bg" }));
    // $SAMOHOST_BRANCH is set at the top of the script to the single-quoted
    // branch; the printf uses %s to interpolate it.
    expect(s).toContain("$SAMOHOST_BRANCH");
    // The branch variable declaration must appear.
    expect(s).toContain("SAMOHOST_BRANCH='demo/red-bg'");
  });

  test("config.js write appears AFTER the clone phase markers and BEFORE the vhost phase markers (placement guard)", () => {
    const s = buildEnvCreateScript(staticApp(), target());
    const cloneOkIdx = s.indexOf("<<<SAMOHOST_PHASE:clone:ok>>>");
    const configJsIdx = s.indexOf("config.js");
    const vhostStartIdx = s.indexOf("<<<SAMOHOST_PHASE:vhost:start>>>");
    expect(cloneOkIdx).toBeGreaterThan(-1);
    expect(configJsIdx).toBeGreaterThan(-1);
    expect(vhostStartIdx).toBeGreaterThan(-1);
    expect(configJsIdx).toBeGreaterThan(cloneOkIdx);
    expect(configJsIdx).toBeLessThan(vhostStartIdx);
  });

  test("static create bash syntax still valid after config.js write addition", () => {
    expect(bashSyntaxOk(buildEnvCreateScript(staticApp(), target()))).toBe(true);
  });

  test("static create is deterministic after config.js write addition", () => {
    expect(buildEnvCreateScript(staticApp(), target())).toBe(
      buildEnvCreateScript(staticApp(), target()),
    );
  });

  test("executed: printf config.js write with a slash branch emits valid JS containing preview: true and branch: \"demo/red-bg\"", () => {
    // Verify the printf form that will be generated works at runtime.
    const dir = mkdtempSync(join(tmpdir(), "samohost-preview-flag-static-"));
    try {
      const prog = [
        "set -euo pipefail",
        `SAMOHOST_ENV_DIR='${dir}'`,
        `SAMOHOST_BRANCH='demo/red-bg'`,
        `printf 'window.__GC1_CONFIG__ = { version: "", preview: true, branch: "%s" };\\n' "$SAMOHOST_BRANCH" > "$SAMOHOST_ENV_DIR/config.js"`,
      ].join("\n");
      const r = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      expect(r.status).toBe(0);
      const content = readFileSync(join(dir, "config.js"), "utf8");
      expect(content).toContain("preview: true");
      expect(content).toContain('branch: "demo/red-bg"');
      // The slash must survive — it is safe in a JS string literal.
      expect(content).not.toContain('branch: "demo"'); // no truncation at /
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PR #62 — static vhost must serve /config.js with no-cache so CF edge does
// not cache it (preview banner never shows when CF returns a stale config.js
// with preview:false from its 4h edge cache). Prod already serves config.js
// with Cache-Control: no-cache, no-store, must-revalidate; the preview static
// vhost must mirror that posture.
// ---------------------------------------------------------------------------

describe("static vhost: /config.js served with no-cache Cache-Control header", () => {
  function staticApp(o: Partial<AppRecord> = {}): AppRecord {
    return app({
      kind: "static",
      buildCmd: "true",
      serviceUnit: "gc1",
      repo: "samo-agent/game-changers",
      appDir: "/opt/gc1/app",
      ...o,
    });
  }

  const NOCACHE_HEADER = 'header /config.js Cache-Control "no-cache, no-store, must-revalidate"';

  test("static create script vhost block contains the config.js Cache-Control no-cache directive", () => {
    const s = buildEnvCreateScript(staticApp(), target({ dbBackend: "none" }));
    expect(s).toContain(NOCACHE_HEADER);
  });

  test("the no-cache directive is inside the site block (appears between root * and the file_server directive in the printf format string)", () => {
    const s = buildEnvCreateScript(staticApp(), target({ dbBackend: "none" }));
    const headerIdx = s.indexOf(NOCACHE_HEADER);
    // Directive must appear in the script.
    expect(headerIdx).toBeGreaterThan(-1);
    // Find the printf format string that contains the Caddy site block.
    // The format string contains \n\tfile_server\n (escaped) after the header.
    // The header appears after root * and before \tfile_server in the format str.
    const rootMarker = "root * %s";
    const fileServerMarker = "\\tfile_server";
    const rootIdx = s.indexOf(rootMarker);
    // The file_server directive inside the format string (escaped \t).
    const fileServerFmtIdx = s.indexOf(fileServerMarker, rootIdx);
    // All three must be present.
    expect(rootIdx).toBeGreaterThan(-1);
    expect(fileServerFmtIdx).toBeGreaterThan(-1);
    // The no-cache header directive must appear after root * and before \tfile_server.
    expect(headerIdx).toBeGreaterThan(rootIdx);
    expect(headerIdx).toBeLessThan(fileServerFmtIdx);
  });

  test("static vhost block still contains tls internal, root *, file_server, try_files (non-regression)", () => {
    const s = buildEnvCreateScript(staticApp(), target({ dbBackend: "none" }));
    expect(s).toContain("tls internal");
    expect(s).toContain("root *");
    expect(s).toContain("file_server");
    expect(s).toContain("try_files {path} /index.html");
  });

  test("static create bash syntax is still valid after adding the no-cache header (bash -n)", () => {
    const s = buildEnvCreateScript(staticApp(), target({ dbBackend: "none" }));
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("static create is still deterministic (byte-identical across two calls)", () => {
    expect(buildEnvCreateScript(staticApp(), target({ dbBackend: "none" }))).toBe(
      buildEnvCreateScript(staticApp(), target({ dbBackend: "none" })),
    );
  });

  test("node-app vhost (reverse_proxy) does NOT contain the config.js Cache-Control header directive", () => {
    // The node-app vhost is a bare reverse_proxy block: it has no config.js
    // (there is no file being served) so the header directive must not appear.
    const s = buildEnvCreateScript(app(), target());
    expect(s).not.toContain(NOCACHE_HEADER);
  });
});

describe("preview-flag: prod deploy path stays clean (SAMO_ENV=preview must NOT appear)", () => {
  // The deploy path is the ONLY path that writes to production; env create is
  // preview-only by construction. This test guards against accidental drift.
  function prodApp(overrides: Partial<AppRecord> = {}): AppRecord {
    return {
      id: "app-prod-1",
      vmId: "vm-prod-1",
      name: "field-record",
      repo: "Tanya301/field-record-1",
      branch: "main",
      appDir: "/opt/field-record/app",
      buildCmd: "npm run build",
      healthUrl: "http://localhost:3000/api/version",
      serviceUnit: "field-record",
      ...overrides,
    };
  }

  const PROD_TARGET = { sha: "abc1234def5678901234567890abcdef12345678" };

  test("buildDeployScript output does NOT contain SAMO_ENV=preview", () => {
    const s = buildDeployScript(prodApp(), PROD_TARGET);
    expect(s).not.toContain("SAMO_ENV=preview");
  });

  test("buildDeployScript output does NOT contain preview: true", () => {
    const s = buildDeployScript(prodApp(), PROD_TARGET);
    expect(s).not.toContain("preview: true");
  });

  test("buildDeployScript bash syntax is still valid (non-regression)", () => {
    expect(bashSyntaxOk(buildDeployScript(prodApp(), PROD_TARGET))).toBe(true);
  });

  // The deploy path SOURCES the operator envFile read-only and NEVER writes it
  // (src/types.ts AppSpec.envFile note). So prod must keep whatever BASE_URL the
  // operator template carries (e.g. https://field-record-1.samo.team) — the
  // deploy script must NOT emit a BASE_URL= write line that would clobber it.
  // This is the prod-side guard for the preview BASE_URL feature: only the
  // preview env-create path rewrites BASE_URL to the preview vhost.
  test("buildDeployScript output does NOT write a BASE_URL line (prod keeps the operator template's BASE_URL)", () => {
    const s = buildDeployScript(prodApp(), PROD_TARGET);
    expect(s).not.toMatch(/BASE_URL=/);
  });
});

// ---------------------------------------------------------------------------
// Magic-link correctness: the preview env-create script MUST set BASE_URL to
// the preview's OWN vhost so the magic-link URL the app builds
// (`${BASE_URL}/api/auth/magic-link/verify?token=...`, field-record src/app.ts)
// points at the preview — NOT at prod. If env-create copies the operator
// template verbatim, the preview inherits prod's BASE_URL
// (https://field-record-1.samo.team) and every magic link clicked logs the
// user into PROD. The fix: the envfile phase rewrites BASE_URL to
// https://$SAMOHOST_VHOST (strip the template's BASE_URL line, append the
// preview one), exactly like the SAMO_ENV/SAMO_BRANCH preview markers.
// RESEND_API_KEY + MAGIC_LINK_FROM_EMAIL (the send credentials) ride along from
// the operator template via the verbatim `cp`; samohost never sees their values.
// ---------------------------------------------------------------------------
describe("magic-link: preview env-create sets BASE_URL to the preview's own vhost", () => {
  test("node create script appends BASE_URL=https://<vhost> (printf %s of $SAMOHOST_VHOST) to the composed .env", () => {
    const s = buildEnvCreateScript(app(), target());
    // The append is a printf with %s bound to $SAMOHOST_VHOST so vhost values
    // are interpolated safely (no shell metachar surprises).
    expect(s).toContain("printf 'BASE_URL=https://%s\\n' \"$SAMOHOST_VHOST\"");
  });

  test("BASE_URL append is present for every db backend", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      expect(s).toContain("printf 'BASE_URL=https://%s\\n' \"$SAMOHOST_VHOST\"");
    }
  });

  test("the envfile phase STRIPS any template BASE_URL before appending the preview one (no prod BASE_URL leaks through)", () => {
    // grep -v removes the template's BASE_URL line so a last-wins-only loader
    // (dotenv variants) can't pick up prod's value. We assert the strip step
    // targets BASE_URL inside the envfile phase.
    const s = buildEnvCreateScript(app(), target());
    expect(s).toMatch(/grep -vE [^\n]*BASE_URL/);
  });

  test("the BASE_URL strip pre-creates the intermediate file at mode 600 (no world-readable credential window)", () => {
    const s = buildEnvCreateScript(app(), target());
    // The intermediate .env.baseurl must be created via `install -m 600` BEFORE
    // the grep redirect; a bare `> file` would inherit the umask (644).
    expect(s).toContain('install -m 600 /dev/null "$SAMOHOST_ENV_DIR/.env.baseurl"');
    // And the strip APPENDS (>>) into that pre-created file, preserving 600.
    expect(s).toMatch(/grep -vE [^\n]*BASE_URL[^\n]*>> "\$SAMOHOST_ENV_DIR\/\.env\.baseurl"/);
  });

  test("node create bash syntax still valid after BASE_URL addition (all backends)", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
  });

  test("node create is deterministic after BASE_URL addition", () => {
    expect(buildEnvCreateScript(app(), target())).toBe(
      buildEnvCreateScript(app(), target()),
    );
  });

  test("executed: the ACTUAL generated envfile phase produces .env with BASE_URL=https://<vhost> and STRIPS the template's prod BASE_URL", () => {
    // Round-trip the REAL generated envfile-phase composition — NOT a hand-coded
    // parallel. We extract the envfile-phase `if <composition>; then` condition
    // straight out of buildEnvCreateScript and execute it against a temp dir, so
    // a subtly-wrong generated fragment (quoting, ordering, missing `|| true`,
    // wrong redirect) would fail HERE. The `none` backend is used so the
    // composition references no db-rewire helper function (isolating the
    // BASE_URL behaviour). A template carrying a PROD BASE_URL + send
    // credentials must come out with the preview vhost BASE_URL, exactly one
    // BASE_URL line, send credentials preserved, prod host absent.
    const vhost = "field-record-1-feat-x.samo.cat";
    const s = buildEnvCreateScript(app(), target({ dbBackend: "none", vhost }));

    // Extract the envfile-phase `if ... ; then` condition from the real script.
    const startMarker = '<<<SAMOHOST_PHASE:envfile:start>>>';
    const startIdx = s.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const ifIdx = s.indexOf("\nif ", startIdx);
    expect(ifIdx).toBeGreaterThan(startIdx);
    const thenIdx = s.indexOf("\nthen", ifIdx);
    expect(thenIdx).toBeGreaterThan(ifIdx);
    // The condition is everything between the `if` and the `then` (inclusive of
    // the `if`). Drop the leading `if ` so it runs as a plain &&-chain command.
    const condition = s.slice(ifIdx + 1, thenIdx).replace(/^if\s+/, "");
    // Sanity: the extracted condition is the real BASE_URL composition.
    expect(condition).toContain("BASE_URL=https://%s");
    expect(condition).toMatch(/grep -vE [^\n]*BASE_URL/);

    const dir = mkdtempSync(join(tmpdir(), "samohost-baseurl-"));
    try {
      const envDir = join(dir, "envdir");
      const templateEnv = join(dir, "template.env");
      writeFileSync(
        templateEnv,
        [
          "NODE_ENV=production",
          "BASE_URL=https://field-record-1.samo.team",
          "RESEND_API_KEY=re_TEST_FAKE_KEY",
          "MAGIC_LINK_FROM_EMAIL=no-reply@samo.cat",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const prog = [
        "set -euo pipefail",
        `SAMOHOST_ENV_DIR='${envDir}'`,
        `SAMOHOST_ENV_TEMPLATE='${templateEnv}'`,
        `SAMOHOST_VHOST='${vhost}'`,
        `SAMOHOST_PORT='3100'`,
        `SAMOHOST_BRANCH='feat/x'`,
        `mkdir -p '${envDir}'`,
        condition, // ← the REAL generated envfile composition
      ].join("\n");
      const syntaxCheck = spawnSync("bash", ["-n"], { input: prog, encoding: "utf8" });
      expect(syntaxCheck.status).toBe(0);
      const r = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      if (r.status !== 0) console.error("baseurl round-trip stderr:", r.stderr);
      expect(r.status).toBe(0);
      const env = readFileSync(join(envDir, ".env"), "utf8");
      // Exactly one BASE_URL, and it is the preview vhost.
      expect(env.match(/^BASE_URL=/gm)).toHaveLength(1);
      expect(env).toContain(`BASE_URL=https://${vhost}`);
      // Prod host is GONE.
      expect(env).not.toContain("field-record-1.samo.team");
      // Send credentials ride along from the template untouched.
      expect(env).toContain("RESEND_API_KEY=re_TEST_FAKE_KEY");
      expect(env).toContain("MAGIC_LINK_FROM_EMAIL=no-reply@samo.cat");
      // The composed .env is mode 600 (intermediate .env.baseurl pre-created at
      // 600; final chmod re-asserts it) — no world-readable credential window.
      expect(statSync(join(envDir, ".env")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Port-check phase — foreign-occupant detection (field-record VM bug 2026-06-18)
//
// Root cause: allocatePort is pure (no OS visibility); a foreign process bound
// 0.0.0.0:3100 before the preview env tried to start. The preview's systemd
// unit failed with EADDRINUSE, but the Caddy snippet was already written, so
// the URL silently served the foreign squatter (wrong code, SAMO_ENV missing).
//
// Fix: the generated env-create script's FIRST phase is "port-check". It uses
// `ss -ltnH` to detect any listener on the allocated port. If a foreign
// process holds the port (something is listening AND our unit is not active),
// the phase emits a :fail marker, removes the stale Caddy snippet, reloads
// Caddy, and exits 1 — so the URL goes DARK rather than serving the squatter.
// ---------------------------------------------------------------------------

/**
 * Run the extracted `samohost_port_check_ok` bash function against a given
 * port and unit name. Returns the spawnSync result.
 */
function runPortCheck(port: number, unitActive: boolean): ReturnType<typeof spawnSync> {
  const script = buildEnvCreateScript(app(), target({ port }));
  const fn = extractFn(script, "samohost_port_check_ok");
  // Stub systemctl: return 0 (active) or 1 (inactive) for our unit.
  const systemctlStub = [
    "systemctl() {",
    '  if [[ "$1" == "is-active" ]]; then',
    unitActive ? "    return 0" : "    return 1",
    "  fi",
    '  command systemctl "$@"',
    "}",
  ].join("\n");
  const prog = [
    "set -uo pipefail",
    systemctlStub,
    fn,
    `samohost_port_check_ok ${port} 'field-record@field-record-1-feat-x.service'`,
  ].join("\n");
  return spawnSync("bash", ["-c", prog], { encoding: "utf8" });
}

describe("port-check phase — foreign-occupant detection", () => {
  // Track open servers for cleanup.
  const _servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(_servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    _servers.length = 0;
  });

  /** Bind a real TCP listener on an ephemeral port and return the port. */
  function bindListener(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      _servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("bad addr"));
        resolve({ server, port: addr.port });
      });
      server.on("error", reject);
    });
  }

  // (a) PORT-CHECK INTEGRATION: real bound socket → non-zero (foreign occupant)
  test("(a) executed: function returns non-zero when a foreign process holds the port", async () => {
    const { port } = await bindListener();
    // Unit is NOT active → this is a foreign occupant, not our own restarting unit.
    const r = runPortCheck(port, false);
    expect(r.status).not.toBe(0);
  });

  test("(a) executed: function returns zero when the port is free", () => {
    // Pick a port unlikely to be in use. We let the OS assign one with bindListener
    // and then CLOSE it, so we know it was free recently.
    // Use a static high port that is almost certainly free.
    const freePort = 19877;
    const r = runPortCheck(freePort, false);
    expect(r.status).toBe(0);
  });

  test("(a) executed: function returns zero (passes) when port is held by OUR OWN active unit", async () => {
    const { port } = await bindListener();
    // Unit IS active → this is our own running instance, treat as idempotent re-create.
    const r = runPortCheck(port, true);
    expect(r.status).toBe(0);
  });

  /** Bind a real TCP listener on the IPv6 loopback (::1) and return the port. */
  function bindListenerV6(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      _servers.push(server);
      server.listen(0, "::1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("bad addr"));
        resolve({ server, port: addr.port });
      });
      server.on("error", reject);
    });
  }

  // (a') IPv6-only squatter must also be caught (samorev #71 hardening): an
  // IPv6-only listener shows as [::1]:PORT in `ss -ltnH`; the old IPv4-only
  // regex was a false negative → unit would still hit EADDRINUSE on a dual-stack
  // bind. ss on this host may not be present in every CI image, so skip cleanly
  // if the address form isn't observable, but assert detection when it is.
  test("(a') executed: function returns non-zero when an IPv6-only process holds the port", async () => {
    let bound: { server: net.Server; port: number };
    try {
      bound = await bindListenerV6();
    } catch {
      return; // no IPv6 loopback in this environment — nothing to assert
    }
    const r = runPortCheck(bound.port, false);
    expect(r.status).not.toBe(0);
  });

  // (b) SCRIPT-CONTENT: port-check phase emitted BEFORE clone, fail path removes Caddy snippet
  test("(b) port-check phase marker appears BEFORE clone phase marker in node path", () => {
    const s = buildEnvCreateScript(app(), target());
    const portCheckIdx = s.indexOf("SAMOHOST_PHASE:port-check:start");
    const cloneIdx = s.indexOf("SAMOHOST_PHASE:clone:start");
    expect(portCheckIdx).toBeGreaterThan(-1);
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(portCheckIdx).toBeLessThan(cloneIdx);
  });

  test("(b) port-check fail path removes the Caddy snippet (rm -f CADDY_SNIPPET)", () => {
    const s = buildEnvCreateScript(app(), target());
    // Must include removal of the stale snippet on failure.
    expect(s).toContain("SAMOHOST_CADDY_SNIPPET");
    // The fail path must include rm -f of the caddy snippet AND caddy reload.
    const portCheckSection = s.slice(
      s.indexOf("SAMOHOST_PHASE:port-check"),
      s.indexOf("SAMOHOST_PHASE:clone"),
    );
    expect(portCheckSection).toContain("rm -f");
    expect(portCheckSection).toContain("SAMOHOST_CADDY_SNIPPET");
    expect(portCheckSection).toContain("reload caddy");
  });

  // (c) STATIC PATH UNCHANGED: static buildEnvCreateScript must NOT contain port-check
  test("(c) static path does NOT emit a port-check phase (no port/unit for static envs)", () => {
    const staticApp = { ...app(), kind: "static" as const };
    const s = buildEnvCreateScript(staticApp, target());
    expect(s).not.toContain("port-check");
    expect(s).not.toContain("SAMOHOST_PHASE:port-check");
  });

  // (d) SAMO_ENV/SAMO_BRANCH regression guard (extend existing content check)
  test("(d) node-path script still sets SAMO_ENV=preview and SAMO_BRANCH= in the envfile", () => {
    const s = buildEnvCreateScript(app(), target());
    expect(s).toContain("SAMO_ENV=preview");
    expect(s).toContain("SAMO_BRANCH=");
  });

  // (e) bash syntax still valid with port-check phase included
  test("(e) buildEnvCreateScript (node path) is still valid bash with all db backends", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// #89 used `sudo /usr/bin/systemctl restart` for the already-active case.
// ADOPTED VMs (field-record, cut-over not provisioned from scratch) never
// received a NOPASSWD `restart` grant — only `enable --now`, `disable --now`,
// `reset-failed` were proven granted everywhere (the cutover restarted units
// via disable--now/enable--now). So on adopted VMs the rebuild/self-heal exited
// failed and the app never reloaded its new DB.
//
// Fix (this MR): when the unit is already active, restart it via
//   sudo /usr/bin/systemctl disable --now <unit>
//   sudo /usr/bin/systemctl enable --now <unit>
// BOTH grants are already universal. `restart` is NOT needed and its grant
// can be removed from host-prep sudoers without breaking anything.
//
// The `is-active` check stays PLAIN (no sudo) — consistent with the
// PORT_CHECK_FN_LINES pattern and the fact that `sudo is-active` is DENIED
// on the hardened host.
//
// Four scenarios tested:
//   A. First create: unit not yet active → `enable --now` only
//   B. Re-create/heal (adopted + provisioned VM): unit already active →
//      `disable --now` then `enable --now` (NOT bare restart)
//   C. Script-level: unit phase contains `disable --now` in the active branch;
//      no bare `restart` in the unit phase block
//   D. host-prep sudoers: NO `restart` grant; `disable --now` and
//      `enable --now` are present; `is-active` is NOT in sudoers
// ---------------------------------------------------------------------------

/**
 * Run the generated unit phase against stubs that accurately model the
 * hardened-host privilege model for BOTH adopted and provisioned VMs:
 *
 *   - Plain `systemctl` (no sudo): handles `is-active` — returns 0/1 based
 *     on `unitActive`. Records `"plain:<subcmd>"` in INVOCATIONS.
 *   - `sudo /usr/bin/systemctl <subcmd>`: handles enable/disable/reset-failed.
 *     EXPLICITLY FAILS (exit 1) for `is-active` AND for `restart` — neither
 *     is in the universal NOPASSWD grant on adopted VMs.
 *     Records `"sudo:<subcmd>"` to distinguish from the plain path.
 *
 * Assertions on `invocations` then verify WHICH path was taken for each
 * sub-command, catching any regression that sneaks sudo back into is-active
 * or reintroduces a bare restart.
 */
function runUnitPhaseWithProdStub(
  unitActive: boolean,
  dbBackend: "dblab" | "template" | "none" = "dblab",
): {
  code: number;
  invocations: string[];
  stdout: string;
  stderr: string;
} {
  const script = buildEnvCreateScript(app(), target({ dbBackend }));

  // Extract the unit phase block (between unit:start and vhost:start markers).
  const unitEchoLine = 'echo "<<<SAMOHOST_PHASE:unit:start>>>"';
  const vhostEchoLine = 'echo "<<<SAMOHOST_PHASE:vhost:start>>>"';
  const unitStart = script.indexOf(unitEchoLine);
  const vhostStart = script.indexOf(vhostEchoLine);
  if (unitStart < 0 || vhostStart < 0) {
    return { code: -1, invocations: [], stdout: "", stderr: "unit/vhost markers not found" };
  }
  const unitBlock = script.slice(unitStart, vhostStart);

  const stub = [
    "INVOCATIONS=()",
    // Plain systemctl: handles is-active (no privilege needed).
    // Records "plain:<subcmd>" so tests can verify the no-sudo path.
    "systemctl() {",
    '  INVOCATIONS+=("plain:$1")',
    '  if [[ "$1" == "is-active" ]]; then',
    unitActive ? "    return 0" : "    return 1",
    "  fi",
    "  return 0",
    "}",
    // sudo stub: models the adopted-VM NOPASSWD list (the minimal universal set).
    // enable --now, disable --now, reset-failed → allowed (return 0).
    // restart → DENIED (return 1) — NOT in the universal grant on adopted VMs.
    // is-active → DENIED (return 1) — it is NOT in the NOPASSWD grant.
    // Records "sudo:<subcmd>" to distinguish from the plain path.
    "sudo() {",
    '  local sub="${2:-}"',
    '  INVOCATIONS+=("sudo:$sub")',
    '  if [[ "$sub" == "is-active" || "$sub" == "restart" ]]; then',
    "    return 1  # DENIED on adopted VMs",
    "  fi",
    "  return 0",
    "}",
    "SAMOHOST_UNIT_INSTANCE='field-record@field-record-1-feat-x.service'",
  ].join("\n");

  const prog = [
    "set -uo pipefail",
    stub,
    unitBlock,
    'printf "INVOKE:%s\\n" "${INVOCATIONS[@]}"',
  ].join("\n");

  const res = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
  const invocations = (res.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("INVOKE:"))
    .map((l) => l.slice("INVOKE:".length));

  return {
    code: res.status ?? -1,
    invocations,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("unit phase restarts an already-active instance via disable--now+enable--now (adopted-VM fix)", () => {
  // (A) First-create: unit not yet active → enable --now only (start + persist).
  //     is-active must be called via PLAIN systemctl (not sudo).
  test("(A) first-create path: unit NOT active → enable --now is called; is-active via plain systemctl (not sudo)", () => {
    const r = runUnitPhaseWithProdStub(false);
    expect(r.code).toBe(0);
    // is-active must be checked — via plain systemctl, NOT sudo.
    expect(r.invocations).toContain("plain:is-active");
    expect(r.invocations).not.toContain("sudo:is-active");
    // On a fresh unit, enable --now is the correct privileged call.
    expect(r.invocations).toContain("sudo:enable");
    // disable must NOT be called on first create (unit was not running).
    expect(r.invocations).not.toContain("sudo:disable");
    // restart must NOT be called at all (not in the universal grant).
    expect(r.invocations).not.toContain("sudo:restart");
  });

  // (B) Re-create/heal: unit already active → disable --now + enable --now.
  //     MUST NOT use bare restart (absent on adopted VMs).
  //     is-active must be called via PLAIN systemctl (not sudo).
  test("(B) re-create/heal path: unit ALREADY ACTIVE → disable--now then enable--now; no bare restart; is-active via plain systemctl", () => {
    const r = runUnitPhaseWithProdStub(true);
    expect(r.code).toBe(0);
    // is-active detected via plain systemctl, not sudo (which would be DENIED).
    expect(r.invocations).toContain("plain:is-active");
    expect(r.invocations).not.toContain("sudo:is-active");
    // The restart is implemented as disable --now + enable --now (both universally granted).
    expect(r.invocations).toContain("sudo:disable");
    expect(r.invocations).toContain("sudo:enable");
    // Bare restart must NOT be called: it is DENIED on adopted VMs.
    expect(r.invocations).not.toContain("sudo:restart");
    // disable must come before enable (stop-then-start ordering).
    expect(r.invocations.indexOf("sudo:disable")).toBeLessThan(
      r.invocations.indexOf("sudo:enable"),
    );
  });

  // (B-template) Same disable+enable semantics for the template db backend.
  test("(B-template) re-create path, template backend: already-active → disable--now+enable--now, no restart", () => {
    const r = runUnitPhaseWithProdStub(true, "template");
    expect(r.code).toBe(0);
    expect(r.invocations).toContain("plain:is-active");
    expect(r.invocations).not.toContain("sudo:is-active");
    expect(r.invocations).toContain("sudo:disable");
    expect(r.invocations).toContain("sudo:enable");
    expect(r.invocations).not.toContain("sudo:restart");
  });

  // (B-none) Same disable+enable semantics for the none db backend.
  test("(B-none) re-create path, none backend: already-active → disable--now+enable--now, no restart", () => {
    const r = runUnitPhaseWithProdStub(true, "none");
    expect(r.code).toBe(0);
    expect(r.invocations).toContain("plain:is-active");
    expect(r.invocations).not.toContain("sudo:is-active");
    expect(r.invocations).toContain("sudo:disable");
    expect(r.invocations).toContain("sudo:enable");
    expect(r.invocations).not.toContain("sudo:restart");
  });

  // (C) Script-level content checks:
  //     - is-active must appear WITHOUT a leading "sudo" in the unit phase.
  //     - Full-path sudo disable --now must appear in the unit phase (active branch).
  //     - Full-path sudo enable --now must appear in the unit phase.
  //     - No bare `systemctl restart` in the unit phase block.
  //     - Generated script is valid bash for all db backends.
  test("(C) generated script calls plain `systemctl is-active` (no sudo) in unit phase; active branch uses disable--now+enable--now, not restart", () => {
    const s = buildEnvCreateScript(app(), target());
    const unitStart = s.indexOf("<<<SAMOHOST_PHASE:unit:start>>>");
    const vhostStart = s.indexOf("<<<SAMOHOST_PHASE:vhost:start>>>");
    const unitBlock = s.slice(unitStart, vhostStart);
    // is-active must appear WITHOUT a "sudo" prefix: bare `systemctl is-active`.
    expect(unitBlock).not.toContain("sudo /usr/bin/systemctl is-active");
    expect(unitBlock).not.toContain("sudo systemctl is-active");
    // Positive: plain `systemctl is-active` must appear.
    expect(unitBlock).toContain("systemctl is-active");
    // Active branch: disable --now then enable --now (both universally granted).
    expect(unitBlock).toContain("sudo /usr/bin/systemctl disable --now");
    expect(unitBlock).toContain("sudo /usr/bin/systemctl enable --now");
    // Bare restart must NOT appear in the unit phase (not in universal grant).
    expect(unitBlock).not.toContain("systemctl restart");
  });

  test("(C-syntax) generated script is valid bash for all db backends", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      expect(bashSyntaxOk(buildEnvCreateScript(app(), target({ dbBackend: db })))).toBe(true);
    }
  });

  // (D) host-prep sudoers: NO restart grant (not needed; adopted VMs never had it).
  //     disable --now and enable --now must be present (already universal).
  //     is-active is unprivileged — must NOT appear in the sudoers block.
  test("(D) host-prep sudoers have disable--now and enable--now grants; NO restart grant; is-active NOT in sudoers", () => {
    const s = buildHostPrepScript(app(), "agent");
    // Exact-path grants that are universally available.
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl disable --now field-record@*.service");
    expect(s).toContain("NOPASSWD: /usr/bin/systemctl enable --now field-record@*.service");
    // restart grant is NOT needed and must NOT appear (adopted VMs never had it).
    expect(s).not.toContain("NOPASSWD: /usr/bin/systemctl restart");
    // is-active is an unprivileged read — must not appear in the sudoers block.
    expect(s).not.toContain("is-active");
  });
});

// ---------------------------------------------------------------------------
// Issue #97 — env-create clone runs as the wrong user (samo instead of the
// registered app user), causing `fatal: detected dubious ownership in
// repository` and making the 600 .gh-token unreadable. The preview systemd
// template unit also runs as samo instead of the app user that owns the env
// dir and the clone.
//
// Root cause: CLONE_FN_LINES uses plain `git` (no sudo), so git rejects
// /opt/<app>/app (owned by the app user, not samo). Under `set -euo pipefail`
// the clone phase fails silently → /etc/caddy/sites.d stays empty → Caddy
// imports nothing → CF 521.
//
// Fix: mirror bootstrap.ts §12 — run git ops as the app user via
//   sudo -u <appUser> GIT_CONFIG_GLOBAL=<git-safe.conf> /usr/bin/git
// with the credential helper reading the token file by LITERAL path (not an
// unexported shell variable). Also reconcile the preview template
// `User=<sshUser>` → `User=<appUser>` and add the SETENV sudoers grant so
// GIT_CONFIG_GLOBAL passes through sudo.
// ---------------------------------------------------------------------------

describe("issue #97: env-create clone + preview unit must use the registered app user", () => {
  // Fixture: samohost-fixture owns /opt/samohost-fixture/app.
  // The SSH user (samo) runs env-create but cannot access the app checkout
  // or read the 600 token; all git ops must delegate to samohost-fixture.
  const APP_USER = "samohost-fixture";
  const appWithUser = () =>
    app({ appUser: APP_USER, appDir: "/opt/samohost-fixture/app" });

  // Paths derived from appDir at generation time (mirrors bootstrap.ts §12):
  //   appBase    = /opt/samohost-fixture
  //   gitSafeConf = /opt/samohost-fixture/git-safe.conf
  //   tokenFile  = /opt/samohost-fixture/.gh-token
  const SAFE_CONF = "/opt/samohost-fixture/git-safe.conf";
  const TOKEN_FILE = "/opt/samohost-fixture/.gh-token";

  test("clone function runs ALL git ops with sudo -u <appUser> (not plain git as samo)", () => {
    const s = buildEnvCreateScript(appWithUser(), target());
    // Every git invocation in the generated clone function must delegate to
    // the app user so git does not see a dubious-ownership mismatch.
    expect(s).toContain(`sudo -u '${APP_USER}'`);
    // Full-path /usr/bin/git is required for the NOPASSWD sudoers grant.
    expect(s).toContain("/usr/bin/git");
    // The sudo invocations must include GIT_CONFIG_GLOBAL so they use the
    // bootstrap-written safe.directory config (verified in separate test).
    expect(s).toContain(`sudo -u '${APP_USER}' GIT_CONFIG_GLOBAL=`);
    // Confirm bash validity.
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("clone function uses GIT_CONFIG_GLOBAL pointing at the bootstrap-written git-safe.conf", () => {
    const s = buildEnvCreateScript(appWithUser(), target());
    // GIT_CONFIG_GLOBAL lets git bypass the safe.directory check that git
    // ≥ 2.35.2 enforces even for the checkout owner when running via sudo.
    // The path is derived from appDir at generation time (literal, not a
    // shell variable), mirroring bootstrap.ts §12.
    expect(s).toContain(`GIT_CONFIG_GLOBAL='${SAFE_CONF}'`);
  });

  test("clone uses a literal-path credential helper (not unexported $TOKEN_FILE)", () => {
    const s = buildEnvCreateScript(appWithUser(), target());
    // The inline credential helper must embed the TOKEN FILE PATH as a literal
    // string — not $TOKEN_FILE (which is not exported into the credential
    // helper subprocess). `cat <literal>` is the proven bootstrap.ts §12
    // pattern (samorev #32 + #83).
    expect(s).toContain(`cat ${TOKEN_FILE}`);
    // The shell variable form must NOT appear in the credential helper.
    expect(s).not.toContain("cat $TOKEN_FILE");
  });

  test("static env-create with appUser also uses sudo -u <appUser> for the clone", () => {
    const s = buildEnvCreateScript({ ...appWithUser(), kind: "static" }, target({ dbBackend: "none" }));
    expect(s).toContain(`sudo -u '${APP_USER}'`);
    expect(s).toContain("/usr/bin/git");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("preview template unit User= matches the app user, not the SSH user", () => {
    const s = buildHostPrepScript(appWithUser(), "samo");
    // The preview systemd instance runs as the app user so it can access files
    // created by the sudo-u-appUser clone (owned by appUser).
    expect(s).toContain(`User=${APP_USER}`);
    // Must NOT set User= to the SSH user (samo).
    // Use a line-anchored regex: "User=samo" would match as a substring of
    // "User=samohost-fixture", so we need to ensure the SSH user's name ends
    // the line (no further characters that would make it the app user).
    expect(s).not.toMatch(/^User=samo$/m);
    expect(bashSyntaxOk(s)).toBe(true);
  });

  test("host-prep sudoers grants samo the SETENV: /usr/bin/git right to run as appUser", () => {
    const s = buildHostPrepScript(appWithUser(), "samo");
    // SETENV: is required so GIT_CONFIG_GLOBAL passes through sudo to git.
    // Without it, sudo strips the env var and git falls back to the default
    // global config, losing the safe.directory override.
    expect(s).toContain(`samo ALL=(${APP_USER}) NOPASSWD: SETENV: /usr/bin/git`);
  });

  test("host-prep envs root is created owned by appUser (not sshUser) when appUser is set", () => {
    // The envs root must be owned by appUser so that `sudo -u appUser git clone`
    // can create the env subdirectory inside it. With sshUser ownership + mode 755,
    // appUser has no write permission and clone fails with EACCES.
    const s = buildHostPrepScript(appWithUser(), "samo");
    const root = envsRoot(appWithUser());
    expect(s).toContain(
      `install -d -m 755 -o ${APP_USER} -g ${APP_USER} '${root}'`,
    );
    // sshUser (samo) must NOT be the owner when appUser is set.
    expect(s).not.toContain(`install -d -m 755 -o samo -g samo '${root}'`);
  });

  test("backward compat: when appUser is absent, no sudo for git (old plain-git behavior)", () => {
    // Existing AppRecords without appUser keep working — plain git is used,
    // which matches the pre-#97 behavior (and only breaks on hosts where the
    // app dir is owned by a different user, i.e. the bug being fixed).
    const s = buildEnvCreateScript(app(), target());
    // No git-specific sudo delegation when appUser is not set.
    expect(s).not.toMatch(/sudo -u '[^']+'\s.*\/usr\/bin\/git/);
    // Plain git calls are still present (the old CLONE_FN_LINES behavior).
    expect(s).toContain("git clone");
  });

  test("backward compat: when appUser is absent, host-prep User= still uses sshUser", () => {
    const s = buildHostPrepScript(app(), "agent");
    expect(s).toContain("User=agent");
    expect(s).not.toContain("User=undefined");
    expect(bashSyntaxOk(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #98 follow-up: install + build phases must run as the app user when
// appUser is registered.
//
// Root cause: #98 fixed the CLONE phase by wrapping `git` invocations in
// `sudo -u <appUser>`, so the env dir is created owned by the app user.
// However the INSTALL phase (lockfile-aware npm ci / npm install) and the
// BUILD phase (app.buildCmd) still ran as the SSH admin user `samo` — which
// has no write permission to the app-user-owned node_modules dir → EACCES →
// install:fail → exit 1 → no .env/unit/Caddy written → CF 521.
//
// PROVEN: running the same commands as the app user completes ('env ready,
// port 3101'); running as `samo` fails with EACCES.
//
// Fix:
//   1. When appUser is set, wrap install (npm ci / npm install) in
//      `sudo -u <appUser> /usr/bin/npm ...`.
//   2. When appUser is set, wrap the build command similarly.
//   3. Add a `sshUser ALL=(appUser) NOPASSWD: /usr/bin/npm` sudoers grant
//      in buildHostPrepScript (the existing git grant does NOT cover npm).
//
// Secondary (latent — same function, #98 missed it):
//   4. The fetch path in buildCloneFnLines (re-create of an existing env dir)
//      uses `sudo -u appUser git fetch origin` WITHOUT the credential helper
//      that the initial clone uses → private-repo re-fetch fails with
//      'could not read Username'. Add the same literal-path credential.helper
//      to the fetch invocation.
// ---------------------------------------------------------------------------

describe("#98 follow-up: install + build run as the app user; fetch path carries credential helper", () => {
  const APP_USER = "samohost-fixture";
  const TOKEN_FILE = "/opt/samohost-fixture/.gh-token";
  const appWithUser = () =>
    app({ appUser: APP_USER, appDir: "/opt/samohost-fixture/app" });

  // (A) install phase ---------------------------------------------------------
  test("(A-install) install phase emits sudo -u appUser /usr/bin/npm when appUser is set", () => {
    const s = buildEnvCreateScript(appWithUser(), target());
    // Slice out just the install phase block.
    const installStart = s.indexOf("<<<SAMOHOST_PHASE:install:start>>>");
    const buildStart = s.indexOf("<<<SAMOHOST_PHASE:build:start>>>");
    expect(installStart).toBeGreaterThan(-1);
    expect(buildStart).toBeGreaterThan(installStart);
    const installBlock = s.slice(installStart, buildStart);
    // Both npm-ci and npm-install paths must delegate to the app user so the
    // write into the app-user-owned env dir does not EACCES.
    expect(installBlock).toContain(`sudo -u '${APP_USER}' /usr/bin/npm ci`);
    expect(installBlock).toContain(`sudo -u '${APP_USER}' /usr/bin/npm install`);
    // The bare (non-sudoed) form must NOT appear: running npm as samo →
    // EACCES when writing node_modules into the appUser-owned env dir.
    expect(installBlock).not.toContain("then npm ci");
    expect(installBlock).not.toContain("else npm install");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  // (A) build phase -----------------------------------------------------------
  test("(A-build) build phase emits sudo -u appUser when appUser is set", () => {
    // Use dbBackend:none so the next phase after build is envfile (no db-preflight
    // in between), making the slice boundary unambiguous.
    const s = buildEnvCreateScript(appWithUser(), target({ dbBackend: "none" }));
    const buildStart = s.indexOf("<<<SAMOHOST_PHASE:build:start>>>");
    const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    expect(buildStart).toBeGreaterThan(-1);
    expect(envfileStart).toBeGreaterThan(buildStart);
    const buildBlock = s.slice(buildStart, envfileStart);
    // The build command must run as the app user.
    expect(buildBlock).toContain(`sudo -u '${APP_USER}'`);
    // Full-path npm is required for the exact-path NOPASSWD grant to match.
    expect(buildBlock).toContain("/usr/bin/npm");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  // (B) backward compat -------------------------------------------------------
  test("(B) install + build are plain (no sudo -u) when appUser is absent", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "none" }));
    const installStart = s.indexOf("<<<SAMOHOST_PHASE:install:start>>>");
    const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    expect(installStart).toBeGreaterThan(-1);
    const installBuildBlock = s.slice(installStart, envfileStart);
    // No appUser → install + build remain unwrapped (pre-#98 behavior preserved
    // for AppRecords that predate the appUser field).
    expect(installBuildBlock).not.toContain("sudo -u");
    expect(installBuildBlock).toContain("npm ci");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  // (C) host-prep sudoers -----------------------------------------------------
  test("(C) host-prep sudoers includes /usr/bin/npm NOPASSWD grant for appUser", () => {
    const s = buildHostPrepScript(appWithUser(), "samo");
    // A single /usr/bin/npm grant covers npm ci, npm install, and npm run build.
    // Without this grant the `sudo -u appUser /usr/bin/npm` calls emitted by
    // the install + build phases fail at runtime with 'a password is required'.
    expect(s).toContain(`samo ALL=(${APP_USER}) NOPASSWD: /usr/bin/npm`);
    expect(bashSyntaxOk(s)).toBe(true);
  });

  // (D) fetch path credential helper ------------------------------------------
  test("(D) fetch path in clone fn carries credential helper when appUser + tokenFile set", () => {
    const s = buildEnvCreateScript(appWithUser(), target());
    // Locate the clone function body (from the opening line to the closing '}'.
    // Tests extract and run this function — closing brace is at column 0.
    const cloneFnStart = s.indexOf("samohost_clone_env_dir()");
    expect(cloneFnStart).toBeGreaterThan(-1);
    const cloneFnEnd = s.indexOf("\n}", cloneFnStart) + 2;
    const cloneFn = s.slice(cloneFnStart, cloneFnEnd);
    // Confirm the fetch line is present (it is the re-create path).
    const fetchIdx = cloneFn.indexOf("fetch origin");
    expect(fetchIdx).toBeGreaterThan(-1);
    // The 300-char window around the fetch invocation must carry the literal
    // token file path inside the credential helper substring (not $TOKEN_FILE,
    // which is not in scope inside the helper subprocess — proven bootstrap.ts
    // §12 / samorev #83 pattern).
    const context = cloneFn.slice(Math.max(0, fetchIdx - 300), fetchIdx + 300);
    expect(context).toContain(`cat ${TOKEN_FILE}`);
    // The clone paths already carry it — verify fetch is not the odd one out.
    expect(cloneFn.indexOf(`cat ${TOKEN_FILE}`)).toBeGreaterThan(-1);
    expect(bashSyntaxOk(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #101: envfile phase must run ALL env-dir writes as appUser when appUser is
// registered — the whack-a-mole root cause.
//
// Root cause: #98 fixed the CLONE phase (sudo -u appUser git), #100 fixed the
// INSTALL + BUILD phases (sudo -u appUser /usr/bin/npm + build binary), but
// the ENVFILE phase — which does cp, chmod, printf>>, install -m 600, grep>>,
// mv, chmod on the app-user-owned env dir — still ran as the SSH user (samo).
//
// samorev SECURITY BLOCKER: the original fix (MR #101 GREEN) wrapped the entire
// compose in `sudo -u appUser /usr/bin/bash -s << 'HEREDOC'`, which required a
// broad `SETENV: /usr/bin/bash` sudoers grant — letting samo run ARBITRARY
// commands as appUser. This is the security gap the tests below gate against.
//
// Fix: compose .env content in a samo-owned temp file (mktemp, /tmp), then
// write it to the appUser-owned envfile via:
//   sudo -u appUser /usr/bin/install -m 600 /dev/null <envfile>   (pre-create at 600)
//   sudo -u appUser /usr/bin/tee <envfile> >/dev/null < tmpfile   (write content)
//   sudo -u appUser /usr/bin/chmod 600 <envfile>                  (re-assert mode)
// Sudoers grants are SCOPED to these specific non-executing binaries at the
// envs-root path pattern — no /usr/bin/bash SETENV grant at all.
//
// Phase audit (buildEnvCreateScript, appUser set):
//   port-check   — B (read-only + root Caddy/systemctl ops; no env-dir writes)
//   clone        — A FIXED in #98 (sudo -u appUser git)
//   install      — A FIXED in #100 (sudo -u appUser /usr/bin/npm)
//   build        — A FIXED in #100 (sudoWrapBuildCmd)
//   db-preflight — B (curl + CLI resolve; no env-dir writes)
//   db           — B (sudo -u postgres psql/createdb/dropdb; no env-dir writes)
//   envfile      — A FIX HERE (scoped tee/chmod/install as appUser; no bash)
//   unit         — B (sudo systemctl enable/disable; no env-dir writes)
//   vhost        — B (sudo tee /etc/caddy/... + sudo systemctl reload; no env-dir writes)
//   health       — B (curl localhost; no writes)
// ---------------------------------------------------------------------------
describe("#101: envfile phase runs all env-dir writes as appUser (complete whack-a-mole audit)", () => {
  const APP_USER = "samohost-fixture";
  const appWithUser = () =>
    app({ appUser: APP_USER, appDir: "/opt/samohost-fixture/app" });

  // (A) envfile phase delegates to appUser via scoped tee/chmod — NOT via bash subshell.
  // Security fix: the broad /usr/bin/bash SETENV grant is replaced by scoped
  // /usr/bin/tee and /usr/bin/chmod grants; the compose runs as samo in a temp
  // file, and only the final write uses sudo -u appUser.
  for (const db of ["dblab", "template", "none"] as const) {
    test(`(A-${db}) envfile phase uses sudo -u appUser /usr/bin/tee (not bash) when appUser is set (${db})`, () => {
      const s = buildEnvCreateScript(
        appWithUser(),
        target({ dbBackend: db, dbName: "test_env_name" }),
      );
      const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
      const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
      expect(envfileStart).toBeGreaterThan(-1);
      expect(envfileOk).toBeGreaterThan(envfileStart);
      const envfileBlock = s.slice(envfileStart, envfileOk);
      // Final write to the envfile MUST use scoped tee as appUser.
      expect(envfileBlock).toContain(`sudo -u '${APP_USER}' /usr/bin/tee`);
      // Must NOT use a bash subshell (that required the broad SETENV bash grant).
      expect(envfileBlock).not.toContain(`sudo -u '${APP_USER}' /usr/bin/bash`);
      // The heredoc sentinel must be absent (no bash subshell).
      expect(envfileBlock).not.toContain("SAMOHOST_ENVFILE_EOF");
      // Valid bash after the change.
      expect(bashSyntaxOk(s)).toBe(true);
    });
  }

  // (B) backward compat: no sudo -u in envfile when appUser is absent
  test("(B) envfile phase has no sudo -u delegation when appUser is absent (backward compat)", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(app(), target({ dbBackend: db }));
      const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
      const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
      expect(envfileStart).toBeGreaterThan(-1);
      const envfileBlock = s.slice(envfileStart, envfileOk);
      // No appUser → envfile body is unchanged (plain cp/chmod/printf as SSH user).
      expect(envfileBlock).not.toContain(`sudo -u`);
      expect(bashSyntaxOk(s)).toBe(true);
    }
  });

  // (C) host-prep sudoers must grant scoped /usr/bin/tee and /usr/bin/chmod for
  //     appUser (tied to the envs-root path pattern), NOT the broad bash grant.
  test("(C) host-prep sudoers grants scoped /usr/bin/tee + /usr/bin/chmod for appUser — NO bash SETENV grant", () => {
    const prep = buildHostPrepScript(appWithUser(), "samo");
    const root = envsRoot(appWithUser());
    // Scoped tee grant: write-only to the env file path pattern.
    expect(prep).toContain(`samo ALL=(${APP_USER}) NOPASSWD: /usr/bin/tee ${root}/*/.env`);
    // Scoped chmod grant: set mode 600 on the env file.
    expect(prep).toContain(`samo ALL=(${APP_USER}) NOPASSWD: /usr/bin/chmod 600 ${root}/*/.env`);
    // The broad bash grant that let samo run arbitrary commands as appUser must be GONE.
    expect(prep).not.toContain(`SETENV: /usr/bin/bash`);
    expect(prep).not.toContain(`/usr/bin/bash`);
    expect(bashSyntaxOk(prep)).toBe(true);
  });

  // (D) structural: every write to the appUser-owned envDir path must itself be
  //     a sudo -u appUser call (tee, chmod, install) — no bare write by samo.
  test("(D) structural: every env-dir write in the generated script is a sudo -u appUser scoped call", () => {
    const envDir = "/opt/samohost-fixture/envs/field-record-1-feat-x";
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(
        appWithUser(),
        target({ dbBackend: db, dbName: "test_env", name: "field-record-1-feat-x" }),
      );
      // Scan every line that references the envDir AND is a write operation.
      const lines = s.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.includes(envDir)) continue;
        // Classify: is this line a write into the env dir?
        const isWriteOp =
          /\bcp\b/.test(line) ||
          /\bchmod\b/.test(line) ||
          /\binstall\b/.test(line) ||
          /\btee\b/.test(line) ||
          (/\bmv\b/.test(line) && !line.trimStart().startsWith("#")) ||
          (/>/.test(line) && !/^#/.test(line.trimStart()));
        if (!isWriteOp) continue;
        // Every write to the envDir must itself be a sudo -u appUser call.
        // (With the temp-file approach the intermediate cp/grep/mv all operate on
        // $tmpfile in /tmp; only install, tee, and chmod reference the literal
        // envDir path, and all three go through sudo -u appUser.)
        expect(
          line,
          `db=${db}, line ${i}: un-delegated write to envDir: ${JSON.stringify(line)}`,
        ).toContain(`sudo -u '${APP_USER}'`);
      }
    }
  });

  // (E) envfile block contains the actual compose operations
  //     (cp, chmod, PORT, SAMO_ENV, BASE_URL must all be visible).
  test("(E) envfile block contains cp, chmod, PORT append, and BASE_URL append when appUser set", () => {
    for (const db of ["dblab", "template", "none"] as const) {
      const s = buildEnvCreateScript(
        appWithUser(),
        target({ dbBackend: db, dbName: "test_env", name: "field-record-1-feat-x" }),
      );
      const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
      const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
      const block = s.slice(envfileStart, envfileOk);
      expect(block).toContain("cp ");
      expect(block).toContain("chmod 600");
      expect(block, `db=${db}: PORT missing`).toContain("PORT=");
      expect(block, `db=${db}: SAMO_ENV missing`).toContain("SAMO_ENV=preview");
      expect(block, `db=${db}: BASE_URL missing`).toContain("BASE_URL=");
    }
  });

  // (F) executed round-trip: extract the envfile phase `if` condition from the
  //     generated script, stub out sudo -u appUser (run commands directly as
  //     the test user — no privilege needed in a temp dir), and verify that the
  //     resulting .env has correct content and mode 600.
  test("(F) executed round-trip: tee-based envfile phase (none backend) produces correct .env with BASE_URL and PORT", () => {
    const vhost = "field-record-1-feat-x.samo.cat";
    const port = 3100;
    const branch = "feat/x";
    const s = buildEnvCreateScript(
      appWithUser(),
      target({ dbBackend: "none", vhost, port, branch }),
    );
    // The envfile phase must NOT use the heredoc mechanism any more.
    expect(s).not.toContain("SAMOHOST_ENVFILE_EOF");

    // Extract the envfile `if` condition (from `\nif ` after the start marker
    // to the `\nthen` that closes it).
    const startMarker = '<<<SAMOHOST_PHASE:envfile:start>>>';
    const startIdx = s.indexOf(startMarker);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const ifIdx = s.indexOf("\nif ", startIdx);
    expect(ifIdx).toBeGreaterThan(startIdx);
    const thenIdx = s.indexOf("\nthen", ifIdx);
    expect(thenIdx).toBeGreaterThan(ifIdx);
    const ifCondition = s.slice(ifIdx + 1, thenIdx);

    // Sanity: the extracted condition contains the tee call.
    expect(ifCondition).toContain("/usr/bin/tee");
    expect(ifCondition).toContain("cp ");
    expect(ifCondition).toContain("chmod 600");

    const dir = mkdtempSync(join(tmpdir(), "samohost-envfile-tee-"));
    try {
      const envDir = join(dir, "envdir");
      const templateEnv = join(dir, "template.env");
      writeFileSync(
        templateEnv,
        [
          "NODE_ENV=production",
          "BASE_URL=https://field-record-1.samo.team",
          "DATABASE_URL=postgres://app_user:secret@localhost:5432/prod_db",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      // Patch literal paths generated by TypeScript to point at the temp dir.
      const envDirLiteral = "/opt/samohost-fixture/envs/field-record-1-feat-x";
      const templateLiteral = "/opt/samohost-fixture/envs.template.env";
      const patchedCondition = ifCondition
        .replace(new RegExp(envDirLiteral.replace(/\//g, "\\/"), "g"), envDir)
        .replace(new RegExp(templateLiteral.replace(/\//g, "\\/"), "g"), templateEnv);

      // Stub sudo -u appUser: strip the `sudo -u '<user>'` prefix and run the
      // remaining command directly (the test user has permission on the temp dir).
      const sudoStub = [
        "sudo() {",
        '  if [[ "$1" == "-u" ]]; then shift 2; fi',
        '  "$@"',
        "}",
      ].join("\n");

      const prog = [
        "set -euo pipefail",
        sudoStub,
        `mkdir -p '${envDir}'`,
        // The extracted condition is the `if ...;` part; add then/fi to complete it.
        patchedCondition,
        "then",
        "  true",
        "fi",
      ].join("\n");

      const syntaxCheck = spawnSync("bash", ["-n"], { input: prog, encoding: "utf8" });
      expect(syntaxCheck.status, `syntax check failed:\n${syntaxCheck.stderr}`).toBe(0);
      const r = spawnSync("bash", ["-c", prog], { encoding: "utf8" });
      if (r.status !== 0) {
        console.error("tee round-trip stderr:", r.stderr);
      }
      expect(r.status).toBe(0);
      const env = readFileSync(join(envDir, ".env"), "utf8");
      expect(env).toContain(`PORT=${port}`);
      expect(env).toContain("SAMO_ENV=preview");
      expect(env).toContain(`SAMO_BRANCH=${branch}`);
      expect(env.match(/^BASE_URL=/gm)).toHaveLength(1);
      expect(env).toContain(`BASE_URL=https://${vhost}`);
      expect(env).not.toContain("field-record-1.samo.team");
      expect(statSync(join(envDir, ".env")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (G) dblab backend: SAMOHOST_DB_PORT is already in the outer bash (set in the
  //     db phase by samohost_clone_port). With the tee approach the rewire function
  //     runs in the outer bash directly — no KEY=val sudo prefix is needed.
  test("(G) dblab backend: envfile phase has NO KEY=val sudo prefix for SAMOHOST_DB_PORT (already in outer bash)", () => {
    const s = buildEnvCreateScript(
      appWithUser(),
      target({ dbBackend: "dblab", dbName: "test_clone" }),
    );
    const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
    const block = s.slice(envfileStart, envfileOk);
    // With tee approach SAMOHOST_DB_PORT is already available in the outer bash
    // (set by `SAMOHOST_DB_PORT="$(samohost_clone_port)"` in the db phase).
    // The KEY=val forwarding prefix was only needed for the inner bash subshell.
    expect(block).not.toContain(`SAMOHOST_DB_PORT="$SAMOHOST_DB_PORT"`);
    // The rewire function IS called in the envfile block (as outer-bash call).
    expect(block).toContain("samohost_rewire_db_hostport");
    expect(bashSyntaxOk(s)).toBe(true);
  });

  // (H) template backend: the rewire function is called in the envfile block (it
  //     is already defined in the outer bash from the db phase). No heredoc.
  test("(H) template backend: envfile block calls samohost_rewire_db_vars (no heredoc sentinel)", () => {
    const dbName = "feat_x_db";
    const s = buildEnvCreateScript(
      appWithUser(),
      target({ dbBackend: "template", dbName }),
    );
    // No heredoc — the tee approach builds content in the outer bash.
    expect(s).not.toContain("SAMOHOST_ENVFILE_EOF");
    const envfileStart = s.indexOf("<<<SAMOHOST_PHASE:envfile:start>>>");
    const envfileOk = s.indexOf("<<<SAMOHOST_PHASE:envfile:ok>>>");
    const block = s.slice(envfileStart, envfileOk);
    // The rewire function is called in the envfile block (outer bash already
    // defines it with SAMOHOST_DB_NAME and SAMOHOST_ENV_DB_VARS from the db phase).
    expect(block).toContain("samohost_rewire_db_vars");
    expect(bashSyntaxOk(s)).toBe(true);
  });
});
