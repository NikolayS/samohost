/**
 * Bootstrap re-run of a node app that already runs in the legacy layout.
 *
 * The legacy unit (/etc/systemd/system/<unit>.service with User=<appUser>) is
 * written only by a legacy node bootstrap: the new layout writes
 * User=<app>-run, a static setup writes no unit, and the steps before the
 * first node bootstrap (app user, clone) write no unit. When that unit exists
 * and there is no split marker and no migrate env file, an env file that is
 * missing or has no DATABASE_URL= line stops the run in §3b with nothing
 * changed, instead of converting the running app to the new layout.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbSection, makeSandbox, readOr, runSection, sandboxScript, stateDirOf, type Sandbox } from "./bootstrap-db-harness.ts";

const LEGACY_UNIT = [
  "[Unit]",
  "Description=shop main service",
  "",
  "[Service]",
  "User=shop",
  "Group=shop",
  "ExecStart=/usr/bin/node dist/index.js",
  "",
].join("\n");

function unitDirOf(sb: Sandbox): string {
  const dir = join(sb.dir, "etc-systemd-system");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(sb: Sandbox, envFile: string) {
  const section = dbSection(sandboxScript(envFile)).replaceAll("/etc/systemd/system", unitDirOf(sb));
  return runSection(sb, section);
}

const markerOf = (sb: Sandbox): string => join(stateDirOf(sb), "db-layout", "shop");

describe("bootstrap re-run — legacy unit without a DATABASE_URL line", () => {
  test("legacy unit and an env file without DATABASE_URL= are refused with nothing written", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      const body = "APP_DATABASE_URL=postgresql://shop_app:abc@127.0.0.1:5432/shop\nCOOKIE_SECRET=00ff\n";
      writeFileSync(envFile, body);
      writeFileSync(join(unitDirOf(sb), "shop.service"), LEGACY_UNIT);
      const res = run(sb, envFile);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("legacy layout");
      expect(res.stderr).toContain("DATABASE_URL=");
      expect(res.stderr).toContain("README");
      expect(res.stderr).toContain("bootstrap changed nothing");
      expect(readFileSync(envFile, "utf8")).toBe(body);
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(false);
      expect(existsSync(markerOf(sb))).toBe(false);
      expect(readOr(sb.sqlLog)).toBe("");
      expect(readOr(sb.argvLog)).toBe("");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy unit and a missing env file are refused with nothing written", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      writeFileSync(join(unitDirOf(sb), "shop.service"), LEGACY_UNIT);
      const res = run(sb, envFile);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("legacy layout");
      expect(existsSync(envFile)).toBe(false);
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(false);
      expect(existsSync(markerOf(sb))).toBe(false);
      expect(readOr(sb.sqlLog)).toBe("");
    } finally {
      sb.cleanup();
    }
  });

  test("the refusal is rendered in §3b, before §4", () => {
    const script = sandboxScript("/opt/shop/staging.env");
    const lines = script.split("\n");
    const check = lines.findIndex((l) => l.includes("is in the legacy layout"));
    expect(check).toBeGreaterThan(lines.findIndex((l) => l.startsWith("# §3b.")));
    expect(check).toBeLessThan(lines.findIndex((l) => l.startsWith("# §4.")));
  });

  test("first node bootstrap after a static setup, the app user and the clone (no node unit) uses the new layout", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      // Clone made before the first node bootstrap; static files from a static setup.
      mkdirSync(join(sb.dir, "app", ".git"), { recursive: true });
      writeFileSync(join(sb.dir, "app", "index.html"), "<p>static</p>\n");
      // Units of other services; the host-prep preview template is not this unit.
      writeFileSync(join(unitDirOf(sb), "caddy.service"), "[Service]\nUser=caddy\n");
      writeFileSync(join(unitDirOf(sb), "shop@.service"), "[Service]\nUser=shop\n");
      const res = run(sb, envFile);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(true);
      expect(readFileSync(markerOf(sb), "utf8")).toBe("split\n");
    } finally {
      sb.cleanup();
    }
  });

  test("an interrupted first new-layout run (unit with User=<app>-run, no env file) uses the new layout", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      writeFileSync(join(unitDirOf(sb), "shop.service"), "[Service]\nUser=shop-run\nGroup=shop-run\n");
      const res = run(sb, envFile);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  test("a split marker uses the new layout even with a unit that runs as the deploy user", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      writeFileSync(envFile, "APP_DATABASE_URL=postgresql://shop_app:abc@127.0.0.1:5432/shop\n");
      writeFileSync(join(unitDirOf(sb), "shop.service"), LEGACY_UNIT);
      mkdirSync(join(stateDirOf(sb), "db-layout"), { recursive: true });
      writeFileSync(markerOf(sb), "split\n");
      const res = run(sb, envFile);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toContain("legacy env layout");
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  test("legacy unit and an env file with the superuser DATABASE_URL keep the legacy layout", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      writeFileSync(envFile, "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n");
      writeFileSync(join(unitDirOf(sb), "shop.service"), LEGACY_UNIT);
      const res = run(sb, envFile);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("legacy env layout");
      expect(readFileSync(envFile, "utf8")).toContain("DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop");
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(false);
      expect(existsSync(markerOf(sb))).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
