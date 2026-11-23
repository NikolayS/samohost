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
  function probe(address: string) {
    const sb = makeDeploySandbox();
    try {
      // Single quotes keep backslashes when the deploy script sources the env file.
      writeFileSync(sb.envFile, `PORT=3100\nAPP_DATABASE_URL='${address.replace(/'/g, "'\\''")}'\n`);
      mkdirSync(join(sb.appDir, "dist"));
      const res = sb.run(buildDeployScript(nodeApp({ appDir: sb.appDir, envFile: sb.envFile }), { sha: TARGET }));
      const log = existsSync(sb.psqlLog) ? readFileSync(sb.psqlLog, "utf8") : "";
      const args = log.split("\n").filter((l) => l.startsWith("ARGS "));
      const env = log.split("\n").filter((l) => l.startsWith("ENV "));
      return { res, args, env };
    } finally {
      sb.cleanup();
    }
  }

  test("the password is not in psql's arguments; PGPASSWORD carries it", () => {
    const { res, args, env } = probe("postgresql://shop_app:0123abcd@127.0.0.1:5432/shop");
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:ok>>>");
    expect(args.length).toBe(1);
    expect(args[0]).not.toContain("0123abcd");
    expect(args[0]).toContain("-d postgresql://shop_app@127.0.0.1:5432/shop ");
    expect(env[0]).toContain("PGPASSWORD=0123abcd ");
  });

  test("a percent-encoded password is decoded", () => {
    const { res, args, env } = probe("postgresql://shop_app:a%40b%3Ac@db.internal:6543/shop?sslmode=require");
    expect(res.status, res.stderr).toBe(0);
    expect(env[0]).toContain("PGPASSWORD=a@b:c ");
    expect(args[0]).toContain("-d postgresql://shop_app@db.internal:6543/shop?sslmode=require ");
  });

  test("a literal backslash, a lone percent sign, %25, %20 and + in the password", () => {
    const { res, env } = probe("postgresql://shop_app:a\\b%zz%25%20+c@db.internal/shop");
    expect(res.status, res.stderr).toBe(0);
    expect(env[0]).toContain("PGPASSWORD=a\\b%zz% +c ");
  });

  test("IPv6, socket-style and postgres:// addresses reach psql with their query parameters", () => {
    expect(probe("postgres://shop_app:pw@[::1]:5432/shop?sslmode=require").args[0]).toContain(
      "-d postgres://shop_app@[::1]:5432/shop?sslmode=require ",
    );
    const socket = probe("postgresql:///shop?host=/var/run/postgresql&user=shop_app");
    expect(socket.res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:ok>>>");
    expect(socket.args[0]).toContain("-d postgresql:///shop?host=/var/run/postgresql&user=shop_app ");
  });

  test("a key=value address reaches psql without its password pair", () => {
    const { res, args, env } = probe("host=127.0.0.1 user=shop_app password=s3cret dbname=shop");
    expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:ok>>>");
    expect(args[0]).toContain("-d host=127.0.0.1 user=shop_app dbname=shop ");
    expect(args[0]).not.toContain("s3cret");
    expect(env[0]).toContain("PGPASSWORD=s3cret ");
  });

  test("an address that cannot be read fails the probe and rolls back", () => {
    const { res, args } = probe("host=127.0.0.1 password='unterminated");
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:fail>>>");
    expect(args.length).toBe(0);
  });
});
