import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDeployScript } from "../src/app/script.ts";
import { staticReleaseStatePaths } from "../src/app/static-root.ts";
import { buildCustomDomainVhostScript } from "../src/env/script.ts";
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
  // explicitly include dev deps in BOTH branches of the lockfile check
  // (field-record's own deploy.sh uses `npm ci --prefer-offline --include=dev
  // --quiet` deliberately). Updated per issue #78: bare npm ci → lockfile-aware.
  test("install includes --include=dev in both lockfile and fallback branches so NODE_ENV=production cannot drop the build toolchain", () => {
    const script = buildDeployScript(fieldRecord(), TARGET);
    // --include=dev in the npm ci branch (lockfile present).
    expect(script).toContain("npm ci --include=dev");
    // --include=dev in the npm install fallback branch (lockfile absent).
    expect(script).toContain("npm install --include=dev");
    // Bare unguarded npm ci (no lockfile awareness, fails on greenfield apps) must be gone.
    expect(script).not.toContain("if npm ci --include=dev; then");
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

// ============================================================================
// Phase B: buildDeployScript — static site path (kind='static')
//
// All tests in this describe block are RED until the static branch is added
// to src/app/script.ts. The backward-compat guard at the end must stay GREEN.
// ============================================================================

function staticApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "app-static-0001",
    vmId: "vm-aaaa-bbbb-cccc",
    name: "my-static-site",
    kind: "static",
    repo: "Tanya301/my-static-site",
    branch: "main",
    appDir: "/opt/my-static-site/app",
    buildCmd: "npm run build",
    healthUrl: "https://my-static-site.example.com/",
    serviceUnit: "my-static-site",
    mainHost: "my-static-site.example.com",
    ...overrides,
  };
}

const STATIC_TARGET = { sha: "abc1234def5678901234567890abcdef12345678" };

describe("buildDeployScript — static path (kind='static')", () => {
  test("release static deploy requires a dated tag and owned main host", () => {
    const releaseApp = staticApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    });
    expect(() => buildDeployScript(releaseApp, STATIC_TARGET)).toThrow(
      "requires the resolved release tag",
    );
    expect(() => buildDeployScript(
      staticApp({ mainHost: undefined }),
      STATIC_TARGET,
    )).toThrow("requires mainHost");
  });

  test("release static activation stages a versioned checkout and atomically routes to it", () => {
    const script = buildDeployScript(staticApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    }), { ...STATIC_TARGET, tag: "v20260713.1" });
    expect(script).toContain(
      '{"version":"%s","tag":"%s","sha":"%s","environment":"production"}',
    );
    expect(script).toContain(".version.next.");
    expect(script).toContain('/usr/bin/mv -f "$SAMOHOST_VERSION_NEXT"');
    expect(script).toContain(".samohost-next-00-main-my-static-site.caddy");
    expect(script).toContain('SAMOHOST_RELEASES_DIR=\'/opt/my-static-site/releases\'');
    expect(script).toContain('git -C "$SAMOHOST_APP_DIR" worktree add --detach');
    expect(script).toContain("umask 022");
    expect(script).toContain('root * "${SAMOHOST_STATIC_DIR}"');
    expect(script).not.toContain('git reset --hard "${SAMOHOST_SHA}"');
    expect(script).toContain(
      "sudo /usr/bin/mv -- '/etc/caddy/sites.d/.samohost-next-00-main-my-static-site.caddy' '/etc/caddy/sites.d/00-main-my-static-site.caddy'",
    );
    expect(script).toContain(
      "SAMOHOST_ACTIVE_STATE='/opt/my-static-site/releases/.samohost-active-static.json'",
    );
    expect(script).toContain(
      "SAMOHOST_ACTIVE_ROUTE='/opt/my-static-site/releases/.samohost-active-static.caddy'",
    );
    const activeRoute = script.indexOf(
      '/usr/bin/mv -f "$SAMOHOST_ACTIVE_ROUTE_NEXT" "$SAMOHOST_ACTIVE_ROUTE"',
    );
    const reload = script.indexOf("sudo /usr/bin/systemctl reload caddy", activeRoute);
    const activeState = script.indexOf(
      '/usr/bin/mv -f "$SAMOHOST_ACTIVE_STATE_NEXT" "$SAMOHOST_ACTIVE_STATE"',
      reload,
    );
    const healthOk = script.indexOf("<<<SAMOHOST_PHASE:health:ok>>>", activeState);
    expect(activeRoute).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(activeRoute);
    expect(activeState).toBeGreaterThan(reload);
    expect(healthOk).toBeGreaterThan(activeState);
  });

  test("release static health uses intended Host identity and rollback restores untouched prior route", () => {
    const script = buildDeployScript(staticApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    }), { ...STATIC_TARGET, tag: "v20260713.1" });
    expect(script).toContain("-H 'Host: my-static-site.example.com'");
    expect(script).toContain("/version.json");
    expect(script).toContain('"environment":"production"');
    const checkpoint = script.indexOf("SAMOHOST_VHOST_BACKUP");
    const checkout = script.indexOf("<<<SAMOHOST_PHASE:checkout:start>>>");
    expect(checkpoint).toBeGreaterThan(-1);
    expect(checkpoint).toBeLessThan(checkout);
    const rollbackStart = script.indexOf("rollback() {");
    const rollbackEnd = script.indexOf("\n}", rollbackStart);
    const rollback = script.slice(rollbackStart, rollbackEnd);
    expect(rollback).not.toContain("git reset --hard");
    expect(rollback).not.toContain("SAMOHOST_VERSION_BACKUP");
    expect(rollback).toContain("SAMOHOST_VHOST_BACKUP");
    expect(rollback).toContain('worktree remove --force "$SAMOHOST_CANDIDATE_DIR"');
    expect(rollback).toContain("caddy validate");
    expect(rollback).toContain("reload caddy");
  });

  test("static deploy script is valid bash", () => {
    // The generated script must be syntactically valid bash (bash -n).
    // This passes today (the output is syntactically valid even though semantically wrong).
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(res.status).toBe(0);
  });

  test("static deploy does NOT emit npm ci, npm install, or npm run build", () => {
    // FAILS today: buildDeployScript unconditionally emits install+build phases.
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    expect(script).not.toContain("npm ci");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("npm run build");
  });

  test("static deploy does NOT emit systemctl restart (no unit to restart for a static site)", () => {
    // FAILS today: buildDeployScript line 285 always emits systemctl restart.
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    const codeLines = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const l of codeLines) {
      expect(l).not.toMatch(/systemctl\s+restart/);
    }
  });

  test("static deploy emits caddy reload as the reload step (NOT systemctl restart)", () => {
    // FAILS today: no caddy-reload step exists in buildDeployScript.
    // The exact form should be `sudo /usr/bin/systemctl reload caddy`
    // (full-path sudo, consistent with header note 3 in app/script.ts).
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    expect(script).toContain("reload caddy");
    // The caddy-reload phase marker must be present.
    expect(script).toContain("<<<SAMOHOST_PHASE:caddy-reload:start>>>");
  });

  test("static rollback switches the vhost back and removes only the failed candidate", () => {
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    const rollbackStart = script.indexOf("rollback() {");
    const rollbackEnd = script.indexOf("\n}", rollbackStart);
    const rollbackBody = script.slice(rollbackStart, rollbackEnd);
    expect(rollbackBody).not.toContain("git reset --hard");
    expect(rollbackBody).toContain("SAMOHOST_VHOST_BACKUP");
    expect(rollbackBody).toContain('worktree remove --force "$SAMOHOST_CANDIDATE_DIR"');
    expect(rollbackBody).toContain("reload caddy");
    expect(rollbackBody).not.toMatch(/systemctl\s+restart/);
  });

  test("public version identity is atomically published as readable mode 0644", () => {
    const script = buildDeployScript(staticApp({
      releaseTagPattern: "v*",
      releaseTagFormat: "date",
      releaseCiWorkflow: ".github/workflows/ci.yml",
    }), { ...STATIC_TARGET, tag: "v20260713.1" });
    const chmod = script.indexOf('chmod 0644 "$SAMOHOST_VERSION_NEXT"');
    const rename = script.indexOf(
      '/usr/bin/mv -f "$SAMOHOST_VERSION_NEXT" "${SAMOHOST_STATIC_DIR}/version.json"',
    );
    const route = script.indexOf(
      "sudo /usr/bin/mv -- '/etc/caddy/sites.d/.samohost-next-00-main-my-static-site.caddy'",
      rename,
    );
    expect(chmod).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(chmod);
    expect(route).toBeGreaterThan(rename);
    expect(script).toContain('[[ -r "${SAMOHOST_STATIC_DIR}/version.json" ]]');
    expect(script).toContain(
      '[[ "$(stat -c \'%a\' "${SAMOHOST_STATIC_DIR}/version.json")" == "644" ]]',
    );
  });

  test("executed repeated releases keep the live checkout untouched and retire only after healthy cutover", () => {
    const dir = mkdtempSync(join(tmpdir(), "samohost-static-release-"));
    const origin = join(dir, "origin.git");
    const seed = join(dir, "seed");
    const appDir = join(dir, "site", "app");
    const caddyDir = join(dir, "caddy");
    const binDir = join(dir, "bin");

    const git = (args: string[], cwd = dir): string => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };

    try {
      mkdirSync(seed, { recursive: true });
      git(["init", "--bare", origin]);
      git(["init", "--initial-branch=main"], seed);
      git(["config", "user.name", "Samohost Test"], seed);
      git(["config", "user.email", "samohost@example.invalid"], seed);

      mkdirSync(join(seed, "dist"));
      writeFileSync(join(seed, "dist", "index.html"), "old\n");
      git(["add", "dist/index.html"], seed);
      git(["commit", "-m", "old"], seed);
      const oldSha = git(["rev-parse", "HEAD"], seed);

      writeFileSync(join(seed, "dist", "index.html"), "release one\n");
      git(["commit", "-am", "release one"], seed);
      const firstSha = git(["rev-parse", "HEAD"], seed);

      writeFileSync(join(seed, "dist", "index.html"), "release two\n");
      git(["commit", "-am", "release two"], seed);
      const secondSha = git(["rev-parse", "HEAD"], seed);

      symlinkSync("index.html", join(seed, "dist", "alias.html"));
      git(["add", "dist/alias.html"], seed);
      git(["commit", "-m", "unsafe nested symlink"], seed);
      const badSymlinkSha = git(["rev-parse", "HEAD"], seed);
      git(["remote", "add", "origin", origin], seed);
      git(["push", "-u", "origin", "main"], seed);

      mkdirSync(join(dir, "site"), { recursive: true });
      git(["clone", origin, appDir]);
      git(["checkout", "--detach", oldSha], appDir);
      const originalHead = git(["rev-parse", "HEAD"], appDir);
      const originalContent = readFileSync(join(appDir, "dist", "index.html"), "utf8");

      mkdirSync(join(caddyDir, "sites.d"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const legacyBase = [
        ":80 {",
        `\troot * "${appDir}"`,
        "\ttry_files {path} /index.html",
        "\tfile_server",
        "}",
        "",
        "import sites.d/*.caddy",
        "",
      ].join("\n");
      const baseFile = join(caddyDir, "Caddyfile");
      writeFileSync(baseFile, legacyBase);
      const siteFile = join(caddyDir, "sites.d", "00-main-my-static-site.caddy");

      writeFileSync(join(binDir, "sudo"), [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "/usr/bin/systemctl" ]]; then exit 0; fi',
        'exec "$@"',
        "",
      ].join("\n"));
      writeFileSync(join(binDir, "caddy"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
      writeFileSync(join(binDir, "curl"), [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"version.json"* ]]; then',
        '  root=$(sed -n \'s/^[[:space:]]*root \\* "\\(.*\\)"$/\\1/p\' "$CADDY_SITE" | head -n 1)',
        '  if [[ "${FAIL_VERSION_HEALTH:-0}" == "1" ]]; then printf \'invalid\\n\'; else cat "$root/version.json"; fi',
        "else",
        "  printf '200'",
        "fi",
        "",
      ].join("\n"));
      for (const command of ["sudo", "caddy", "sleep", "curl"]) {
        chmodSync(join(binDir, command), 0o755);
      }

      const releaseApp = staticApp({
        appDir,
        staticRoot: "dist",
        mainListen: "cp-http80",
        releaseTagPattern: "v*",
        releaseTagFormat: "date",
        releaseCiWorkflow: ".github/workflows/ci.yml",
      });
      const activePaths = staticReleaseStatePaths(appDir);
      const domainFile = join(caddyDir, "sites.d", "10-domain-client-example.caddy");
      let lastExecutionStderr = "";
      const execute = (sha: string, tag: string, expectFailure = false): string => {
        const script = buildDeployScript(releaseApp, { sha, tag })
          .replaceAll("/etc/caddy", caddyDir);
        const result = spawnSync("bash", ["-s"], {
          input: script,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
            CADDY_SITE: siteFile,
            FAIL_VERSION_HEALTH: expectFailure ? "1" : "0",
          },
        });
        lastExecutionStderr = result.stderr;
        if ((!expectFailure && result.status !== 0) || (expectFailure && result.status !== 1)) {
          throw new Error(
            `unexpected static deploy exit (${result.status}):\n${result.stdout}\n${result.stderr}`,
          );
        }
        return script;
      };
      const executeDomain = (expectFailure = false): string => {
        const script = buildCustomDomainVhostScript(releaseApp, "client.example")
          .replaceAll("/etc/caddy", caddyDir);
        const result = spawnSync("bash", ["-s"], {
          input: script,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          },
        });
        lastExecutionStderr = result.stderr;
        if ((!expectFailure && result.status !== 0) || (expectFailure && result.status !== 1)) {
          throw new Error(
            `unexpected custom-domain exit (${result.status}):\n${result.stdout}\n${result.stderr}`,
          );
        }
        return script;
      };
      const routedRoot = (): string => {
        const match = readFileSync(siteFile, "utf8").match(/root \* "([^"]+)"/);
        if (!match?.[1]) throw new Error("routed root missing from test vhost");
        return match[1];
      };
      const activeRoot = (): string => {
        const match = readFileSync(activePaths.activeRoute, "utf8").match(/root \* "([^"]+)"/);
        if (!match?.[1]) throw new Error("active static root missing from managed route");
        return match[1];
      };

      // Before any health-proven release, a release-channel domain cannot fall
      // back to the stale bootstrap checkout.
      executeDomain(true);
      expect(lastExecutionStderr).toContain("no authorized healthy static release is active");
      expect(existsSync(domainFile)).toBe(false);

      // A failed first activation must restore the GC-style base-file route
      // byte-for-byte and remove all unproven public and shared routing state.
      execute(firstSha, "v20260713.1", true);
      expect(readFileSync(baseFile, "utf8")).toBe(legacyBase);
      expect(existsSync(siteFile)).toBe(false);
      expect(existsSync(activePaths.activeState)).toBe(false);
      expect(existsSync(activePaths.activeRoute)).toBe(false);
      executeDomain(true);
      expect(existsSync(domainFile)).toBe(false);

      const firstScript = execute(firstSha, "v20260713.2");
      const firstRoot = routedRoot();
      expect(firstRoot).not.toBe(appDir);
      const migratedBase = readFileSync(baseFile, "utf8");
      expect(migratedBase).not.toContain(`root * "${appDir}"`);
      expect(migratedBase.match(/^\s*import\s+sites\.d\/\*\.caddy\s*$/gm)).toHaveLength(1);
      expect(spawnSync("caddy", ["validate", "--config", baseFile]).status).toBe(0);
      expect(readFileSync(join(firstRoot, "index.html"), "utf8")).toBe("release one\n");
      expect(JSON.parse(readFileSync(join(firstRoot, "version.json"), "utf8"))).toEqual({
        version: "v20260713.2",
        tag: "v20260713.2",
        sha: firstSha,
        environment: "production",
      });
      expect(statSync(join(firstRoot, "version.json")).mode & 0o777).toBe(0o644);
      expect(activeRoot()).toBe(firstRoot);
      expect(JSON.parse(readFileSync(activePaths.activeState, "utf8"))).toEqual({
        schema: 1,
        appName: releaseApp.name,
        sha: firstSha,
        tag: "v20260713.2",
        releaseDir: firstRoot.slice(0, -"/dist".length),
        staticRoot: "dist",
      });
      expect(firstScript.indexOf("SAMOHOST_PHASE:health:ok")).toBeLessThan(
        firstScript.indexOf('worktree remove --force "$SAMOHOST_PREVIOUS_RELEASE_DIR"'),
      );

      const domainScript = executeDomain();
      const firstDomain = readFileSync(domainFile, "utf8");
      expect(firstDomain).toContain(`import "${activePaths.activeRoute}"`);
      expect(firstDomain).not.toContain(appDir);
      expect(domainScript).not.toContain(`${appDir}/dist`);
      expect(activeRoot()).toBe(firstRoot);
      expect(spawnSync("caddy", ["validate", "--config", baseFile]).status).toBe(0);

      execute(secondSha, "v20260713.3");
      const secondRoot = routedRoot();
      expect(secondRoot).not.toBe(firstRoot);
      expect(readFileSync(join(secondRoot, "index.html"), "utf8")).toBe("release two\n");
      expect(statSync(join(secondRoot, "version.json")).mode & 0o777).toBe(0o644);
      expect(existsSync(firstRoot)).toBe(false);
      expect(activeRoot()).toBe(secondRoot);
      expect(readFileSync(domainFile, "utf8")).toBe(firstDomain);
      expect(JSON.parse(readFileSync(activePaths.activeState, "utf8"))).toMatchObject({
        sha: secondSha,
        tag: "v20260713.3",
        releaseDir: secondRoot.slice(0, -"/dist".length),
      });
      expect(spawnSync("caddy", ["validate", "--config", baseFile]).status).toBe(0);

      const secondIdentity = readFileSync(join(secondRoot, "version.json"), "utf8");
      const secondState = readFileSync(activePaths.activeState, "utf8");
      const secondRoute = readFileSync(activePaths.activeRoute, "utf8");
      execute(firstSha, "v20260713.4", true);
      expect(routedRoot()).toBe(secondRoot);
      expect(activeRoot()).toBe(secondRoot);
      expect(readFileSync(activePaths.activeState, "utf8")).toBe(secondState);
      expect(readFileSync(activePaths.activeRoute, "utf8")).toBe(secondRoute);
      expect(readFileSync(domainFile, "utf8")).toBe(firstDomain);
      expect(readFileSync(join(secondRoot, "index.html"), "utf8")).toBe("release two\n");
      expect(readFileSync(join(secondRoot, "version.json"), "utf8")).toBe(secondIdentity);
      expect(git(["worktree", "list", "--porcelain"], appDir)).not.toContain(
        `${firstSha}.candidate`,
      );

      execute(badSymlinkSha, "v20260713.5", true);
      expect(lastExecutionStderr).toContain("staticRoot tree contains a symlink");
      expect(routedRoot()).toBe(secondRoot);
      expect(activeRoot()).toBe(secondRoot);
      expect(readFileSync(activePaths.activeState, "utf8")).toBe(secondState);
      expect(readFileSync(activePaths.activeRoute, "utf8")).toBe(secondRoute);
      expect(readFileSync(domainFile, "utf8")).toBe(firstDomain);
      expect(readFileSync(join(secondRoot, "index.html"), "utf8")).toBe("release two\n");
      expect(readFileSync(join(secondRoot, "version.json"), "utf8")).toBe(secondIdentity);
      expect(git(["worktree", "list", "--porcelain"], appDir)).not.toContain(
        `${badSymlinkSha}.candidate`,
      );

      // Every attempt fetched and staged elsewhere; the original checkout was
      // never reset or rewritten before any candidate health check.
      expect(git(["rev-parse", "HEAD"], appDir)).toBe(originalHead);
      expect(readFileSync(join(appDir, "dist", "index.html"), "utf8")).toBe(originalContent);
      expect(readdirSync(join(caddyDir, "sites.d")).sort()).toEqual([
        "00-main-my-static-site.caddy",
        "10-domain-client-example.caddy",
      ]);
      expect(readdirSync(activePaths.releasesDir).some((entry) =>
        /^\.active-(?:route|state)\.(?:next|restore)\./.test(entry)
      )).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("static deploy does NOT emit install/build/migrate/assert-rls/seed phase markers", () => {
    // FAILS today: install, build markers are emitted unconditionally.
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    expect(script).not.toContain("<<<SAMOHOST_PHASE:install:");
    expect(script).not.toContain("<<<SAMOHOST_PHASE:build:");
    expect(script).not.toContain("<<<SAMOHOST_PHASE:migrate:");
    expect(script).not.toContain("<<<SAMOHOST_PHASE:assert-rls:");
    expect(script).not.toContain("<<<SAMOHOST_PHASE:seed:");
  });

  test("static deploy DOES emit fetch, checkpoint, checkout, caddy-reload, health phase markers", () => {
    // FAILS today: caddy-reload phase does not exist.
    // fetch/checkpoint/checkout/health are already emitted but caddy-reload is missing.
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    expect(script).toContain("<<<SAMOHOST_PHASE:fetch:start>>>");
    expect(script).toContain("<<<SAMOHOST_PHASE:checkpoint:start>>>");
    expect(script).toContain("<<<SAMOHOST_PHASE:checkout:start>>>");
    expect(script).toContain("<<<SAMOHOST_PHASE:caddy-reload:start>>>");
    expect(script).toContain("<<<SAMOHOST_PHASE:health:start>>>");
  });

  test("static deploy health probe passes -k to tolerate tls internal self-signed cert", () => {
    // FAILS today: health curl in buildDeployScript does not pass -k.
    const script = buildDeployScript(staticApp(), STATIC_TARGET);
    const healthStart = script.indexOf("<<<SAMOHOST_PHASE:health:start>>>");
    const healthOk = script.indexOf("<<<SAMOHOST_PHASE:health:ok>>>");
    expect(healthStart).toBeGreaterThan(-1);
    const healthSection = script.slice(healthStart, Math.max(healthOk + 50, healthStart + 200));
    expect(healthSection).toContain("-k");
  });

  test("node path unchanged: still emits install, restart, rollback with systemctl restart", () => {
    // Backward-compat guard. PASSES today; must continue to pass after the static
    // branch is added.
    const script = buildDeployScript(fieldRecord(), TARGET);
    expect(script).toContain("<<<SAMOHOST_PHASE:install:start>>>");
    expect(script).toContain("<<<SAMOHOST_PHASE:restart:start>>>");
    expect(script).toContain("sudo /usr/bin/systemctl restart");
    expect(script).not.toContain("reload caddy");
    expect(script).not.toContain("caddy-reload");
  });
});

// ============================================================================
// Issue #122: deploy-script cwd leak between phases.
//
// The generated script runs build + migrate (+ restart/health) in ONE bash
// session. A buildCmd that ends inside a subdirectory (e.g. "cd apps/web &&
// ... bun run build" — a completely normal monorepo build) leaves the shell
// cwd inside apps/web, so a RELATIVE migrateCmd like
// "bun packages/shared/db/migrate.ts" resolves against apps/web and dies with
// "Module not found". This forced samograph's prod cutover to be done by hand.
//
// Contract pinned here: EVERY phase that runs an app-supplied command (build,
// migrate, seed) executes from SAMOHOST_APP_DIR regardless of where the
// previous phase's command cd'd to.
//
// NO MOCKING: the test slices the actual build+migrate phases out of the
// generated script and executes them in a real bash against a real temp
// directory tree, exactly as `ssh ... bash -s` would.
// ============================================================================
describe("issue #122: per-phase cwd — build's cd must not leak into migrate", () => {
  /** Slice the generated script between two phase-comment anchors. */
  function slicePhases(script: string, from: string, to: string): string {
    const start = script.indexOf(from);
    const end = script.indexOf(to);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return script.slice(start, end);
  }

  test("relative migrateCmd resolves from the app dir even when buildCmd cd's into a subdir (real bash execution)", () => {
    // Real app-dir layout: a monorepo with apps/web (build cd's here) and a
    // migration entrypoint addressed RELATIVE to the app root.
    const appDir = mkdtempSync(join(tmpdir(), "samohost-122-"));
    mkdirSync(join(appDir, "apps", "web"), { recursive: true });
    mkdirSync(join(appDir, "packages", "shared", "db"), { recursive: true });
    writeFileSync(
      join(appDir, "packages", "shared", "db", "migrate.sh"),
      'echo "MIGRATIONS_APPLIED"\n',
    );

    const app = fieldRecord({
      appDir,
      // samograph-shaped commands: build ends inside apps/web; migrate is
      // relative to the app root (prod shape that broke the cutover).
      buildCmd: "cd apps/web && echo built",
      migrateCmd: "bash packages/shared/db/migrate.sh",
      seedCmd: undefined,
      assertions: undefined,
      envFile: undefined,
    });
    const script = buildDeployScript(app, TARGET);

    // Execute exactly the build+migrate phase code the remote shell would run
    // (fetch/checkout/install need a VM; the cwd contract doesn't).
    const phases = slicePhases(script, "# --- build ---", "# --- restart");
    const harness = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `SAMOHOST_APP_DIR='${appDir}'`,
      'cd "$SAMOHOST_APP_DIR"',
      phases,
    ].join("\n");

    const run = spawnSync("bash", ["-s"], { input: harness, encoding: "utf8" });

    expect(run.stdout).toContain("<<<SAMOHOST_PHASE:build:ok>>>");
    // The whole point: migrate must succeed from the app dir, not from
    // wherever buildCmd's `cd apps/web` left the shell.
    expect(run.stdout).toContain("MIGRATIONS_APPLIED");
    expect(run.stdout).toContain("<<<SAMOHOST_PHASE:migrate:ok>>>");
    expect(run.stdout).not.toContain("<<<SAMOHOST_PHASE:migrate:fail>>>");
    expect(run.status).toBe(0);
  });

  test("build's cd does not leak into seed either (real bash execution)", () => {
    const appDir = mkdtempSync(join(tmpdir(), "samohost-122-seed-"));
    mkdirSync(join(appDir, "apps", "web"), { recursive: true });
    writeFileSync(join(appDir, "seed.sh"), 'echo "SEEDED"\n');

    const app = fieldRecord({
      appDir,
      buildCmd: "cd apps/web && echo built",
      migrateCmd: undefined,
      seedCmd: "bash seed.sh",
      assertions: undefined,
      envFile: undefined,
    });
    const script = buildDeployScript(app, TARGET);

    // Run build, then jump straight to seed (restart/health need a VM; their
    // commands are absolute-path/cwd-independent).
    const build = slicePhases(script, "# --- build ---", "# --- restart");
    const seed = slicePhases(script, "# --- seed", 'echo "deploy complete');
    const harness = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `SAMOHOST_APP_DIR='${appDir}'`,
      'cd "$SAMOHOST_APP_DIR"',
      build,
      seed,
    ].join("\n");

    const run = spawnSync("bash", ["-s"], { input: harness, encoding: "utf8" });

    expect(run.stdout).toContain("SEEDED");
    expect(run.stdout).toContain("<<<SAMOHOST_PHASE:seed:ok>>>");
    expect(run.status).toBe(0);
  });
});
