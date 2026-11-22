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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHostBootstrapScript,
  type HostBootstrapOptions,
} from "../src/app/bootstrap.ts";
import type { AppRecord } from "../src/types.ts";

export function nodeApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-node-0001",
    vmId: "vm-node-0001",
    name: "shop",
    repo: "example/shop",
    branch: "main",
    appDir: "/opt/shop/app",
    buildCmd: "npm run build",
    migrateCmd: "npm run migrate",
    healthUrl: "http://127.0.0.1:3100/healthz",
    serviceUnit: "shop",
    envFile: "/opt/shop/staging.env",
    rlsUrlVar: "APP_DATABASE_URL",
    assertions: { rlsNonSuperuser: true },
    ...overrides,
  };
}

export function nodeOpts(overrides: Partial<HostBootstrapOptions> = {}): HostBootstrapOptions {
  return { appUser: "shop", dbName: "shop", ...overrides };
}

/** Lines of the script that are not comments. */
function codeLines(script: string): string[] {
  return script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
}

/**
 * The part of the script from the §10 heading to the line before the §12
 * heading: database bootstrap and env files.
 */
export function dbSection(script: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.startsWith("# §10."));
  const end = lines.findIndex((l) => l.startsWith("# §12."));
  expect(start, "§10 heading").toBeGreaterThan(0);
  expect(end, "§12 heading").toBeGreaterThan(start);
  // Include the dashes line above each heading only for the start.
  return lines.slice(start - 1, end - 1).join("\n");
}

export interface Sandbox {
  dir: string;
  bin: string;
  argvLog: string;
  sqlLog: string;
  rolesFile: string;
  cleanup(): void;
}

/**
 * Stub commands:
 *   sudo     records argv (one line per call) and stdin SQL; answers the
 *            `SELECT 1 FROM pg_roles/pg_database` probes from rolesFile;
 *            drops `-u <user>` and runs nothing else.
 *   openssl  prints a fixed 48-character hex value per call (counter-based).
 *   chown    no-op (the test user cannot chown to the app user).
 */
export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "samohost-dbroles-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const argvLog = join(dir, "argv.log");
  const sqlLog = join(dir, "sql.log");
  const rolesFile = join(dir, "roles.txt");
  writeFileSync(rolesFile, "");
  const sudo = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'args="$*"',
    'if [[ "$args" == *"-c "* || "$args" == *"-qAtc"* ]]; then',
    '  if [[ "$args" == *"pg_roles"* ]]; then',
    `    role=$(printf '%s' "$args" | sed -E "s/.*rolname='([^']*)'.*/\\1/")`,
    `    grep -qx "$role" ${JSON.stringify(rolesFile)} && echo 1`,
    "  elif [[ \"$args\" == *\"select 1\"* ]]; then echo 1",
    "  fi",
    "  exit 0",
    "fi",
    'if [[ "$args" == *psql* ]]; then',
    `  cat >> ${JSON.stringify(sqlLog)}`,
    `  printf '\\n-- end of psql call\\n' >> ${JSON.stringify(sqlLog)}`,
    "fi",
    "exit 0",
  ].join("\n");
  writeFileSync(join(bin, "sudo"), sudo);
  chmodSync(join(bin, "sudo"), 0o755);
  const opensslCounter = join(dir, "openssl.count");
  writeFileSync(
    join(bin, "openssl"),
    [
      "#!/usr/bin/env bash",
      `n=$(( $(cat ${JSON.stringify(opensslCounter)} 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > ${JSON.stringify(opensslCounter)}`,
      // 48 hex characters, distinct per call.
      'printf "%048x\\n" "$(( 0xabc000 + n ))"',
    ].join("\n"),
  );
  chmodSync(join(bin, "openssl"), 0o755);
  writeFileSync(join(bin, "chown"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "chown"), 0o755);
  writeFileSync(join(bin, "useradd"), `#!/usr/bin/env bash\nprintf 'useradd %s\\n' "$*" >> ${JSON.stringify(argvLog)}\n`);
  chmodSync(join(bin, "useradd"), 0o755);
  return {
    dir,
    bin,
    argvLog,
    sqlLog,
    rolesFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function runSection(sb: Sandbox, section: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${section}`], {
    encoding: "utf8",
    env: { PATH: `${sb.bin}:/usr/bin:/bin`, HOME: sb.dir },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function readOr(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
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
      expect(readOr(sb.sqlLog)).not.toContain("legacy_role");
      expect(readOr(sb.sqlLog)).not.toContain("shop_app");
    } finally {
      sb.cleanup();
    }
  });
});
