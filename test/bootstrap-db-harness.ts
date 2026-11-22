/**
 * Helpers for executing the database and env-file sections of the node-app
 * bootstrap script with stub commands (see bootstrap-db-roles.test.ts).
 */

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostBootstrapOptions } from "../src/app/bootstrap.ts";
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

