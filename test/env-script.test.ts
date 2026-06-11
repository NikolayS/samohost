import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

  test("dblab backend: clone create + on-host password, no samohost-side secrets", () => {
    const s = buildEnvCreateScript(app(), target({ dbBackend: "dblab" }));
    expect(s).toContain("dblab clone create --id");
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
    expect(s).toContain("/usr/bin/psql");
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

  test("dblab destroy deletes the clone", () => {
    const s = buildEnvDestroyScript(app(), target({ dbBackend: "dblab" }));
    expect(s).toContain("dblab clone destroy");
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
