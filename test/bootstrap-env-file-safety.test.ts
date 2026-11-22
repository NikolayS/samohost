/**
 * Bootstrap runs as root and writes files in the app user's directory:
 *   - it refuses an env file or migrate env file that is a symbolic link,
 *     and writes both through a temporary file in a root-owned directory
 *     that is renamed into place (mv -T: the target is never followed);
 *   - a reused superuser password must be hex, as samohost generates it;
 *   - once an app has the split layout, a root-owned marker keeps it there:
 *     deleting migrate.env does not bring back the superuser path.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dbSection, makeSandbox, readOr, runSection, sandboxScript, stateDirOf } from "./bootstrap-db-harness.ts";

function bootstrap(sb: ReturnType<typeof makeSandbox>) {
  const envFile = join(sb.dir, "staging.env");
  return { envFile, run: () => runSection(sb, dbSection(sandboxScript(envFile))) };
}

describe("symbolic links in the app user's directory", () => {
  for (const name of ["staging.env", "migrate.env"]) {
    test(`a symbolic link at ${name} is refused before anything is read or written`, () => {
      const sb = makeSandbox();
      try {
        const victim = join(sb.dir, "victim.txt");
        writeFileSync(victim, "untouched\n");
        symlinkSync(victim, join(sb.dir, name));
        const res = bootstrap(sb).run();
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("is a symbolic link");
        expect(readFileSync(victim, "utf8")).toBe("untouched\n");
        expect(readOr(sb.sqlLog)).toBe("");
      } finally {
        sb.cleanup();
      }
    });
  }

  test("both env files are renamed into place from a root-owned temporary directory", () => {
    const sb = makeSandbox();
    try {
      const { run } = bootstrap(sb);
      const script = sandboxScript(join(sb.dir, "staging.env"));
      const section = dbSection(script);
      expect(section).not.toMatch(/cat > "\$ENV_FILE"|cat > "\$MIGRATE_ENV_FILE"/);
      expect(section).not.toMatch(/(chown|chmod)[^\n]*"\$(MIGRATE_)?ENV_FILE"/);
      expect(section).toContain('mv -fT "$SAMOHOST_WRITE_DIR/env" "$ENV_FILE"');
      expect(section).toContain('mv -fT "$SAMOHOST_WRITE_DIR/migrate" "$MIGRATE_ENV_FILE"');
      const res = run();
      expect(res.status, res.stderr).toBe(0);
      for (const f of ["staging.env", "migrate.env"]) {
        expect(lstatSync(join(sb.dir, f)).isFile()).toBe(true);
        expect((lstatSync(join(sb.dir, f)).mode & 0o777).toString(8)).toBe("600");
      }
      // The temporary directory is removed.
      expect(readdirSync(dirname(sb.dir)).filter((n) => n.startsWith(".samohost-bootstrap."))).toEqual([]);
    } finally {
      sb.cleanup();
    }
  });
});

describe("legacy layout: reused superuser password", () => {
  test("a password that is not hex is refused and nothing is sent to psql", () => {
    const sb = makeSandbox();
    try {
      const { envFile, run } = bootstrap(sb);
      writeFileSync(envFile, "DATABASE_URL=postgresql://postgres:x$pgpw$;DROP@127.0.0.1:5432/shop\n");
      const res = run();
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("not a hex value");
      expect(readOr(sb.sqlLog)).not.toContain("ALTER ROLE postgres");
    } finally {
      sb.cleanup();
    }
  });

  test("a hex password is reused", () => {
    const sb = makeSandbox();
    try {
      const { envFile, run } = bootstrap(sb);
      writeFileSync(envFile, "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n");
      const res = run();
      expect(res.status, res.stderr).toBe(0);
      expect(readOr(sb.sqlLog)).toContain("ALTER ROLE postgres PASSWORD $pgpw$abc123$pgpw$;");
    } finally {
      sb.cleanup();
    }
  });
});

describe("split layout marker", () => {
  test("first split bootstrap writes the marker; deleting migrate.env and planting a superuser address keeps split", () => {
    const sb = makeSandbox();
    try {
      const { envFile, run } = bootstrap(sb);
      expect(run().status).toBe(0);
      const marker = join(stateDirOf(sb), "db-layout", "shop");
      expect(readFileSync(marker, "utf8")).toBe("split\n");
      unlinkSync(join(sb.dir, "migrate.env"));
      writeFileSync(envFile, "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n");
      writeFileSync(sb.sqlLog, "");
      const res = run();
      expect(res.status, res.stderr).toBe(0);
      expect(readOr(sb.sqlLog)).not.toContain("ALTER ROLE postgres");
      expect(existsSync(join(sb.dir, "migrate.env"))).toBe(true);
      expect(readFileSync(envFile, "utf8")).not.toContain("postgresql://postgres:");
    } finally {
      sb.cleanup();
    }
  });

  test("legacy layout writes no marker", () => {
    const sb = makeSandbox();
    try {
      const { envFile, run } = bootstrap(sb);
      writeFileSync(envFile, "DATABASE_URL=postgresql://postgres:abc123@127.0.0.1:5432/shop\n");
      expect(run().status).toBe(0);
      expect(existsSync(join(stateDirOf(sb), "db-layout", "shop"))).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});
