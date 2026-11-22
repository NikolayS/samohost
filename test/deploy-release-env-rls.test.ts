/**
 * Node deploy: the release env file write is not fatal, keeps no temporary
 * backup file, and the assert-rls probe passes the app's database password
 * to psql through PG* environment variables, not as a process argument.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import { nodeApp } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const TARGET = "5555555555555555555555555555555555555555";
const APP_URL = "APP_DATABASE_URL=postgresql://shop_app:0123abcd@127.0.0.1:5432/shop\n";

describe("release env file write", () => {
  test("a release env file that cannot be written gives a warning and the deploy continues", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, `PORT=3100\n${APP_URL}`);
      // A directory in place of the temporary file makes the write fail.
      mkdirSync(join(sb.dir, "release.env.next"));
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("WARNING: could not write the release env file");
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:health:ok>>>");
      expect(res.stdout).not.toContain("<<<SAMOHOST_PHASE:rollback:");
    } finally {
      sb.cleanup();
    }
  });

  test("no temporary backup file is made; rollback restores the previous content", () => {
    const script = buildDeployScript(nodeApp(), { sha: TARGET });
    expect(script).not.toContain("mktemp");
    const sb = makeDeploySandbox({ healthCode: "500" });
    try {
      writeFileSync(sb.envFile, `PORT=3100\n${APP_URL}`);
      const previous = "SAMO_RELEASE_TAG=v20261121.1\nSAMO_RELEASE_SHA=1111111\n";
      writeFileSync(join(sb.dir, "release.env"), previous);
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(res.status).toBe(1);
      expect(readFileSync(join(sb.dir, "release.env"), "utf8")).toBe(previous);
    } finally {
      sb.cleanup();
    }
  });
});

describe("assert-rls probe", () => {
  test("the password and the URL are not in psql's arguments; PG* variables carry them", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, `PORT=3100\n${APP_URL}`);
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:ok>>>");
      const log = readFileSync(sb.psqlLog, "utf8");
      const args = log.split("\n").filter((l) => l.startsWith("ARGS "));
      expect(args.length).toBe(1);
      expect(args[0]).not.toContain("0123abcd");
      expect(args[0]).not.toContain("postgresql://");
      expect(log).toContain("ENV PGHOST=127.0.0.1 PGPORT=5432 PGUSER=shop_app PGPASSWORD=0123abcd PGDATABASE=shop");
    } finally {
      sb.cleanup();
    }
  });

  test("a percent-encoded password is decoded", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=postgresql://shop_app:a%40b%3Ac@db.internal:6543/shop?sslmode=require\n");
      sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(readFileSync(sb.psqlLog, "utf8")).toContain("PGHOST=db.internal PGPORT=6543 PGUSER=shop_app PGPASSWORD=a@b:c PGDATABASE=shop");
    } finally {
      sb.cleanup();
    }
  });

  test("an address that is not a postgresql:// URL fails the probe and rolls back", () => {
    const sb = makeDeploySandbox();
    try {
      writeFileSync(sb.envFile, "PORT=3100\nAPP_DATABASE_URL=host=127.0.0.1 user=x\n");
      mkdirSync(join(sb.appDir, "dist"));
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:fail>>>");
      expect(existsSync(sb.psqlLog)).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
