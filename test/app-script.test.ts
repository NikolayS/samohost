import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDeployScript } from "../src/app/script.ts";
import type { AppRecord } from "../src/types.ts";

/** A field-record-1-like app record (the production deploy this generalizes). */
function fieldRecord(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-1111-2222-3333",
    vmId: "vm-aaaa-bbbb-cccc",
    name: "field-record",
    repo: "Tanya301/field-record-1",
    branch: "main",
    appDir: "/opt/field-record/app",
    buildCmd: "npm run build",
    migrateCmd: "node --import tsx/esm src/migration-runner-cli.ts",
    seedCmd: "npm run db:seed",
    healthUrl: "http://localhost:3000/api/version",
    serviceUnit: "field-record",
    envFile: "/opt/field-record/staging.env",
    assertions: { rlsNonSuperuser: true },
    ...overrides,
  };
}

const TARGET = { sha: "abc1234def5678901234567890abcdef12345678" };
const GOLDEN = join(import.meta.dir, "fixtures", "deploy-field-record.sh");

describe("buildDeployScript golden", () => {
  test("matches the golden file (set SAMOHOST_UPDATE_GOLDEN=1 to refresh)", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    if (process.env["SAMOHOST_UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, script);
    }
    expect(script).toBe(readFileSync(GOLDEN, "utf8"));
  });

  test("is deterministic (pure)", () => {
    expect(buildDeployScript(fieldRecord(), TARGET)).toBe(
      buildDeployScript(fieldRecord(), TARGET),
    );
  });
});

describe("buildDeployScript hard-won behaviors", () => {
  test("systemctl is ALWAYS full-path under sudo — no bare `sudo systemctl`", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    // Every systemctl invocation must be `sudo /usr/bin/systemctl`.
    expect(script).toContain("sudo /usr/bin/systemctl restart");
    // Inspect only EXECUTABLE lines (drop comments) — a comment may legitimately
    // mention the bare form when explaining why we avoid it.
    const codeLines = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"));
    for (const line of codeLines) {
      // A bare `sudo systemctl` (no full path) must NOT appear in any command.
      expect(/sudo\s+systemctl\b/.test(line)).toBe(false);
      // Any systemctl token in a command must be the full path.
      if (/systemctl/.test(line)) {
        expect(line).toContain("/usr/bin/systemctl");
      }
    }
  });

  test("never embeds secrets: no env-file values or DATABASE_URL= assignment", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    // The script must never assign a literal secret value.
    expect(script).not.toContain("DATABASE_URL=");
    expect(script).not.toContain("PGPASSWORD=");
    // It may *reference* the env var (read-only) but never write the env file.
    expect(script).not.toContain("staging.env");
    expect(script).not.toContain(">> ");
    expect(script).not.toContain("sed -i");
  });

  test("documents that pushed scripts are immune to the splice bug (no re-exec)", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain("PUSHED-SCRIPT NOTE");
    // The deploy.sh self-overwrite re-exec marker must NOT be present.
    expect(script).not.toContain("DEPLOY_SH_REEXEC");
    expect(script).not.toContain("exec env");
  });

  test("checkpoint records PRE_DEPLOY_SHA and preserves dist.prev", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain("PRE_DEPLOY_SHA=$(git rev-parse HEAD)");
    expect(script).toContain("dist.prev");
  });

  test("rollback resets to PRE_DEPLOY_SHA, restores dist, re-healths", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain('git reset --hard "${PRE_DEPLOY_SHA}"');
    expect(script).toContain("rollback:ok>>>");
    expect(script).toContain("rollback:fail>>>");
  });

  test("emits start/ok/fail markers for the always-present phases", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    for (const phase of [
      "fetch",
      "checkpoint",
      "checkout",
      "install",
      "build",
      "restart",
      "health",
    ]) {
      expect(script).toContain(`<<<SAMOHOST_PHASE:${phase}:start>>>`);
    }
  });

  test("omits optional phases when their commands/assertions are absent", () => {
    const minimal = fieldRecord({
      migrateCmd: undefined,
      seedCmd: undefined,
      assertions: undefined,
    });
    const script = buildDeployScript(minimal, TARGET);
    expect(script).not.toContain("SAMOHOST_PHASE:migrate");
    expect(script).not.toContain("SAMOHOST_PHASE:seed");
    expect(script).not.toContain("SAMOHOST_PHASE:assert-rls");
  });

  test("assert-rls phase appears only when rlsNonSuperuser is set", () => {
    const withRls = buildDeployScript(fieldRecord(), TARGET);
    expect(withRls).toContain("SAMOHOST_PHASE:assert-rls:start");
    expect(withRls).toContain("rolsuper");
    const without = buildDeployScript(
      fieldRecord({ assertions: { rlsNonSuperuser: false } }),
      TARGET,
    );
    expect(without).not.toContain("SAMOHOST_PHASE:assert-rls");
  });

  test("embeds the exact target sha and app dir", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain(TARGET.sha);
    expect(script).toContain("/opt/field-record/app");
  });
});
