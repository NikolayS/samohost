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

  test("never embeds secrets and never WRITES the env file", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    // The script must never assign a literal secret value.
    expect(script).not.toContain("DATABASE_URL=");
    expect(script).not.toContain("PGPASSWORD=");
    // Issue #2 (bug 1): the env file IS now sourced (read-only) so migrate/
    // seed/probes get the app environment — but it must never be WRITTEN:
    // no append-redirect, no in-place edit, no DEPLOYED_SHA bookkeeping in it.
    expect(script).not.toContain(">> ");
    expect(script).not.toContain("sed -i");
    expect(script).not.toContain("DEPLOYED_SHA");
    expect(script).not.toContain("DEPLOY_FAILED_SHA");
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

  // Issue #2 bug 3 (coupled to bug 1): once the env file is sourced,
  // NODE_ENV=production reaches the deploy shell and a plain `npm ci` drops
  // devDependencies — the build toolchain (tsc, tsx) lives there, so build
  // died with "sh: 1: tsc: not found" at runtime. The install phase must
  // explicitly include dev deps (field-record's own deploy.sh uses
  // `npm ci --prefer-offline --include=dev --quiet` deliberately).
  test("install uses `npm ci --include=dev` so NODE_ENV=production cannot drop the build toolchain", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain("if npm ci --include=dev; then");
    expect(script).not.toContain("if npm ci; then");
  });

  // Issue #2 bug 1: the registered --env-file was stored but never sourced, so
  // migrate/seed/RLS ran with no app env. On the real VM, migrate died with
  // "DATABASE_URL environment variable is required". The env file must be
  // sourced (read-only) BEFORE install so NODE_ENV etc. apply consistently to
  // install/build/migrate/seed/probes.
  test("sources the registered envFile (read-only, exported) before install", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    const sourceLine = `set -a; . '/opt/field-record/staging.env'; set +a`;
    expect(script).toContain(sourceLine);
    const sourceIdx = script.indexOf(sourceLine);
    const installIdx = script.indexOf("<<<SAMOHOST_PHASE:install:start>>>");
    expect(installIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeGreaterThan(-1);
    expect(sourceIdx).toBeLessThan(installIdx);
  });

  test("omits env-file sourcing when no envFile is registered", () => {
    const script = buildDeployScript(fieldRecord({ envFile: undefined }), TARGET);
    expect(script).not.toContain("set -a");
    expect(script).not.toContain("set +a");
  });

  test("quotes the envFile path safely (spaces, single quotes)", () => {
    const script = buildDeployScript(
      fieldRecord({ envFile: "/opt/my app/it's.env" }),
      TARGET,
    );
    expect(script).toContain(`set -a; . '/opt/my app/it'\\''s.env'; set +a`);
  });

  // Issue #2 bug 2: the probe's env-var name was hardcoded to
  // RLS_DATABASE_URL || DATABASE_URL. field-record's NON-superuser URL is
  // APP_DATABASE_URL, and DATABASE_URL is the SUPERUSER URL — so the probe
  // connected as superuser, saw rolsuper=t, and rolled back a HEALTHY deploy
  // (runtime-confirmed, issue #2 attempt 3). The var name must be
  // configurable per app.
  test("assert-rls probe uses the configured rlsUrlVar, not the hardcoded chain", () => {
    const app = { ...fieldRecord(), rlsUrlVar: "APP_DATABASE_URL" };
    const script = buildDeployScript(app, TARGET);
    expect(script).toContain('RLS_URL="${APP_DATABASE_URL:-}"');
    // No silent fallback to a possibly-superuser DATABASE_URL: that fallback
    // IS bug 2. If the configured var is unset, the probe must fail loudly.
    expect(script).not.toContain("${RLS_DATABASE_URL:-${DATABASE_URL:-}}");
    // The error message must name the actual var consulted.
    expect(script).toContain(
      "assert-rls: APP_DATABASE_URL (configured via --rls-url-var) is not set",
    );
  });

  test("assert-rls default (no rlsUrlVar) preserves the back-compat fallback chain", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain('RLS_URL="${RLS_DATABASE_URL:-${DATABASE_URL:-}}"');
    // The error message names the actual vars consulted.
    expect(script).toContain("neither RLS_DATABASE_URL nor DATABASE_URL is set");
  });

  test("embeds the exact target sha and app dir", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain(TARGET.sha);
    expect(script).toContain("/opt/field-record/app");
  });

  // Issue #78: lockfile-less apps (no-DB fixtures, minimal greenfield) hard-fail
  // npm ci with "can only install with an existing package-lock.json", which aborts
  // the whole deploy BEFORE the .env / systemd unit / Caddy vhost are written,
  // leaving no :443 listener → CF 521. The install phase must detect whether a
  // lockfile is present and fall back to npm install when it is not.
  //
  // --include=dev must be preserved in BOTH branches (issue #2 bug 3 invariant).
  test("install phase is lockfile-aware: falls back to npm install --include=dev when no lockfile exists", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    // The rendered script must gate on the presence of a lockfile.
    expect(script).toContain("[ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]");
    // Fallback branch for lockfile-less apps.
    expect(script).toContain("npm install --include=dev");
    // npm ci branch preserved for the lockfile-present case.
    expect(script).toContain("npm ci --include=dev");
    // Bare unguarded npm ci (fails on lockfile-less apps) must be gone.
    expect(script).not.toContain("if npm ci --include=dev; then");
  });
});
