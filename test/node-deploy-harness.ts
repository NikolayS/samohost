/**
 * Sandbox for executing a node-app deploy script from buildDeployScript
 * without a server: stub git, npm, curl, sudo, psql and sleep on PATH.
 *
 * The npm stub records, for every call, its arguments and the values of the
 * variables listed in RECORDED_VARS that are present in its environment, so a
 * test can check what each phase (install, build, migrate) received.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RECORDED_VARS = [
  "DATABASE_URL",
  "APP_DATABASE_URL",
  "SEED_OWNER_LOGIN",
  "SEED_OWNER_PASSWORD",
  "COOKIE_SECRET",
  "SAMO_RELEASE_TAG",
  "SAMO_RELEASE_SHA",
];

export interface DeploySandbox {
  dir: string;
  appDir: string;
  envFile: string;
  migrateEnvFile: string;
  npmLog: string;
  sudoLog: string;
  run(script: string): { status: number | null; stdout: string; stderr: string };
  /** Recorded npm calls: args plus the recorded variables it saw. */
  npmCalls(): Array<{ args: string; env: Record<string, string> }>;
  cleanup(): void;
}

function stub(bin: string, name: string, body: string[]): void {
  writeFileSync(join(bin, name), ["#!/usr/bin/env bash", ...body].join("\n") + "\n");
  chmodSync(join(bin, name), 0o755);
}

export function makeDeploySandbox(opts: { headSha?: string; healthCode?: string } = {}): DeploySandbox {
  const dir = mkdtempSync(join(tmpdir(), "samohost-deploy-"));
  const bin = join(dir, "bin");
  const appDir = join(dir, "app");
  mkdirSync(bin);
  mkdirSync(appDir);
  writeFileSync(join(appDir, "package-lock.json"), "{}\n");
  const npmLog = join(dir, "npm.log");
  const sudoLog = join(dir, "sudo.log");
  const headSha = opts.headSha ?? "1111111111111111111111111111111111111111";
  stub(bin, "git", [
    'case "$1" in',
    `  rev-parse) echo ${headSha} ;;`,
    "  *) exit 0 ;;",
    "esac",
  ]);
  stub(bin, "npm", [
    `{ printf 'CALL %s\\n' "$*"; for v in ${RECORDED_VARS.join(" ")}; do if [[ -n "\${!v+x}" ]]; then printf 'ENV %s=%s\\n' "$v" "\${!v}"; fi; done; } >> ${JSON.stringify(npmLog)}`,
  ]);
  stub(bin, "curl", [`echo ${opts.healthCode ?? "200"}`]);
  stub(bin, "sudo", [`printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}`]);
  stub(bin, "psql", ["echo f"]);
  stub(bin, "sleep", ["exit 0"]);
  return {
    dir,
    appDir,
    envFile: join(dir, "staging.env"),
    migrateEnvFile: join(dir, "migrate.env"),
    npmLog,
    sudoLog,
    run(script: string) {
      const res = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
      });
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    npmCalls() {
      if (!existsSync(npmLog)) return [];
      const calls: Array<{ args: string; env: Record<string, string> }> = [];
      for (const line of readFileSync(npmLog, "utf8").split("\n")) {
        if (line.startsWith("CALL ")) calls.push({ args: line.slice(5), env: {} });
        else if (line.startsWith("ENV ") && calls.length > 0) {
          const kv = line.slice(4);
          const eq = kv.indexOf("=");
          calls[calls.length - 1]!.env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      return calls;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
