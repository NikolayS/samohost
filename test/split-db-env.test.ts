/**
 * Split database env layout for node apps (src/app/db-layout.ts).
 *
 * Bootstrap: a newly bootstrapped node app gets a runtime env file without any
 * superuser or migration address, a migrate env file with the migration
 * role's DATABASE_URL and the SEED_OWNER_* values, and a migration role that
 * owns only the app's database. An app bootstrapped before (superuser
 * DATABASE_URL in its env file, no migrate env file) keeps its layout.
 *
 * Deploy: with a migrate env file on the server, `npm ci` and the build run
 * without any database address in their environment; only the migrate step
 * gets DATABASE_URL (migration role), APP_DATABASE_URL and SEED_OWNER_*.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import { migrateEnvFileOf } from "../src/app/db-layout.ts";
import { dbSection, makeSandbox, nodeApp, readOr, runSection, sandboxScript } from "./bootstrap-db-harness.ts";
import { makeDeploySandbox } from "./node-deploy-harness.ts";

const SHA = "2222222222222222222222222222222222222222";

describe("migrateEnvFileOf", () => {
  test("is migrate.env next to the runtime env file", () => {
    expect(migrateEnvFileOf("/opt/shop/staging.env")).toBe("/opt/shop/migrate.env");
  });
  test("refuses an env file that is itself named migrate.env", () => {
    expect(() => migrateEnvFileOf("/opt/shop/migrate.env")).toThrow(/reserved/);
  });
});

describe("bootstrap — split env layout (executed with stubs)", () => {
  test("fresh app: runtime env has no superuser or migration address; migrate env has the owner role", () => {
    const sb = makeSandbox();
    try {
      const app = nodeApp({ envFile: join(sb.dir, "staging.env") });
      const res = runSection(sb, dbSection(sandboxScript(app.envFile!)));
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const runtime = readFileSync(join(sb.dir, "staging.env"), "utf8");
      const migrate = readFileSync(join(sb.dir, "migrate.env"), "utf8");
      expect(runtime).not.toMatch(/^DATABASE_URL=/m);
      expect(runtime).not.toContain("postgres:");
      expect(runtime).not.toMatch(/^SEED_OWNER_/m);
      expect(runtime).toMatch(/^APP_DATABASE_URL=postgresql:\/\/shop_app:[0-9a-f]{48}@127\.0\.0\.1:5432\/shop$/m);
      expect(runtime).toMatch(/^COOKIE_SECRET=[0-9a-f]+$/m);
      // The app listens on loopback only: Caddy on this server is its only client.
      expect(runtime).toMatch(/^HOST=127\.0\.0\.1$/m);
      expect(runtime).not.toContain("HOST=0.0.0.0");
      const owner = migrate.match(/^DATABASE_URL=postgresql:\/\/shop_owner:([0-9a-f]{48})@127\.0\.0\.1:5432\/shop$/m);
      expect(owner, migrate).not.toBeNull();
      expect(migrate).toMatch(/^SEED_OWNER_LOGIN=owner$/m);
      expect(migrate).toMatch(/^SEED_OWNER_PASSWORD=[0-9a-f]{16,}$/m);
      const sql = readOr(sb.sqlLog);
      // No superuser password is set in the split layout.
      expect(sql).not.toContain("ALTER ROLE postgres");
      expect(sql).toContain(
        "ALTER ROLE shop_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD",
      );
      expect(sql).toContain("SELECT format('ALTER DATABASE %I OWNER TO %I', 'shop', 'shop_owner') \\gexec");
      expect(sql).toContain("SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', 'shop', 'shop_owner') \\gexec");
      expect(readOr(sb.argvLog)).toContain("createdb -p 5432 -O shop_owner shop");
      // Secrets never in argv or on stdout.
      expect(readOr(sb.argvLog)).not.toContain(owner![1]!);
      expect(res.stdout).not.toContain(owner![1]!);
    } finally {
      sb.cleanup();
    }
  });

  test("re-run keeps the migration role password and the seed password", () => {
    const sb = makeSandbox();
    try {
      const app = nodeApp({ envFile: join(sb.dir, "staging.env") });
      const section = dbSection(sandboxScript(app.envFile!));
      expect(runSection(sb, section).status).toBe(0);
      const first = readFileSync(join(sb.dir, "migrate.env"), "utf8");
      const firstRuntime = readFileSync(join(sb.dir, "staging.env"), "utf8");
      expect(runSection(sb, section).status).toBe(0);
      expect(readFileSync(join(sb.dir, "migrate.env"), "utf8")).toBe(first);
      expect(readFileSync(join(sb.dir, "staging.env"), "utf8")).toBe(firstRuntime);
    } finally {
      sb.cleanup();
    }
  });

  test("legacy app (superuser DATABASE_URL, no migrate env file) keeps its layout", () => {
    const sb = makeSandbox();
    try {
      const envFile = join(sb.dir, "staging.env");
      writeFileSync(
        envFile,
        "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n" +
          "APP_DATABASE_URL=postgresql://legacy_role:s3cret@127.0.0.1:5432/shop\n" +
          "SEED_OWNER_PASSWORD=0011223344556677\n",
      );
      const res = runSection(sb, dbSection(sandboxScript(envFile)));
      expect(res.status).toBe(0);
      const env = readFileSync(envFile, "utf8");
      expect(env).toContain("DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop");
      expect(env).toContain("APP_DATABASE_URL=postgresql://legacy_role:s3cret@127.0.0.1:5432/shop");
      expect(env).toContain("SEED_OWNER_PASSWORD=0011223344556677");
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(false);
      expect(readOr(sb.sqlLog)).not.toContain("shop_owner");
      expect(readOr(sb.argvLog)).not.toContain("-O shop_owner");
    } finally {
      sb.cleanup();
    }
  });
});

describe("deploy — split env layout (executed with stubs)", () => {
  function setup(withMigrateEnv: boolean) {
    const sb = makeDeploySandbox();
    writeFileSync(
      sb.envFile,
      "APP_DATABASE_URL=postgresql://shop_app:apppw@127.0.0.1:5432/shop\nCOOKIE_SECRET=cookie\nNODE_ENV=production\n" +
        (withMigrateEnv ? "" : "DATABASE_URL=postgresql://postgres:superpw@127.0.0.1:5432/shop\n"),
    );
    if (withMigrateEnv) {
      writeFileSync(
        sb.migrateEnvFile,
        "DATABASE_URL=postgresql://shop_owner:ownerpw@127.0.0.1:5432/shop\nSEED_OWNER_LOGIN=owner\nSEED_OWNER_PASSWORD=seedpassword1\n",
      );
    }
    const app = nodeApp({ appDir: sb.appDir, envFile: sb.envFile });
    return { sb, script: buildDeployScript(app, { sha: SHA }) };
  }

  test("npm ci and the build get no database address; migrate gets the migration role and the seed", () => {
    const { sb, script } = setup(true);
    try {
      const res = sb.run(script);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const calls = sb.npmCalls();
      const install = calls.find((c) => c.args.startsWith("ci"))!;
      const build = calls.find((c) => c.args === "run build")!;
      const migrate = calls.find((c) => c.args === "run migrate")!;
      for (const phase of [install, build]) {
        expect(phase.env.DATABASE_URL).toBeUndefined();
        expect(phase.env.APP_DATABASE_URL).toBeUndefined();
        expect(phase.env.SEED_OWNER_PASSWORD).toBeUndefined();
      }
      expect(migrate.env.DATABASE_URL).toBe("postgresql://shop_owner:ownerpw@127.0.0.1:5432/shop");
      expect(migrate.env.APP_DATABASE_URL).toBe("postgresql://shop_app:apppw@127.0.0.1:5432/shop");
      expect(migrate.env.SEED_OWNER_PASSWORD).toBe("seedpassword1");
    } finally {
      sb.cleanup();
    }
  });

  test("assert-rls still checks the app role in the split layout", () => {
    const { sb, script } = setup(true);
    try {
      const res = sb.run(script);
      expect(res.stdout).toContain("<<<SAMOHOST_PHASE:assert-rls:ok>>>");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy app without a migrate env file: phases see the env file as before", () => {
    const { sb, script } = setup(false);
    try {
      const res = sb.run(script);
      expect(res.status).toBe(0);
      const install = sb.npmCalls().find((c) => c.args.startsWith("ci"))!;
      expect(install.env.DATABASE_URL).toBe("postgresql://postgres:superpw@127.0.0.1:5432/shop");
      expect(install.env.APP_DATABASE_URL).toBe("postgresql://shop_app:apppw@127.0.0.1:5432/shop");
    } finally {
      sb.cleanup();
    }
  });
});
