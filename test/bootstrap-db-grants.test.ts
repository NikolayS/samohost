/**
 * Bootstrap, database rights of a node app:
 *   - split layout: the migration role owns schema public; the app role gets
 *     data rights on tables and sequences the migration role creates
 *     (default privileges) and on those that exist;
 *   - a role in APP_DATABASE_URL that samohost did not create keeps CONNECT;
 *   - psql sessions inside the app database pin search_path to pg_catalog;
 *   - statements that carry a password are not written to the server log;
 *   - the app role name is checked.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHostBootstrapScript } from "../src/app/bootstrap.ts";
import { dbSection, makeSandbox, nodeApp, nodeOpts, readOr, runSection } from "./bootstrap-db-harness.ts";

const NO_LOG = [
  "SET log_statement TO 'none';",
  "SET log_min_duration_statement TO -1;",
  "SET log_min_error_statement TO 'panic';",
];

/** The SQL fed to each psql call, in order. */
function psqlCalls(sqlLog: string): string[] {
  return sqlLog.split("\n-- end of psql call\n").filter((c) => c.trim() !== "");
}

function runFresh(envBody?: string) {
  const sb = makeSandbox();
  const envFile = join(sb.dir, "staging.env");
  if (envBody !== undefined) writeFileSync(envFile, envBody);
  const res = runSection(sb, dbSection(buildHostBootstrapScript(nodeApp({ envFile }), nodeOpts())));
  return { sb, res, envFile };
}

describe("split layout: schema owner and data rights of the app role", () => {
  test("one psql call inside the app database sets owner, default privileges and existing grants", () => {
    const { sb, res } = runFresh();
    try {
      expect(res.status, res.stderr).toBe(0);
      const calls = psqlCalls(readOr(sb.sqlLog));
      const grants = calls.find((c) => c.includes("ALTER DEFAULT PRIVILEGES"));
      expect(grants, readOr(sb.sqlLog)).toBeDefined();
      const where = "FROM pg_catalog.pg_roles WHERE rolname = 'shop_app' \\gexec";
      expect(grants!.trim().split("\n")).toEqual([
        "SELECT format('ALTER SCHEMA public OWNER TO %I', 'shop_owner') \\gexec",
        `SELECT format('GRANT USAGE ON SCHEMA public TO %I', rolname) ${where}`,
        `SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', 'shop_owner', rolname) ${where}`,
        `SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', 'shop_owner', rolname) ${where}`,
        `SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', rolname) ${where}`,
        `SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', rolname) ${where}`,
      ]);
      const argv = readOr(sb.argvLog).split("\n");
      expect(argv).toContain("-u postgres env PGOPTIONS=-c search_path=pg_catalog psql -p 5432 -d shop -q -v ON_ERROR_STOP=1");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy layout: no schema owner change and no default privileges", () => {
    const { sb, res } = runFresh(
      "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\nAPP_DATABASE_URL=postgresql://shop_app:0a0b@127.0.0.1:5432/shop\n",
    );
    try {
      expect(res.status, res.stderr).toBe(0);
      expect(readOr(sb.sqlLog)).not.toContain("ALTER SCHEMA public OWNER");
      expect(readOr(sb.sqlLog)).not.toContain("ALTER DEFAULT PRIVILEGES");
    } finally {
      sb.cleanup();
    }
  });
});

describe("a role in APP_DATABASE_URL set up by hand", () => {
  test("is left unchanged but gets CONNECT on the database (split layout)", () => {
    const { sb, res, envFile } = runFresh("APP_DATABASE_URL=postgresql://legacy_role:s3cret@127.0.0.1:5432/shop\n");
    try {
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(envFile, "utf8")).toContain("APP_DATABASE_URL=postgresql://legacy_role:s3cret@127.0.0.1:5432/shop");
      const sql = readOr(sb.sqlLog);
      expect(sql).not.toContain("ALTER ROLE legacy_role");
      expect(sql).toContain(
        "SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', 'shop', rolname) FROM pg_catalog.pg_roles WHERE rolname = 'legacy_role' \\gexec",
      );
      expect(sql).toContain("GRANT USAGE ON SCHEMA public TO %I', rolname) FROM pg_catalog.pg_roles WHERE rolname = 'legacy_role'");
    } finally {
      sb.cleanup();
    }
  });

  test("a role name that is not a plain lowercase name gets no grant", () => {
    const { sb, res } = runFresh("APP_DATABASE_URL=postgresql://Bad%27Role:s3cret@127.0.0.1:5432/shop\n");
    try {
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("gets no grants");
      expect(readOr(sb.sqlLog)).not.toContain("Bad");
    } finally {
      sb.cleanup();
    }
  });
});

describe("psql as postgres inside the app database", () => {
  test("every call with -d pins search_path; the owner count query uses qualified names", () => {
    const { sb, res } = runFresh();
    try {
      expect(res.status, res.stderr).toBe(0);
      const inDb = readOr(sb.argvLog).split("\n").filter((l) => / -d shop\b/.test(l));
      expect(inDb.length).toBeGreaterThanOrEqual(2);
      for (const l of inDb) expect(l).toContain("env PGOPTIONS=-c search_path=pg_catalog psql");
      const count = inDb.find((l) => l.includes("count("))!;
      expect(count).toContain("pg_catalog.count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n");
      expect(count).toContain("SELECT oid FROM pg_catalog.pg_roles");
      expect(count).not.toMatch(/[^.]pg_class|[^.]pg_namespace|[^.]pg_roles/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("password statements are not logged by the server", () => {
  for (const [name, envBody] of [
    ["split", undefined],
    ["legacy", "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n"],
  ] as const) {
    test(`${name} layout: each psql input with a PASSWORD starts with the no-log settings`, () => {
      const { sb, res } = runFresh(envBody);
      try {
        expect(res.status, res.stderr).toBe(0);
        const withPw = psqlCalls(readOr(sb.sqlLog)).filter((c) => c.includes("PASSWORD"));
        expect(withPw.length).toBeGreaterThanOrEqual(name === "split" ? 2 : 2);
        for (const c of withPw) expect(c.split("\n").slice(0, 3)).toEqual(NO_LOG);
      } finally {
        sb.cleanup();
      }
    });
  }
});

describe("app role name", () => {
  for (const bad of ["postgres", "pg_shop", "shop_owner", "other_app", "shopapp"]) {
    test(`refuses ${bad}`, () => {
      expect(() => buildHostBootstrapScript(nodeApp(), nodeOpts({ appDbRole: bad }))).toThrow(/invalid appDbRole/);
    });
  }
  test("accepts <dbName>_<suffix>", () => {
    expect(() => buildHostBootstrapScript(nodeApp(), nodeOpts({ appDbRole: "shop_web" }))).not.toThrow();
  });
});
